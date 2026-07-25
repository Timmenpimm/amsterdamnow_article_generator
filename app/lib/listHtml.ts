import type { ListArticleStructure } from './types';
import type { ImageNameContext } from './mediaName';
import { imageAltName, listItemNameContext } from './mediaName';

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
// Buurt</em>", itemfoto's als eigen alinea in WordPress-classic markup
// (wp-image-{id} class voor srcset/responsive), quotes als eenregelige
// blockquote (cursieve quote — bron) ertussen.
//
// `ctx` is de naamcontext van het artikel (categorie/stad); is die er, dan
// krijgen title en alt van de itemfoto's de AmsterdamNOW-conventienaam
// ({venue-slug}-{type}-{plaats}_{n}) in plaats van de kale itemnaam. De
// parameter is optioneel zodat aanroepers die de context niet bij de hand
// hebben (lib/listWriter.ts assembleert vóór het beeldwerk) hun huidige
// gedrag houden.
export function assembleListHtml(s: ListArticleStructure, ctx?: ImageNameContext): string {
  const parts: string[] = [];
  if (s.inleiding.trim()) parts.push(`<p>${escapeHtml(s.inleiding.trim())}</p>`);
  for (const [itemIndex, item] of s.items.entries()) {
    parts.push(`<h2>${escapeHtml(item.naam)}</h2>`);
    const adres = [item.adres, item.buurt].filter(Boolean).join(', ') + (item.extra_info ? `. ${item.extra_info}` : '');
    parts.push(`<p>${linkedDescription(item.naam, item.beschrijving, item.interne_link)} &#8212; <em>${escapeHtml(adres)}</em></p>`);
    if (item.media) {
      const media = item.media;
      // Zelfde index als waarmee de itemfoto geüpload is (itemIndex + 1), zodat
      // de alt-tekst in de content exact gelijk blijft aan de mediatitel/-slug
      // in WordPress, ook nadat een foto vervangen is.
      const naam = ctx
        ? imageAltName(listItemNameContext(ctx, item.naam, item.buurt), itemIndex + 1)
        : item.naam;
      parts.push(
        `<p><img class="alignnone wp-image-${media.id} size-full" title="${escapeAttr(naam)}" src="${escapeAttr(media.url)}" alt="${escapeAttr(naam)}" /></p>`
      );
    }
    if (item.quote) {
      parts.push(`<blockquote><p><em>&#8220;${escapeHtml(item.quote.tekst)}&#8221;</em> &#8212; ${escapeHtml(item.quote.bron)}</p></blockquote>`);
    }
  }
  if (s.afsluiting.trim()) parts.push(`<p>${escapeHtml(s.afsluiting.trim())}</p>`);
  return parts.join('\n');
}
