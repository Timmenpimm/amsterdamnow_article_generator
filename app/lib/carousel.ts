// ============================================================================
// CAROUSEL-CLIENT — Instagram Carousel-pagina
// ----------------------------------------------------------------------------
// Vervangt de oude mock-laag (`carousel-mock.ts`). Praat via de server-side
// proxy-routes onder `/api/carousel/*` met de echte socials-engine
// (amsterdamnow_socials); de Bearer-key blijft daarmee server-side. De types
// (`CarouselContent`/`CarouselMeta`/…) zijn ongewijzigd overgenomen uit de
// mock, zodat de componenten alleen hun import-pad hoefden aan te passen.
//
// carouselId-bewaring: module-level Map per artikel-id, gevuld door
// getCarouselContent()/generateCarousel()/getCarouselMetas(). save/regenerate/
// markReady/publish zoeken de id daar op — zelfde functiesignaturen als de
// mock. Autosave is 800 ms gedebounced en fire-and-forget; flushCarouselSave()
// dwingt een openstaande save af (vóór klaarzetten/publiceren/unmount).
// ============================================================================

import type { Article } from './types';

export type CarouselTemplate = 'modern-news' | 'minimal-business' | 'magazine';

export const CAROUSEL_TEMPLATES: { key: CarouselTemplate; label: string }[] = [
  { key: 'modern-news', label: 'modern-news' },
  { key: 'minimal-business', label: 'minimal-business' },
  { key: 'magazine', label: 'magazine' },
];

export type SlideLayout = 'hero' | 'info' | 'image' | 'quote' | 'cta';

export interface CarouselSlide {
  index: number;
  layout: SlideLayout;
  headline: string;
  body: string;
  imagePrompt: string;
  imageUrl?: string;
}

export interface CarouselContent {
  title: string;
  slides: CarouselSlide[];
  caption: string;
  hashtags: string[];
}

// 'none'      → nog geen carousel gemaakt
// 'concept'   → gegenereerd, nog niet klaargezet (engine: DRAFT)
// 'ready'     → klaargezet, wacht op plaatsing (engine: APPROVED/PUBLISHING/FAILED)
// 'published' → op Instagram geplaatst (engine: PUBLISHED)
export type CarouselStatus = 'none' | 'concept' | 'ready' | 'published';

export interface CarouselMeta {
  articleId: number;
  status: CarouselStatus;
  template: CarouselTemplate | null;
  slidesDone: number;
  slidesTotal: number;
  savedAt: string | null;
  publishedAt: string | null;
  instagramId: string | null;
}

export interface GenerateStep {
  label: string;
  state: 'done' | 'active' | 'pending';
  detail?: string;
}

export interface GenerateProgress {
  headline: string;
  detail: string;
  steps: GenerateStep[];
  pct: number;
}

export const STEP_LABELS = ['Artikel-context geladen', 'Slides schrijven', 'Beelden renderen', 'Voorbeeld klaarzetten'];

function stepsAt(activeIndex: number, sub?: string): GenerateStep[] {
  return STEP_LABELS.map((label, i) => ({
    label,
    state: i < activeIndex ? 'done' : i === activeIndex ? 'active' : 'pending',
    detail: i === activeIndex ? sub : undefined,
  }));
}

// ---------------------------------------------------------------------------
// Fouten
// ---------------------------------------------------------------------------

// Aparte foutklasse zodat de UI "engine niet gekoppeld" kan onderscheiden en
// een nette banner met link naar /instellingen kan tonen.
export class EngineNotConfiguredError extends Error {
  notConfigured = true as const;
  constructor(message?: string) {
    super(message || 'Socials-engine niet gekoppeld — ga naar Instellingen → Instagram om de koppeling in te stellen.');
  }
}

async function readBody(res: Response): Promise<any> {
  return res.json().catch(() => null);
}

function toError(body: any, res: Response): Error {
  if (body?.notConfigured) return new EngineNotConfiguredError(body.error);
  return new Error(body?.error || `Er ging iets mis bij de socials-engine (HTTP ${res.status}).`);
}

// ---------------------------------------------------------------------------
// carouselId-bewaring (module state)
// ---------------------------------------------------------------------------

const carouselIds = new Map<number, string>();

function requireCarouselId(articleId: number): string {
  const id = carouselIds.get(articleId);
  if (!id) throw new Error('Geen carousel gevonden voor dit artikel — genereer er eerst één.');
  return id;
}

export function emptyCarouselMeta(articleId: number): CarouselMeta {
  return {
    articleId, status: 'none', template: null,
    slidesDone: 0, slidesTotal: 0, savedAt: null, publishedAt: null, instagramId: null,
  };
}

// ---------------------------------------------------------------------------
// Lezen
// ---------------------------------------------------------------------------

// Batch: één call voor het hele overzicht. Ontbrekende artikelen krijgen een
// lege meta (status 'none').
export async function getCarouselMetas(ids: number[]): Promise<Record<number, CarouselMeta>> {
  if (ids.length === 0) return {};
  const res = await fetch(`/api/carousel/status?ids=${ids.join(',')}`, { cache: 'no-store' });
  const body = await readBody(res);
  if (!res.ok) throw toError(body, res);
  const out: Record<number, CarouselMeta> = {};
  for (const id of ids) {
    const m = body?.metas?.[id];
    if (m) {
      const { carouselId, ...meta } = m;
      out[id] = meta as CarouselMeta;
      if (typeof carouselId === 'string' && carouselId) carouselIds.set(id, carouselId);
    } else {
      out[id] = emptyCarouselMeta(id);
    }
  }
  return out;
}

