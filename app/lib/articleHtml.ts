function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function plainText(value: string): string {
  return value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

export function hasEditorialFormatting(html: string): boolean {
  return /<h2\b/i.test(html) || /<blockquote\b/i.test(html);
}

// Standaardartikelen krijgen altijd dezelfde redactionele WordPress-opmaak:
// de lede is een H2 en de door Claude gevalideerde pull-quote volgt na de
// tweede tekstalinea. De quote blijft ook in de lopende tekst staan; een
// pull-quote is nadruk, geen vervanging van de oorspronkelijke zin.
export function formatStandardArticleHtml(content: string, quote: string): string {
  const paragraphs = content.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  if (paragraphs.length < 2) throw new Error('Artikel heeft minimaal twee alinea’s nodig voor de redactionele opmaak.');

  const blocks = paragraphs.map((paragraph, index) => index === 0
    ? `<h2>${paragraph.replace(/\n/g, '<br>')}</h2>`
    : `<p>${paragraph.replace(/\n/g, '<br>')}</p>`);
  blocks.splice(2, 0, `<blockquote><p>${escapeHtml(plainText(quote))}</p></blockquote>`);
  return blocks.join('\n');
}

export function formatExistingStandardArticleHtml(html: string, quote: string): string | null {
  if (hasEditorialFormatting(html)) return null;
  const paragraphRe = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  const paragraphs = [...html.matchAll(paragraphRe)];
  if (paragraphs.length < 2 || !plainText(quote)) return null;

  const blocks = paragraphs.map((match, index) => index === 0
    ? `<h2>${match[1]}</h2>`
    : `<p>${match[1]}</p>`);
  blocks.splice(2, 0, `<blockquote><p>${escapeHtml(plainText(quote))}</p></blockquote>`);
  return blocks.join('\n');
}
