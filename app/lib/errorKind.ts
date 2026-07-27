// Foutclassificatie voor de wachtrij. Eén fout, vier soorten afhandeling:
//
// - 'infra'       omgeving/diensten (Tavily-quotum, netwerk, database, API-key):
//                 niet de schuld van het onderwerp — automatisch opnieuw
//                 inplannen (zie failTopicClassified in lib/db.ts) en bij een
//                 accountbrede conditie de hele wachtrij pauzeren.
// - 'data'        het onderwerp zelf deugt niet als invoer (geen bronnen,
//                 entiteit klopt niet, concurrent als onderwerp): de redactie
//                 moet titel/website aanpassen vóór een retry zin heeft.
// - 'inhoudelijk' de generatie of validatie keurde het resultaat af
//                 (invalshoek-poort, tegensprekende research, stijlchecks):
//                 een retry kán een ander resultaat geven.
// - 'definitief'  bewuste redactionele poort ("Event is voorbij", duplicaat):
//                 retry is per definitie zinloos; alleen aanpassen of
//                 verwijderen.
//
// De classificatie werkt op regex-patronen over de foutmelding, plus een
// duck-typed statuscheck voor fouten die een HTTP-status meedragen (zoals
// ProviderHttpError in lib/claude.ts en — zodra die bestaat — een
// TavilyHttpError in lib/tavily.ts). Er is bewust GEEN import uit tavily.ts
// of claude.ts: dit bestand moet ook classificeren als die helpers (nog) niet
// bestaan, en mag geen serverafhankelijkheden de client-bundel in trekken
// (Pipeline.tsx gebruikt classifyError voor oude rijen zonder error_kind).
//
// Onbekend → 'inhoudelijk': de veiligste default, want die triggert géén
// automatische herkansing en houdt de retry-knop beschikbaar.

export type ErrorKind = 'infra' | 'data' | 'inhoudelijk' | 'definitief';

interface DuckError {
  status?: unknown;
  name?: unknown;
  message?: unknown;
  code?: unknown;
}

function meldingVan(err: unknown): string {
  if (typeof err === 'string') return err;
  const e = err as DuckError | null;
  if (e && typeof e.message === 'string') return e.message;
  return String(err ?? '');
}

function codeVan(err: unknown): string {
  const e = err as DuckError | null;
  return e && typeof e.code === 'string' ? e.code : '';
}

// Bewuste redactionele poorten: het besluit staat vast, opnieuw proberen
// levert gegarandeerd dezelfde uitkomst op.
const DEFINITIEF_PATRONEN: RegExp[] = [
  /Event is voorbij/i,
  /Duplicaat van bestaand artikel/i,
];

// De invoer (titel/website van het onderwerp) is het probleem; pas die aan
// vóór een nieuwe poging.
const DATA_PATRONEN: RegExp[] = [
  /Entiteitscontrole faalt/i,
  /Onderwerp draagt de naam van concurrent/i,
  /aan als onderwerp; dat is een concurrerende stadsgids/i,
  /Alle gevonden bronnen komen van concurrerende stadsgidsen/i,
  /Tavily vond geen bruikbare bronnen/i,
];

// Omgeving/diensten. Zelfde familie als INFRA_PATRONEN in
// app/api/audit/tick/route.ts, uitgebreid met de meldingsvormen van de
// schrijfpipeline (Tavily-statuscodes, provider-statuscodes, WordPress-5xx,
// JSON-vangnet van lib/claude.ts).
const INFRA_PATRONEN: RegExp[] = [
  /Tavily (429|432|433|5\d\d)/i,
  /(Claude|Omniroute) (429|529|5\d\d)/i,
  /WordPress 5\d\d/i,
  /Omniroute onbereikbaar/i,
  /ECONNREFUSED/i,
  /ENOTFOUND/i,
  /EAI_AGAIN/i,
  /ETIMEDOUT/i,
  /\btime-?out\b/i,
  /FUNCTION_INVOCATION_TIMEOUT/i,
  /API[-_ ]?key/i,
  /niet geconfigureerd/i,
  /DATABASE_URL/i,
  /Connection terminated/i,
  /too many connections/i,
  /Claude gaf geen geldige JSON/i,
  /credit balance/i,
];

