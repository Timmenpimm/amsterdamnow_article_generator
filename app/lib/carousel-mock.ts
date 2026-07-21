// ============================================================================
// MOCK-LAAG — Instagram Carousel-pagina (feat/carousel-page)
// ----------------------------------------------------------------------------
// De echte engine (AI-analyse → carousel-JSON → gebrandede PNG's via Satori →
// Instagram Graph API-publicatie) bestaat nog niet en wordt apart gebouwd in
// `amsterdamnow_socials` (zie briefing §5, aanbeveling: optie A — aparte
// service, API-koppeling). Deze module simuleert die integratie met exact
// hetzelfde datacontract (`CarouselContent`) zodat de UI hier al gebouwd en
// getest kan worden. Bij de echte koppeling wordt alleen déze file vervangen
// door `fetch()`-calls naar de socials-service — de componenten die deze
// functies aanroepen veranderen niet.
//
// Bewaring: in-memory (module-level Map), dus reset bij een volledige
// page-reload. Dat is bewust — er is nog geen tabel in `db.ts` voor
// carousel-status (zie briefing §6, "lichte cache/statusveld"); die komt er
// pas bij de echte koppeling.
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
  imageUrl?: string; // mock: hergebruikt bestaande artikelbeelden i.p.v. Satori-render
}

export interface CarouselContent {
  title: string;
  slides: CarouselSlide[];
  caption: string;
  hashtags: string[];
}

// 'none'      → nog geen carousel gemaakt
// 'concept'   → gegenereerd, nog niet klaargezet
// 'ready'     → klaargezet, wacht op handmatige plaatsing
// 'published' → op Instagram geplaatst
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

interface StoreEntry {
  meta: CarouselMeta;
  content: CarouselContent | null;
}

const store = new Map<number, StoreEntry>();

function emptyMeta(articleId: number): CarouselMeta {
  return {
    articleId, status: 'none', template: null,
    slidesDone: 0, slidesTotal: 0, savedAt: null, publishedAt: null, instagramId: null,
  };
}

export function getCarouselMeta(articleId: number): CarouselMeta {
  return store.get(articleId)?.meta ?? emptyMeta(articleId);
}

