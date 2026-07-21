import { NextRequest, NextResponse } from 'next/server';
import { getArticle, updateArticleContent, updateImages, uploadMediaFromUrl } from '@/lib/wp';
import { searchImageCandidates } from '@/lib/imageSearch';
import { assembleListHtml } from '@/lib/listHtml';
import {
  addImageCandidates, listImageCandidates, unscoredImageCandidates,
  setImageCandidateStatus, getListStructure, saveListStructure,
} from '@/lib/db';
import { imageCount } from '@/lib/types';
import type { ImageCandidate, ListArticleStructure, MediaRef } from '@/lib/types';
import { scoreOneBatch } from '@/lib/imageScore';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Vanaf deze score mag een beeld automatisch geplaatst worden; alles
// daaronder blijft alleen als kandidaat in de grid staan.
const AUTO_MIN_SCORE = 55;

// Max kandidaten die per itemfoto-tik gescoord worden: itemzoeken + één
// vision-call + upload moet samen binnen de 60s-limiet blijven, dus geen
// meerdere scorebatches zoals in de featured/slider-fase.
const ITEM_SCORE_BATCH = 12;

// Melding waarmee een item wordt gemarkeerd als "autofill vond niets
// bruikbaars"; de item-loop slaat gemarkeerde items daarna over zodat hij
// nooit eeuwig op hetzelfde item blijft hameren. De redactie ziet de melding
// in het beeldwerk-scherm en kan alsnog handmatig een foto kiezen.
const NO_ITEM_PHOTO_PREFIX = 'Geen geschikte itemfoto gevonden voor ';
const noPhotoMelding = (naam: string) =>
  `${NO_ITEM_PHOTO_PREFIX}"${naam}" — kies handmatig een foto.`;

// Item-indexen zonder foto die nog niet als "niets gevonden" gemarkeerd zijn.
function unfilledItemIndexes(list: ListArticleStructure): number[] {
  return list.items
    .map((item, i) => ({ item, i }))
    .filter(({ item }) => !item.media && !(list.meldingen || []).includes(noPhotoMelding(item.naam)))
    .map(({ i }) => i);
}

