import { activePrompt, claimNextTopic, completeTopic, failTopic } from './db';
import { askClaudeJson } from './claude';
import { createDraft } from './wp';

function html(content: string): string {
  return content.split(/\n\s*\n/).map(p => `<p>${p.trim().replace(/\n/g, '<br>')}</p>`).join('\n');
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Claude liet ${label} leeg.`);
  return value.trim();
}

export async function writeNextTopic() {
  const topic = await claimNextTopic();
  if (!topic) return { topic: null, article: null };
  try {
    const [writePrompt, seoPrompt] = await Promise.all([activePrompt('schrijf'), activePrompt('seo')]);
    const article = await askClaudeJson(
      writePrompt.content,
      `Onderwerp: ${topic.title}\n\nOnderzoek dit onderwerp eerst met web search. Gebruik alleen controleerbare feiten uit de gevonden bronnen. Schrijf daarna het artikel als geldige JSON volgens de actieve prompt.`,
      true,
    );
    const title = string(article.title, 'title');
    const intro = string(article.introductie_tekst, 'introductie_tekst');
    const content = string(article.content, 'content');
    const seo = await askClaudeJson(
      seoPrompt.content,
      `POST_TITLE: ${title}\nPOST_EXCERPT: ${intro}\nPOST_CONTENT: ${content}\nCATEGORY: \nDISTRICT: `,
    );
    const draft = await createDraft({
      title,
      subregel: string(article.subregel, 'subregel'),
      intro,
      contentHtml: html(content),
      quote: string(article.quote, 'quote'),
      focusKeyword: string(seo.rank_math_focus_keyword, 'rank_math_focus_keyword'),
      slug: string(seo.slug, 'slug'),
      seoTitle: string(seo.rank_math_title, 'rank_math_title'),
      metaDescription: string(seo.rank_math_description, 'rank_math_description'),
    });
    await completeTopic(topic.id, draft.id);
    return { topic, article: draft };
  } catch (error: any) {
    await failTopic(topic.id, error.message || 'Onbekende fout', 'Claude schrijven');
    throw error;
  }
}
