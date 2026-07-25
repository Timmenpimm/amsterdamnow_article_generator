import { competitorInHost } from './competitors';

type TavilyResult = { title?: string; url?: string; content?: string; raw_content?: string };
type TavilyResponse = { results?: TavilyResult[]; detail?: string; message?: string };

export type ResearchSource = { title: string; url: string; content: string };

// Elke fase-stap moet binnen de 60s serverless-limiet blijven. Zonder timeout
// kan één hangende Tavily-call de hele tik over die grens duwen, waarna de
// fail-open-catch in writer.ts niet eens meer wordt bereikt en het topic een
// lease-cyclus verliest. 15s is ruim voor een advanced search.
const TAVILY_TIMEOUT_MS = 15_000;

// Resultaat van researchWithTavily: de bronnen én de gedetecteerde officiële
// origin (site-root) van het onderwerp, of null als die niet te bepalen was.
// De caller (writer.ts) gebruikt officialUrl om research.website te overschrijven
// met de homepage.
export type ResearchResult = { sources: ResearchSource[]; officialUrl: string | null };

// Hosts die vrijwel nooit de officiële site van het onderwerp zijn maar wél
// hoog scoren in een zoekopdracht: agenda's, ticketverkoop, social, reviews.
// Een match hierop diskwalificeert een URL als "officiële site".
const AGGREGATOR_HOSTS = [
  'iamsterdam', 'ticketmaster', 'eventbrite', 'songkick', 'facebook', 'instagram',
  'tripadvisor', 'google', 'youtube', 'wikipedia', 'timeout', 'reddit', 'tiktok',
  'spotify', 'bandsintown', 'residentadvisor', 'ra.co', 'paylogic', 'eventix',
  'ticketswap', 'linkedin', 'x.com', 'twitter', 'booking', 'yelp',
];

// Betekenisvolle tokens uit de onderwerptitel (≥4 tekens), voor de domein-match.
// "amsterdam" wordt uitgesloten: het staat in bijna elke titel (en in de query)
// en zou stads-/portaaldomeinen (amsterdam.nl e.d.) vals als "officieel" matchen.
const TOKEN_STOPWORDS = new Set(['amsterdam']);
function topicTokens(topic: string): string[] {
  return topic.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w.length >= 4 && !TOKEN_STOPWORDS.has(w));
}

// Is deze host een aggregator (agenda/tickets/social/reviews)? Dan nooit "de
// officiële site". Een onbereikbare/ongeldige URL behandelen we defensief als
// aggregator, zodat 'ie de homepage-detectie niet vervuilt.
function isAggregatorHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return AGGREGATOR_HOSTS.some(a => host.includes(a));
  } catch {
    return true;
  }
}

// Is dit waarschijnlijk de eigen site van het onderwerp? Geen aggregator, en het
// domeinlabel (bv. "paradiso" in paradiso.nl) bevat de naam van het onderwerp.
// STRIKT en éénrichting (alleen label.includes(needle), nooit needle.includes
// (label)): het domeinlabel moet óf de samengetrokken volledige onderwerpnaam
// bevatten (alle tokens aaneen zonder spaties, bv. topic "ClubWST" -> "clubwst",
// "Club West" -> "clubwest"), óf minstens twee losse tokens van >=4 tekens. Zo
// matcht een losse token "club" niet langer met domein "clubwest".
function looksOfficial(url: string, tokens: string[]): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    if (AGGREGATOR_HOSTS.some(a => host.includes(a))) return false;
    const parts = host.split('.');
    const label = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    const full = tokens.join('');
    if (full.length >= 4 && label.includes(full)) return true;
    return tokens.filter(t => t.length >= 4 && label.includes(t)).length >= 2;
  } catch {
    return false;
  }
}

