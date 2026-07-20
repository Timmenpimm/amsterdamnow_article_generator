type TavilyResult = { title?: string; url?: string; content?: string; raw_content?: string };
type TavilyResponse = { results?: TavilyResult[]; detail?: string; message?: string };

export type ResearchSource = { title: string; url: string; content: string };

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

  const sources = (data.results || [])
    .filter(r => r.url && (r.raw_content || r.content))
    .map(r => ({ title: r.title || r.url!, url: r.url!, content: (r.raw_content || r.content || '').slice(0, 12_000) }));
  if (!sources.length) throw new Error('Tavily vond geen bruikbare bronnen voor dit onderwerp.');
  return sources;
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
