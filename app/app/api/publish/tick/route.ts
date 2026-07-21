import { NextRequest, NextResponse } from 'next/server';
import { listStructures } from '@/lib/db';
import { listArticles, publishArticle } from '@/lib/wp';
import { articlePhase } from '@/lib/types';
import {
  getAutoPublishSettings, saveAutoPublishSettings, classifyArticles, pickNextForPublish, nextRunAt,
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
  const settings = await getAutoPublishSettings();
  if (!settings.enabled) return { enabled: false };

  const now = new Date();
  if (settings.lastPublishedAt) {
    const nextAt = nextRunAt(settings);
    if (nextAt && now.getTime() < new Date(nextAt).getTime()) {
      return { enabled: true, due: false, nextAt };
    }
  }

  // Zelfde bron als /api/board: alle artikelen + lijststructuren, om exact
  // dezelfde "Klaar voor publicatie"-regel te kunnen toepassen als Pipeline.tsx.
  const [articles, structures] = await Promise.all([listArticles(), listStructures()]);
  const ready = articles.filter(a => articlePhase(a, structures[a.id] || null) === 'ready');

  // Eén Claude-call per tik (60s-limiet): classificeert max 8 nog-onbekende
  // ready-artikelen; fail-open, zie lib/publisher.ts.
  const metaById = await classifyArticles(ready);

  if (!ready.length) {
    return { enabled: true, due: true, published: null, reason: 'empty' };
  }

  const published = articles.filter(a => a.status === 'publish');
  const pick = pickNextForPublish(ready, metaById, published, now);
  if (!pick) {
    return { enabled: true, due: true, published: null, reason: 'empty' };
  }

  try {
    const article = await publishArticle(pick.id);
    const updated = await saveAutoPublishSettings({ lastPublishedAt: now.toISOString() });
    return {
      enabled: true,
      due: true,
      published: { id: pick.id, title: article?.title || pick.title },
      nextAt: nextRunAt(updated),
    };
  } catch (error: any) {
    // lastPublishedAt bewust niet bijwerken — de volgende tik probeert opnieuw.
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
