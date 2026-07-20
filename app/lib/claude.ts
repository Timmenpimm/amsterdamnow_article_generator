const API_URL = 'https://api.anthropic.com/v1/messages';
// claude-sonnet-4-20250514 is met pensioen (404 sinds juni 2026); Opus 4.8 is
// het huidige aanbevolen model. Override mogelijk via ANTHROPIC_MODEL.
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
// Voor stappen die een lang, ongestreamd antwoord in één keer genereren (een
// volledig artikel of lijstartikel): Opus 4.8 kan daar langer over doen dan
// de 60s function-timeout van de Vercel-serverless-functie toestaat. Sonnet 5
// is ruim snel genoeg voor "zet deze al-geverifieerde feiten om in lopende
// tekst" en voorkomt zo FUNCTION_INVOCATION_TIMEOUT.
export const FAST_WRITE_MODEL = process.env.ANTHROPIC_FAST_MODEL || 'claude-sonnet-5';

type ClaudeBlock = { type: string; text?: string };
type ClaudeResponse = { content?: ClaudeBlock[]; stop_reason?: string; error?: { message?: string } };

function apiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Claude is niet geconfigureerd. Voeg ANTHROPIC_API_KEY toe aan de omgevingsvariabelen.');
  return key;
}

async function request(body: Record<string, unknown>): Promise<ClaudeResponse> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey(),
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({})) as ClaudeResponse;
  if (!res.ok) throw new Error(`Claude ${res.status}: ${data.error?.message || 'onbekende fout'}`);
  return data;
}

function textFrom(response: ClaudeResponse): string {
  return (response.content || []).filter(b => b.type === 'text').map(b => b.text || '').join('').trim();
}

export async function askClaudeJson(
  system: string, prompt: string, withResearch = false, model = MODEL
): Promise<Record<string, unknown>> {
  const tools = withResearch ? [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }] : undefined;
  // Prompt caching op de systeem-prompt. Dezelfde prompt wordt binnen één
  // artikel vaak herhaald (bv. de verificatie-prompt bij elk item, de
  // lijst-schrijf-prompt bij elk compose-blok) én tussen opeenvolgende
  // artikelen. Door de systeem-prompt als cacheerbaar blok te sturen betaal je
  // 'm één keer vol; volgende calls binnen ~5 minuten lezen 'm ~90% goedkoper.
  // Zonder gedragsverandering: de inhoud die het model ziet is identiek.
  const systemBlocks = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [{ role: 'user', content: prompt }];
  let response = await request({ model, max_tokens: 6000, system: systemBlocks, messages, ...(tools ? { tools } : {}) });

  // Server-side web search can pause a long-running turn. Continue it with the
  // returned content, as prescribed by the Messages API, up to two times.
  for (let attempt = 0; response.stop_reason === 'pause_turn' && attempt < 2; attempt++) {
    messages.push({ role: 'assistant', content: response.content || [] });
    response = await request({ model, max_tokens: 6000, system: systemBlocks, messages, ...(tools ? { tools } : {}) });
  }
  if (response.stop_reason === 'pause_turn') throw new Error('Claude kon het bronnenonderzoek niet binnen de beschikbare tijd afronden.');
  const raw = textFrom(response).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(raw);
  } catch { /* het model kan tekst om de JSON heen zetten; isoleer het object */ }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch { /* valt door naar de foutmelding */ }
  }
  throw new Error(`Claude gaf geen geldige JSON terug (respons begint met: ${raw.slice(0, 120)}…)`);
}
