// Concurrenten van Amsterdam NOW: stadsgidsen, uitagenda's en contentplatforms
// die hetzelfde publiek bedienen. Hun pagina's zijn zelf redactie, geen bron.
//
// Waarom deze lijst bestaat (artikel 87365, 25-07-2026): de bronscanner haalde
// de kop "Museumagenda Amsterdam juli 2026: 18 X tentoonstellingstips" van
// ylbb.nl binnen. De research zocht daarop, vond als beste treffer het
// YLBB-artikel zelf, en tavily.ts verklaarde die site tot "officiële site" van
// het onderwerp. Vanaf dat moment was Your Little Black Book de entiteit:
// naam_locatie, website, focus-keyword, titel, slug, meta-description en de
// beeld-zoekopdracht liepen allemaal op hun merknaam. Er was wél een
// blacklist, maar die gold alleen voor quotes.
//
// Vandaar: één lijst, en op elke plek waar iets van buiten naar binnen komt
// een controle. Bronnen scannen we nog steeds — daar staan echte tips in —
// maar er mag niets van hén in ons artikel belanden: geen research-bron, geen
// entiteit, geen tekst, geen quote, geen beeld.
//
// Bewuste afweging bij de tekstcontrole: een merknaam als "Time Out" kan in
// theorie ook als gewoon woord voorbijkomen ("een time-out"). Zo'n afkeuring
// kost één herschrijfronde en is zichtbaar in de foutmelding; een concurrent
// die ongemerkt in de tekst blijft staan kost meer. De lijst blijft daarom
// uniform: wat hier staat, blokkeert overal.

export type Competitor = {
  /** Weergavenaam in foutmeldingen. */
  naam: string;
  /** Hostnames (zonder www). Ook subdomeinen tellen mee. */
  domeinen: string[];
  /** Merknaam-varianten zoals ze in tekst, bronvermeldingen en credits staan. */
  aliassen: string[];
};

export const COMPETITORS: Competitor[] = [
  {
    naam: 'Your Little Black Book',
    domeinen: ['yourlittleblackbook.me', 'ylbb.nl'],
    aliassen: ['your little black book', 'yourlittleblackbook', 'ylbb'],
  },
  {
    naam: 'Barts Boekje',
    domeinen: ['bartsboekje.nl'],
    aliassen: ['barts boekje', 'bartsboekje'],
  },
  {
    naam: 'Indebuurt',
    domeinen: ['indebuurt.nl'],
    aliassen: ['indebuurt'],
  },
  {
    naam: 'I amsterdam',
    domeinen: ['iamsterdam.com', 'iamsterdam.nl'],
    aliassen: ['iamsterdam', 'i amsterdam'],
  },
  {
    naam: 'Time Out',
    domeinen: ['timeout.com', 'timeout.nl'],
    aliassen: ['time out', 'timeout'],
  },
  {
    naam: 'Cityguys',
    domeinen: ['cityguys.nl'],
    aliassen: ['cityguys'],
  },
  {
    naam: 'Dagjeweg',
    domeinen: ['dagjeweg.nl'],
    aliassen: ['dagjeweg'],
  },
  {
    naam: 'Awesome Amsterdam',
    domeinen: ['awesomeamsterdam.com'],
    aliassen: ['awesome amsterdam'],
  },
  {
    naam: 'Amsterdam Lokaal',
    domeinen: ['amsterdamlokaal.nl'],
    aliassen: ['amsterdamlokaal', 'amsterdam lokaal'],
  },
  {
    naam: 'Kidsproof',
    domeinen: ['kidsproof.nl'],
    aliassen: ['kidsproof'],
  },
  {
    naam: 'Roadbook',
    domeinen: ['roadbook.nl'],
    aliassen: ['roadbook'],
  },
];

// De platte alias-lijst. Bestaat voor de quote-controle in validation.ts, die
// al met losse strings werkte (StandaardConstraints.quoteSourceBlacklist) en
// die vorm houdt zodat opgeslagen constraint-versies blijven werken.
export const COMPETITOR_ALIASSEN: string[] = COMPETITORS.flatMap(c => c.aliassen);

// Lowercase, leestekens en accenten weg, alles op enkele spaties. Zo matcht
// "Your Little Black Book!", "yourlittleblackbook.me" en "YLBB — Amsterdam"
// allemaal op dezelfde manier.
function normaliseer(value: string): string {
  return (value || '')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('nl-NL')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Spaties eromheen zodat een alias nooit middenin een ander woord matcht
// ("ylbb" mag niet aanslaan op "stylbbq").
function bevat(haystack: string, needle: string): boolean {
  const n = normaliseer(needle);
  return n.length > 1 && ` ${haystack} `.includes(` ${n} `);
}

// Extra termen komen uit de instellingen (quoteSourceBlacklist): wat de
// redactie daar toevoegt, blokkeert net zo hard als de ingebouwde lijst.
function extraNeedles(extra: string[]): string[] {
  return (extra || []).map(e => (e || '').trim()).filter(Boolean);
}

/**
 * De naam van de concurrent die in een van de teksten voorkomt, of null.
 * Geschikt voor vrije tekst, bronvermeldingen, credits en losse veldwaarden.
 */
export function competitorInTekst(waarden: (string | null | undefined)[], extra: string[] = []): string | null {
  const haystack = normaliseer(waarden.filter(Boolean).join(' '));
  if (!haystack) return null;
  for (const c of COMPETITORS) {
    if (c.aliassen.some(a => bevat(haystack, a))) return c.naam;
    // Domeinen ook als tekst: een kale URL of "· ylbb.nl" in een credit.
    if (c.domeinen.some(d => bevat(haystack, d))) return c.naam;
  }
  for (const term of extraNeedles(extra)) {
    if (bevat(haystack, term)) return term;
  }
  return null;
}

/**
 * De naam van de concurrent die deze URL host, of null. Kijkt alleen naar de
 * hostname: een pagina die een concurrent noemt is geen concurrent-pagina.
 * Een onbruikbare URL geldt niet als concurrent (de aanroeper filtert die al
 * op andere gronden).
 */
export function competitorInHost(url: string | null | undefined, extra: string[] = []): string | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
  for (const c of COMPETITORS) {
    if (c.domeinen.some(d => host === d || host.endsWith(`.${d}`))) return c.naam;
  }
  for (const term of extraNeedles(extra)) {
    const t = term.trim().toLowerCase();
    // Alleen domeinachtige extra-termen op de host toepassen; een losse
    // merknaam ("barts boekje") zegt niets over een hostname.
    if (t.includes('.') && (host === t || host.endsWith(`.${t}`))) return term;
  }
  return null;
}

/** Host óf tekst: de brede controle voor bronnen, beeldkandidaten en credits. */
export function competitorInBron(
  velden: { url?: string | null; tekst?: (string | null | undefined)[] },
  extra: string[] = [],
): string | null {
  return competitorInHost(velden.url, extra) ?? competitorInTekst(velden.tekst ?? [], extra);
}