export function getCarouselContent(articleId: number): CarouselContent | null {
  return store.get(articleId)?.content ?? null;
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function sentences(text: string): string[] {
  return stripHtml(text).split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
}

// Bouwt vijf slides + onderschrift + hashtags uit het artikel zelf, zodat de
// mock-inhoud herkenbaar aan het brondocument blijft in plaats van generieke
// lorem-ipsum-tekst. Vaste layout-volgorde (hero/info/image/quote/cta) —
// analoog aan de vier checklist-items in het laadscherm (4c) van het design.
function craftContent(article: Article, template: CarouselTemplate): CarouselContent {
  const s = sentences(article.contentHtml);
  const hero = article.featured?.url || article.slider[0]?.url;
  const secondary = article.slider[0]?.url || article.featured?.url;

  const slides: CarouselSlide[] = [
    {
      index: 0, layout: 'hero',
      headline: article.title,
      body: article.subregel || article.intro || '',
      imagePrompt: `Hero-beeld — ${article.title}`,
      imageUrl: hero,
    },
    {
      index: 1, layout: 'info',
      headline: 'Het aanbod',
      body: s[0] || article.intro || '',
      imagePrompt: 'Info-kaart met kernpunt',
    },
    {
      index: 2, layout: 'image',
      headline: (s[1] || article.naam_locatie || article.title).slice(0, 65),
      body: s[1] || '',
      imagePrompt: 'Sfeerbeeld uit het artikel',
      imageUrl: secondary,
    },
    {
      index: 3, layout: 'quote',
      headline: s[2] ? `“${s[2]}”` : `“${article.title}”`,
      body: [article.naam_locatie, article.adres].filter(Boolean).join(', '),
      imagePrompt: 'Quote-kaart, donkere achtergrond',
    },
    {
      index: 4, layout: 'cta',
      headline: 'Lees het hele verhaal',
      body: 'Swipe voor alle info · link in bio',
      imagePrompt: 'CTA-kaart',
      imageUrl: hero,
    },
  ];

  const captionIntro = article.intro || article.subregel || s[0] || article.title;
  const caption = `${captionIntro} Swipe voor alle info. Volledige artikel via de link in bio.`;

  const hashtags = Array.from(new Set([
    'amsterdam',
    ...(article.district ? [article.district.toLowerCase().replace(/[^a-z0-9]/g, '')] : []),
    ...(article.category ? [article.category.toLowerCase().replace(/[^a-z0-9]/g, '')] : []),
    ...article.tags.slice(0, 3).map(t => t.toLowerCase().replace(/[^a-z0-9]/g, '')),
    'uittips',
    'amsterdamnow',
  ].filter(Boolean)));

  return { title: article.title, slides, caption, hashtags };
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

const STEP_LABELS = ['Artikel-context geladen', 'Slides schrijven', 'Beelden renderen (Satori)', 'Voorbeeld klaarzetten'];

function stepsAt(activeIndex: number, sub?: string): GenerateStep[] {
  return STEP_LABELS.map((label, i) => ({
    label,
    state: i < activeIndex ? 'done' : i === activeIndex ? 'active' : 'pending',
    detail: i === activeIndex ? sub : undefined,
  }));
}

// ~1 op 8 pogingen faalt met een gesimuleerde 60s-time-out — zodat de
// foutstaat (4d) en de retry-flow ook echt te zien/testen zijn, net als in
// productie waar de socials-service weleens een gateway-time-out geeft.
const GENERATE_FAILURE_RATE = 0.12;
const PUBLISH_FAILURE_RATE = 0.12;

export async function generateCarousel(
  article: Article,
  template: CarouselTemplate,
  onProgress: (p: GenerateProgress) => void
): Promise<CarouselContent> {
  onProgress({ headline: 'Claude analyseert het artikel…', detail: 'Artikel-context laden', steps: stepsAt(0), pct: 4 });
  await delay(450);

  onProgress({ headline: 'Claude analyseert het artikel…', detail: 'Kernpunten kiezen en slides schrijven', steps: stepsAt(1, '0 / 5'), pct: 12 });
  for (let i = 1; i <= 5; i++) {
    await delay(260);
    onProgress({
      headline: 'Claude analyseert het artikel…',
      detail: `Kernpunten kiezen en slides schrijven — template ${template}`,
      steps: stepsAt(1, `${i} / 5`),
      pct: 12 + i * 12,
    });
  }

  onProgress({ headline: 'Beelden renderen…', detail: 'Socials-service rendert de PNG-slides', steps: stepsAt(2), pct: 82 });
  await delay(500);

  if (Math.random() < GENERATE_FAILURE_RATE) {
    throw new Error('Claude kon het artikel nu niet analyseren — time-out na 60 seconden.');
  }

  onProgress({ headline: 'Voorbeeld klaarzetten…', detail: '', steps: stepsAt(3), pct: 95 });
  await delay(350);

  const content = craftContent(article, template);
  store.set(article.id, {
    content,
    meta: {
      articleId: article.id, status: 'concept', template,
      slidesDone: content.slides.length, slidesTotal: content.slides.length,
      savedAt: new Date().toISOString(), publishedAt: null, instagramId: null,
    },
  });
  return content;
}

// Regenereert alléén de aangewezen slide — de rest van de set blijft ongemoeid
// (analoog aan hoe `CandidateCard` in ArticleDetail.tsx per kandidaat een actie
// aanbiedt zonder de hele set opnieuw te laden).
export async function regenerateSlide(article: Article, template: CarouselTemplate, slideIndex: number): Promise<CarouselSlide> {
  await delay(700);
  const fresh = craftContent(article, template);
  const slide = fresh.slides[slideIndex] || fresh.slides[0];
  const entry = store.get(article.id);
  if (entry?.content) {
    entry.content.slides = entry.content.slides.map((s, i) => (i === slideIndex ? { ...slide, index: i } : s));
    entry.meta.savedAt = new Date().toISOString();
  }
  return { ...slide, index: slideIndex };
}

// Handmatige bewerkingen (kop/kicker/beeld/onderschrift/hashtags) — synchrone
// autosave in de mock-store, zodat "concept · laatst bewaard HH:MM" klopt.
export function saveCarouselContent(articleId: number, content: CarouselContent): void {
  const entry = store.get(articleId);
  if (!entry) return;
  entry.content = content;
  entry.meta.savedAt = new Date().toISOString();
}

export function markReady(articleId: number): void {
  const entry = store.get(articleId);
  if (!entry) return;
  entry.meta.status = 'ready';
  entry.meta.savedAt = new Date().toISOString();
}

export async function publishCarousel(articleId: number): Promise<void> {
  await delay(900);
  if (Math.random() < PUBLISH_FAILURE_RATE) {
    throw new Error('Instagram Graph API-token verlopen — vraag de beheerder een nieuw token aan. Het concept is bewaard.');
  }
  const entry = store.get(articleId);
  if (!entry) return;
  entry.meta.status = 'published';
  entry.meta.publishedAt = new Date().toISOString();
  entry.meta.instagramId = `mock_ig_${articleId}_${Date.now()}`;
}