// Vult automatisch beelden in voor een vers artikel. Eén stap per aanroep
// i.v.m. de 60s serverless-limiet (max één Claude-call per request):
//   1e tik   → kandidaten zoeken
//   n tikken → per tik max 12 beelden scoren (één Claude-call)
//   dan      → top-beelden uploaden en plaatsen (featured + slider [+ inline])
//   lijst    → daarna per tik ÉÉN itemfoto: zoeken op de itemnaam, één
//              scorebatch, beste ≥ drempel uploaden en de content opnieuw
//              assembleren (zelfde patroon als /api/articles/[id]/item-media).
// De aanroeper (bord of beeldwerk-scherm) blijft aanroepen tot done: true.
//
// De featured/slider-fase draait alleen voor onaangeraakte artikelen: 0
// beelden én nog geen kandidaat die door de redactie gebruikt of afgewezen
// is. De itemfoto-fase vult uitsluitend lege item-slots (nooit overschrijven)
// en draait dus ook als de redactie featured/slider al zelf zette.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const article = await getArticle(Number(id));
    if (!article) return NextResponse.json({ error: 'Artikel niet gevonden.' }, { status: 404 });
    if (article.status !== 'draft') {
      return NextResponse.json({ done: true, eligible: false, placed: 0 });
    }

    const list = await getListStructure(article.id);
    let candidates = await listImageCandidates(article.id);
    const touched = candidates.some(c => c.status === 'used' || c.status === 'dismissed');
    const untouched = imageCount(article, list) === 0 && !touched;

    if (!list && !untouched) {
      return NextResponse.json({ done: true, eligible: false, placed: 0 });
    }

    // ---------- fase A: featured + slider (+ inline bij standaard) ----------
    if (untouched) {
      // Stap 1: zoeken.
      if (!candidates.length) {
        const { drafts, errors } = await searchImageCandidates(article);
        await addImageCandidates(article.id, drafts);
        candidates = await listImageCandidates(article.id);
        if (candidates.length) {
          return NextResponse.json({ done: false, step: 'search', found: candidates.length, errors });
        }
        if (!list) return NextResponse.json({ done: true, eligible: true, placed: 0, errors });
        // Lijst zonder artikel-brede vondsten: door naar de itemfoto-fase —
        // de item-zoektermen (naam + buurt) vinden vaak wél iets.
      }

      // Stap 2: scoren, één batch per tik.
      const unscored = await unscoredImageCandidates(article.id, 12);
      if (unscored.length) {
        await scoreOneBatch(article, unscored);
        const remaining = (await unscoredImageCandidates(article.id, 1)).length;
        return NextResponse.json({ done: false, step: 'score', remaining });
      }

      // Stap 3: plaatsen. Featured = het advies van de beoordelaar als dat er
      // is, anders de hoogste score; daarna 1 slider en 1 inline (in die volgorde).
      const eligibleCands = candidates
        .filter(c => c.status === 'scored' && (c.score ?? 0) >= AUTO_MIN_SCORE)
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      const featuredPick = eligibleCands.find(c => c.role === 'featured') || eligibleCands[0];
      const ordered = featuredPick
        ? [featuredPick, ...eligibleCands.filter(c => c.id !== featuredPick.id)]
        : [];
      if (!ordered.length && !list) {
        return NextResponse.json({ done: true, eligible: true, placed: 0 });
      }

      if (ordered.length) {
        // Dode bron-URL? Schuif door naar de volgende kandidaat tot er 3 staan.
        const uploaded: { candidate: ImageCandidate; media: MediaRef }[] = [];
        for (const c of ordered) {
          if (uploaded.length >= 3) break;
          try {
            uploaded.push({ candidate: c, media: await uploadMediaFromUrl(c.url) });
          } catch {
            await setImageCandidateStatus(article.id, c.id, 'dismissed'); // niet nóg eens proberen
          }
        }
        if (!uploaded.length && !list) {
          return NextResponse.json({ done: true, eligible: true, placed: 0 });
        }
        if (uploaded.length) {
          const best = uploaded[0].candidate;
          const credit = [best.author, best.source, best.license].filter(Boolean).join(' · ');
          // Standaardartikel: featured + 1 slider + 1 inline. Lijstartikel heeft
          // geen inline-beeld (eigen itemfoto-flow, content wordt
          // her-geassembleerd) → de resterende beelden gaan naar de slider.
          const placement = list
            ? { sliderIds: uploaded.slice(1).map(u => u.media.id) }
            : { sliderIds: uploaded[1] ? [uploaded[1].media.id] : [], inlineId: uploaded[2] ? uploaded[2].media.id : undefined };
          const updated = await updateImages(
            article.id,
            {
              featuredId: uploaded[0].media.id,
              ...placement,
              ...(article.fotograaf ? {} : { fotograaf: credit }),
            },
            uploaded.map(u => u.media)
          );
          for (const u of uploaded) await setImageCandidateStatus(article.id, u.candidate.id, 'used');

          if (!list) {
            return NextResponse.json({ done: true, eligible: true, placed: uploaded.length, article: updated });
          }
          // Lijst: door naar de itemfoto's — de volgende tikken vullen per
          // aanroep één item (deze tik heeft z'n uploads al gehad).
          const remainingItems = unfilledItemIndexes(list).length;
          return NextResponse.json({
            done: remainingItems === 0, eligible: true, step: 'place',
            placed: uploaded.length, article: updated, remainingItems,
          });
        }
      }
      // Lijst zonder plaatsbare artikel-brede kandidaten: door naar fase B.
    }

    // ---------- fase B: itemfoto's (alleen lijstartikelen) ----------
    // Max één item per aanroep: zoeken (geen Claude) + één scorebatch (één
    // Claude-call) + upload + content her-assembleren.
    if (!list) return NextResponse.json({ done: true, eligible: false, placed: 0 });

    const unfilled = unfilledItemIndexes(list);
    if (!unfilled.length) {
      return NextResponse.json({ done: true, eligible: true, placed: 0, remainingItems: 0 });
    }
    const idx = unfilled[0];
    const item = list.items[idx];

    // Zoektermen per item, via dezelfde buildImageQueries-logica als de
    // candidates/search-route: itemnaam als locatie ("<naam> Amsterdam"
    // voorop), buurt als district voor de Amsterdam-context.
    const { drafts } = await searchImageCandidates({
      title: `${item.naam} ${item.buurt || article.district || ''} Amsterdam`.replace(/\s+/g, ' ').trim(),
      naam_locatie: item.naam,
      district: item.buurt || article.district,
      tags: [],
      category: article.category,
    });

    // Kandidaten bewaren in de bestaande pool (dedup op URL in de db) zodat
    // de redactie ze ook in de grid ziet; scoren op thumbnails met de
    // bestaande scoring, in item-context.
    await addImageCandidates(article.id, drafts);
    const itemUrls = new Set(drafts.map(d => d.url.split('?')[0]));
    candidates = await listImageCandidates(article.id);
    const isItemCand = (c: ImageCandidate) => itemUrls.has(c.url.split('?')[0]);
    const toScore = candidates.filter(c => isItemCand(c) && c.status === 'new').slice(0, ITEM_SCORE_BATCH);
    if (toScore.length) {
      await scoreOneBatch(
        { title: `${item.naam} (item uit: ${article.title})`, naam_locatie: item.naam, district: item.buurt || article.district },
        toScore
      );
      candidates = await listImageCandidates(article.id);
    }

    const picks = candidates
      .filter(c => isItemCand(c) && c.status === 'scored' && (c.score ?? 0) >= AUTO_MIN_SCORE)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    // Dode bron-URL? Schuif door naar de volgende kandidaat.
    let placedCand: ImageCandidate | null = null;
    let placedMedia: MediaRef | null = null;
    for (const c of picks) {
      try {
        placedMedia = await uploadMediaFromUrl(c.url);
        placedCand = c;
        break;
      } catch {
        await setImageCandidateStatus(article.id, c.id, 'dismissed');
      }
    }

    if (!placedCand || !placedMedia) {
      // Niets boven de drempel (of alles onbereikbaar): item markeren zodat
      // de loop 'm overslaat, en door naar het volgende item.
      list.meldingen = [...(list.meldingen || []), noPhotoMelding(item.naam)];
      await saveListStructure(article.id, null, list);
      const remainingItems = unfilledItemIndexes(list).length;
      return NextResponse.json({
        done: remainingItems === 0, eligible: true, step: 'item', placed: 0,
        skippedItem: { index: idx, naam: item.naam }, remainingItems,
      });
    }

    // Zelfde patroon als /api/articles/[id]/item-media: media zetten, content
    // opnieuw assembleren, structuur bewaren.
    list.items[idx].media = placedMedia;
    await updateArticleContent(article.id, assembleListHtml(list));
    await saveListStructure(article.id, null, list);
    await setImageCandidateStatus(article.id, placedCand.id, 'used');

    const remainingItems = unfilledItemIndexes(list).length;
    return NextResponse.json({
      done: remainingItems === 0, eligible: true, step: 'item', placed: 1,
      filledItem: { index: idx, naam: item.naam, media: placedMedia }, remainingItems,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
