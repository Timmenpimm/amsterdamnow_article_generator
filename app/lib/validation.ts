export type GeneratedArticle = {
  title: string; subregel: string; introductie_tekst: string; content: string; quote: string;
};

function words(value: string) {
  return value.replace(/<[^>]*>/g, ' ').trim().split(/\s+/).filter(Boolean).length;
}

function normal(value: string) {
  return value.toLocaleLowerCase('nl-NL').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function range(label: string, value: string, min: number, max: number) {
  const count = words(value);
  if (count < min || count > max) throw new Error(`${label} moet ${min}-${max} woorden bevatten (nu ${count}).`);
}

export function validateArticle(article: GeneratedArticle, topic: string) {
  range('Titel', article.title, 8, 12);
  range('Subregel', article.subregel, 10, 15);
  range('Introductie', article.introductie_tekst, 40, 60);
  range('Artikeltekst', article.content, 400, 450);
  range('Quote', article.quote, 15, 25);
  if (!normal(article.title).includes(normal(topic))) throw new Error('De titel moet de naam van het onderwerp bevatten.');
  if (!normal(article.content).includes(normal(article.quote))) throw new Error('De quote moet letterlijk in de artikeltekst voorkomen.');
  if ([article.title, article.subregel, article.introductie_tekst, article.content, article.quote].some(v => /[—–]/.test(v))) {
    throw new Error('Een artikel mag geen em dash of en dash bevatten.');
  }
  if (/\bAmsterdam\b/i.test(`${article.title} ${article.subregel} ${article.introductie_tekst}`)) {
    throw new Error('Amsterdam mag niet in titel, subregel of introductie staan.');
  }
  if (article.content.split(/\n\s*\n/).filter(Boolean).length < 5) throw new Error('Artikeltekst moet uit minimaal vijf alinea’s bestaan.');
}
