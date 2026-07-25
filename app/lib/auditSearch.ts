// Eigen zoekpad van de auditor: Google via Serper.dev.
//
// Dit bestand bestaat alléén omdat de auditor onafhankelijk moet zijn. De
// generatie doet haar research met Tavily (lib/tavily.ts); zou de auditor
// dezelfde index bevragen, dan controleert hij de aannames van de generatie
// tegen precies de bronnen die die aannames veroorzaakten — en vindt hij per
// definitie niets. Andere index, andere snippets, andere kans om een fout
// getal of een onbewezen superlatief te zien. Daarom géén import uit
// tavily.ts, ook niet voor de timeout-helper.
//
// Waarom Serper en niet Googles eigen API: dezelfde reden als bij de
// beeldselectie (zie lib/imageSearch.ts) — de Custom Search JSON API is dicht
// voor nieuwe aanmeldingen en de enterprise-opvolger begint bij $30k/maand.
// De stijl (timeout-fetch, expliciete status in de foutmelding) volgt
// imageSearch.ts; de code is bewust apart, want dat bestand hoort bij de
// beeldselectie en mag hier niet aan vast komen te zitten.

export type AuditSource = { title: string; url: string; snippet: string };

// 10s per zoekopdracht. De auditor doet er maximaal drie per artikel binnen
// dezelfde 60s-functielimiet als de rest van deze codebase, naast een
// extractie-, een vision- en een verdict-call. Blijft een zoekopdracht hangen,
// dan is een lege bronnenlijst beter dan een afgebroken audit.
const SEARCH_TIMEOUT_MS = 10_000;
// Zes resultaten is genoeg om een claim te bevestigen of te ontkrachten en
// houdt de verdict-call klein (drie claims × zes snippets past ruim in de
// tokenruimte van één call).
const RESULTS_PER_QUERY = 6;
const MISSING_KEY = 'SERPER_API_KEY ontbreekt: de auditor kan zonder eigen zoekindex geen claims natrekken.';

/**
 * True als het eigen zoekpad bruikbaar is. Voor de route: die kan hiermee
 * vóór het starten van een run melden dat de sleutel ontbreekt, in plaats van
 * de gebruiker per artikel een "controle mislukt"-bevinding te laten zien.
 */
export function auditSearchConfigured(): boolean {
  return Boolean(process.env.SERPER_API_KEY);
}

/**
 * Zoekt bronnen bij één claim. Gooit alleen als de configuratie ontbreekt —
 * dat is een instelfout die de redactie moet zien. Een mislukte zoekopdracht
 * (netwerk, rate limit, rare respons) levert een lege lijst op: de auditor
 * moet zijn andere controles kunnen afmaken, en een claim zonder bronnen
 * eindigt verderop hoe dan ook op `twijfel` in plaats van `ok`.
 */
export async function searchClaimSources(query: string): Promise<AuditSource[]> {
  const key = process.env.SERPER_API_KEY;
  if (!key) throw new Error(MISSING_KEY);

  const q = (query || '').trim().replace(/\s+/g, ' ');
  if (!q) return [];

  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      cache: 'no-store',
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
      // gl/hl op nl: de claims gaan over Amsterdamse zaken en events, dus de
      // Nederlandse resultatenpagina is de relevante index.
      body: JSON.stringify({ q, gl: 'nl', hl: 'nl', num: RESULTS_PER_QUERY }),
    });
    if (!res.ok) return [];
    const data = await res.json() as {
      organic?: Array<{ title?: string; link?: string; snippet?: string }>;
      answerBox?: { title?: string; link?: string; snippet?: string; answer?: string };
      knowledgeGraph?: { title?: string; website?: string; description?: string };
    };

    const out: AuditSource[] = [];
    const push = (title: unknown, url: unknown, snippet: unknown) => {
      const u = typeof url === 'string' ? url.trim() : '';
      const s = typeof snippet === 'string' ? snippet.trim() : '';
      // Zonder URL is een resultaat waardeloos voor de auditor: het oordeel
      // moet altijd naar een aanwijsbare bron kunnen verwijzen.
      if (!/^https?:\/\//i.test(u)) return;
      if (out.some(o => o.url === u)) return;
      out.push({ title: (typeof title === 'string' ? title.trim() : '').slice(0, 200), url: u, snippet: s.slice(0, 400) });
    };

    // answerBox en knowledgeGraph eerst: dat is precies het soort gegeven
    // (openingstijden, adres, capaciteit) waar de claimcheck naar zoekt, en
    // Google zet het niet altijd óók in de organic-resultaten.
    if (data.answerBox) push(data.answerBox.title, data.answerBox.link, data.answerBox.snippet || data.answerBox.answer);
    if (data.knowledgeGraph) push(data.knowledgeGraph.title, data.knowledgeGraph.website, data.knowledgeGraph.description);
    for (const r of data.organic || []) push(r.title, r.link, r.snippet);

    return out.slice(0, RESULTS_PER_QUERY);
  } catch {
    // Bewust stil: een enkele mislukte zoekopdracht mag de audit niet stoppen.
    return [];
  }
}
