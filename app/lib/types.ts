import { COMPETITOR_ALIASSEN } from './competitors';

export type TopicStatus = 'queued' | 'writing' | 'review' | 'failed' | 'done';
export type TopicType = 'standaard' | 'lijst';

// Fasen van de lijstpipeline. Eén fase-stap per process-aanroep, zodat elke
// stap binnen de serverless-limiet blijft.
export type ListPhase = 'select' | 'verify' | 'review' | 'compose' | 'finalize';

// Fasen van de standaardpipeline (één los artikel). Zelfde reden als
// hierboven: research, schrijven en SEO+draft waren ooit één aaneengesloten
// aanroep met 3-4 Claude-calls, wat regelmatig over de 60s-serverless-limiet
// heen liep (FUNCTION_INVOCATION_TIMEOUT). Nu één fase per process-aanroep.
// 'schrijf-retry' is losgetrokken van 'schrijf': de validatie-herkansing was
// zelf ook een 2e Claude-call binnen dezelfde aanroep en kon daardoor alsnog
// over de 60s heen lopen (gezien op productie na de eerste fase-opsplitsing).
// 'research-aanvullend' is de weg terug naar Tavily: leverde de eerste ronde te
// weinig harde feiten op, dan haalt deze fase gericht bronnen bij op de dingen
// die ontbraken. Ook dat is een eigen fase-stap, om dezelfde reden: extra
// Tavily-calls plus een tweede extractie passen niet meer in de research-tik.
export type StandaardPhase = 'research' | 'research-aanvullend' | 'schrijf' | 'schrijf-retry' | 'seo';

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
  composeChunks?: ComposedList[]; // tussentijdse compose-blokken (elke tik schrijft er één, i.v.m. de 60s function-timeout)
  composeFeedback?: string;  // afkeurreden van de vorige compose-poging; gaat als extra instructie mee in de herkansing
  composeAttempts?: number;  // aantal volledig afgekeurde compose-pogingen (feedback-loop stopt na een maximum)
}

export interface Topic {
  id: number;
  title: string;
  status: TopicStatus;
  type: TopicType;
  phase: ListPhase | StandaardPhase | null;
  list_state: string | null; // JSON van ListState (lijst) of StandaardState (standaard)
  sort: number;
  created_at: string;
  started_at: string | null;
  error: string | null;
  error_step: string | null;
  attempts: number;
  post_id: number | null;
  locked_at?: string | null;
  lock_owner?: string | null;
  dedup_override: number; // 1 = force-toegevoegd; slaat de herkans-check vóór createDraft over
}

export function parseListState(topic: Topic): ListState | null {
  if (topic.type !== 'lijst' || !topic.list_state) return null;
  try { return JSON.parse(topic.list_state) as ListState; } catch { return null; }
}

