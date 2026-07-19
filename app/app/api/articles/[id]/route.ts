import { NextRequest, NextResponse } from 'next/server';
import { getArticle, updateImages } from '@/lib/wp';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const article = await getArticle(Number(id));
  if (!article) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ article });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  try {
    const article = await updateImages(
      Number(id),
      { featuredId: body.featuredId, sliderIds: body.sliderIds, fotograaf: body.fotograaf },
      body.knownMedia || []
    );
    if (!article) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({ article });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
