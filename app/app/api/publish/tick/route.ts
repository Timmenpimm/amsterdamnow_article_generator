import { NextRequest, NextResponse } from 'next/server';
import { listStructures, getPublishMetaByIds } from '@/lib/db';
import { listArticles, publishArticle } from '@/lib/wp';
import { articlePhase } from '@/lib/types';
import {
  getAutoPublishSettingsRaw, getAutoPublishSettings, saveAutoPublishSettings,
  claimAutoPublishTick, classifyArticles, pickNextForPublish, publishedCountLast24h, nextRunAt,
} from '@/lib/publisher';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Client-driven (het bord polt dit elke 60s, geen auth vereist) — zelfde
// patroon als /api/topics/process. Komt er wél een Authorization-header mee
// (toekomstig cron-gebruik), dan moet die exact Bearer CRON_SECRET zijn.
function authorized(req: NextRequest): boolean {
  const auth = req.headers.get('authorization');
  if (!auth) return true;
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && auth === `Bearer ${secret}`;
}

async function tick() {
  const { settings, raw } = await getAutoPublishSettingsRaw();
  if (!settings.enabled) return { enabled: false };

  const now = new Date();
  if (settings.lastPublishedAt) {
    const nextAt = nextRunAt(settings);
    if (nextAt && now.getTime() < new Date(nextAt).getTime()) {
      return { enabled: true, due: false, nextAt };
    }
  }

  // Optimistische claim VÓÓR classificeren/publiceren: schrijft lastPublishedAt
  // = nu, maar alleen als de instellingen sinds het lezen hierboven niet zijn
  // gewijzigd. Twee gelijktijdige polls kunnen allebei de due-check hierboven
  // doorkomen; zonder deze claim zouden ze dan ook allebei classifyArticles()
  // (een Haiku-call) én publishArticle() aanroepen. De verliezer stopt hier
  // meteen — geen classificatie, geen publicatie.
  const nowIso = now.toISOString();
  const claimed = await claimAutoPublishTick(raw, settings, nowIso);
  if (!claimed) {
    return { enabled: true, due: false, raced: true };
  }

  // Draait de claim terug: lastPublishedAt weer op de vorige waarde, zodat de
  // volgende tik het gewoon opnieuw probeert. Gebruikt bij een lege
  // wachtrij (niets te publiceren) of een mislukte publicatie.
  async function rollbackClaim() {
    await saveAutoPublishSettings({ lastPublishedAt: settings.lastPublishedAt });
  }

  // Zelfde bron als /api/board: alle artikelen + lijststructuren, om exact
  // dezelfde "Klaar voor publicatie"-regel te kunnen toepassen als Pipeline.tsx.
  // 50 gepubliceerde artikelen meeladen (i.p.v. de bord-default 15): de
  // cluster-cooldown en de dagcap hebben een langere terugkijk nodig.
  const [articles, structures] = await Promise.all([listArticles(50), listStructures()]);
  const ready = articles.filter(a => articlePhase(a, structures[a.id] || null) === 'ready');

  // Eén Claude-call per tik (60s-limiet): classificeert max 8 nog-onbekende
  // ready-artikelen; fail-open, zie lib/publisher.ts.
  const metaById = await classifyArticles(ready);

  if (!ready.length) {
    await rollbackClaim();
    return { enabled: true, due: true, published: null, reason: 'empty' };
  }

  const published = articles.filter(a => a.status === 'publish');

  // Harde dagcap: al genoeg gepubliceerd in de laatste 24u? Dan deze dag niets
  // meer (fail-open: cap 0/onbekend = onbeperkt). De claim wordt teruggedraaid
  // zodat de volgende tik het na het verstrijken van het venster weer probeert.
  if (settings.maxPerDay > 0) {
    const last24h = publishedCountLast24h(published, now);
    if (last24h >= settings.maxPerDay) {
      await rollbackClaim();
      return { enabled: true, due: true, published: null, reason: 'daycap', published24h: last24h, maxPerDay: settings.maxPerDay };
    }
  }

  // Cluster-cooldown checkt óók de laatste N gepubliceerde artikelen; hun cluster
  // staat (indien ooit geclassificeerd) in publish_meta. Merge dat in metaById,
  // zodat de cooldown niet louter op de primaire categorie hoeft terug te vallen.
  const publishedMeta = await getPublishMetaByIds(published.map(a => a.id));
  for (const [id, meta] of publishedMeta) if (!metaById.has(id)) metaById.set(id, meta);

  const pick = pickNextForPublish(ready, metaById, published, settings.clusterCooldown, now);
  if (!pick) {
    await rollbackClaim();
    return { enabled: true, due: true, published: null, reason: 'empty' };
  }

  try {
    const article = await publishArticle(pick.id);
    const updated = await getAutoPublishSettings();
    return {
      enabled: true,
      due: true,
      published: { id: pick.id, title: article?.title || pick.title },
      nextAt: nextRunAt(updated),
    };
  } catch (error: any) {
    // lastPublishedAt terugdraaien — de volgende tik probeert opnieuw. Loggen
    // hier is de enige plek waar een mislukte auto-publish zichtbaar wordt:
    // de tick-route geeft altijd HTTP 200 terug (zie GET hieronder), dus
    // zonder deze log verdwijnt de fout stilletjes in Vercel's function-logs.
    console.error(`[autopublish] publiceren van artikel ${pick.id} mislukt`, error);
    await rollbackClaim();
    return { enabled: true, due: true, published: null, error: error.message || 'Publiceren mislukt' };
  }
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'Niet geautoriseerd.' }, { status: 401 });
  try {
    return NextResponse.json(await tick());
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Auto-publish tik mislukt' }, { status: 500 });
  }
}

// POST-alias, zoals /api/topics/process — Pipeline.tsx zelf gebruikt de GET
// (fire-and-forget poll), maar sommige aanroepers (cron, curl) verwachten POST.
export async function POST(req: NextRequest) {
  return GET(req);
}
