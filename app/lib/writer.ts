import { activeConstraints, activePrompt, claimNextTopic, completeTopic, failTopic } from './db';
import { askClaudeJson, FAST_WRITE_MODEL } from './claude';
import { createDraft, taxonomyChoices } from './wp';
import { researchWithTavily } from './tavily';
import { validateArticle, GeneratedArticle } from './validation';
import type { StandaardConstraints, Topic, WordRange } from './types';

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

export async function writeNextTopic() {
  const topic = await claimNextTopic();
  if (!topic) return { topic: null, article: null };
  return writeTopic(topic);
}

// De queue-route claimt werk van beide types atomisch en geeft een standaard-
// topic hier direct door. Deze functie claimt dus zelf niets.
export async function writeTopic(topic: Topic) {
  try {
    const [researchPrompt, writePrompt, seoPrompt, taxonomies, constraints] = await Promise.all([
      activePrompt('research'), activePrompt('schrijf'), activePrompt('seo'), taxonomyChoices(), activeConstraints('standaard'),
    ]);
    const sources = await researchWithTavily(topic.title);
    const research = await askClaudeJson(
      researchPrompt.content,
      `Onderwerp: ${topic.title}\n\nBeschikbare WordPress-categorieën: ${taxonomies.categories.join(', ')}\nBeschikbare WordPress-districten: ${taxonomies.districts.join(', ')}\n\nTavily-bronnen:\n${sources.map((s, i) => `\n[${i + 1}] ${s.title}\n${s.url}\n${s.content}`).join('\n')}`,
    );
    const rules = describeStandaardConstraints(constraints);
    let payload = await askClaudeJson(
      writePrompt.content,
      `Onderwerp: ${topic.title}\n\nGebruik uitsluitend deze gecontroleerde research van Tavily. Schrijf het artikel als geldige JSON volgens de actieve prompt.\n\nHoud je aan deze regels:\n${rules}\n\n${JSON.stringify(research)}`,
      false, FAST_WRITE_MODEL,
    );
    // Herkansing binnen dezelfde request: een validatiefout (te weinig woorden,
    // dash, quote niet letterlijk, …) gaat mét afkeurreden en de vorige versie
    // terug naar het snelle model in plaats van het topic direct op "mislukt"
    // te zetten. Eén ronde — meer past niet binnen de 60s-limiet.
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
    const { title, subregel, introductie_tekst: intro, content, quote } = checked;
    const seo = await askClaudeJson(
      seoPrompt.content,
      `POST_TITLE: ${title}\nPOST_EXCERPT: ${intro}\nPOST_CONTENT: ${content}\nCATEGORY: ${strings(research.categories, 'categories').join(', ')}\nDISTRICT: ${string(research.district, 'district')}`,
    );
    const draft = await createDraft({
      title,
      subregel,
      intro,
      contentHtml: html(content),
      quote,
      focusKeyword: string(seo.rank_math_focus_keyword, 'rank_math_focus_keyword'),
      slug: string(seo.slug, 'slug'),
      seoTitle: string(seo.rank_math_title, 'rank_math_title'),
      metaDescription: string(seo.rank_math_description, 'rank_math_description'),
      categories: strings(research.categories, 'categories'),
      district: string(research.district, 'district'),
      tags: strings(research.tags, 'tags'),
      rubriek: string(research.rubriek, 'rubriek'),
      naamLocatie: string(research.naam_locatie, 'naam_locatie'),
      adres: string(research.adres, 'adres'),
      stad: string(research.stad, 'stad'),
      website: string(research.website, 'website'),
    });
    await completeTopic(topic.id, draft.id);
    return { topic, article: draft };
  } catch (error: any) {
    await failTopic(topic.id, error.message || 'Onbekende fout', 'Claude schrijven');
    throw error;
  }
}
