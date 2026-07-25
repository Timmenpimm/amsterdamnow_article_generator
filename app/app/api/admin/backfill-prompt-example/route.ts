import { NextRequest, NextResponse } from 'next/server';
import { getArticle, listArticles, updateArticleContent } from '@/lib/wp';
import { activePrompt, getListStructure } from '@/lib/db';
import { extractPromptExamples, findPromptExampleLeak } from '@/lib/validation';
import { findExistingQuoteBlock, rewriteQuote } from '@/lib/writer';
import type { Article } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Opruimactie voor artikelen waarin het model een voorbeeldzin uit de
// schrijfprompt letterlijk heeft overgenomen. Concreet geval: de pull-quote
// "De wijnkaart is hier net zo serieus als de keuken. En dat is precies de
// bedoeling." uit <example type="quote"> stond in artikelen over een
// techno-festival, een sportwinkel en een theater. Nieuwe artikelen worden
// hierop afgekeurd (validation.ts findPromptExampleLeak); deze route ruimt de
// bestaande op.
//
// De besmette zinnen worden niet hardgecodeerd maar uit de ACTIEVE
// schrijfprompt gehaald, zodat de route meegaat met latere promptversies.
// Let op: is een voorbeeldzin inmiddels uit de prompt gehaald, dan vindt deze
// route hem ook niet meer — geef zo'n zin dan mee via "extraZinnen".
//
// Beveiligd met Bearer CRON_SECRET. Standaard dryRun: er wordt niets
// weggeschreven tot je expliciet {"dryRun": false} meestuurt.
//
// Body (alles optioneel):
//   dryRun       boolean  — default true; alleen rapporteren
//   ids          number[] — alleen deze post-ids nakijken (anders: drafts +
//                           recent gepubliceerd via listArticles)
//   publishedPerPage number — hoeveel gepubliceerde artikelen meescannen (max 100)
//   extraZinnen  string[] — extra te weren zinnen bovenop de promptvoorbeelden
const MAX_PER_TICK = 10;

function plain(html: string): string {
  return html.replace(/<[^>]*>/g, ' ');
}

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const dryRun = body.dryRun !== false;
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isFinite) : null;
    const publishedPerPage = Number(body.publishedPerPage) || 100;
    const extra = Array.isArray(body.extraZinnen) ? body.extraZinnen.map(String).filter(Boolean) : [];

    const prompt = await activePrompt('schrijf');
    const voorbeelden = [...extractPromptExamples(prompt.content), ...extra];
    if (!voorbeelden.length) {
      return NextResponse.json({ error: 'Geen voorbeeldzinnen in de actieve schrijfprompt gevonden.' }, { status: 400 });
    }

    const kandidaten: Article[] = ids
      ? (await Promise.all(ids.map((id: number) => getArticle(id)))).filter((a): a is Article => Boolean(a))
      : await listArticles(publishedPerPage);

    const besmet: { article: Article; zin: string }[] = [];
    for (const a of kandidaten) {
      const zin = findPromptExampleLeak(plain(a.contentHtml || ''), voorbeelden);
      if (!zin) continue;
      if (await getListStructure(a.id)) continue; // lijstartikelen: andere opbouw, geen pull-quote
      besmet.push({ article: a, zin });
    }

    if (dryRun) {
      return NextResponse.json({
        dryRun: true,
        gescand: kandidaten.length,
        gevonden: besmet.map(({ article, zin }) => ({
          id: article.id,
          title: article.title,
          status: article.status,
          zin,
          // Zonder blockquote-bronparagraaf kan rewriteQuote niets; die
          // artikelen moeten handmatig, en dat wil je vóóraf weten.
          herschrijfbaar: Boolean(findExistingQuoteBlock(article.contentHtml || '')),
        })),
      });
    }

    const batch = besmet.slice(0, MAX_PER_TICK);
    const changed: { id: number; title: string; quote: string }[] = [];
    const skipped: { id: number; title: string; reason: string }[] = [];
    for (const { article, zin } of batch) {
      try {
        const { html, quote } = await rewriteQuote(article, article.contentHtml, {
          reden: 'letterlijk uit een voorbeeld in de schrijfprompt overgenomen en dus niet over dit artikel',
          verbodenZinnen: [zin, ...voorbeelden],
        });
        await updateArticleContent(article.id, html);
        changed.push({ id: article.id, title: article.title, quote });
      } catch (e: any) {
        // Fail-safe, net als backfill-quote-length: bij twijfel overslaan in
        // plaats van live tekst fout herschrijven.
        skipped.push({ id: article.id, title: article.title, reason: e.message || 'onbekende fout' });
      }
    }

    return NextResponse.json({
      dryRun: false,
      gescand: kandidaten.length,
      changed,
      skipped,
      remaining: Math.max(0, besmet.length - batch.length),
      done: besmet.length <= MAX_PER_TICK,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
