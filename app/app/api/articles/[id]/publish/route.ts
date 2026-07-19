import { NextRequest, NextResponse } from 'next/server';
import { getArticle, publishArticle } from '@/lib/wp';
import { getListStructure } from '@/lib/db';
import { imageCount, REQUIRED_IMAGES } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const article = await getArticle(Number(id));
    if (!article) return NextResponse.json({ error: 'artikel niet gevonden' }, { status: 404 });
    const list = await getListStructure(Number(id));
    const count = imageCount(article, list);
    if (count < REQUIRED_IMAGES) {
      return NextResponse.json(
        { error: `Publiceren geblokkeerd: ${count}/${REQUIRED_IMAGES} beelden. Voeg eerst beelden toe.` },
        { status: 409 }
      );
    }
    const updated = await publishArticle(Number(id));
    return NextResponse.json({ article: updated });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