// Tussentijdse staat van de standaardpipeline, bewaard tussen fase-stappen.
export interface StandaardState {
  research?: Record<string, unknown>; // ruwe research-JSON van Claude
  article?: { title: string; subregel: string; introductie_tekst: string; content: string; quote: string };
  draftPayload?: Record<string, unknown>; // afgekeurde Claude-JSON, input voor de herkansing
  rejectReason?: string;                  // afkeurreden van de vorige poging
  schrijfAttempts?: number;               // aantal afgekeurde herkansingen tot nu toe
  // Door de bronscanner aangedragen event-datum (JJJJ-MM-DD), als beginstaat op
  // het topic gezet in addTopics. stepResearch prefereert deze boven de
  // research-gok — de bronpagina is de betrouwbaarste datumbron.
  seedStartDatum?: string;
  seedEindDatum?: string;
  // Uitkomst van de entiteitsverificatie na de research (writer.ts verifyEntity):
  // horen naam_locatie, adres en website bij dezelfde echte zaak? Werkstroom C
  // kan dit later uitlezen. Fail-open: bij een mislukte verificatiecall blijft
  // entiteitConsistent undefined en de waarschuwing leeg.
  entiteitConsistent?: boolean;
  entiteitWaarschuwing?: string;
  // De getrimde Tavily-bronnen van de research, bewaard tot in de schrijffase.
  // De schrijver kreeg tot nu toe alleen de research-JSON en vulde de gaten
  // daartussen met verzinsels (plafondhoogtes, nationaliteiten, sectienamen);
  // met de brontekst erbij kan elk concreet detail herleid worden. Getrimd
  // omdat de volledige bronnen (6 × 12.000 tekens) de schrijfcall over haar
  // tokenruimte heen zouden duwen.
  researchSources?: { title: string; url: string; content: string }[];
  // Wat het model NIET in de bronnen kon vinden ("openingstijden", "namen van
  // de eigenaren"). Stuurt de gerichte queries van de aanvullende ronde.
  missingFacts?: string[];
  // 1 of 2. Bewaakt dat de aanvullende research nooit twee keer draait: die
  // ronde kost extra Tavily- en Claude-calls, en een derde ronde levert
  // aantoonbaar niets meer op als de eerste twee al niks vonden.
  researchRounds?: number;
  // Sufficiëntie-score van de research (zie researchFactScore in writer.ts).
  // Bepaalt zowel de poort naar de aanvullende ronde als het woordbereik van
  // het artikel: dunne research hoort een korter artikel op te leveren, geen
  // opgevulde 400 woorden.
  factScore?: number;
  // Letterlijke quote van een betrokkene uit de bronnen, mét bron-URL en wie
  // het zei; null als er geen echte quote in de bronnen stond. Alleen gevuld
  // als de bron door de quote-blacklist komt.
  bronQuote?: { tekst: string; bron: string; herkomst?: string } | null;
}

export function parseStandaardState(topic: Topic): StandaardState | null {
  if (topic.type !== 'standaard' || !topic.list_state) return null;
  try { return JSON.parse(topic.list_state) as StandaardState; } catch { return null; }
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
  inline: MediaRef | null;
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
  // Event-startdatum uit ACF (start_datum), genormaliseerd naar JJJJ-MM-DD; ''
  // als het geen event met datum is. De auto-publisher gebruikt dit om de
  // event_date-classificatie zonder LLM-call te bepalen (zie lib/publisher.ts).
  eventStart?: string;
  // Event-einddatum uit ACF (eind_datum), zelfde normalisatie. De publisher
  // toetst hierop of een event al voorbij is: bij een tentoonstelling die
  // maanden loopt zegt de startdatum niets over de actualiteit, de slotdatum
  // wel (zie lib/eventDate.ts).
  eventEnd?: string;
  flags: {
    new_in_town: boolean;
    featured_item: boolean;
    beste_van_amsterdam: boolean;
    homepage_carousel: boolean;
  };
}

export const REQUIRED_IMAGES = 3;

// Bij lijstartikelen tellen itemfoto's mee in de beeldenteller.
export function imageCount(a: Pick<Article, 'featured' | 'slider' | 'inline'>, list?: ListArticleStructure | null): number {
  const itemImages = list ? list.items.filter(i => i.media).length : 0;
  return (a.featured ? 1 : 0) + a.slider.length + (a.inline ? 1 : 0) + itemImages;
}

// Compacte tellingen per lijstartikel — zelfde vorm als BoardData.lists, zodat
// zowel de server (volledige structuur) als het bord (compacte tellingen)
// dezelfde klaar-regel kan toepassen.
export interface ListImageCounts { items: number; withMedia: number }

export function listImageCounts(list: ListArticleStructure): ListImageCounts {
  return { items: list.items.length, withMedia: list.items.filter(i => i.media).length };
}

