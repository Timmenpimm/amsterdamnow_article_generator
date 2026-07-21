// Eenmalige backfill: vult ontbrekende RankMath SEO-velden (focus keyword,
// titel, meta description) in voor bestaande WordPress-artikelen die van
// vóór de REST-meta-registratie dateren (zie de mu-plugin-snippet die
// register_post_meta aanroept voor rank_math_focus_keyword/_title/
// _description — zonder die registratie negeert WordPress deze velden
// stilzwijgend, zowel bij het schrijven als het uitlezen via de REST API).
//
// Draait over alle drafts op het bord (Klaar - beelden nodig én Klaar voor
// publicatie, dat zijn samen alle drafts) én alle gepubliceerde artikelen.
// Slug blijft bewust onaangeroerd, zie updateArticleSeo in wp.ts.
//
// Zelfde patroon als backfillDraftEditorialFormatting in wp.ts: dryRun,
// kleine batches per aanroep (hier een Claude-call per artikel, dus trager
// dan een pure WP-PATCH), done/remaining zodat de aanroeper gewoon net zo
// vaak opnieuw post totdat done: true.
import { listArticles, listAllPublishedArticles, updateArticleSeo, LIVE } from './wp';
import { getListStructure, activePrompt } from './db';
import { askClaudeJson, FAST_WRITE_MODEL } from './claude';
import { SEO_SCHEMA } from './schemas';
import type { Article } from './types';

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export interface SeoBackfillResult {
  scanned: number;
  updated: { id: number; title: string }[];
  skipped: { id: number; title: string; reason: string }[];
  done: boolean;
  remaining: number;
}

// Eén Claude-call per artikel; klein genoeg om ruim binnen de 60s-
// serverless-limiet te blijven, ook als de laatste call trager is dan gemiddeld.
const BATCH_SIZE = 5;

async function generateStandardSeo(article: Article) {
  const seoPrompt = await activePrompt('seo');
  const seo = await askClaudeJson(
    seoPrompt.content,
    `POST_TITLE: ${article.title}\nPOST_EXCERPT: ${article.intro}\nPOST_CONTENT: ${article.contentHtml}\nCATEGORY: ${article.category}\nDISTRICT: ${article.district}`,
    false, FAST_WRITE_MODEL, 6000, SEO_SCHEMA,
  );
  return {
    focusKeyword: str(seo.rank_math_focus_keyword),
    seoTitle: str(seo.rank_math_title),
    metaDescription: str(seo.rank_math_description),
  };
}

async function generateListSeo(article: Article, items: string[]) {
  const seoPrompt = await activePrompt('lijst-seo');
  const seo = await askClaudeJson(
    seoPrompt.content,
    `Onderwerp: ${article.title}\nTitel: ${article.title}\nIntro: ${article.intro}\nItems: ${items.join(', ')}`,
    false, FAST_WRITE_MODEL, 6000, SEO_SCHEMA,
  );
  return {
    focusKeyword: str(seo.rank_math_focus_keyword),
    seoTitle: str(seo.rank_math_title),
    metaDescription: str(seo.rank_math_description),
  };
}

export async function backfillSeo(dryRun = false): Promise<SeoBackfillResult> {
  if (!LIVE) throw new Error('Backfill is alleen beschikbaar in live-modus.');
  const [drafts, published] = await Promise.all([
    listArticles().then(list => list.filter(a => a.status === 'draft')),
    listAllPublishedArticles(),
  ]);
  const all = [...drafts, ...published];
  // seoTitle leeg ⇒ de SEO-stap heeft voor dit artikel nooit succesvol
  // meta weggeschreven (of kon dat niet, vóór de REST-registratie).
  const candidates = all.filter(a => !a.seoTitle);

  const result: SeoBackfillResult = { scanned: all.length, updated: [], skipped: [], done: true, remaining: 0 };
  if (!candidates.length) return result;

  if (dryRun) {
    result.updated = candidates.map(a => ({ id: a.id, title: a.title }));
    result.remaining = candidates.length;
    return result;
  }

  const batch = candidates.slice(0, BATCH_SIZE);
  for (const article of batch) {
    try {
      const structure = await getListStructure(article.id);
      const seo = structure
        ? await generateListSeo(article, structure.items.map(i => i.naam))
        : await generateStandardSeo(article);
      if (!seo.seoTitle) throw new Error('SEO-agent gaf geen titel terug');
      await updateArticleSeo(article.id, seo);
      result.updated.push({ id: article.id, title: article.title });
    } catch (err: any) {
      result.skipped.push({ id: article.id, title: article.title, reason: err.message || 'onbekende fout' });
    }
  }
  result.remaining = Math.max(0, candidates.length - batch.length);
  result.done = result.remaining === 0;
  return result;
}
