import { activeConstraints, activePrompt, completeTopic, failTopic, saveTopicProgress } from './db';
import { askClaudeJson, FAST_WRITE_MODEL } from './claude';
import { RESEARCH_SCHEMA, ARTICLE_SCHEMA, SEO_SCHEMA } from './schemas';
import { createDraft, taxonomyChoices } from './wp';
import { checkTopicAgainstWp } from './dedup';
import { researchWithTavily } from './tavily';
import { validateArticle, GeneratedArticle } from './validation';
import { parseStandaardState, type StandaardConstraints, type StandaardPhase, type StandaardState, type Topic, type WordRange } from './types';
import { formatStandardArticleHtml } from './articleHtml';

// Ruime marge boven een realistisch artikel (~450 woorden content + korte
// titel/subregel/intro/quote-velden ≈ 800-1000 tokens als JSON), maar veel
// krapper dan de standaard 6000: op productie liep de write-call een keer
// tot 58s door voordat 'ie tegen de oude limiet van 6000 aanliep (afgekapt,
// stop_reason=max_tokens) — gevaarlijk dicht bij de 60s-functielimiet. Bij
// 2000 (gemeten: ~25s tot afkapping) sloeg de cap voor sommige onderwerpen
// een ander legitiem iets langer antwoord af; 3000 geeft daar ruimte voor
// terwijl een op hol geslagen generatie nog altijd ruim (~35-40s, gemeten
// lineair) onder de 60s-limiet stopt in plaats van er tegenaan te lopen.
// De schrijfcall denkt bewust NIET (zie lib/claude.ts): op productie getest
// (2026-07-20) kapte adaptive thinking + structured outputs élk artikel af,
// zelfs op 4500 tokens. Zonder thinking is een artikel ~1100 output-tokens;
// 4500 geeft ruim marge voor lange legitieme artikelen terwijl een op hol
// geslagen generatie (~50s bij ~90 tokens/s) nog net binnen de
// 60s-functielimiet stopt. De max_tokens-throw in claude.ts is het vangnet.
const WRITE_MAX_TOKENS = 4500;
// Maximaal aantal herschrijfrondes na de eerste schrijfpoging.
const MAX_SCHRIJF_HERKANSINGEN = 2;

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Claude liet ${label} leeg.`);
  return value.trim();
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every(v => typeof v === 'string' && v.trim())) throw new Error(`Claude gaf geen geldige ${label} terug.`);
  return value.map(v => v.trim());
}

// De actieve Criteria als expliciete instructieregels bij de schrijfopdracht.
// Woordaantallen mikken op het midden van de bandbreedte: het model telt niet
// exact, dus wie op de ondergrens mikt valt er regelmatig onder — precies de
// fout die topics op "mislukt" zette.
function describeStandaardConstraints(c: StandaardConstraints, naam: string): string {
  const mid = (r: WordRange) => Math.round((r.min + r.max) / 2);
  // De titelcheck (validateArticle) eist de naam létterlijk; zeg het model dus
  // precies welke tekenreeks er in de titel moet, niet alleen "de naam van het
  // onderwerp" — daar maakte het model zelf een kortere variant van (bv.
  // "AMAZE" waar naam_locatie "AMAZE by ID&T" is), die de check dan afkeurt.
  const lines = [
    `- Titel: ${c.titleWords.min}-${c.titleWords.max} woorden${c.titleMustContainTopic ? `, met daarin letterlijk: "${naam}"` : ''}.`,
    `- Subregel: ${c.subregelWords.min}-${c.subregelWords.max} woorden.`,
    `- Introductie: ${c.introWords.min}-${c.introWords.max} woorden; mik op ~${mid(c.introWords)}.`,
    `- Artikeltekst: ${c.contentWords.min}-${c.contentWords.max} woorden; mik op ~${mid(c.contentWords)}, verdeeld over minimaal ${c.minParagraphs} alinea's. Schrijf liever iets te ruim dan te krap.`,
    `- Quote: ${c.quoteWords.min}-${c.quoteWords.max} woorden${c.quoteMustBeVerbatimInContent ? ', en woord voor woord letterlijk terug te vinden in de artikeltekst' : ''}.`,
  ];
  if (c.noDashInText) lines.push('- Geen em dash (—) of en dash (–), nergens.');
  if (c.noAmsterdamRepeatInTitleSubregelIntro) lines.push('- Het woord "Amsterdam" mag níet in titel, subregel of introductie staan.');
  return lines.join('\n');
}

