type TavilyResult = { title?: string; url?: string; content?: string; raw_content?: string };
type TavilyResponse = { results?: TavilyResult[]; detail?: string; message?: string };

export type ResearchSource = { title: string; url: string; content: string };

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

// Is dit waarschijnlijk de eigen site van het onderwerp? Geen aggregator, en het
// domeinlabel (bv. "paradiso" in paradiso.nl) deelt een token met de titel.
function looksOfficial(url: string, tokens: string[]): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    if (AGGREGATOR_HOSTS.some(a => host.includes(a))) return false;
    const parts = host.split('.');
    const label = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    return tokens.some(t => label.includes(t) || t.includes(label));
  } catch {
    return false;
  }
}

export async function researchWithTavily(topic: string): Promise<ResearchSource[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error('Tavily is niet geconfigureerd. Voeg TAVILY_API_KEY toe aan de omgevingsvariabelen.');

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      query: `${topic} Amsterdam`,
      topic: 'general',
      search_depth: 'advanced',
      max_results: 5,
      include_raw_content: 'markdown',
    }),
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({})) as TavilyResponse;
  if (!res.ok) throw new Error(`Tavily ${res.status}: ${data.detail || data.message || 'onderzoek mislukt'}`);

  const results = data.results || [];
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
  const tokens = topicTokens(topic);
  const officialUrl = results.map(r => r.url).find((u): u is string => !!u && looksOfficial(u, tokens));
  let homepage: ResearchSource | null = null;
  if (officialUrl) {
    try {
      const origin = new URL(officialUrl).origin;
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
  if (!sources.length) throw new Error('Tavily vond geen bruikbare bronnen voor dit onderwerp.');
  return sources.slice(0, 6);
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