// Klaar-regel voor lijstartikelen: featured gezet, minstens 1 sliderfoto én
// élk item een eigen foto. Zonder itemfoto's zou een lijstartikel met alleen
// featured + slider als 'ready' gelden en dus zonder één beeld in de lopende
// tekst gepubliceerd (of auto-gepubliceerd) worden. Standaardartikelen houden
// de REQUIRED_IMAGES-telling.
export function listImagesReady(a: Pick<Article, 'featured' | 'slider'>, counts: ListImageCounts): boolean {
  return Boolean(a.featured) && a.slider.length >= 1 && counts.withMedia >= counts.items;
}

export type ArticlePhase = 'needImages' | 'ready' | 'published';

export function articlePhase(a: Article, list?: ListArticleStructure | null): ArticlePhase {
  if (a.status === 'publish') return 'published';
  if (list) return listImagesReady(a, listImageCounts(list)) ? 'ready' : 'needImages';
  return imageCount(a) >= REQUIRED_IMAGES ? 'ready' : 'needImages';
}

// De twee audit-kinds staan bewust in dezelfde lijst als de generatieprompts:
// ze delen de prompts-tabel en dus het versiebeheer (activePrompt/
// savePromptVersion), maar zijn losse kinds zodat een aanscherping van de
// claimcheck nooit de schrijfprompt raakt. Zie docs/auditor-ontwerp.md:
// onafhankelijkheid van de auditor zit in eigen prompts, eigen bronnen en een
// eigen oordeel — niet in een tweede promptmechaniek.
export type PromptKind =
  | 'research' | 'schrijf' | 'seo'
  | 'lijst-selectie' | 'lijst-research' | 'lijst-schrijf' | 'lijst-seo'
  | 'audit-claims' | 'audit-beeld';

export const PROMPT_KINDS: PromptKind[] = [
  'research', 'schrijf', 'seo',
  'lijst-selectie', 'lijst-research', 'lijst-schrijf', 'lijst-seo',
  'audit-claims', 'audit-beeld',
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
  titleMaxChars: number;
  subregelWords: WordRange;
  introWords: WordRange;
  contentWords: WordRange;
  quoteWords: WordRange;
  minParagraphs: number;
  titleMustContainTopic: boolean;
  quoteMustBeVerbatimInContent: boolean;
  noDashInText: boolean;
  noAmsterdamRepeatInTitleSubregelIntro: boolean;
  // Drempel voor de sufficiëntie-poort na de research: haalt de research deze
  // score niet, dan gaat de pipeline terug naar Tavily voor een aanvullende
  // ronde (zie researchFactScore in writer.ts).
  minFactScore: number;
  // Woordbereik bij research die ook ná de aanvullende ronde dun blijft. Het
  // harde minimum van 400 woorden was de directe aanleiding voor verzonnen
  // details: wie te weinig feiten heeft en toch 400 woorden moet vullen, vult
  // ze met fictie. Minder feiten hoort een korter artikel op te leveren.
  sparseContentWords: WordRange;
  // Bronnen waarvan we nooit een quote overnemen (concurrerende stadsgidsen).
  quoteSourceBlacklist: string[];
  // Heeft een echte, letterlijke quote uit de bronnen voorrang op een door de
  // schrijver gekozen zin uit het eigen artikel?
  quotePreferSource: boolean;
}