export interface StandaardStepResult {
  topic: Topic;
  phase: StandaardPhase;
  done: boolean;           // true zodra de draft er staat
  progress: string;        // korte statusregel voor het bord
  article?: { id: number; title: string };
}

// Eén fase-stap van de standaardpipeline. Was ooit één aaneengesloten aanroep
// (research + schrijven + evt. herschrijfronde + SEO + WordPress-draft, dus
// tot 4 Claude-calls in één request) — dat liep regelmatig over de 60s-
// serverless-limiet heen (FUNCTION_INVOCATION_TIMEOUT), waarna de taak zonder
// foutafhandeling op 'writing' bleef staan en de wachtrij blokkeerde (zie
// lib/queue.ts: er mag maar 1 taak tegelijk 'writing' zijn). Nu net als de
// lijstpipeline: één fase per process-aanroep.
export async function processStandaardStep(topic: Topic): Promise<StandaardStepResult> {
  const s = parseStandaardState(topic) ?? {};
  const phase: StandaardPhase =
    topic.phase === 'schrijf' || topic.phase === 'schrijf-retry' || topic.phase === 'seo' ? topic.phase : 'research';
  try {
    switch (phase) {
      case 'research': return await stepResearch(topic, s);
      case 'schrijf': return await stepSchrijf(topic, s);
      case 'schrijf-retry': return await stepSchrijfRetry(topic, s);
      case 'seo': return await stepSeo(topic, s);
    }
  } catch (error: any) {
    await failTopic(topic.id, error.message || 'Onbekende fout', `standaardfase: ${phase}`);
    throw error;
  }
}

// De "naam van het onderwerp" voor de titelcheck in validateArticle. De
// bron-scanner maakt tegenwoordig hele zinstitels als wachtrijtitel ("Vermut
// opent in Amsterdam: restaurant én aperitivobar ineen"); eisen dat de
// artikeltitel die volledige zin bevat is onhaalbaar én botst frontaal met de
// regel dat "Amsterdam" niet in de titel mag — elke scanner-titel met
// "Amsterdam" faalde daardoor gegarandeerd. De research-fase extraheert al de
// echte naam van de zaak of het evenement (naam_locatie); dáár hoort de
// titelcheck op te toetsen, met de wachtrijtitel als vangnet.
function subjectName(topic: Topic, s: StandaardState): string {
  const naam = s.research?.naam_locatie;
  return typeof naam === 'string' && naam.trim() ? naam.trim() : topic.title;
}

function buildCandidate(payload: Record<string, unknown>): GeneratedArticle {
  return {
    title: string(payload.title, 'title'),
    subregel: string(payload.subregel, 'subregel'),
    introductie_tekst: string(payload.introductie_tekst, 'introductie_tekst'),
    content: string(payload.content, 'content'),
    quote: string(payload.quote, 'quote'),
  };
}

