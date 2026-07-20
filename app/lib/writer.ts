import { activeConstraints, activePrompt, completeTopic, failTopic, saveTopicProgress } from './db';
import { askClaudeJson, FAST_WRITE_MODEL } from './claude';
import { createDraft, taxonomyChoices } from './wp';
import { researchWithTavily } from './tavily';
import { validateArticle, GeneratedArticle } from './validation';
import { parseStandaardState, type StandaardConstraints, type StandaardPhase, type StandaardState, type Topic, type WordRange } from './types';

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
  const phase: StandaardPhase = topic.phase === 'schrijf' || topic.phase === 'seo' ? topic.phase : 'research';
  try {
    switch (phase) {
      case 'research': return await stepResearch(topic, s);
      case 'schrijf': return await stepSchrijf(topic, s);
      case 'seo': return await stepSeo(topic, s);
    }
  } catch (error: any) {
    await failTopic(topic.id, error.message || 'Onbekende fout', `standaardfase: ${phase}`);
    throw error;
  }
}

async function stepResearch(topic: Topic, s: StandaardState): Promise<StandaardStepResult> {
  const [researchPrompt, taxonomies] = await Promise.all([activePrompt('research'), taxonomyChoices()]);
  const sources = await researchWithTavily(topic.title);
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
  const [writePrompt, constraints] = await Promise.all([activePrompt('schrijf'), activeConstraints('standaard')]);
  const rules = describeStandaardConstraints(constraints);
  let payload = await askClaudeJson(
    writePrompt.content,
    `Onderwerp: ${topic.title}\n\nGebruik uitsluitend deze gecontroleerde research van Tavily. Schrijf het artikel als geldige JSON volgens de actieve prompt.\n\nHoud je aan deze regels:\n${rules}\n\n${JSON.stringify(s.research)}`,
    false, FAST_WRITE_MODEL,
  );
  // Herkansing binnen dezelfde fase-stap: een validatiefout (te weinig woorden,
  // dash, quote niet letterlijk, …) gaat mét afkeurreden en de vorige versie
  // terug naar het snelle model in plaats van het topic direct op "mislukt"
  // te zetten. Eén ronde — meer past niet binnen de 60s-limiet, en beide
  // pogingen gebruiken het snelle model, dus dit blijft ruim binnen de tijd.
  let checked: GeneratedArticle | null = null;
  for (let attempt = 0; ; attempt++) {
    try {
      const candidate: GeneratedArticle = {
        title: string(payload.title, 'title'),
        subregel: string(payload.subregel, 'subregel'),
        introductie_tekst: string(payload.introductie_tekst, 'introductie_tekst'),
        content: string(payload.content, 'content'),
        quote: string(payload.quote, 'quote'),
      };
      validateArticle(candidate, topic.title, constraints);
      checked = candidate;
      break;
    } catch (e: any) {
      if (attempt >= 1) throw new Error(`${e.message} (ook na een herschrijfronde)`);
      payload = await askClaudeJson(
        writePrompt.content,
        `Je vorige versie van dit artikel is afgekeurd door de eindredactie.\n\nOnderwerp: ${topic.title}\nAfkeurreden: ${e.message}\n\nLever het VOLLEDIGE artikel opnieuw aan als JSON met exact dezelfde velden (title, subregel, introductie_tekst, content, quote). Los de afkeurreden op en houd de rest zoveel mogelijk intact. Alle regels blijven gelden:\n${rules}\n\nJe vorige versie:\n${JSON.stringify(payload)}`,
        false, FAST_WRITE_MODEL,
      );
    }
  }
  s.article = checked;
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
  await completeTopic(topic.id, draft.id);
  return { topic, phase: 'seo', done: true, progress: 'Draft aangemaakt', article: { id: draft.id, title: draft.title } };
}