export async function getCarouselMeta(articleId: number): Promise<CarouselMeta> {
  const metas = await getCarouselMetas([articleId]);
  return metas[articleId] || emptyCarouselMeta(articleId);
}

export async function getCarouselContent(
  articleId: number
): Promise<{ carouselId: string | null; meta: CarouselMeta; content: CarouselContent | null }> {
  const res = await fetch(`/api/carousel/${articleId}`, { cache: 'no-store' });
  const body = await readBody(res);
  if (!res.ok) throw toError(body, res);
  const carouselId: string | null = typeof body?.carouselId === 'string' ? body.carouselId : null;
  if (carouselId) carouselIds.set(articleId, carouselId);
  return {
    carouselId,
    meta: (body?.meta as CarouselMeta) || emptyCarouselMeta(articleId),
    content: (body?.content as CarouselContent) || null,
  };
}

// ---------------------------------------------------------------------------
// Genereren
// ---------------------------------------------------------------------------

// Eén server-call; de voortgangsstappen uit het design (4c) lopen ondertussen
// op een timer mee zodat LoadingPanel blijft werken. De laatste stap wordt pas
// afgevinkt zodra de engine echt antwoordt.
export async function generateCarousel(
  article: Article,
  template: CarouselTemplate,
  onProgress: (p: GenerateProgress) => void
): Promise<CarouselContent> {
  const timers: ReturnType<typeof setTimeout>[] = [];
  const stage = (i: number, pct: number, headline: string, detail = '', sub?: string) =>
    onProgress({ headline, detail, steps: stepsAt(i, sub), pct });

  stage(0, 6, 'Claude analyseert het artikel…', 'Artikel-context laden');
  timers.push(setTimeout(() => stage(1, 25, 'Claude analyseert het artikel…', `Kernpunten kiezen en slides schrijven — template ${template}`), 1200));
  timers.push(setTimeout(() => stage(1, 55, 'Claude analyseert het artikel…', `Kernpunten kiezen en slides schrijven — template ${template}`, 'bezig'), 5000));
  timers.push(setTimeout(() => stage(2, 80, 'Beelden renderen…', 'Socials-engine rendert de slides'), 10000));

  try {
    const res = await fetch(`/api/carousel/${article.id}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template }),
    });
    const body = await readBody(res);
    if (!res.ok) throw toError(body, res);
    timers.forEach(clearTimeout);
    stage(3, 95, 'Voorbeeld klaarzetten…');
    if (typeof body?.carouselId === 'string' && body.carouselId) carouselIds.set(article.id, body.carouselId);
    if (!body?.content) throw new Error('Onverwacht antwoord van de socials-engine — geen carousel-inhoud ontvangen.');
    return body.content as CarouselContent;
  } finally {
    timers.forEach(clearTimeout);
  }
}

export async function regenerateSlide(
  article: Article,
  _template: CarouselTemplate,
  slideIndex: number
): Promise<CarouselSlide> {
  const carouselId = requireCarouselId(article.id);
  await flushCarouselSave();
  const res = await fetch(`/api/carousel/${article.id}/slide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ carouselId, slideIndex }),
  });
  const body = await readBody(res);
  if (!res.ok) throw toError(body, res);
  if (!body?.slide) throw new Error('Onverwacht antwoord van de socials-engine — geen slide ontvangen.');
  return { ...(body.slide as CarouselSlide), index: slideIndex };
}

// ---------------------------------------------------------------------------
// Bewaren (autosave, 800 ms debounce, fire-and-forget)
// ---------------------------------------------------------------------------

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSave: { articleId: number; content: CarouselContent } | null = null;

async function performSave(): Promise<void> {
  if (!pendingSave) return;
  const { articleId, content } = pendingSave;
  pendingSave = null;
  const carouselId = carouselIds.get(articleId);
  if (!carouselId) return; // niets om naar te schrijven (nog geen carousel)
  try {
    await fetch(`/api/carousel/${articleId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ carouselId, slides: content.slides, caption: content.caption, hashtags: content.hashtags }),
    });
  } catch {
    // fire-and-forget: een gemiste autosave wordt bij de volgende toetsaanslag
    // of bij flushCarouselSave() opnieuw geprobeerd met de verse inhoud.
  }
}

export function saveCarouselContent(articleId: number, content: CarouselContent): void {
  pendingSave = { articleId, content };
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; void performSave(); }, 800);
}

// Dwingt een openstaande (gedebouncede) save af — aanroepen vóór klaarzetten,
// publiceren en bij unmount.
export async function flushCarouselSave(): Promise<void> {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  await performSave();
}

// ---------------------------------------------------------------------------
// Statusovergangen
// ---------------------------------------------------------------------------

export async function markReady(articleId: number): Promise<void> {
  const carouselId = requireCarouselId(articleId);
  await flushCarouselSave();
  const res = await fetch(`/api/carousel/${articleId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ carouselId, status: 'APPROVED' }),
  });
  if (!res.ok) throw toError(await readBody(res), res);
}

export async function publishCarousel(articleId: number): Promise<void> {
  const carouselId = requireCarouselId(articleId);
  await flushCarouselSave();
  const res = await fetch(`/api/carousel/${articleId}/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ carouselId }),
  });
  const body = await readBody(res);
  if (!res.ok) {
    throw body?.notConfigured
      ? new EngineNotConfiguredError(body.error)
      : new Error(body?.error || 'Publiceren op Instagram is mislukt — probeer het later opnieuw. Het concept is bewaard.');
  }
}
