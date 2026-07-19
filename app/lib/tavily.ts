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
