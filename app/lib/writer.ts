import { activeConstraints, activePrompt, completeTopic, failTopic, saveTopicProgress } from './db';
import { askClaudeJson, FAST_WRITE_MODEL } from './claude';
import { createDraft, taxonomyChoices } from './wp';
import { researchWithTavily } from './tavily';
import { validateArticle, GeneratedArticle } from './validation';
import { parseStandaardState, type StandaardConstraints, type StandaardPhase, type StandaardState, type Topic, type WordRange } from './types';

// Ruime marge boven een realistisch artikel (~450 woorden content + korte
// titel/subregel/intro/quote-velden ≈ 800-1000 tokens als JSON), maar veel
// krapper dan de standaard 6000: op productie liep de write-call een keer
// tot 58s door voordat 'ie tegen de oude limiet van 6000 aanliep (afgekapt,
// stop_reason=max_tokens) — gevaarlijk dicht bij de 60s-functielimiet. Bij
// 2000 (gemeten: ~25s tot afkapping) sloeg de cap voor sommige onderwerpen
// een ander legitiem iets langer antwoord af; 3000 geeft daar ruimte voor
// terwijl een op hol geslagen generatie nog altijd ruim (~35-40s, gemeten
// lineair) onder de 60s-limiet stopt in plaats van er tegenaan te lopen.
const WRITE_MAX_TOKENS = 3000;

