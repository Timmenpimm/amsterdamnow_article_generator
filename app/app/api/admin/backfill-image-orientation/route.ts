import { NextRequest, NextResponse } from 'next/server';
import { listArticles, mediaDimensions, updateImages, updateArticleContent, uploadMediaFromUrl } from '@/lib/wp';
import type { ImageUpdate } from '@/lib/wp';
import { searchImageCandidates, isLandscapeEnough } from '@/lib/imageSearch';
import { scoreOneBatch } from '@/lib/imageScore';
import { assembleListHtml } from '@/lib/listHtml';
import {
  getListStructure, saveListStructure, addImageCandidates, listImageCandidates, setImageCandidateStatus,
} from '@/lib/db';
import type { Article, ImageCandidate, ImageCandidateDraft, ListArticleStructure, MediaRef } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Met terugwerkende kracht LIGGENDE beelden geven aan bestaande "Klaar"-
// drafts (featured + slider + itemfoto's van lijstartikelen), nu het
// liggend-filter (lib/imageSearch.ts isLandscapeEnough) na eerdere drafts is
// gemerged. Alleen status==='draft' — gepubliceerde artikelen worden nooit
// aangeraakt. Zelfde tik-patroon als backfill-inline: elke tik herberekent
// `todo` vanaf de huidige staat, verwerkt er MAX_PER_TICK, en de aanroeper
// POST't door tot done:true. Geen aparte "gedaan"-tabel — zie de
// NO_ALT_MARKER-toelichting hieronder voor de ene uitzondering daarop.
//
// Drempel voor een "goed genoeg" kandidaat: zelfde AUTO_MIN_SCORE als de
// bestaande autofill-route (app/app/api/articles/[id]/candidates/autofill/
// route.ts) gebruikt — dezelfde vision-scoring, dus dezelfde lat.
const AUTO_MIN_SCORE = 55;

// Laag houden: dit is de duurste route in de tool. Per artikel kan dit tot
// twee externe zoekrondes (elk 4 queries × 4 providers) + twee vision-
// scoreringen kosten (artikel-brede slots + één itemfoto), dus MAX_PER_TICK
// blijft ver onder wat backfill-inline (puur een WP-schrijfactie) aankan.
const MAX_PER_TICK = 2;

// Hoeveel kandidaten er per zoekronde maximaal gescoord worden — begrenst de
// vision-kosten per tik-item, net als ITEM_SCORE_BATCH in de autofill-route.
const SCORE_BATCH = 12;

// searchImageCandidates() filtert de resultaten al op isLandscapeEnough (zie
// lib/imageSearch.ts), dus elke kandidaat die hier binnenkomt is al liggend
// genoeg — scoren bepaalt alleen nog of hij ook goed genoeg is.

// Sentinel-kandidaat: als voor een artikel geen liggend alternatief boven de
// drempel gevonden wordt, zetten we deze marker-URL in de bestaande
// image_candidates-tabel (per artikel gededupliceerd op URL, net als elke
// andere kandidaat). Zonder dit zou `todo` bij de volgende tik exact
// dezelfde geskipte artikelen weer bovenaan zetten en nooit `done: true`
// bereiken — een aparte "gedaan"-tabel mag niet, dus dit hergebruikt de
// tabel die er al is voor kandidaat-tracking.
const NO_ALT_MARKER_URL = 'backfill-image-orientation:no-landscape-alternative';
function noAltMarkerDraft(): ImageCandidateDraft {
  return {
    url: NO_ALT_MARKER_URL, thumb_url: NO_ALT_MARKER_URL, width: 0, height: 0,
    source: 'backfill-image-orientation', source_page: '',
    license: '', license_url: '', author: '',
    title: 'Geen liggend alternatief gevonden — backfill slaat dit artikel voortaan over.',
    query: '',
  };
}

interface ArticleAudit {
  article: Article;
  list: ListArticleStructure | null;
  featuredBad: boolean;
  sliderBadIdx: number[]; // indexen in article.slider die niet liggend genoeg zijn
  itemBadIdx: number[];   // indexen in list.items met een itemfoto die niet liggend genoeg is
  hasBad: boolean;
}

