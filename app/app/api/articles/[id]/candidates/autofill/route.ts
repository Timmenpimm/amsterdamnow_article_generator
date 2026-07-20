import { NextRequest, NextResponse } from 'next/server';
import { getArticle, updateImages, uploadMediaFromUrl } from '@/lib/wp';
import { searchImageCandidates } from '@/lib/imageSearch';
import {
  addImageCandidates, listImageCandidates, unscoredImageCandidates,
  setImageCandidateStatus, getListStructure,
} from '@/lib/db';
import { imageCount } from '@/lib/types';
import type { ImageCandidate, MediaRef } from '@/lib/types';
import { scoreOneBatch } from '@/lib/imageScore';

export const dynamic = 'force-dynamic';

// Vanaf deze score mag een beeld automatisch geplaatst worden; alles
// daaronder blijft alleen als kandidaat in de grid staan.
const AUTO_MIN_SCORE = 55;

// Vult de beste 3 beelden (featured + 2 slider) alvast in voor een vers
// artikel. Eén stap per aanroep i.v.m. de 60s serverless-limiet:
//   1e tik  → kandidaten zoeken
//   n tikken → per tik max 12 beelden scoren (één Claude-call)
//   laatste  → top-3 uploaden en plaatsen
// De aanroeper (bord of beeldwerk-scherm) blijft aanroepen tot done: true.
//
// Alleen voor onaangeraakte artikelen: 0 beelden én nog geen kandidaat die
// door de redactie gebruikt of afgewezen is. Heeft de redactie al iets
// gedaan, dan blijft de machine eraf.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const article = await getArticle(Number(id));
    if (!article) return NextResponse.json({ error: 'Artikel niet gevonden.' }, { status: 404 });

    const list = await getListStructure(article.id);
    let candidates = await listImageCandidates(article.id);
    const touched = candidates.some(c => c.status === 'used' || c.status === 'dismissed');
    if (article.status !== 'draft' || imageCount(article, list) > 0 || touched) {
      return NextResponse.json({ done: true, eligible: false, placed: 0 });
    }

    // Stap 1: zoeken.
    if (!candidates.length) {
      const { drafts, errors } = await searchImageCandidates(article);
      await addImageCandidates(article.id, drafts);
      candidates = await listImageCandidates(article.id);
      if (!candidates.length) {
        return NextResponse.json({ done: true, eligible: true, placed: 0, errors });
      }
      return NextResponse.json({ done: false, step: 'search', found: candidates.length, errors });
    }

    // Stap 2: scoren, één batch per tik.
    const unscored = await unscoredImageCandidates(article.id, 12);
    if (unscored.length) {
      await scoreOneBatch(article, unscored);
      const remaining = (await unscoredImageCandidates(article.id, 1)).length;
      return NextResponse.json({ done: false, step: 'score', remaining });
    }

    // Stap 3: plaatsen. Featured = het advies van de beoordelaar als dat er
    // is, anders de hoogste score; daarna de twee beste voor de slider.
    const eligibleCands = candidates
      .filter(c => c.status === 'scored' && (c.score ?? 0) >= AUTO_MIN_SCORE)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const featuredPick = eligibleCands.find(c => c.role === 'featured') || eligibleCands[0];
    const ordered = featuredPick
      ? [featuredPick, ...eligibleCands.filter(c => c.id !== featuredPick.id)]
      : [];
    if (!ordered.length) return NextResponse.json({ done: true, eligible: true, placed: 0 });

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
    if (!uploaded.length) return NextResponse.json({ done: true, eligible: true, placed: 0 });

    const best = uploaded[0].candidate;
    const credit = [best.author, best.source, best.license].filter(Boolean).join(' · ');
    const updated = await updateImages(
      article.id,
      {
        featuredId: uploaded[0].media.id,
        sliderIds: uploaded.slice(1).map(u => u.media.id),
        ...(article.fotograaf ? {} : { fotograaf: credit }),
      },
      uploaded.map(u => u.media)
    );
    for (const u of uploaded) await setImageCandidateStatus(article.id, u.candidate.id, 'used');

    return NextResponse.json({ done: true, eligible: true, placed: uploaded.length, article: updated });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
