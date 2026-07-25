import { NextRequest, NextResponse } from 'next/server';
import { engineFetch } from '@/lib/socialsEngine';
import {
  engineConfigured, engineErrorJson, notConfiguredJson, toContent, toMeta,
  type EngineCarousel,
} from '@/lib/carouselEngine';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// POST /api/carousel/[articleId]/slide — regenereert één slide via de engine
// (POST /api/generate/slide, passthrough).
export async function POST(req: NextRequest, { params }: { params: Promise<{ articleId: string }> }) {
  const { articleId } = await params;
  const id = Number(articleId);
  const body = await req.json().catch(() => null);
  const carouselId = typeof body?.carouselId === 'string' ? body.carouselId : '';
  const slideIndex = Number(body?.slideIndex);
  if (!carouselId || !Number.isInteger(slideIndex) || slideIndex < 0) {
    return NextResponse.json({ error: 'carouselId of slideIndex ontbreekt in de aanvraag.' }, { status: 400 });
  }
  if (!(await engineConfigured())) return notConfiguredJson();

  try {
    const res = await engineFetch('/api/generate/slide', {
      method: 'POST',
      body: JSON.stringify({ carouselId, slideIndex }),
      signal: AbortSignal.timeout(55000),
    });
    const eng = await res.json().catch(() => null);
    if (!eng?.slide) {
      return NextResponse.json({ error: 'Onverwacht antwoord van de socials-engine bij het regenereren van de slide.' }, { status: 502 });
    }
    const c: EngineCarousel | undefined = eng.carousel;
    return NextResponse.json({
      slide: eng.slide,
      carouselId,
      ...(c?.id ? { meta: toMeta(id, c), content: toContent(c) } : {}),
    });
  } catch (err) {
    return engineErrorJson(err);
  }
}