export interface ListConstraints {
  titleMaxChars: number;
  introSentences: WordRange;
  minItems: number;
  itemSentences: WordRange;
  quoteNormPerItems: number;
  quoteNormMandatory: boolean;
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

// Concurrerende stadsgidsen en agenda-portalen: hun teksten zijn zelf redactie,
// geen bron. De lijst zelf staat in lib/competitors.ts en geldt pipeline-breed
// (bron, entiteit, tekst, quote, beeld); dit veld blijft bestaan omdat het in
// opgeslagen constraint-versies staat en de redactie er in de instellingen
// eigen termen aan kan toevoegen.
const QUOTE_SOURCE_BLACKLIST: string[] = COMPETITOR_ALIASSEN;

export const DEFAULT_STANDAARD_CONSTRAINTS: StandaardConstraints = {
  titleWords: { min: 8, max: 12 },
  titleMaxChars: 70,
  subregelWords: { min: 10, max: 15 },
  introWords: { min: 40, max: 60 },
  contentWords: { min: 400, max: 450 },
  quoteWords: { min: 25, max: 40 },
  minParagraphs: 5,
  titleMustContainTopic: true,
  quoteMustBeVerbatimInContent: true,
  noDashInText: true,
  noAmsterdamRepeatInTitleSubregelIntro: true,
  minFactScore: 5,
  sparseContentWords: { min: 250, max: 450 },
  quoteSourceBlacklist: QUOTE_SOURCE_BLACKLIST,
  quotePreferSource: true,
};

// ---------- bronnen (agenda-scanner) ----------

// Een bron is een agenda-/programmapagina die periodiek wordt uitgelezen. Nieuwe
// items belanden direct als topic in de wachtrij (zelfde `topics`-tabel).
export interface Source {
  id: number;
  name: string;
  url: string;                // canoniek, mét protocol
  label: string;              // vrij badge-label, bv "poppodium"
  active: 0 | 1;              // gepauzeerd = 0
  created_at: string;
  last_scan_at: string | null;
  last_scan_status: 'ok' | 'error' | null;
  last_scan_error: string | null;
  last_new_count: number | null; // aantal nieuwe onderwerpen bij de laatste scan
  content_hash: string | null;   // sha256 van de paginatekst bij de laatst geslaagde scan
}

// Weergavestatus van een vondst, afgeleid uit de topics-tabel bij het lezen:
// - 'queued'  → topic staat nog in de wachtrij/pipeline
// - 'written' → topic is 'done' (artikel geschreven)
// - 'deleted' → de redactie heeft het topic verwijderd (finding-rij blijft,
//                zodat het event niet opnieuw wordt opgepakt = dedup-historie)
export type FindingState = 'queued' | 'written' | 'deleted';

export interface SourceFinding {
  id: number;
  title: string;
  found_at: string;
  state: FindingState;
}

// Wat de Bronnen-pagina per bron nodig heeft: de bron zelf + afgeleide tellingen
// en de recentste vondsten.
export interface SourceSummary extends Source {
  foundCount: number;         // totaal gevonden sinds toevoeging
  recent: SourceFinding[];    // recentste vondsten (nieuwste eerst)
}

// Resultaat van één scan-actie, voor de UI en de "laatste run"-samenvatting.
export interface ScanResult {
  sourceId: number;
  ok: boolean;
  added: number;              // nieuwe onderwerpen in de wachtrij
  skipped: number;            // al bekend (globaal of eerder gevonden)
  error?: string;
}

// ---------- beeldselectie (voorselectie rechtenvrije beelden) ----------

// Levenscyclus van een kandidaat-beeld:
// 'new'       → gevonden, nog niet gescoord
// 'scored'    → door Claude beoordeeld op de AmsterdamNOW-beeldstijl
// 'used'      → door de redactie in een slot gezet (featured/slider/item)
// 'dismissed' → afgewezen; blijft bewaard zodat hij bij vernieuwen niet terugkomt
export type CandidateStatus = 'new' | 'scored' | 'used' | 'dismissed';

// Wat een provider oplevert vóór opslag (zonder id/status/score).
export interface ImageCandidateDraft {
  url: string;                // volledige afbeelding (deze wordt geüpload bij gebruik)
  thumb_url: string;          // kleiner beeld voor de grid + Claude-scoring
  width: number;
  height: number;
  source: string;             // bv. "Openverse · Flickr", "Wikimedia Commons", "Pexels"
  source_page: string;        // pagina van het beeld bij de bron (voor de redactie)
  license: string;            // bv. "CC BY 2.0", "Pexels-licentie (vrij te gebruiken)"
  license_url: string;
  author: string;
  title: string;
  query: string;              // met welke zoekterm dit beeld gevonden is
}

export interface ImageCandidate extends ImageCandidateDraft {
  id: number;
  post_id: number;
  score: number | null;       // 0-100, door Claude
  reason: string;             // korte motivatie bij de score
  role: string;               // advies: 'featured' | 'slider' | 'geen'
  status: CandidateStatus;
  created_at: string;
}

// ---------- auditor (onafhankelijke steekproefcontrole) ----------

// Het oordeel per bevinding. Bewust drie waarden en geen score: de auditor moet
// een redacteur vertellen of hij moet ingrijpen, niet hoe zeker een model is.
// 'twijfel' is expliciet de veilige uitkomst — een niet te verifiëren claim mag
// nooit als 'ok' wegvallen (zie docs/prompts/audit-claims-v1.md).
export type AuditVerdict = 'ok' | 'twijfel' | 'fout';

export type AuditStatus = 'running' | 'done' | 'failed';

// Welke van de drie controles de bevinding opleverde: 'claim' (model + Serper),
// 'beeld' (vision + bestandsnaam/alt-heuristiek) of 'tekst' (deterministische
// dubbele-zin- en contaminatiecheck).
export type AuditFindingKind = 'claim' | 'beeld' | 'tekst';

// De steekproef: 'drafts' = alles wat nog gepubliceerd moet worden,
// 'ready' = alleen wat publicatieklaar is.
export type AuditScope = 'drafts' | 'ready';

// Eén auditronde. `postIds` is de volledige trekking, `donePostIds` wat al
// afgehandeld is — de tick-route werkt één artikel per aanroep af (60s-limiet),
// dus het verschil tussen die twee lijsten is de resterende wachtrij én de
// voortgangsindicator voor de UI.
export interface AuditRun {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: AuditStatus;
  scope: AuditScope;
  sampleSize: number;
  postIds: number[];
  donePostIds: number[];
  error: string | null;
}

export interface AuditFinding {
  id: number;
  runId: number;
  postId: number;
  kind: AuditFindingKind;
  verdict: AuditVerdict;
  onderwerp: string;   // de gecontroleerde claim, of de beeldrol ("featured")
  bevinding: string;   // wat er aan de hand is, één zin
  bron: string;        // URL of ''
  createdAt: string;
}

// Wat een controle oplevert vóór opslag: run en artikel zijn dan al bekend bij
// de aanroeper, het tijdstip zet de database.
export type AuditFindingInput = Omit<AuditFinding, 'id' | 'runId' | 'postId' | 'createdAt'>;

const VERDICT_RANK: Record<AuditVerdict, number> = { ok: 0, twijfel: 1, fout: 2 };

// Eindoordeel per artikel = het zwaarste bevinding-verdict: 'fout' > 'twijfel' >
// 'ok'. Een artikel zonder bevindingen is 'ok' — geen bevindingen is de
// geldige, en gewenste, uitkomst van een controle.
export function worstVerdict(findings: { verdict: AuditVerdict }[]): AuditVerdict {
  let worst: AuditVerdict = 'ok';
  for (const f of findings) {
    if (VERDICT_RANK[f.verdict] > VERDICT_RANK[worst]) worst = f.verdict;
  }
  return worst;
}

export const DEFAULT_LIST_CONSTRAINTS: ListConstraints = {
  titleMaxChars: 75,
  introSentences: { min: 2, max: 3 },
  minItems: 3,
  itemSentences: { min: 3, max: 5 },
  quoteNormPerItems: 3,
  quoteNormMandatory: true,
  minNamedItemsInClosing: 2,
  forbiddenWords: [
    'hotspot', 'pareltje', 'bruisend', 'iconisch',
    'elektronische muziek',
    'opent zijn deuren', 'verwelkomt gasten', 'biedt een unieke ervaring',
    'mis het niet', 'een aanrader voor iedereen',
  ],
  quoteSourceBlacklist: QUOTE_SOURCE_BLACKLIST,
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
