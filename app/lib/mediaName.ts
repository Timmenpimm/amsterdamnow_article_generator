// Beeldnaamgeving volgens de vaste AmsterdamNOW-conventie.
//
// Op de oudere posts is beeld altijd op precies één manier benoemd:
// bestandsnaam == media-slug == media-titel == alt-tekst, allemaal exact
// dezelfde string:
//
//     {venue-slug}-{type}-{plaats}_{n}
//
// bijv. stadsbakkerij-as-winkel-amsterdam_1, caffe-toscanini-cafe-amsterdam_3,
// mark-restaurant-durgerdam_1. Die herhaling is geen slordigheid maar de bron
// van de beeld-SEO: Google Afbeeldingen leest bestandsnaam én alt, en de hele
// oude beeldbank is er consistent op ingericht. Nieuwe artikelen die door deze
// tool worden gepubliceerd moeten daar naadloos tussen passen, dus wordt de
// naam hier één keer, deterministisch (geen AI) samengesteld en door zowel de
// uploadkant (wp.ts) als de lijst-/artikelkant hergebruikt.
//
// Twee dingen die uit de live data blijken en makkelijk fout gaan:
//   1. `_n` is 1-based en loopt per artikel op zonder gaten. Er is géén vaste
//      positie voor het featured beeld — die kan elke index zijn.
//   2. Het type-token volgt de wérkelijke aard van de zaak, niet de
//      WP-categorie. Post 85844 staat in "Restaurants" maar heet
//      `...-winkel-...`; 85773 idem maar `...-cafe-...`. De artikel-slug is
//      daarom de eerste bron: die schrijft de AI al als
//      [naam]-[type]-[kenmerk]-[buurt]. De categorie is pas het laatste
//      redmiddel.

export interface ImageNameContext {
  naamLocatie?: string | null; // ACF naam_locatie — primaire bron voor de venue-slug
  title?: string | null;       // artikeltitel — fallback venue-slug
  slug?: string | null;        // artikel-slug, AI-gegenereerd als [naam]-[type]-[kenmerk]-[buurt]
  category?: string | null;    // WP-categorienamen, komma-gescheiden ("Restaurants, Uitgaan")
  district?: string | null;    // taxonomie district ("Amsterdam Noord")
  stad?: string | null;        // ACF stad, meestal "Amsterdam"
}

// Geobserveerde type-vocabulaire uit de live beeldbank. Enkelvoud, Nederlands.
// Bewust een gesloten lijst: liever géén type-token dan een verzonnen token —
// `kids-amsterdam_1` bestaat echt en is een geldige naam.
export const VENUE_TYPES: readonly string[] = [
  'restaurant',
  'cafe',
  'bar',
  'cocktailbar',
  'bistro',
  'lunchroom',
  'bakkerij',
  'branderij',
  'proeflokaal',
  'club',
  'festival',
  'winkel',
  'boutique',
  'markt',
  'museum',
  'tentoonstelling',
  'expositie',
  'theater',
  'voorstelling',
  'bioscoop',
  'ballet',
  'hotel',
  'zwembad',
  'gym',
  'pilates',
  'yoga',
  'speeltuin',
  'terras',
  'galerie',
];

// Alleen categorieën met één duidelijk dominant type in de live cross-tab.
// Lifestyle/Nieuws/Agenda e.d. staan er bewust niet in: daar is de spreiding
// zo breed dat een gok het beeld eerder verkeerd labelt dan goed.
export const CATEGORY_TYPE_MAP: Readonly<Record<string, string>> = {
  Restaurants: 'restaurant',
  Winkels: 'winkel',
  Cultuur: 'museum',
  Uitgaan: 'cafe',
};

// Extensietabel voor de bestandsnaam. Bewust een eigen kopie en niet die uit
// wp.ts geïmporteerd: wp.ts importeert juist van hier, en een cirkel tussen
// die twee is het niet waard. wp.ts hergebruikt deze export.
export const MEDIA_MIME_EXT: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/pjpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/heic': 'heic',
};

