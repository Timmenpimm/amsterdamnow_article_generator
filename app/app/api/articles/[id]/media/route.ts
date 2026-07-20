import { NextRequest, NextResponse } from 'next/server';
import { getArticle, updateImages, uploadMediaFromBuffer, uploadMediaFromUrl } from '@/lib/wp';
import type { MediaRef } from '@/lib/types';

export const dynamic = 'force-dynamic';

// Upload één of meer beelden (multipart "files" of JSON {url}) en hang ze aan
// het artikel: ?role=featured zet (het eerste) beeld als featured, ?role=inline
// zet (het eerste) beeld als inline-beeld in de tekst, de rest gaat naar de
// slider. Zonder role: featured vullen als die leeg is, anders slider.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const role = req.nextUrl.searchParams.get('role'); // featured | slider | inline | null
  try {
    const uploaded: MediaRef[] = [];
    const contentType = req.headers.get('content-type') || '';
    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData();
      for (const entry of form.getAll('files')) {
        if (!(entry instanceof File)) continue;
        const buf = Buffer.from(await entry.arrayBuffer());
        uploaded.push(await uploadMediaFromBuffer(buf, entry.name || 'upload.jpg', entry.type || 'image/jpeg'));
      }
    } else {
      const { url } = await req.json();
      if (url) uploaded.push(await uploadMediaFromUrl(String(url)));
    }
    if (!uploaded.length) return NextResponse.json({ error: 'geen beelden ontvangen' }, { status: 400 });

    const article = await getArticle(Number(id));
    if (!article) return NextResponse.json({ error: 'artikel niet gevonden' }, { status: 404 });

    let featuredId = article.featured?.id ?? null;
    let inlineId = article.inline?.id ?? null;
    const sliderIds = article.slider.map(m => m.id);
    for (const m of uploaded) {
      if (role === 'featured' && m === uploaded[0]) {
        if (featuredId && !sliderIds.includes(featuredId)) sliderIds.push(featuredId);
        featuredId = m.id;
      } else if (role === 'inline' && m === uploaded[0]) {
        inlineId = m.id;
      } else if (role !== 'featured' && role !== 'inline' && role !== 'slider' && featuredId == null) {
        featuredId = m.id;
      } else {
        sliderIds.push(m.id);
      }
    }
    const updated = await updateImages(
      Number(id),
      { featuredId, sliderIds, inlineId },
      [...uploaded, ...(article.featured ? [article.featured] : []), ...article.slider, ...(article.inline ? [article.inline] : [])]
    );
    return NextResponse.json({ article: updated, uploaded });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
