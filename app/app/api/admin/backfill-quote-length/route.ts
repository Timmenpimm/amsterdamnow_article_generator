import { NextRequest, NextResponse } from 'next/server';
import { listArticles, updateArticleContent } from '@/lib/wp';
import { getListStructure } from '@/lib/db';
import { findExistingQuoteBlock, rewriteQuote } from '@/lib/writer';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Eenmalige, idempotente verlenging van bestaande, te korte pull-quotes
// (< 25 woorden) in "Klaar"-drafts naar 25-40 woorden — de eis die nieuw
// geschreven artikelen al moeten halen (StandaardConstraints.quoteWords /
// quoteMustBeVerbatimInContent). Alleen standaard-artikelen (lijstartikelen
// hebben geen quoteWords-eis, herkenbaar via getListStructure(a.id) !== null)
// en alleen drafts met een herkenbare bestaande <blockquote>+bronparagraaf-
// structuur (zoals lib/articleHtml.ts formatStandardArticleHtml die opzet).
//
// De todo-selectie is puur leeswerk uit contentHtml (geen Claude-call): een
// artikel doet alleen mee als de bestaande blockquote-tekst nog geen 25
// woorden heeft. De daadwerkelijke herschrijving (lib/writer.ts rewriteQuote)
// kost wél een goedkope call, en wordt daarna hard getoetst (25-40 woorden +
// letterlijk terug te vinden in de nieuwe content) vóór er iets wordt
// weggeschreven. Bij twijfel — mislukte call, geen bronparagraaf te vinden,
// eisen niet gehaald — wordt het artikel overgeslagen, nooit fout herschreven.
//
// Beveiligd met Bearer CRON_SECRET; per tik max MAX_PER_TICK i.v.m. de 60s
// serverless-limiet. De aanroeper blijft POST'en tot done: true.
const MAX_PER_TICK = 10;
const MIN_QUOTE_WORDS = 25;

// Zelfde telling als validation.ts words() (niet geëxporteerd daar, en
// validation.ts mag voor deze backfill niet gewijzigd worden) — hier 1-op-1
// herhaald voor de goedkope todo-selectie.
function wordCount(value: string): number {
  return value.replace(/<[^>]*>/g, ' ').trim().split(/\s+/).filter(Boolean).length;
}

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    const articles = await listArticles();
    const drafts = articles.filter(a => a.status === 'draft');

    const todo: typeof drafts = [];
    for (const a of drafts) {
      const list = await getListStructure(a.id);
      if (list) continue; // lijstartikelen overslaan
      const block = findExistingQuoteBlock(a.contentHtml);
      if (!block) continue; // geen herkenbare quote-structuur — niets te doen
      if (wordCount(block.quoteText) >= MIN_QUOTE_WORDS) continue; // al lang genoeg
      todo.push(a);
    }

    const batch = todo.slice(0, MAX_PER_TICK);
    const changed: { id: number; title: string }[] = [];
    const skipped: { id: number; title: string; reason: string }[] = [];
    for (const a of batch) {
      try {
        const { html } = await rewriteQuote(a, a.contentHtml);
        await updateArticleContent(a.id, html);
        changed.push({ id: a.id, title: a.title });
      } catch (e: any) {
        // Fail-safe: bij elke twijfel (mislukte call, quote niet 25-40 woorden,
        // quote niet letterlijk terug te vinden) wordt het artikel overgeslagen
        // in plaats van fout herschreven — de route past bestaande, live tekst
        // aan, dus liever skippen dan verkeerd herschrijven.
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
