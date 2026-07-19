export type TopicStatus = 'queued' | 'writing' | 'review' | 'failed' | 'done';
export type TopicType = 'standaard' | 'lijst';

// Fasen van de lijstpipeline. Eén fase-stap per process-aanroep, zodat elke
// stap binnen de serverless-limiet blijft.
export type ListPhase = 'select' | 'verify' | 'review' | 'compose' | 'finalize';

export interface ListItemState {
  naam: string;
  status: 'pending' | 'verified' | 'rejected' | 'excluded';
  reden?: string;            // waarom afgevallen (rejected) of uitgesloten door redacteur (excluded)
  adres?: string;            // "Straatnaam nr"
  buurt?: string;            // buurtnaam, geen stadsdeel
  extra_info?: string;       // openingstijden/prijs/datum, cursief achter het adres
  bron?: string;             // primaire bron-URL waarmee het adres bevestigd is
  feiten?: string;           // concrete research voor de schrijffase
  quote?: { tekst: string; bron: string; herkomst?: string } | null;
}

export interface ComposedList {
  title: string;
  subregel: string;
  introcontent: string;
  inleiding: string;
  items: { naam: string; beschrijving: string; plaats_quote: boolean }[];
  afsluiting: string;
  categories: string[];
  district: string;
  tags: string[];
  rubriek: string;
}

export interface ListState {
  items: ListItemState[];
  aangeleverd: boolean;      // items door de redacteur meegegeven (selectiefase overgeslagen)
  weekendgids: boolean;
  verified: number;
  rejected: number;
  meldingen: string[];       // bv. "quote-norm niet gehaald"
  artikel?: ComposedList;    // resultaat van de compose-fase
}

export interface Topic {
  id: number;
  title: string;
  status: TopicStatus;
  type: TopicType;
  phase: ListPhase | null;
  list_state: string | null; // JSON van ListState (alleen bij type 'lijst')
  sort: number;
  created_at: string;
  started_at: string | null;
  error: string | null;
  error_step: string | null;
  attempts: number;
  post_id: number | null;
}

export function parseListState(topic: Topic): ListState | null {
  if (topic.type !== 'lijst' || !topic.list_state) return null;
  try { return JSON.parse(topic.list_state) as ListState; } catch { return null; }
}

export interface MediaRef {
  id: number;
  url: string;
}

export type ArticleStatus = 'draft' | 'publish';

export interface Article {
  id: number;
  title: string;
  subregel: string;
  intro: string;
  contentHtml: string;
  status: ArticleStatus;
  link: string;
  modified: string;
  date: string;
  category: string;
  district: string;
  rubriek: string;
  featured: MediaRef | null;
  slider: MediaRef[];
  fotograaf: string;
  naam_locatie: string;
  adres: string;
  stad: string;
  website: string;
  cordA: string;
  cordB: string;
  tags: string[];
  focusKeyword: string;
  slug: string;
  seoTitle: string;
  metaDescription: string;
  flags: {
    new_in_town: boolean;
    featured_item: boolean;
    beste_van_amsterdam: boolean;
    homepage_carousel: boolean;
  };
}

export const REQUIRED_IMAGES = 3;

// Bij lijstartikelen tellen itemfoto's mee in de beeldenteller.
export function imageCount(a: Pick<Article, 'featured' | 'slider'>, list?: ListArticleStructure | null): number {
  const itemImages = list ? list.items.filter(i => i.media).length : 0;
  return (a.featured ? 1 : 0) + a.slider.length + itemImages;
}

export type ArticlePhase = 'needImages' | 'ready' | 'published';

export function articlePhase(a: Article, list?: ListArticleStructure | null): ArticlePhase {
  if (a.status === 'publish') return 'published';
  return imageCount(a, list) >= REQUIRED_IMAGES ? 'ready' : 'needImages';
}

export type PromptKind =
  | 'research' | 'schrijf' | 'seo'
  | 'lijst-selectie' | 'lijst-research' | 'lijst-schrijf' | 'lijst-seo';

export const PROMPT_KINDS: PromptKind[] = [
  'research', 'schrijf', 'seo',
  'lijst-selectie', 'lijst-research', 'lijst-schrijf', 'lijst-seo',
];

export interface PromptVersion {
  id: number;
  kind: PromptKind;
  version: number;
  content: string;
  note: string;
  author: string;
  created_at: string;
  active: 0 | 1;
}

