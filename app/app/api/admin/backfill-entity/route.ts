import { NextRequest, NextResponse } from 'next/server';
import { listArticles, updateArticleFields } from '@/lib/wp';
import { getListStructure } from '@/lib/db';
import { researchWithTavily } from '@/lib/tavily';
import { verifyEntityFields } from '@/lib/writer';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Eenmalige, idempotente correctie van bestaande "Klaar"-drafts (standaard-
// artikelen): naam_locatie canoniseren en website naar de homepage-origin
// zetten, op basis van dezelfde entiteitsverificatie die de research-fase
// van nieuwe artikelen al gebruikt (lib/writer.ts verifyEntity/
// verifyEntityFields). Alleen standaard-artikelen — lijstartikelen hebben
// geen eigen naam_locatie/adres/website en geen quoteWords-eis (herkenbaar
// via getListStructure(a.id) !== null) en vallen buiten deze backfill.
//
// Skip-marker om onnodige re-research te voorkomen: een artikel met een
// ingevulde naam_locatie ÉN een website die al een kale homepage-origin is
// (pad "/" of leeg, geen diepe link, geen querystring) is vermoedelijk al
// eerder gecorrigeerd (door deze backfill, of al goed aangeleverd) en wordt
// overgeslagen zonder dure Tavily/Claude-calls. Adres wordt bewust niet
// aangepast: verifyEntityFields levert geen gecorrigeerd adres terug (alleen
// naam + consistentie + waarschuwing) — een geraden adres is erger dan het
// bestaande laten staan.
//
// Beveiligd met Bearer CRON_SECRET; per tik max MAX_PER_TICK i.v.m. de 60s
// serverless-limiet. De aanroeper blijft POST'en tot done: true.
const MAX_PER_TICK = 5;

function isHomepageOrigin(website: string): boolean {
  const w = (website || '').trim();
  if (!w) return false;
  try {
    const u = new URL(w);
    return (u.pathname === '/' || u.pathname === '') && !u.search;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    const articles = await listArticles();
    const drafts = articles.filter(a => a.status === 'draft');

    // Sla lijstartikelen over (eigen itemfoto-flow, geen naam_locatie/website).
    const todo: typeof drafts = [];
    for (const a of drafts) {
      const list = await getListStructure(a.id);
      if (list) continue;
      if (a.naam_locatie.trim() && isHomepageOrigin(a.website)) continue; // al correct
      todo.push(a);
    }

    const batch = todo.slice(0, MAX_PER_TICK);
    const changed: { id: number; title: string }[] = [];
    const skipped: { id: number; title: string; reason: string }[] = [];
    for (const a of batch) {
      try {
        const { sources, officialUrl } = await researchWithTavily(a.title);
        const homepageContent = officialUrl ? (sources.find(src => src.url === officialUrl)?.content ?? '') : '';
        const result = await verifyEntityFields({
          naam: a.naam_locatie,
          adres: a.adres,
          website: a.website,
          rubriek: a.rubriek,
          officialUrl,
          homepageContent,
        });
        const naamLocatie = result.canonical_naam_locatie || a.naam_locatie;
        const website = officialUrl || a.website;
        if (naamLocatie === a.naam_locatie && website === a.website) {
          skipped.push({ id: a.id, title: a.title, reason: 'geen wijziging nodig' });
          continue;
        }
        await updateArticleFields(a.id, { naamLocatie, website });
        changed.push({ id: a.id, title: a.title });
      } catch (e: any) {
        // FAIL-OPEN: mislukte research/verificatie → niets schrijven, overslaan.
        skipped.push({ id: a.id, title: a.title, reason: e.message || 'onbekende fout' });
      }
    }

    return NextResponse.json({
      done: todo.length <= MAX_PER_TICK,
      changed,
      remaining: Math.max(0, todo.length - batch.length),
      skipped,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