async function stepResearch(topic: Topic, s: StandaardState): Promise<StandaardStepResult> {
  const [researchPrompt, taxonomies] = await Promise.all([activePrompt('research'), taxonomyChoices()]);
  const sources = await researchWithTavily(topic.title);
  // Research = feiten extraheren uit aangeleverde bronnen, geen creatief werk:
  // Sonnet 5 volstaat en kost een fractie van Opus (zie FAST_WRITE_MODEL in
  // lib/claude.ts). Bronnen worden hier ook getrimd op 8000 tekens — relevante
  // info zoals adres/feiten staat doorgaans vooraan in de geëxtraheerde
  // content (zie VERIFY_SOURCE_CHARS in listWriter.ts voor dezelfde afweging).
  const research = await askClaudeJson(
    researchPrompt.content,
    `Onderwerp: ${topic.title}\n\nBeschikbare WordPress-categorieën: ${taxonomies.categories.join(', ')}\nBeschikbare WordPress-districten: ${taxonomies.districts.join(', ')}\nBeschikbare WordPress-tags: ${taxonomies.tags.join(', ')}\nKies "tags" uitsluitend uit deze lijst; verzin nooit nieuwe tags. Past geen enkele bestaande tag goed, geef dan een lege lijst terug.\n\nTavily-bronnen:\n${sources.map((src, i) => `\n[${i + 1}] ${src.title}\n${src.url}\n${src.content.slice(0, 8000)}`).join('\n')}`,
    false, FAST_WRITE_MODEL, 6000, RESEARCH_SCHEMA,
  );
  s.research = research;
  await saveTopicProgress(topic.id, { status: 'queued', phase: 'schrijf', state: s });
  return { topic, phase: 'schrijf', done: false, progress: 'Research klaar · schrijven start' };
}

async function stepSchrijf(topic: Topic, s: StandaardState): Promise<StandaardStepResult> {
  if (!s.research) throw new Error('Research ontbreekt voor de schrijffase.');
  const [writePrompt, constraints] = await Promise.all([activePrompt('schrijf'), activeConstraints('standaard')]);
  const rules = describeStandaardConstraints(constraints, subjectName(topic, s));
  const payload = await askClaudeJson(
    writePrompt.content,
    `Onderwerp: ${topic.title}\n\nGebruik uitsluitend deze gecontroleerde research van Tavily. Schrijf het artikel als geldige JSON volgens de actieve prompt.\n\nHoud je aan deze regels:\n${rules}\n\n${JSON.stringify(s.research)}`,
    false, FAST_WRITE_MODEL, WRITE_MAX_TOKENS, ARTICLE_SCHEMA,
  );
  try {
    const candidate = buildCandidate(payload);
    validateArticle(candidate, subjectName(topic, s), constraints);
    s.article = candidate;
    await saveTopicProgress(topic.id, { status: 'queued', phase: 'seo', state: s });
    return { topic, phase: 'seo', done: false, progress: 'Artikel geschreven en gevalideerd · SEO en draft' };
  } catch (e: any) {
    // Herkansing als eigen fase-stap (niet meer als 2e Claude-call binnen
    // dezelfde aanroep): een validatiefout (te weinig woorden, dash, quote
    // niet letterlijk, …) gaat mét afkeurreden en de vorige versie naar de
    // volgende tik, in plaats van het topic direct op "mislukt" te zetten.
    s.draftPayload = payload;
    s.rejectReason = e.message;
    await saveTopicProgress(topic.id, { status: 'queued', phase: 'schrijf-retry', state: s });
    return { topic, phase: 'schrijf-retry', done: false, progress: `Afgekeurd (${String(e.message).slice(0, 60)}…) · herkansing start` };
  }
}