function html(content: string): string {
  return content.split(/\n\s*\n/).map(p => `<p>${p.trim().replace(/\n/g, '<br>')}</p>`).join('\n');
}

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
function describeStandaardConstraints(c: StandaardConstraints): string {
  const mid = (r: WordRange) => Math.round((r.min + r.max) / 2);
  const lines = [
    `- Titel: ${c.titleWords.min}-${c.titleWords.max} woorden${c.titleMustContainTopic ? ', met de naam van het onderwerp erin' : ''}.`,
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
  // Tijdelijke timing-instrumentatie (2026-07-20), zie lib/claude.ts.
  const stepStart = Date.now();
  console.log(`[standaard] topic=${topic.id} phase=${phase} start`);
  try {
    let result: StandaardStepResult;
    switch (phase) {
      case 'research': result = await stepResearch(topic, s); break;
      case 'schrijf': result = await stepSchrijf(topic, s); break;
      case 'schrijf-retry': result = await stepSchrijfRetry(topic, s); break;
      case 'seo': result = await stepSeo(topic, s); break;
    }
    console.log(`[standaard] topic=${topic.id} phase=${phase} done in ${Date.now() - stepStart}ms -> ${result.phase}`);
    return result;
  } catch (error: any) {
    console.log(`[standaard] topic=${topic.id} phase=${phase} FAILED after ${Date.now() - stepStart}ms: ${error.message}`);
    await failTopic(topic.id, error.message || 'Onbekende fout', `standaardfase: ${phase}`);
    throw error;
  }
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
  const dbStart = Date.now();
  const [researchPrompt, taxonomies] = await Promise.all([activePrompt('research'), taxonomyChoices()]);
  console.log(`[standaard] topic=${topic.id} research: prompt+taxonomieën geladen in ${Date.now() - dbStart}ms`);
  const tavilyStart = Date.now();
  const sources = await researchWithTavily(topic.title);
  console.log(`[standaard] topic=${topic.id} research: tavily klaar in ${Date.now() - tavilyStart}ms (${sources.length} bronnen)`);
  const research = await askClaudeJson(
    researchPrompt.content,
    `Onderwerp: ${topic.title}\n\nBeschikbare WordPress-categorieën: ${taxonomies.categories.join(', ')}\nBeschikbare WordPress-districten: ${taxonomies.districts.join(', ')}\n\nTavily-bronnen:\n${sources.map((src, i) => `\n[${i + 1}] ${src.title}\n${src.url}\n${src.content}`).join('\n')}`,
  );
  s.research = research;
  await saveTopicProgress(topic.id, { status: 'queued', phase: 'schrijf', state: s });
  return { topic, phase: 'schrijf', done: false, progress: 'Research klaar · schrijven start' };
}

async function stepSchrijf(topic: Topic, s: StandaardState): Promise<StandaardStepResult> {
  if (!s.research) throw new Error('Research ontbreekt voor de schrijffase.');
  const dbStart = Date.now();
  const [writePrompt, constraints] = await Promise.all([activePrompt('schrijf'), activeConstraints('standaard')]);
  console.log(`[standaard] topic=${topic.id} schrijf: prompt+constraints geladen in ${Date.now() - dbStart}ms`);
  const rules = describeStandaardConstraints(constraints);
  const payload = await askClaudeJson(
    writePrompt.content,
    `Onderwerp: ${topic.title}\n\nGebruik uitsluitend deze gecontroleerde research van Tavily. Schrijf het artikel als geldige JSON volgens de actieve prompt.\n\nHoud je aan deze regels:\n${rules}\n\n${JSON.stringify(s.research)}`,
    false, FAST_WRITE_MODEL, WRITE_MAX_TOKENS,
  );
  try {
    const candidate = buildCandidate(payload);
    validateArticle(candidate, topic.title, constraints);
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
  const dbStart = Date.now();
  const [writePrompt, constraints] = await Promise.all([activePrompt('schrijf'), activeConstraints('standaard')]);
  console.log(`[standaard] topic=${topic.id} schrijf-retry: prompt+constraints geladen in ${Date.now() - dbStart}ms`);
  const rules = describeStandaardConstraints(constraints);
  const payload = await askClaudeJson(
    writePrompt.content,
    `Je vorige versie van dit artikel is afgekeurd door de eindredactie.\n\nOnderwerp: ${topic.title}\nAfkeurreden: ${s.rejectReason}\n\nLever het VOLLEDIGE artikel opnieuw aan als JSON met exact dezelfde velden (title, subregel, introductie_tekst, content, quote). Los de afkeurreden op en houd de rest zoveel mogelijk intact. Alle regels blijven gelden:\n${rules}\n\nJe vorige versie:\n${JSON.stringify(s.draftPayload)}`,
    false, FAST_WRITE_MODEL, WRITE_MAX_TOKENS,
  );
  let checked: GeneratedArticle;
  try {
    checked = buildCandidate(payload);
    validateArticle(checked, topic.title, constraints);
  } catch (e: any) {
    // Eén herkansing — meer past niet zonder het risico op een derde
    // sequentiële Claude-call binnen één aanroep.
    throw new Error(`${e.message} (ook na een herschrijfronde)`);
  }
  s.article = checked;
  s.draftPayload = undefined;
  s.rejectReason = undefined;
  await saveTopicProgress(topic.id, { status: 'queued', phase: 'seo', state: s });
  return { topic, phase: 'seo', done: false, progress: 'Artikel geschreven en gevalideerd · SEO en draft' };
}

async function stepSeo(topic: Topic, s: StandaardState): Promise<StandaardStepResult> {
  if (!s.research || !s.article) throw new Error('Onvolledige staat voor de SEO-fase.');
  const { title, subregel, introductie_tekst: intro, content, quote } = s.article;
  const seoPrompt = await activePrompt('seo');
  const seo = await askClaudeJson(
    seoPrompt.content,
    `POST_TITLE: ${title}\nPOST_EXCERPT: ${intro}\nPOST_CONTENT: ${content}\nCATEGORY: ${strings(s.research.categories, 'categories').join(', ')}\nDISTRICT: ${string(s.research.district, 'district')}`,
  );
  const wpStart = Date.now();
  const draft = await createDraft({
    title, subregel, intro, contentHtml: html(content), quote,
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
  console.log(`[standaard] topic=${topic.id} seo: wp-draft aangemaakt in ${Date.now() - wpStart}ms`);
  await completeTopic(topic.id, draft.id);
  return { topic, phase: 'seo', done: true, progress: 'Draft aangemaakt', article: { id: draft.id, title: draft.title } };
}
