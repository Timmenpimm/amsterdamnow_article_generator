import { NextRequest, NextResponse } from 'next/server';
import { getArticle } from '@/lib/wp';
import { scoreOneBatch } from '@/lib/imageScore';
import { listImageCandidates, unscoredImageCandidates } from '@/lib/db';

export const dynamic = 'force-dynamic';

// Maximaal één Claude-call per request (60s serverless-limiet). De client
// roept deze route herhaald aan tot `remaining` 0 is.
const BATCH = 12;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const article = await getArticle(Number(id));
    if (!article) return NextResponse.json({ error: 'Artikel niet gevonden.' }, { status: 404 });

    const batch = await unscoredImageCandidates(article.id, BATCH);
    if (batch.length) await scoreOneBatch(article, batch);

    const remaining = (await unscoredImageCandidates(article.id, 1)).length;
    return NextResponse.json({ candidates: await listImageCandidates(article.id), remaining });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