// Maximale lengte van de basisnaam (zonder _n en extensie). WordPress kapt
// zelf niet af, maar bestandsnamen van 150+ tekens breken uploads bij sommige
// hosts en lezen voor niemand prettig.
const MAX_BASE_LENGTH = 80;

const TYPE_SET = new Set(VENUE_TYPES);

// Tekens die NFD niet als los diakriet opsplitst.
const LOSSE_LETTERS: Record<string, string> = {
  ø: 'o',
  œ: 'oe',
  æ: 'ae',
  ß: 'ss',
  ł: 'l',
  đ: 'd',
  ð: 'd',
  þ: 'th',
};

// Leidende lidwoorden vallen weg: De Prael → prael, Het Bosch → bosch,
// 't Westerhuys → westerhuys, L'Entrecôte → entrecote. Zo staat het in de
// bestaande beeldbank, en zo zoekt een lezer de zaak ook.
const LEADING_ARTICLE_RE =
  /^(?:(?:de|het|een|the|la|le|les)[\s-]+|['’`´]?t[\s-]+|[ld]['’`´][\s-]*)/;

const APOSTROPHE_RE = /['’‘`´]/g;

function deaccent(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[øœæßłđðþ]/g, (c) => LOSSE_LETTERS[c] ?? c);
}