function slotOk(dims: Map<number, { width: number; height: number }>, media: MediaRef | null): boolean {
  if (!media) return true; // leeg slot is niets om te vervangen
  const d = dims.get(media.id);
  return isLandscapeEnough(d?.width ?? 0, d?.height ?? 0);
}

async function auditDrafts(drafts: Article[]): Promise<ArticleAudit[]> {
  const lists = new Map<number, ListArticleStructure | null>();
  const allIds = new Set<number>();
  for (const a of drafts) {
    const list = await getListStructure(a.id);
    lists.set(a.id, list);
    if (a.featured) allIds.add(a.featured.id);
    for (const m of a.slider) allIds.add(m.id);
    if (list) for (const it of list.items) if (it.media) allIds.add(it.media.id);
  }
  const dims = await mediaDimensions([...allIds]);

  return drafts.map(article => {
    const list = lists.get(article.id) || null;
    const featuredBad = !slotOk(dims, article.featured);
    const sliderBadIdx = article.slider
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => !slotOk(dims, m))
      .map(({ i }) => i);
    const itemBadIdx = list
      ? list.items
          .map((it, i) => ({ it, i }))
          .filter(({ it }) => it.media && !slotOk(dims, it.media))
          .map(({ i }) => i)
      : [];
    return { article, list, featuredBad, sliderBadIdx, itemBadIdx, hasBad: featuredBad || sliderBadIdx.length > 0 || itemBadIdx.length > 0 };
  });
}

// Vervangt de niet-liggende featured/slider-slots van één artikel. Eén
// gedeelde zoekronde voor het hele artikel (searchImageCandidates(article)),
// daarna zoveel liggende kandidaten ≥ AUTO_MIN_SCORE geüpload als er
// niet-liggende slots zijn — nooit meer, en de al-liggende slots blijven
// ongemoeid (alleen de niet-liggende index/indices worden overschreven).
async function fixFeaturedSlider(audit: ArticleAudit): Promise<boolean> {
  const { article, featuredBad, sliderBadIdx } = audit;
  const needed = (featuredBad ? 1 : 0) + sliderBadIdx.length;
  if (!needed) return true;

  const { drafts } = await searchImageCandidates(article);
  if (drafts.length) await addImageCandidates(article.id, drafts);
  const urlKey = (u: string) => u.split('?')[0];
  const urlSet = new Set(drafts.map(d => urlKey(d.url)));

  let cands = await listImageCandidates(article.id);
  const toScore = cands.filter(c => urlSet.has(urlKey(c.url)) && c.status === 'new').slice(0, SCORE_BATCH);
  if (toScore.length) {
    await scoreOneBatch(article, toScore);
    cands = await listImageCandidates(article.id);
  }
  const picks = cands
    .filter(c => urlSet.has(urlKey(c.url)) && c.status === 'scored' && (c.score ?? 0) >= AUTO_MIN_SCORE)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  const uploaded: { candidate: ImageCandidate; media: MediaRef }[] = [];
  for (const c of picks) {
    if (uploaded.length >= needed) break;
    try {
      uploaded.push({ candidate: c, media: await uploadMediaFromUrl(c.url) });
    } catch {
      await setImageCandidateStatus(article.id, c.id, 'dismissed'); // dode bron-URL, niet nóg eens proberen
    }
  }

  if (uploaded.length) {
    let i = 0;
    const upd: ImageUpdate = {};
    if (featuredBad) { upd.featuredId = uploaded[i]?.media.id; i++; }
    if (sliderBadIdx.length) {
      const newSlider = article.slider.map(m => m.id);
      for (const idx of sliderBadIdx) {
        if (!uploaded[i]) break;
        newSlider[idx] = uploaded[i].media.id;
        i++;
      }
      upd.sliderIds = newSlider;
    }
    // featuredId kan undefined blijven staan als er geen kandidaat over was —
    // updateImages schrijft een veld alleen als het is meegegeven.
    if (upd.featuredId === undefined) delete upd.featuredId;
    await updateImages(article.id, upd, uploaded.map(u => u.media));
    for (const u of uploaded) await setImageCandidateStatus(article.id, u.candidate.id, 'used');
  }
  return uploaded.length >= needed;
}