async function stepSchrijfRetry(topic: Topic, s: StandaardState): Promise<StandaardStepResult> {
  if (!s.research || !s.draftPayload || !s.rejectReason) throw new Error('Onvolledige staat voor de herschrijfronde.');
  const [writePrompt, constraints] = await Promise.all([activePrompt('schrijf'), activeConstraints('standaard')]);
  const rules = describeStandaardConstraints(constraints, subjectName(topic, s));
  const payload = await askClaudeJson(
    writePrompt.content,
    `Je vorige versie van dit artikel is afgekeurd door de eindredactie.\n\nOnderwerp: ${topic.title}\nAfkeurreden: ${s.rejectReason}\n\nLever het VOLLEDIGE artikel opnieuw aan als JSON met exact dezelfde velden (title, subregel, introductie_tekst, content, quote). Los de afkeurreden op en houd de rest zoveel mogelijk intact. Alle regels blijven gelden:\n${rules}\n\nJe vorige versie:\n${JSON.stringify(s.draftPayload)}`,
    false, FAST_WRITE_MODEL, WRITE_MAX_TOKENS, ARTICLE_SCHEMA,
  );
  let checked: GeneratedArticle;
  try {
    checked = buildCandidate(payload);
    validateArticle(checked, subjectName(topic, s), constraints);
  } catch (e: any) {
    // Elke herkansing is sinds de fase-opsplitsing een eigen serverless-tick,
    // dus meerdere rondes kunnen veilig (zelfde patroon als composeAttempts in
    // listWriter.ts). Afkeuringen zijn vaak randmissers (intro 38/40 woorden,
    // quote 14/15); een extra ronde mét de nieuwe afkeurreden redt die bijna
    // altijd, tegen de prijs van één extra call — alleen bij falen.
    const attempts = (s.schrijfAttempts || 0) + 1;
    if (attempts >= MAX_SCHRIJF_HERKANSINGEN) {
      throw new Error(`${e.message} (ook na ${attempts} herschrijfrondes)`);
    }
    s.schrijfAttempts = attempts;
    s.draftPayload = payload;
    s.rejectReason = e.message;
    await saveTopicProgress(topic.id, { status: 'queued', phase: 'schrijf-retry', state: s });
    return { topic, phase: 'schrijf-retry', done: false, progress: `Afgekeurd (${String(e.message).slice(0, 60)}…) · herkansing ${attempts + 1} start` };
  }
  s.article = checked;
  s.draftPayload = undefined;
  s.rejectReason = undefined;
  s.schrijfAttempts = undefined;
  await saveTopicProgress(topic.id, { status: 'queued', phase: 'seo', state: s });
  return { topic, phase: 'seo', done: false, progress: 'Artikel geschreven en gevalideerd · SEO en draft' };
}

async function stepSeo(topic: Topic, s: StandaardState): Promise<StandaardStepResult> {
  if (!s.research || !s.article) throw new Error('Onvolledige staat voor de SEO-fase.');
  // Herkans-check vlak vóór de draft: topics kunnen lang in de wachtrij staan,
  // dus de bij-invoer-check (POST /api/topics) kan intussen verouderd zijn.
  // Force-toegevoegde topics (dedup_override) slaan deze over. Zie
  // docs/superpowers/specs/2026-07-21-wp-dedup-index-design.md §4.
  if (!topic.dedup_override) {
    const dedup = await checkTopicAgainstWp(topic.title);
    if (dedup.verdict === 'duplicate' && dedup.existing) {
      throw new Error(`Duplicaat van bestaand artikel: ${dedup.existing.link}`);
    }
  }
  const { title, subregel, introductie_tekst: intro, content, quote } = s.article;
  const seoPrompt = await activePrompt('seo');
  const seo = await askClaudeJson(
    seoPrompt.content,
    `POST_TITLE: ${title}\nPOST_EXCERPT: ${intro}\nPOST_CONTENT: ${content}\nCATEGORY: ${strings(s.research.categories, 'categories').join(', ')}\nDISTRICT: ${string(s.research.district, 'district')}`,
    false, FAST_WRITE_MODEL, 6000, SEO_SCHEMA,
  );
  const draft = await createDraft({
    title, subregel, intro, contentHtml: formatStandardArticleHtml(content, quote), quote,
    focusKeyword: string(seo.rank_math_focus_keyword, 'rank_math_focus_keyword'),
    slug: string(seo.slug, 'slug'),
    seoTitle: string(seo.rank_math_title, 'rank_math_title'),
    metaDescription: string(seo.rank_math_description, 'rank_math_description'),
    categories: strings(s.research.categories, 'categories'),
    district: string(s.research.district, 'district'),
    tags: strings(s.research.tags, 'tags'),
    rubriek: string(s.research.rubriek, 'rubriek'),
    naamLocatie: string(s.research.naam_locatie, 'naam_locatie'),
    adres: string(s.research.adres, 'adres'),
    stad: string(s.research.stad, 'stad'),
    website: string(s.research.website, 'website'),
  });
  await completeTopic(topic.id, draft.id);
  return { topic, phase: 'seo', done: true, progress: 'Draft aangemaakt', article: { id: draft.id, title: draft.title } };
}
