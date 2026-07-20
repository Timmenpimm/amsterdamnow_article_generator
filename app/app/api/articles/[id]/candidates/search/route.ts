import { NextRequest, NextResponse } from 'next/server';
import { getArticle } from '@/lib/wp';
import { searchImageCandidates } from '@/lib/imageSearch';
import { addImageCandidates, listImageCandidates } from '@/lib/db';

export const dynamic = 'force-dynamic';

// Zoekt rechtenvrije kandidaat-beelden (≥1000×1000) bij het artikel en slaat
// ze op als status 'new'. Geen Claude-call — scoren gebeurt via /score.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const article = await getArticle(Number(id));
    if (!article) return NextResponse.json({ error: 'Artikel niet gevonden.' }, { status: 404 });

    const { drafts, queries, errors } = await searchImageCandidates(article);
    const added = await addImageCandidates(article.id, drafts);
    const candidates = await listImageCandidates(article.id);
    return NextResponse.json({ candidates, added, found: drafts.length, queries, errors });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
