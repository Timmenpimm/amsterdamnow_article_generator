function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function plainText(value: string): string {
  return value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

export function hasEditorialFormatting(html: string): boolean {
  return /<h2\b/i.test(html) || /<blockquote\b/i.test(html);
}

// Het quote-blok. Zonder attributie exact de opmaak van vóór het
// echte-quote-pad: één blockquote met de pull-quote, verder niets — bestaande
// drafts mogen niet ineens anders renderen. Mét attributie (een échte,
// letterlijke uitspraak uit de research, inclusief wie het zei) komt daar een
// <cite>-regel bij, met dezelfde em-dash-conventie als het lijstartikel
// (listHtml.ts: quote &#8212; bron), zodat beide artikeltypes er hetzelfde
// uitzien.
function quoteBlock(quote: string, attributie?: string): string {
  const cite = attributie?.trim()
    ? `<cite>&#8212; ${escapeHtml(plainText(attributie))}</cite>`
    : '';
  return `<blockquote><p>${escapeHtml(plainText(quote))}</p>${cite}</blockquote>`;
}

// Standaardartikelen krijgen altijd dezelfde redactionele WordPress-opmaak:
// de lede is een H2 en de door Claude gevalideerde pull-quote volgt na de
// tweede tekstalinea. De quote blijft ook in de lopende tekst staan; een
// pull-quote is nadruk, geen vervanging van de oorspronkelijke zin.
// `attributie` is optioneel: alleen gevuld als de quote een geverifieerde
// bronuitspraak is ("eigenaar Lasse Jensen in Het Parool").
export function formatStandardArticleHtml(content: string, quote: string, attributie?: string): string {
  const paragraphs = content.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  if (paragraphs.length < 2) throw new Error('Artikel heeft minimaal twee alinea’s nodig voor de redactionele opmaak.');

  const blocks = paragraphs.map((paragraph, index) => index === 0
    ? `<h2>${paragraph.replace(/\n/g, '<br>')}</h2>`
    : `<p>${paragraph.replace(/\n/g, '<br>')}</p>`);
  blocks.splice(2, 0, quoteBlock(quote, attributie));
  return blocks.join('\n');
}

// Zelfde verhaal voor de backfill van oudere drafts (wp.ts): de bestaande
// aanroep met twee argumenten levert byte-voor-byte dezelfde HTML als eerst.
export function formatExistingStandardArticleHtml(html: string, quote: string, attributie?: string): string | null {
  if (hasEditorialFormatting(html)) return null;
  const paragraphRe = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  const paragraphs = [...html.matchAll(paragraphRe)];
  if (paragraphs.length < 2 || !plainText(quote)) return null;

  const blocks = paragraphs.map((match, index) => index === 0
    ? `<h2>${match[1]}</h2>`
    : `<p>${match[1]}</p>`);
  blocks.splice(2, 0, quoteBlock(quote, attributie));
  return blocks.join('\n');
}
