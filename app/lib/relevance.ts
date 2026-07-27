// Onderwerprelevantie van researchbronnen (writer.ts stepResearch en
// stepResearchAanvullend).
//
// Aanleiding (productie, 26-07-2026): de profielqueries van de verdiepingsronde
// ("<naam> line-up programma") halen regelmatig pagina's over VREEMDE
// onderwerpen binnen — bij "Wolvenroedel … ADE … Fabrique des Lumières" kwam er
// een DGTL-festivalpagina mee, waarna de invalshoek-poort het topic afkeurde op
// een "tegenspraak" over DGTL-data die niets met het onderwerp te maken had.
// Alle bronnen gingen tot nu toe ongefilterd via describeSources de
// invalshoek- en schrijfprompt in; dit bestand is het ontbrekende
// relevantiefilter.
//
// Methode: token-overlap, zelfde familie als de Dice-logica in lib/dedup.ts
// maar asymmetrisch — een bron is relevant zodra hij ook maar één
// onderscheidende onderwerptoken bevat (in titel, URL of het begin van de
// content). Substring-match in plaats van token-gelijkheid, zodat "lumieres"
// ook het aaneengeschreven domein "fabriquedeslumieres.com" raakt.
//
// Puur en zonder I/O gehouden zodat het los testbaar is
// (scripts/relevance.test.mjs).

// Woorden die in vrijwel elke Amsterdamse agenda-/horecapagina staan en dus
// niets zeggen over of een bron over HET onderwerp gaat. Bewust breder dan de
// stopwoorden van dedup.ts: daar gaat het om titel-op-titel-vergelijking,
// hier om "gaat deze willekeurige webpagina over dit onderwerp" — generieke
// domeinwoorden als "festival" of "museum" staan óók op de pagina van elk
// ander festival of museum.
const STOPWOORDEN = new Set([
  'amsterdam', 'nederland', 'netherlands', 'holland',
  'festival', 'museum', 'musea', 'restaurant', 'theater', 'winkel', 'store',
  'event', 'events', 'evenement', 'evenementen', 'tickets', 'agenda',
  'expositie', 'tentoonstelling', 'voorstelling', 'concert', 'club',
  'nieuw', 'nieuwe', 'opent', 'opening', 'editie', 'gratis',
  'nachtleven', 'uitgaan', 'cultuur', 'lifestyle', 'shop', 'markt', 'cafe',
  'this', 'that', 'with', 'from', 'voor', 'naar', 'over', 'door', 'jaar',
]);

// Diacritics strippen via NFD-decompositie (é → e + combining accent, dat
// laatste valt in U+0300–U+036F). Zelfde aanpak als dedup.ts.
function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normaliseer(s: string): string {
  return stripDiacritics(String(s || '').toLowerCase()).replace(/[^a-z0-9\s]+/g, ' ');
}

// Onderscheidende tokens van het onderwerp: uit de wachtrijtitel én de
// gecanoniseerde naam_locatie, genormaliseerd, gededupliceerd, minimaal
// 4 tekens (net als topicTokens in tavily.ts — korter matcht te veel per
// ongeluk als substring) en zonder generieke domeinwoorden.
export function onderwerpTokens(...namen: (string | null | undefined)[]): string[] {
  const gezien = new Set<string>();
  const tokens: string[] = [];
  for (const naam of namen) {
    for (const token of normaliseer(naam || '').split(/\s+/)) {
      if (token.length < 4 || STOPWOORDEN.has(token) || gezien.has(token)) continue;
      gezien.add(token);
      tokens.push(token);
    }
  }
  return tokens;
}

export interface RelevantieBron {
  title: string;
  url: string;
  content: string;
}

// Hoeveel tekens van de content meetellen. De naam van het onderwerp staat op
// een echt relevante pagina vrijwel altijd bovenaan; de hele content meenemen
// zou een lange pagina die het onderwerp één keer terloops noemt (agenda-
// overzicht met twintig events) ten onrechte relevant maken.
const CONTENT_VENSTER = 2000;

// Gaat deze bron (waarschijnlijk) over het onderwerp? Eén overlappende token
// in titel, URL of het begin van de content volstaat: het filter moet alleen
// bronnen weren die aantoonbaar over iets ánders gaan (DGTL-pagina bij een
// Wolvenroedel-onderwerp), niet streng cureren — dat doet de extractie zelf.
export function bronIsRelevant(bron: RelevantieBron, tokens: string[]): boolean {
  if (!tokens.length) return true; // geen onderscheidende tokens → niet filteren
  const hooiberg = normaliseer(`${bron.title} ${bron.url} ${(bron.content || '').slice(0, CONTENT_VENSTER)}`)
    // Spaties óók verwijderd meenemen, zodat "fabrique des lumieres" als token
    // "fabriquedeslumieres" in een domeinnaam of slug terugvindt en andersom.
    .replace(/\s+/g, ' ');
  const aaneen = hooiberg.replace(/ /g, '');
  return tokens.some(token => hooiberg.includes(token) || aaneen.includes(token));
}

// Filtert bronnen op onderwerprelevantie. Robuustheidskeuze: blijven er
// minstens `minBronnen` relevante bronnen over, dan vallen de irrelevante weg;
// zo niet, dan komen de irrelevante als LAATSTE terug (gedegradeerd) in plaats
// van weggegooid — liever een dunne bron dan helemaal geen research, en de
// belangrijkste posities (die describeSources vooraan zet en waar trimSources
// op afkapt) blijven voor de relevante bronnen. Met minBronnen 0 is het filter
// strikt: alles zonder overlap valt weg (de verdiepingsronde gebruikt dat —
// daar liggen de ronde-1-bronnen al als vangnet).
export function filterOpRelevantie<T extends RelevantieBron>(
  bronnen: T[], tokens: string[], minBronnen = 2,
): T[] {
  const relevant: T[] = [];
  const rest: T[] = [];
  for (const bron of bronnen) (bronIsRelevant(bron, tokens) ? relevant : rest).push(bron);
  return relevant.length >= minBronnen ? relevant : [...relevant, ...rest];
}

// Onderscheidende zoektermen uit een lopende NL-zin (de afwijsreden van de
// invalshoek-poort), voor de gerichte herstelronde: stopwoorden en korte
// woorden eruit, hooguit `max` termen. Geen normalisatie naar lowercase-only
// nodig voor een zoekmachine, maar wel dezelfde token-regels als hierboven
// zodat er geen ruis ("de", "een", "artikel") in de query belandt.
export function kernwoorden(zin: string, max = 6): string {
  const eigen = new Set(['research', 'artikel', 'onderwerp', 'verhaal', 'concreet', 'concrete', 'bronnen', 'weinig', 'alleen', 'geen', 'zonder', 'ontbreekt', 'ontbreken', 'marketingtaal', 'generiek', 'generieke']);
  return normaliseer(zin).split(/\s+/)
    .filter(t => t.length >= 4 && !STOPWOORDEN.has(t) && !eigen.has(t))
    .slice(0, max)
    .join(' ');
}
