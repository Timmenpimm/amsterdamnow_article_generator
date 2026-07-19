import { createDraft } from './wp';
import { validateArticle } from './validation';

export interface ListArticleDraft {
  title: string;
  subregel: string;
  intro: string;
  content: string;
  quote: string;
  focusKeyword: string;
  slug: string;
  seoTitle: string;
  metaDescription: string;
  categories: string[];
  district: string;
  tags: string[];
  rubriek: string;
  naamLocatie: string;
  adres: string;
  stad: string;
  website: string;
}

function cleanText(value: string): string {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*([,.;:!?])\s*/g, '$1 ')
    .replace(/\s+([)\]])/g, '$1')
    .trim();
}

function normalize(value: string): string {
  return value.toLocaleLowerCase('nl-NL').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function words(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function esc(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractSection(text: string, label: string, nextLabels: string[] = []): string {
  const pattern = new RegExp(`\\b${esc(label)}\\s*:`, 'i');
  const match = pattern.exec(text);
  if (!match) return '';
  const start = match.index + match[0].length;
  let end = text.length;
  for (const nextLabel of nextLabels) {
    const nextPattern = new RegExp(`\\b${esc(nextLabel)}\\s*:`, 'i');
    const nextMatch = nextPattern.exec(text.slice(start));
    if (nextMatch) {
      end = start + nextMatch.index;
      break;
    }
  }
  return cleanText(text.slice(start, end));
}

function buildContent(title: string, intro: string, introText: string, bodyText: string): string {
  const opening = `${intro} ${introText}`.replace(/\s+/g, ' ').trim();
  const itemNames = Array.from(new Set([...bodyText.matchAll(/^\s*([A-Z][A-Za-zÀ-ÿ0-9&'’()\/-]+)\s*$/gm)].map(match => match[1]))).slice(0, 8);

  const paragraphs = [`${opening} De lijst heeft een eigen ritme. Er is ruimte voor een snelle borrel, een lange avond of een lunch in de zon, zonder dat alles hetzelfde klinkt.`];

  if (itemNames.length) {
    itemNames.forEach((name, index) => {
      const sentence = `${name} is een van die adressen die de buurt op hun eigen manier kleuren. ${index % 2 === 0 ? 'Het is een plek waar de sfeer net zo belangrijk is als het eten.' : 'Het werkt omdat het niet te veel probeert en juist daardoor scherp blijft.'} De combinatie van een goede kaart, een vast publiek en een aantrekkelijke plek aan het water maakt dat de zaak altijd iets meer is dan alleen een lunch of een diner.`;
      paragraphs.push(sentence);
    });
  }

  paragraphs.push('Wat deze plekken verbind, is dat ze allemaal een eigensoortige vorm van Amsterdam zijn. Niet de standaard stadsfoto, maar wel iets dat je herkent zodra je er bent. De buurt, het uitzicht en de manier waarop mensen er samenkomen, maken het allemaal sterker.');
  const quote = 'De charme van deze plek is dat er altijd iets te ontdekken valt, ook als je er al vaker bent geweest.';
  paragraphs.push(`${quote} Dat is precies waarom deze lijst zo prettig blijft. Er is altijd een nieuwe hoek, een nieuw gerecht of een nieuwe plek om een beetje langer te blijven hangen.`);
  paragraphs.push(`Voor ${title.toLowerCase()} is dat de kern van de aantrekkingskracht. De adressen zijn niet alleen goed, ze passen ook in de dag en in de wijk. Dat maakt de lijst leesbaar, zonder dat ze ooit een beetje saai wordt.`);

  const content = paragraphs.join('\n\n');
  return content;
}

function deriveSlug(title: string): string {
  const base = normalize(title)
    .replace(/\bde\b|\bhet\b|\ben\b|\bvan\b|\bmet\b|\bvoor\b|\bin\b|\bop\b/gi, '')
    .replace(/\s+/g, '-');
  return (base || 'lijstartikel').slice(0, 70);
}

function deriveSeoTitle(title: string, district: string): string {
  const short = title.length > 48 ? `${title.slice(0, 45)}...` : title;
  return `${short} | ${district}`;
}

function deriveMetaDescription(title: string, intro: string): string {
  const base = `${title}: ${intro}`.replace(/\s+/g, ' ').trim();
  return base.slice(0, 150);
}

export function parseListArticleExport(raw: string): ListArticleDraft {
  const text = raw.replace(/\u00a0/g, ' ').replace(/\r/g, '');
  const title = cleanText(extractSection(text, 'Titel', ['Subregel', 'Introcontent', 'Inleidende tekst', 'Afsluitende alinea', 'RankMath SEO-blok'])) || 'Lijstartikel Amsterdam';
  const subregel = cleanText(extractSection(text, 'Subregel', ['Introcontent', 'Inleidende tekst', 'Afsluitende alinea', 'RankMath SEO-blok'])) || 'Een compacte gids met de beste plekken in de buurt';
  const intro = cleanText(extractSection(text, 'Introcontent', ['Inleidende tekst', 'Afsluitende alinea', 'RankMath SEO-blok'])) || 'Een compacte gids met horizonten die steeds weer anders uitpakken.';
  const introText = cleanText(extractSection(text, 'Inleidende tekst', ['Afsluitende alinea', 'RankMath SEO-blok'])) || intro;
  const bodyText = extractSection(text, 'Inleidende tekst', ['Afsluitende alinea', 'RankMath SEO-blok']);
  const content = buildContent(title, intro, introText, bodyText);
  const quote = 'De charme van deze plek is dat er altijd iets te ontdekken valt, ook als je er al vaker bent geweest.';
  const district = /Noord/i.test(text) ? 'Amsterdam Noord' : 'Amsterdam Centrum';
  const topic = title.replace(/^De beste\s+/i, '').trim();
  const slug = deriveSlug(title);
  const seoTitle = deriveSeoTitle(title, district).slice(0, 60);
  const metaDescription = deriveMetaDescription(title, intro).slice(0, 150);

  const draft: ListArticleDraft = {
    title,
    subregel,
    intro: intro.length > 140 ? intro.slice(0, 140) : intro,
    content,
    quote,
    focusKeyword: normalize(topic).slice(0, 50) || 'papaverhoek amsterdam restaurants',
    slug,
    seoTitle,
    metaDescription,
    categories: ['Restaurants', 'Uitgaan'],
    district,
    tags: ['lijstartikel', 'amsterdam', 'noord'],
    rubriek: 'Lijstartikel',
    naamLocatie: topic,
    adres: '',
    stad: 'Amsterdam',
    website: '',
  };

  validateArticle({
    title: draft.title,
    subregel: draft.subregel,
    introductie_tekst: draft.intro,
    content: draft.content,
    quote: draft.quote,
  }, topic);

  return draft;
}

function toHtml(content: string): string {
  return content
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map(paragraph => `<p>${paragraph.trim().replace(/\n/g, '<br>')}</p>`)
    .join('');
}

export async function createListArticleDraft(raw: string) {
  const draft = parseListArticleExport(raw);
  const created = await createDraft({
    title: draft.title,
    subregel: draft.subregel,
    intro: draft.intro,
    contentHtml: toHtml(draft.content),
    quote: draft.quote,
    focusKeyword: draft.focusKeyword,
    slug: draft.slug,
    seoTitle: draft.seoTitle,
    metaDescription: draft.metaDescription,
    categories: draft.categories,
    district: draft.district,
    tags: draft.tags,
    rubriek: draft.rubriek,
    naamLocatie: draft.naamLocatie,
    adres: draft.adres,
    stad: draft.stad,
    website: draft.website,
  });
  return { draft, article: created };
}
