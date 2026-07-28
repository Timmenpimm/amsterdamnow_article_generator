import type { ListArticleStructure } from './types';
import type { ImageNameContext } from './mediaName';
import { imageAltName, listItemNameContext } from './mediaName';
import { decodeHtmlEntities } from './htmlEntities';

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

// De omgekeerde weg van assembleListHtml: haalt uit de artikel-HTML terug welke
// foto bij welke zaak hoort. Nodig voor lijstartikelen die de tool niet zelf
// heeft geschreven — daarvoor bestaat er geen rij in list_articles, dus is de
// gepubliceerde HTML de enige bron. De carousel-engine deelt de foto's anders op
// volgorde uit, en dat gaat mis zodra het model niet de eerste items kiest maar
// de sterkste.
//
// Het contract is dat van assembleListHtml hierboven: per item een <h2> met de
// naam, daarna een <p>, daarna de itemfoto in een eigen <p>. Gekoppeld wordt de
// <h2> aan de eerstvolgende <img> die vóór de volgende <h2> staat — een item
// zonder foto pikt zo nooit de foto van het volgende item in. title/alt bevatten
// meestal ook de naam, maar niet altijd: staat de naamcontext van het artikel
// erbij, dan krijgen ze de AmsterdamNOW-conventienaam
// ({venue-slug}-{type}-{plaats}_{n}). Daarom telt alleen de positie.
const H2_OR_IMG_RE = /<h2\b[^>]*>([\s\S]*?)<\/h2>|<img\b[^>]*>/gi;
const IMG_SRC_ATTR_RE = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

export interface ListItemImage {
  naam: string;
  imageUrl: string;
}

export function parseListItemImages(contentHtml: string): ListItemImage[] {
  const out: ListItemImage[] = [];
  const seenNames = new Set<string>();
  let pendingName: string | null = null;

  H2_OR_IMG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = H2_OR_IMG_RE.exec(contentHtml || '')) !== null) {
    // match[1] is alleen gezet voor de <h2>-tak van de alternatie.
    if (match[1] !== undefined) {
      const naam = decodeHtmlEntities(match[1].replace(/<[^>]*>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim();
      pendingName = naam || null;
      continue;
    }
    if (!pendingName) continue;

    const srcM = match[0].match(IMG_SRC_ATTR_RE);
    const url = decodeHtmlEntities(srcM?.[1] ?? srcM?.[2] ?? srcM?.[3] ?? '').trim();
    // De naam is hoe dan ook verbruikt: een <h2> koppelt aan hooguit één foto,
    // ook als die foto geen bruikbare src blijkt te hebben.
    const naam = pendingName;
    pendingName = null;
    if (!url || seenNames.has(naam)) continue;
    seenNames.add(naam);
    out.push({ naam, imageUrl: url });
  }

  return out;
}