// opts stuurt de aanvullende researchronde (writer.ts stepResearchAanvullend):
// die zoekt gericht op wat de eerste ronde niet vond ("<naam> <stad>
// openingstijden") in plaats van breed op het onderwerp, met een kleinere
// resultatenset omdat er dan al bronnen liggen. Zonder opts is het gedrag
// exact als voorheen — de eerste ronde mag hier niets van merken.
export async function researchWithTavily(
  topic: string,
  opts?: { query?: string; maxResults?: number },
): Promise<ResearchResult> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error('Tavily is niet geconfigureerd. Voeg TAVILY_API_KEY toe aan de omgevingsvariabelen.');

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    signal: AbortSignal.timeout(TAVILY_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      query: opts?.query || `${topic} Amsterdam`,
      topic: 'general',
      search_depth: 'advanced',
      max_results: opts?.maxResults ?? 5,
      include_raw_content: 'markdown',
    }),
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({})) as TavilyResponse;
  if (!res.ok) throw new Error(`Tavily ${res.status}: ${data.detail || data.message || 'onderzoek mislukt'}`);

  // Concurrenten eruit vóórdat er iets met de resultaten gebeurt. Zij zijn de
  // reden dat artikel 87365 bestond: hun listicle was de beste treffer op een
  // van hun eigen koppen, waarna de homepage-detectie hieronder hun site tot
  // "officiële site van het onderwerp" verklaarde. Weggooien op dit punt dekt
  // in één keer de bron, de entiteit, de website én de feiten die de schrijver
  // te zien krijgt.
  const alleResults = data.results || [];
  const results = alleResults.filter(r => !competitorInHost(r.url));
  const geweerd = alleResults.length - results.length;
  const searchSources = results
    .filter(r => r.url && (r.raw_content || r.content))
    .map(r => ({ title: r.title || r.url!, url: r.url!, content: (r.raw_content || r.content || '').slice(0, 12_000) }));

  // Homepage van het onderwerp vooraan: de eigen site heeft doorgaans de
  // betrouwbaarste feiten (adres, openingstijden, event-datum) en canonieke
  // spelling van de naam/website. We detecteren de officiële site onder de
  // resultaten, extracten de hoofdpagina (site-root) en zetten 'm als bron [1].
  // Eén extra call (bounded i.v.m. de 60s-limiet), best-effort: mislukt het,
  // dan gewoon de zoekresultaten. Vervangt het oude n8n-gedrag dat de tool
  // kwijt was — zie writer.ts stepResearch.
  // Harde eis: de officiële homepage moet ALTIJD bekeken worden voor basale
  // info (adres, openingstijden, canonieke naam). Eerst een resultaat dat
  // looksOfficial haalt; haalt niets dat, dan tóch de origin van het eerste
  // niet-aggregator zoekresultaat (best passende kandidaat) — die mag nooit
  // gemist worden. De gekozen origin geven we ook naar buiten (officialUrl).
  // Bij een eigen query (aanvullende ronde) slaan we dit over: de homepage is
  // in ronde 1 al gecrawld en staat al bij de bewaarde bronnen, dus een tweede
  // extract-call zou alleen tijd kosten binnen dezelfde 60s-tik. officialUrl
  // blijft dan null; de caller heeft die in ronde 2 niet meer nodig.
  const tokens = topicTokens(topic);
  const resultUrls = results.map(r => r.url).filter((u): u is string => !!u);
  const chosen = opts?.query
    ? null
    : resultUrls.find(u => looksOfficial(u, tokens))
      ?? resultUrls.find(u => !isAggregatorHost(u))
      ?? null;
  let officialUrl: string | null = null;
  let homepage: ResearchSource | null = null;
  if (chosen) {
    try {
      const origin = new URL(chosen).origin;
      officialUrl = origin;
      const text = (await extractPageText(origin)).trim();
      if (text) homepage = { title: `Officiële site — ${new URL(origin).hostname.replace(/^www\./, '')}`, url: origin, content: text.slice(0, 12_000) };
    } catch { /* best-effort: val terug op de zoekresultaten */ }
  }

  // Dedupliceer op URL (zonder trailing slash) zodat de site-root niet dubbel
  // staat als 'ie ook een zoekresultaat was; homepage blijft vooraan.
  const seen = new Set<string>();
  const sources: ResearchSource[] = [];
  for (const s of [homepage, ...searchSources]) {
    if (!s) continue;
    const key = s.url.replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push(s);
  }
  if (!sources.length) {
    // Bleef er niets over omdat álles van concurrenten kwam, dan is dat de
    // echte reden — en die hoort in de foutmelding, anders gaat de redactie
    // zoeken naar een Tavily-storing die er niet is.
    if (geweerd) {
      throw new Error(
        'Alle gevonden bronnen komen van concurrerende stadsgidsen. Dit onderwerp bestaat kennelijk alleen in hún artikel; schrijf het niet over maar kies de onderliggende zaak of het event als onderwerp.'
      );
    }
    throw new Error('Tavily vond geen bruikbare bronnen voor dit onderwerp.');
  }
  return { sources: sources.slice(0, 6), officialUrl };
}

// Leest de tekst van één specifieke pagina uit voor de bronscanner. Eerst via
// Tavily /extract (rendert JS, zoals veel agendapagina's nodig hebben); zonder
// key of bij een lege/mislukte extract valt het terug op een platte fetch.
export async function extractPageText(url: string): Promise<string> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (apiKey) {
    try {
      const res = await fetch('https://api.tavily.com/extract', {
        method: 'POST',
        signal: AbortSignal.timeout(TAVILY_TIMEOUT_MS),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ urls: [url], extract_depth: 'basic' }),
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({})) as { results?: { raw_content?: string }[] };
      const text = (data.results?.[0]?.raw_content || '').trim();
      if (res.ok && text) return text.slice(0, 16_000);
    } catch { /* val door naar platte fetch */ }
  }
  return plainFetchText(url);
}

async function plainFetchText(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(TAVILY_TIMEOUT_MS),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AmsterdamNOW-bronscanner)' },
      cache: 'no-store',
    });
  } catch {
    throw new Error('Bron niet bereikbaar — de pagina gaf geen antwoord.');
  }
  if (!res.ok) throw new Error(`Bron niet bereikbaar — de pagina gaf HTTP ${res.status}.`);
  const text = stripHtml(await res.text());
  if (!text) throw new Error('De pagina gaf geen leesbare inhoud.');
  return text.slice(0, 16_000);
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