// Duck-typed statuscheck: herkent zowel ProviderHttpError (lib/claude.ts) als
// een toekomstige TavilyHttpError zonder van een van beide af te hangen.
function isInfraStatus(err: unknown): boolean {
  const e = err as DuckError | null;
  if (!e || typeof e.status !== 'number') return false;
  const status = e.status;
  const melding = meldingVan(err);
  const naam = typeof e.name === 'string' ? e.name : '';
  const isTavily = /tavily/i.test(naam) || /^Tavily\b/i.test(melding);
  // Tavily: 429 = rate limit, 432 = planlimiet, 433 = bestedingslimiet.
  if (isTavily) return status === 429 || status === 432 || status === 433 || status >= 500;
  if (status === 429 || status === 529 || status >= 500) return true;
  // Anthropic geeft "credit balance is too low" als 400 — zie
  // isCreditOrRateError in lib/claude.ts.
  if ((status === 400 || status === 403) && /credit/i.test(melding)) return true;
  return false;
}

export function classifyError(err: unknown): ErrorKind {
  const melding = meldingVan(err);
  const code = codeVan(err);
  if (DEFINITIEF_PATRONEN.some(p => p.test(melding))) return 'definitief';
  if (DATA_PATRONEN.some(p => p.test(melding))) return 'data';
  if (isInfraStatus(err)) return 'infra';
  if (INFRA_PATRONEN.some(p => p.test(melding) || (code && p.test(code)))) return 'infra';
  return 'inhoudelijk';
}

// Accountbrede quotum-/tegoedcondities: één zo'n fout betekent dat élk
// volgend onderwerp tegen dezelfde muur loopt. Geeft de leesbare reden terug
// (voor de wachtrij-pauze en de UI), of null als dit geen quotumfout is.
export function quotumReden(err: unknown): string | null {
  const melding = meldingVan(err);
  const e = err as DuckError | null;
  const status = e && typeof e.status === 'number' ? e.status : 0;
  const naam = e && typeof e.name === 'string' ? e.name : '';
  const isTavily = /tavily/i.test(naam) || /^Tavily\b/i.test(melding);
  const match = melding.match(/Tavily (\d{3})/i);
  const tavilyStatus = isTavily && status ? status : (match ? Number(match[1]) : 0);
  if (tavilyStatus === 432) return 'Tavily-quotum op (432: planlimiet van het abonnement bereikt)';
  if (tavilyStatus === 433) return 'Tavily-bestedingslimiet bereikt (433)';
  if (tavilyStatus === 429) return 'Tavily-limiet geraakt (429: te veel verzoeken)';
  if (/credit balance/i.test(melding)) return 'Claude-tegoed is op';
  if ((status === 400 || status === 403) && /credit/i.test(melding)) return 'Claude-tegoed is op';
  return null;
}

export function isQuotumFout(err: unknown): boolean {
  return quotumReden(err) !== null;
}

// Korte NL-uitleg per soort, voor boven de foutmelding op het bord.
export function uitlegVoorKind(kind: ErrorKind, melding: string): string {
  if (kind === 'infra') {
    const quotum = quotumReden(melding);
    if (quotum) return `${quotum} — controleer je abonnement of tegoed.`;
    return 'Tijdelijke storing — wordt automatisch opnieuw geprobeerd.';
  }
  if (kind === 'data') return 'Controleer de titel en website van het onderwerp.';
  if (kind === 'definitief') return 'Dit onderwerp wordt niet geschreven.';
  return 'Inhoudelijk afgekeurd — opnieuw proberen kan een ander resultaat geven.';
}