// Vervangt precies één niet-liggende itemfoto van een lijstartikel — exact
// het patroon van autofill fase B (per-item zoekterm, content her-
// assembleren, structuur bewaren). Eén item per tik-aanroep i.v.m. de
// 60s-limiet; volgende tikken pakken de rest op.
async function fixOneListItem(audit: ArticleAudit): Promise<boolean> {
  const { article, list, itemBadIdx } = audit;
  if (!list || !itemBadIdx.length) return true;
  const idx = itemBadIdx[0];
  const item = list.items[idx];

  const { drafts } = await searchImageCandidates({
    title: `${item.naam} ${item.buurt || article.district || ''} Amsterdam`.replace(/\s+/g, ' ').trim(),
    naam_locatie: item.naam,
    district: item.buurt || article.district,
    tags: [],
    category: article.category,
  });
  if (drafts.length) await addImageCandidates(article.id, drafts);
  const urlKey = (u: string) => u.split('?')[0];
  const itemUrls = new Set(drafts.map(d => urlKey(d.url)));

  let cands = await listImageCandidates(article.id);
  const toScore = cands.filter(c => itemUrls.has(urlKey(c.url)) && c.status === 'new').slice(0, SCORE_BATCH);
  if (toScore.length) {
    await scoreOneBatch(
      { title: `${item.naam} (item uit: ${article.title})`, naam_locatie: item.naam, district: item.buurt || article.district },
      toScore
    );
    cands = await listImageCandidates(article.id);
  }
  const picks = cands
    .filter(c => itemUrls.has(urlKey(c.url)) && c.status === 'scored' && (c.score ?? 0) >= AUTO_MIN_SCORE)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  for (const c of picks) {
    try {
      const media = await uploadMediaFromUrl(c.url);
      list.items[idx].media = media;
      await updateArticleContent(article.id, assembleListHtml(list));
      await saveListStructure(article.id, null, list);
      await setImageCandidateStatus(article.id, c.id, 'used');
      return true;
    } catch {
      await setImageCandidateStatus(article.id, c.id, 'dismissed');
    }
  }
  return false;
}

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    const drafts = (await listArticles()).filter(a => a.status === 'draft');
    const audits = await auditDrafts(drafts);
    const badAudits = audits.filter(a => a.hasBad);

    // Al eerder geskipt (NO_ALT_MARKER staat er) → niet opnieuw proberen,
    // anders wordt done:true nooit bereikt (zie toelichting bij de marker).
    const todo: ArticleAudit[] = [];
    for (const a of badAudits) {
      const cands = await listImageCandidates(a.article.id);
      if (cands.some(c => c.url === NO_ALT_MARKER_URL)) continue;
      todo.push(a);
    }

    const batch = todo.slice(0, MAX_PER_TICK);
    const changed: { id: number; title: string }[] = [];
    const skipped: { id: number; title: string; reason: string }[] = [];
    const errors: { id: number; title: string; error: string }[] = [];

    for (const audit of batch) {
      const { article } = audit;
      try {
        const featuredSliderOk = await fixFeaturedSlider(audit);
        const itemOk = await fixOneListItem(audit);
        const fullySolved = featuredSliderOk && itemOk;

        // Opnieuw beoordelen of er nog steeds iets niet-liggends over is
        // (bv. featured wél gefixed maar de itemfoto niet): alleen dan
        // resulteert dit in "changed" zonder skip-marker.
        if (fullySolved) {
          changed.push({ id: article.id, title: article.title });
        } else {
          // Gedeeltelijk of niets opgelost: als er wél íets vervangen is,
          // telt dat toch als changed, maar we markeren ook als geskipt
          // zodat het onopgeloste restdeel niet blijft hangen.
          if (!featuredSliderOk || !itemOk) {
            await addImageCandidates(article.id, [noAltMarkerDraft()]);
          }
          if (!featuredSliderOk && !itemOk) {
            skipped.push({ id: article.id, title: article.title, reason: 'geen liggend alternatief' });
          } else {
            changed.push({ id: article.id, title: article.title });
          }
        }
      } catch (e: any) {
        errors.push({ id: article.id, title: article.title, error: e?.message || String(e) });
      }
    }

    return NextResponse.json({
      done: todo.length <= MAX_PER_TICK,
      changed,
      remaining: Math.max(0, todo.length - batch.length),
      skipped,
      errors,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
