import { NextRequest, NextResponse } from 'next/server';
import { engineFetch } from '@/lib/socialsEngine';
import {
  emptyMeta, engineConfigured, engineErrorJson, newestPerWordpressId, notConfiguredJson,
  toContent, toMeta, type EngineCarousel,
} from '@/lib/carouselEngine';

export const dynamic = 'force-dynamic';

// GET /api/carousel/[articleId] — nieuwste carousel voor dit artikel
// (engine-lookup op ?wordpressId=). Geen carousel → { carouselId: null }.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ articleId: string }> }) {
  const { articleId } = await params;
  const id = Number(articleId);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: 'Ongeldig artikel-id.' }, { status: 400 });
  }
  if (!(await engineConfigured())) return notConfiguredJson();

  try {
    const res = await engineFetch(`/api/carousels?wordpressId=${id}`);
    const body = await res.json().catch(() => null);
    const carousels: EngineCarousel[] = Array.isArray(body?.carousels) ? body.carousels : [];
    const c = newestPerWordpressId(carousels).get(id);
    if (!c) {
      return NextResponse.json({ carouselId: null, meta: emptyMeta(id), content: null });
    }
    return NextResponse.json({ carouselId: c.id, meta: toMeta(id, c), content: toContent(c) });
  } catch (err) {
    return engineErrorJson(err);
  }
}

// PATCH /api/carousel/[articleId] — passthrough naar engine-PATCH
// (slides/caption/hashtags/template/status). Body bevat het carouselId dat de
// client eerder via GET of genereren heeft gekregen.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ articleId: string }> }) {
  const { articleId } = await params;
  const id = Number(articleId);
  const body = await req.json().catch(() => null);
  const carouselId = typeof body?.carouselId === 'string' ? body.carouselId : '';
  if (!carouselId) {
    return NextResponse.json({ error: 'carouselId ontbreekt in de aanvraag.' }, { status: 400 });
  }
  if (!(await engineConfigured())) return notConfiguredJson();

  // Slides gaan als opaque JSON door — zowel satori-slides (layout/headline/
  // body) als NOW-slides (slideType/values). Hier bewust gén vormcontrole:
  // dat zou NOW-slides bij de eerste autosave wegvagen. Idem voor `template`:
  // 'modern-news' en 'now:<family>' zijn allebei geldig voor de engine.
  const patch: Record<string, unknown> = {};
  if (Array.isArray(body.slides)) patch.slides = body.slides;
  if (typeof body.caption === 'string') patch.caption = body.caption;
  if (Array.isArray(body.hashtags)) patch.hashtags = body.hashtags;
  if (typeof body.template === 'string') patch.template = body.template;
  if (typeof body.status === 'string') patch.status = body.status;
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Niets om bij te werken.' }, { status: 400 });
  }

  try {
    const res = await engineFetch(`/api/carousels/${encodeURIComponent(carouselId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    const eng = await res.json().catch(() => null);
    const c: EngineCarousel = eng?.carousel || eng || { id: carouselId };
    return NextResponse.json({ carouselId, meta: toMeta(id, c), content: toContent(c) });
  } catch (err) {
    return engineErrorJson(err);
  }
}

// DELETE /api/carousel/[articleId] — verwijdert de carousel bij de engine.
// De engine weigert dit zelf als de carousel PUBLISHING/PUBLISHED is (409).
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ articleId: string }> }) {
  await params; // articleId zit in het pad voor consistentie; engine werkt op carouselId
  const body = await req.json().catch(() => null);
  const carouselId = typeof body?.carouselId === 'string' ? body.carouselId : '';
  if (!carouselId) {
    return NextResponse.json({ error: 'carouselId ontbreekt in de aanvraag.' }, { status: 400 });
  }
  if (!(await engineConfigured())) return notConfiguredJson();

  try {
    await engineFetch(`/api/carousels/${encodeURIComponent(carouselId)}`, { method: 'DELETE' });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return engineErrorJson(err);
  }
}
