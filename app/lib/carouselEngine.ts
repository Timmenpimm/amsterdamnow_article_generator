// ---------------------------------------------------------------------------
// Server-side helpers voor de /api/carousel/*-proxyroutes.
//
// Vertaalt het datamodel van de socials-engine (status DRAFT/APPROVED/
// PUBLISHING/PUBLISHED/FAILED, carousel met eigen id) naar het tool-contract
// (`CarouselMeta`/`CarouselContent` uit lib/carousel.ts). Alleen server-side
// gebruiken — de Bearer-key zit in socialsEngine.ts.
// ---------------------------------------------------------------------------

import { NextResponse } from 'next/server';
import { EngineError, getEngineSettings } from './socialsEngine';
import { isNowTemplate } from './carousel';
import type {
  AnyCarouselSlide, CarouselContent, CarouselMeta, CarouselStatus, CarouselTemplate, NowCarouselSlide,
} from './carousel';

export interface EngineCarousel {
  id: string;
  template?: string;
  slides?: unknown[];
  caption?: string;
  hashtags?: string[];
  status?: string;
  instagramId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  publishedAt?: string | null;
  article?: { id?: string; wordpressId?: number; title?: string };
}

export async function engineConfigured(): Promise<boolean> {
  const { apiKey } = await getEngineSettings();
  return Boolean(apiKey);
}

// Vaste not-configured-respons: de client herkent `notConfigured` en toont een
// banner met link naar Instellingen → Instagram.
export function notConfiguredJson(): NextResponse {
  return NextResponse.json(
    { error: 'Socials-engine niet gekoppeld — stel de API-key in via Instellingen → Instagram.', notConfigured: true },
    { status: 503 }
  );
}

// Engine-status → tool-status. FAILED tonen we als 'ready' (het concept staat
// klaar, publicatie is mislukt — retry via de editor); absent = 'none' (caller).
export function mapEngineStatus(s: string | undefined): CarouselStatus {
  switch (s) {
    case 'PUBLISHED': return 'published';
    case 'APPROVED':
    case 'PUBLISHING':
    case 'FAILED': return 'ready';
    case 'DRAFT':
    default: return 'concept';
  }
}

function stamp(c: EngineCarousel): number {
  return +new Date(c.updatedAt || c.createdAt || 0) || 0;
}

// Nieuwste carousel per wordpressId wint (op updatedAt/createdAt).
export function newestPerWordpressId(carousels: EngineCarousel[]): Map<number, EngineCarousel> {
  const map = new Map<number, EngineCarousel>();
  for (const c of carousels) {
    const wpId = c?.article?.wordpressId;
    if (typeof wpId !== 'number' || !c?.id) continue;
    const prev = map.get(wpId);
    if (!prev || stamp(c) >= stamp(prev)) map.set(wpId, c);
  }
  return map;
}

// NOW-slides herkennen we aan hun vorm (slideType + values), niet aan het
// template-id: een carousel kan onderweg van template wisselen.
function isNowShape(slide: unknown): slide is NowCarouselSlide {
  const s = slide as NowCarouselSlide | null;
  return Boolean(s && typeof s === 'object' && typeof s.slideType === 'string' && typeof s.values === 'object' && s.values !== null);
}

// "Af" voor een NOW-slide = minstens één ingevulde tekstwaarde. Een slide die
// de engine wel aanmaakte maar (nog) niet vulde telt dus niet mee.
function nowSlideDone(slide: unknown): boolean {
  if (!isNowShape(slide)) return false;
  return Object.values(slide.values).some(v => typeof v === 'string' && v.trim() !== '');
}

export function toMeta(articleId: number, c: EngineCarousel): CarouselMeta & { carouselId: string } {
  const slides = Array.isArray(c.slides) ? c.slides : [];
  const published = c.status === 'PUBLISHED';
  const template = (typeof c.template === 'string' ? c.template : null) as CarouselTemplate | null;
  return {
    carouselId: c.id,
    articleId,
    status: mapEngineStatus(c.status),
    template,
    // Satori: elke slide telt (de engine levert ze compleet aan). NOW: tellen
    // hoeveel slides al tekst hebben — een gids kan 4-10 slides lang zijn.
    slidesDone: isNowTemplate(template) ? slides.filter(nowSlideDone).length : slides.length,
    slidesTotal: slides.length,
    savedAt: c.updatedAt || c.createdAt || null,
    publishedAt: c.publishedAt || (published ? c.updatedAt || c.createdAt || null : null),
    instagramId: c.instagramId || null,
  };
}

// Slides gaan opaque door: satori-slides (headline/body/layout) én NOW-slides
// (slideType/values) blijven exact zoals de engine ze bewaart — nooit in de
// satori-vorm dwingen, de componenten splitsen zelf met isNowSlide().
export function toContent(c: EngineCarousel, localTitle?: string): CarouselContent {
  return {
    title: localTitle || c.article?.title || '',
    slides: (Array.isArray(c.slides) ? c.slides : []) as AnyCarouselSlide[],
    caption: typeof c.caption === 'string' ? c.caption : '',
    hashtags: Array.isArray(c.hashtags) ? c.hashtags.map(String) : [],
  };
}

export function emptyMeta(articleId: number): CarouselMeta {
  return {
    articleId, status: 'none', template: null,
    slidesDone: 0, slidesTotal: 0, savedAt: null, publishedAt: null, instagramId: null,
  };
}

// Engine-fout → nette Nederlandse JSON-fout (nooit de key; EngineError bevat
// die ook niet — alleen status + afgekapte body).
export function engineErrorJson(err: unknown): NextResponse {
  if (err instanceof EngineError) {
    const msg =
      err.status === 401 || err.status === 403
        ? 'Socials-engine weigert de API-key — controleer de key via Instellingen → Instagram.'
        : err.status === null
          ? 'Socials-engine niet bereikbaar — controleer de URL via Instellingen → Instagram of probeer het later opnieuw.'
          : `Socials-engine gaf een fout: ${err.message}`;
    return NextResponse.json({ error: msg }, { status: 502 });
  }
  const msg = err instanceof Error ? err.message : 'Onbekende fout bij de socials-engine.';
  return NextResponse.json({ error: msg }, { status: 500 });
}
