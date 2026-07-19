import { NextRequest, NextResponse } from 'next/server';
import { getArticle, updateArticleContent, uploadMediaFromBuffer, uploadMediaFromUrl } from '@/lib/wp';
import { getListStructure, saveListStructure } from '@/lib/db';
import { assembleListHtml } from '@/lib/listHtml';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Itemfoto van een lijstartikel zetten of weghalen. De content-HTML wordt
// daarna opnieuw geassembleerd zodat de foto op de juiste plek staat.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const itemIndex = Number(req.nextUrl.searchParams.get('item'));
  try {
    const structure = await getListStructure(Number(id));
    if (!structure) return NextResponse.json({ error: 'Geen lijstartikel-structuur voor deze post' }, { status: 404 });
    if (!(itemIndex >= 0 && itemIndex < structure.items.length)) {
      return NextResponse.json({ error: 'Ongeldig item' }, { status: 400 });
    }
    const contentType = req.headers.get('content-type') || '';
    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData();
      const file = form.get('files');
      if (!(file instanceof File)) return NextResponse.json({ error: 'geen bestand ontvangen' }, { status: 400 });
      const buf = Buffer.from(await file.arrayBuffer());
      structure.items[itemIndex].media = await uploadMediaFromBuffer(buf, file.name || 'item.jpg', file.type || 'image/jpeg');
    } else {
      const body = await req.json();
      if (body.remove) structure.items[itemIndex].media = null;
      else if (body.url) structure.items[itemIndex].media = await uploadMediaFromUrl(String(body.url));
      else return NextResponse.json({ error: 'geen beeld ontvangen' }, { status: 400 });
    }
    await updateArticleContent(Number(id), assembleListHtml(structure));
    await saveListStructure(Number(id), null, structure);
    const article = await getArticle(Number(id));
    return NextResponse.json({ article, list: structure });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