// Structuur van een geschreven lijstartikel, bewaard in de tool-database zodat
// het beeldwerk-scherm per item een foto-slot kan tonen en de content opnieuw
// kan assembleren met de foto's op de juiste plek.
export interface ListArticleItem {
  naam: string;
  beschrijving: string;      // 3-5 zinnen, lopende tekst
  adres: string;             // "Straatnaam nr"
  buurt: string;
  extra_info?: string;
  interne_link?: string;     // bestaand AmsterdamNOW-artikel over deze zaak
  quote?: { tekst: string; bron: string } | null; // blockquote ná dit item
  media?: MediaRef | null;   // itemfoto, gezet via het beeldwerk-scherm
}

export interface ListArticleStructure {
  postId: number;
  introcontent: string;      // 2-3 zinnen boven de lijst
  inleiding: string;         // alinea met selectiecriteria
  items: ListArticleItem[];
  afsluiting: string;
  meldingen: string[];
}

export interface BoardData {
  mode: 'live' | 'demo';
  storage?: 'postgres' | 'sqlite';
  persistent?: boolean;
  topics: Topic[];
  articles: Article[];
  // Compacte tellingen per lijstartikel (postId → items/withMedia), zodat het
  // bord itemfoto's kan meetellen zonder de volledige structuur te laden.
  lists?: Record<number, { items: number; withMedia: number }>;
}

export type ConstraintKind = 'standaard' | 'lijst';

export const CONSTRAINT_KINDS: ConstraintKind[] = ['standaard', 'lijst'];

export interface WordRange {
  min: number;
  max: number;
}

export interface StandaardConstraints {
  titleWords: WordRange;
  subregelWords: WordRange;
  introWords: WordRange;
  contentWords: WordRange;
  quoteWords: WordRange;
  minParagraphs: number;
  titleMustContainTopic: boolean;
  quoteMustBeVerbatimInContent: boolean;
  noDashInText: boolean;
  noAmsterdamRepeatInTitleSubregelIntro: boolean;
}

export interface ListConstraints {
  titleMaxChars: number;
  introSentences: WordRange;
  minItems: number;
  itemSentences: WordRange;
  quoteNormPerItems: number;
  minNamedItemsInClosing: number;
  forbiddenWords: string[];
  quoteSourceBlacklist: string[];
  titleNoCount: boolean;
  subregelNoVanTotFormula: boolean;
  subregelNoAmsterdamRepeat: boolean;
  noDashInText: boolean;
  noBulletsInItem: boolean;
  addressNotInDescription: boolean;
  itemRequiresAddress: boolean;
  itemRequiresBuurt: boolean;
  noConsecutiveQuotes: boolean;
}

export interface ConstraintVersion {
  id: number;
  kind: ConstraintKind;
  version: number;
  content: string; // JSON van StandaardConstraints of ListConstraints
  note: string;
  author: string;
  created_at: string;
  active: 0 | 1;
}

export const DEFAULT_STANDAARD_CONSTRAINTS: StandaardConstraints = {
  titleWords: { min: 8, max: 12 },
  subregelWords: { min: 10, max: 15 },
  introWords: { min: 40, max: 60 },
  contentWords: { min: 400, max: 450 },
  quoteWords: { min: 15, max: 25 },
  minParagraphs: 5,
  titleMustContainTopic: true,
  quoteMustBeVerbatimInContent: true,
  noDashInText: true,
  noAmsterdamRepeatInTitleSubregelIntro: true,
};

export const DEFAULT_LIST_CONSTRAINTS: ListConstraints = {
  titleMaxChars: 75,
  introSentences: { min: 2, max: 3 },
  minItems: 3,
  itemSentences: { min: 3, max: 5 },
  quoteNormPerItems: 3,
  minNamedItemsInClosing: 2,
  forbiddenWords: [
    'hotspot', 'pareltje', 'bruisend', 'iconisch',
    'elektronische muziek',
    'opent zijn deuren', 'verwelkomt gasten', 'biedt een unieke ervaring',
    'mis het niet', 'een aanrader voor iedereen',
  ],
  quoteSourceBlacklist: [
    'ylbb', 'your little black book', 'yourlittleblackbook',
    'bartsboekje', 'barts boekje',
    'iamsterdam',
    'time out', 'timeout',
    'cityguys', 'dagjeweg', 'awesome amsterdam', 'amsterdamlokaal', 'kidsproof', 'roadbook',
  ],
  titleNoCount: true,
  subregelNoVanTotFormula: true,
  subregelNoAmsterdamRepeat: true,
  noDashInText: true,
  noBulletsInItem: true,
  addressNotInDescription: true,
  itemRequiresAddress: true,
  itemRequiresBuurt: true,
  noConsecutiveQuotes: true,
};
