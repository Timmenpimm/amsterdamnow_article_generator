import { activePrompt, claimNextTopic, completeTopic, failTopic } from './db';
import { askClaudeJson } from './claude';
import { createDraft, taxonomyChoices } from './wp';
import { researchWithTavily } from './tavily';
import { validateArticle } from './validation';

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

export async function writeNextTopic() {
  const topic = await claimNextTopic();
  if (!topic) return { topic: null, article: null };
  try {
    const [researchPrompt, writePrompt, seoPrompt, taxonomies] = await Promise.all([
      activePrompt('research'), activePrompt('schrijf'), activePrompt('seo'), taxonomyChoices(),
    ]);
    const sources = await researchWithTavily(topic.title);
    const research = await askClaudeJson(
      researchPrompt.content,
      `Onderwerp: ${topic.title}\n\nBeschikbare WordPress-categorieën: ${taxonomies.categories.join(', ')}\nBeschikbare WordPress-districten: ${taxonomies.districts.join(', ')}\n\nTavily-bronnen:\n${sources.map((s, i) => `\n[${i + 1}] ${s.title}\n${s.url}\n${s.content}`).join('\n')}`,
    );
    const article = await askClaudeJson(
      writePrompt.content,
      `Onderwerp: ${topic.title}\n\nGebruik uitsluitend deze gecontroleerde research van Tavily. Schrijf het artikel als geldige JSON volgens de actieve prompt.\n\n${JSON.stringify(research)}`,
    );
    const title = string(article.title, 'title');
    const intro = string(article.introductie_tekst, 'introductie_tekst');
    const content = string(article.content, 'content');
    const subregel = string(article.subregel, 'subregel');
    const quote = string(article.quote, 'quote');
    validateArticle({ title, subregel, introductie_tekst: intro, content, quote }, topic.title);
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
