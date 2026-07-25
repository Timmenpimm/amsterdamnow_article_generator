import { NextRequest, NextResponse } from 'next/server';
import { EngineError, engineFetch, getEngineSettings } from '@/lib/socialsEngine';
import {
  engineConfigured, engineErrorJson, newestPerWordpressId, notConfiguredJson,
  type EngineCarousel,
} from '@/lib/carouselEngine';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const RENDER_PATH = '/api/render';

// NOW-carousels zijn pixel-exacte HTML-ontwerpen: de engine rendert ze met een
// headless browser tot PNG's. De preview in de tool laat dus het échte beeld
// zien in plaats van een DOM-benadering, en haalt dat hier op.
//
// Waarom geen engineFetch() voor de render-call zelf: die gooit bij !ok een
// EngineError met een afgekapte tekstbody, waardoor de `issues[]` van een
// 422 verloren gaan. Deze route praat daarom rechtstreeks met de engine —
// zelfde headers/Bearer-key uit socialsEngine.ts, zelfde no-store — en valt
// voor álle andere fouten terug op EngineError + engineErrorJson(), zodat de
// foutmeldingen identiek zijn aan de andere proxy's. De key gaat nooit mee in
// het antwoord.
async function renderOnEngine(
  payload: { carouselId: string; slideIndex?: number }
): Promise<{ status: number; body: any }> {
  const { baseUrl, apiKey } = await getEngineSettings();
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${RENDER_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
      cache: 'no-store',
      // Headless-browser-render mag lang duren; ruimer dan de 15s-default.
      signal: AbortSignal.timeout(55000),
    });
  } catch (err) {
    throw new EngineError(
      `Socials-engine onbereikbaar op ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
      null
    );
  }
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// Zelfde lookup als GET /api/carousel/[articleId]: nieuwste carousel per
// wordpressId. De client kent het carouselId niet altijd, dus mag het
// meesturen (snelpad) maar hoeft dat niet.
async function resolveCarouselId(articleId: number): Promise<string | null> {
  const res = await engineFetch(`/api/carousels?wordpressId=${articleId}`);
  const body = await res.json().catch(() => null);
  const carousels: EngineCarousel[] = Array.isArray(body?.carousels) ? body.carousels : [];
  return newestPerWordpressId(carousels).get(articleId)?.id || null;
}

// POST /api/carousel/[articleId]/render — body { slideIndex?, carouselId? }.
// Antwoord: { slides: [{ index, dataUrl }] } (dataUrl = PNG data-URI).
// Zonder slideIndex rendert de engine de hele carousel.
//
// Statusmapping:
//   422 → 422 { error, issues[] }  (slide mist verplichte tokens)
//   503 → 503 { error }            (headless browser niet beschikbaar)
//   engine niet gekoppeld → vaste notConfigured-respons (503, notConfigured)
//   overige engine-fouten → engineErrorJson() (401/403/onbereikbaar/502)
export async function POST(req: NextRequest, { params }: { params: Promise<{ articleId: string }> }) {
  const { articleId } = await params;
  const id = Number(articleId);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: 'Ongeldig artikel-id.' }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const hasSlideIndex = body?.slideIndex !== undefined && body?.slideIndex !== null;
  const slideIndex = Number(body?.slideIndex);
  if (hasSlideIndex && (!Number.isInteger(slideIndex) || slideIndex < 0)) {
    return NextResponse.json({ error: 'slideIndex is ongeldig.' }, { status: 400 });
  }
  if (!(await engineConfigured())) return notConfiguredJson();

  try {
    const carouselId =
      (typeof body?.carouselId === 'string' && body.carouselId) || (await resolveCarouselId(id));
    if (!carouselId) {
      return NextResponse.json(
        { error: 'Geen carousel gevonden voor dit artikel — genereer er eerst één.' },
        { status: 404 }
      );
    }

    const { status, body: eng } = await renderOnEngine({
      carouselId,
      ...(hasSlideIndex ? { slideIndex } : {}),
    });

    if (status === 422) {
      return NextResponse.json(
        {
          error: eng?.error || 'Deze slide kan nog niet gerenderd worden — vul de ontbrekende velden aan.',
          issues: Array.isArray(eng?.issues) ? eng.issues.map(String) : [],
        },
        { status: 422 }
      );
    }
    if (status === 503) {
      return NextResponse.json(
        { error: eng?.error || 'De render-service is even niet beschikbaar — probeer het zo opnieuw.' },
        { status: 503 }
      );
    }
    if (status < 200 || status >= 300) {
      throw new EngineError(
        `Socials-engine ${status} bij ${RENDER_PATH}: ${JSON.stringify(eng ?? '').slice(0, 300)}`,
        status
      );
    }

    const slides = (Array.isArray(eng?.slides) ? eng.slides : [])
      .filter((s: any) => Number.isInteger(s?.index) && typeof s?.dataUrl === 'string')
      .map((s: any) => ({ index: s.index as number, dataUrl: s.dataUrl as string }));
    if (!slides.length) {
      return NextResponse.json(
        { error: 'Onverwacht antwoord van de socials-engine — geen gerenderde slides ontvangen.' },
        { status: 502 }
      );
    }
    return NextResponse.json({ carouselId, slides });
  } catch (err) {
    return engineErrorJson(err);
  }
}
