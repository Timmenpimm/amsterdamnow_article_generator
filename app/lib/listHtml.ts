import type { ListArticleStructure } from './types';

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

// Linkt de eerste vermelding van de itemnaam in de beschrijving naar een
// bestaand AmsterdamNOW-artikel, zoals in de gepubliceerde lijstartikelen.
function linkedDescription(naam: string, beschrijving: string, link?: string): string {
  const safe = escapeHtml(beschrijving);
  if (!link) return safe;
  const safeNaam = escapeHtml(naam);
  const idx = safe.indexOf(safeNaam);
  if (idx < 0) return safe;
  return `${safe.slice(0, idx)}<a href="${escapeAttr(link)}">${safeNaam}</a>${safe.slice(idx + safeNaam.length)}`;
}

// Assembleert de WordPress-content van een lijstartikel, in exact het formaat
// van de bestaande gepubliceerde lijstartikelen op amsterdamnow.com:
// inleiding-alinea, per item een H2 + beschrijving eindigend op "— <em>adres,
// Buurt</em>", itemfoto's als eigen alinea, quotes als blockquote ertussen.
export function assembleListHtml(s: ListArticleStructure): string {
  const parts: string[] = [];
  if (s.inleiding.trim()) parts.push(`<p>${escapeHtml(s.inleiding.trim())}</p>`);
  for (const item of s.items) {
    parts.push(`<h2>${escapeHtml(item.naam)}</h2>`);
    const adres = [item.adres, item.buurt].filter(Boolean).join(', ') + (item.extra_info ? `. ${item.extra_info}` : '');
    parts.push(`<p>${linkedDescription(item.naam, item.beschrijving, item.interne_link)} &#8212; <em>${escapeHtml(adres)}</em></p>`);
    if (item.media) {
      parts.push(`<p><img src="${escapeAttr(item.media.url)}" alt="${escapeAttr(item.naam)}" /></p>`);
    }
    if (item.quote) {
      parts.push(`<blockquote><p>&#8220;${escapeHtml(item.quote.tekst)}&#8221;</p><p>&#8212; ${escapeHtml(item.quote.bron)}</p></blockquote>`);
    }
  }
  if (s.afsluiting.trim()) parts.push(`<p>${escapeHtml(s.afsluiting.trim())}</p>`);
  return parts.join('\n');
}
