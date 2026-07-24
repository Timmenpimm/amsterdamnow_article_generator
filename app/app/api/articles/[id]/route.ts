import { NextRequest, NextResponse } from 'next/server';
import { deleteArticle, getArticle, updateArticleFields, updateArticleTags, updateImages } from '@/lib/wp';
import { deleteListStructure, getListStructure } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const article = await getArticle(Number(id));
  if (!article) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const list = await getListStructure(Number(id));
  return NextResponse.json({ article, list });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  try {
    let article = await updateImages(
      Number(id),
      { featuredId: body.featuredId, sliderIds: body.sliderIds, inlineId: body.inlineId, fotograaf: body.fotograaf },
      body.knownMedia || []
    );
    if (!article) return NextResponse.json({ error: 'not found' }, { status: 404 });
    if (Array.isArray(body.tags)) {
      article = await updateArticleTags(Number(id), body.tags);
    }
    // Redactioneel corrigeerbare ACF-velden. Alleen meesturen wat de client ook
    // echt aanlevert (undefined = ongewijzigd), zodat een tags-only PATCH deze
    // velden niet leegmaakt.
    if (body.naamLocatie !== undefined || body.adres !== undefined || body.website !== undefined) {
      article = await updateArticleFields(Number(id), {
        naamLocatie: body.naamLocatie,
        adres: body.adres,
        website: body.website,
      });
    }
    const list = await getListStructure(Number(id));
    return NextResponse.json({ article, list });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const article = await getArticle(Number(id));
    if (!article) return NextResponse.json({ error: 'niet gevonden' }, { status: 404 });
    if (article.status === 'publish') {
      return NextResponse.json({ error: 'gepubliceerde artikelen kun je hier niet verwijderen' }, { status: 409 });
    }
    await deleteArticle(Number(id));
    await deleteListStructure(Number(id));
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