/** 'Caffè Toscanini' -> 'caffe-toscanini'; lege input -> '' */
export function slugifyName(input: string | null | undefined): string {
  if (input === null || input === undefined) return '';
  let s = deaccent(String(input));
  s = s.replace(LEADING_ARTICLE_RE, '');
  // Apostrof verdwijnt zónder scheidingsteken (Molly's → mollys); '&' en de
  // rest wél mét, waarna de run-collapse er één streepje van maakt
  // (Morgan & Mees → morgan-mees).
  s = s.replace(APOSTROPHE_RE, '');
  return s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Losse woorden uit vrije tekst of een slug, diakriet-ongevoelig. */
function toTokens(input: string | null | undefined): string[] {
  if (!input) return [];
  return deaccent(String(input))
    .replace(APOSTROPHE_RE, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Meervoud → enkelvoud, maar alleen als het resultaat een bekend type is.
// "restaurants"/"winkels"/"cafés" komen zo uit een titel, "terrassen" en
// "bakkerijen" uit een lijstartikel. Geen resultaat = geen type.
function singularType(word: string): string {
  if (TYPE_SET.has(word)) return word;
  if (word.endsWith('sen') && TYPE_SET.has(word.slice(0, -3))) return word.slice(0, -3);
  if (word.endsWith('en') && TYPE_SET.has(word.slice(0, -2))) return word.slice(0, -2);
  if (word.endsWith('s') && TYPE_SET.has(word.slice(0, -1))) return word.slice(0, -1);
  return '';
}

/** De venue-slug: naam_locatie wint, anders de artikeltitel. Kan '' zijn. */
function venueSlugFor(ctx: ImageNameContext): string {
  return slugifyName(ctx.naamLocatie) || slugifyName(ctx.title);
}

/** Type-token, of '' als niets betrouwbaars te vinden is. */
export function venueTypeFor(ctx: ImageNameContext): string {
  // 1. Uit de artikel-slug. Het venue-deel staat vooraan en wordt eerst
  //    weggestreept, anders zou "Restaurant Sinne" zijn eigen naam als type
  //    teruggeven in plaats van het type dat de AI erachter zette.
  const venueTokens = venueSlugFor(ctx).split('-').filter(Boolean);
  const slugTokens = toTokens(ctx.slug);
  const heeftVenuePrefix =
    venueTokens.length > 0 &&
    slugTokens.length >= venueTokens.length &&
    slugTokens.slice(0, venueTokens.length).join('-') === venueTokens.join('-');
  for (const token of heeftVenuePrefix ? slugTokens.slice(venueTokens.length) : slugTokens) {
    const type = singularType(token);
    if (type) return type;
  }

  // 2. Uit de titel of naam_locatie ("Restaurant Sinne", "de beste winkels").
  for (const text of [ctx.title, ctx.naamLocatie]) {
    for (const token of toTokens(text)) {
      const type = singularType(token);
      if (type) return type;
    }
  }

  // 3. Pas als laatste de WP-categorie, en alleen de eerste — die is leidend.
  const eersteCategorie = String(ctx.category ?? '').split(',')[0].trim().toLowerCase();
  if (eersteCategorie) {
    for (const [naam, type] of Object.entries(CATEGORY_TYPE_MAP)) {
      if (naam.toLowerCase() === eersteCategorie) return type;
    }
  }

  return '';
}

// De plaats is letterlijk 'amsterdam', nooit 'amsterdam-noord': een stadsdeel
// is in deze conventie hooguit een extra los token vóór de plaats, en nooit
// een vervanging ervan. Buiten de gemeente (Amstelveen, Durgerdam) telt de
// echte plaatsnaam. `district` blijft in v1 daarom volledig buiten de naam.
function plaatsFor(ctx: ImageNameContext): string {
  const stad = slugifyName(ctx.stad);
  if (!stad || stad === 'amsterdam' || stad.startsWith('amsterdam-')) return 'amsterdam';
  return stad;
}

/** 'stadsbakkerij-as-winkel-amsterdam' — zonder index, zonder extensie. */
export function imageBaseName(ctx: ImageNameContext): string {
  const venue = venueSlugFor(ctx) || 'amsterdamnow';
  const plaats = plaatsFor(ctx);
  const type = venueTypeFor(ctx);

  const venueTokens = venue.split('-').filter(Boolean);
  // "Restaurant Sinne" zou anders restaurant-sinne-restaurant-amsterdam
  // worden; het type staat dan al in de naam.
  const staart = venueTokens.includes(type) || !type ? plaats : `${type}-${plaats}`;

  // Inkorten gebeurt aan de venue-kant, op token-grens: type en plaats zijn
  // het deel waar de naamgeving op zoekt en blijven dus altijd staan.
  const ruimte = MAX_BASE_LENGTH - staart.length - 1;
  const behouden = [...venueTokens];
  while (behouden.length > 1 && behouden.join('-').length > ruimte) behouden.pop();
  let kop = behouden.join('-');
  if (kop.length > ruimte) kop = kop.slice(0, Math.max(1, ruimte)).replace(/-+$/, '');

  return [kop, staart].filter(Boolean).join('-');
}

/** 'stadsbakkerij-as-winkel-amsterdam_2' */
export function imageAltName(ctx: ImageNameContext, index: number): string {
  // 1-based en oplopend zonder gaten; een onbruikbare index is nog altijd
  // beter als _1 dan als _NaN in een bestandsnaam.
  const n = Number.isFinite(index) ? Math.max(1, Math.floor(index)) : 1;
  return `${imageBaseName(ctx)}_${n}`;
}

/** Zelfde string + extensie op basis van mime: 'stadsbakkerij-as-winkel-amsterdam_2.jpg' */
export function imageFileName(ctx: ImageNameContext, index: number, mime: string): string {
  // WordPress leidt het toegestane bestandstype af uit de extensie, dus die
  // moet er altijd zijn en bij het echte mime-type passen; onbekend → jpg.
  const type = String(mime ?? '').split(';')[0].trim().toLowerCase();
  const ext = MEDIA_MIME_EXT[type] || 'jpg';
  return `${imageAltName(ctx, index)}.${ext}`;
}

/** Variant voor itemfoto's van lijstartikelen: venue = de itemnaam. */
export function listItemNameContext(
  ctx: ImageNameContext,
  itemNaam: string,
  itemBuurt?: string | null,
): ImageNameContext {
  // Titel, slug en categorie van het lijstartikel blijven staan: de itemnaam
  // levert de venue, maar het type moet nog steeds uit het artikel komen
  // ("de beste restaurants van..." → restaurant). De buurt gaat naar
  // `district`, dat v1 niet in de naam verwerkt.
  return {
    ...ctx,
    naamLocatie: itemNaam,
    district: itemBuurt ?? ctx.district ?? null,
  };
}
