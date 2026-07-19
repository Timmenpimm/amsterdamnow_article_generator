const API_URL = 'https://api.anthropic.com/v1/messages';
// claude-sonnet-4-20250514 is met pensioen (404 sinds juni 2026); Opus 4.8 is
// het huidige aanbevolen model. Override mogelijk via ANTHROPIC_MODEL.
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';

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

export async function askClaudeJson(system: string, prompt: string, withResearch = false): Promise<Record<string, unknown>> {
  const tools = withResearch ? [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }] : undefined;
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [{ role: 'user', content: prompt }];
  let response = await request({ model: MODEL, max_tokens: 6000, system, messages, ...(tools ? { tools } : {}) });

  // Server-side web search can pause a long-running turn. Continue it with the
  // returned content, as prescribed by the Messages API, up to two times.
  for (let attempt = 0; response.stop_reason === 'pause_turn' && attempt < 2; attempt++) {
    messages.push({ role: 'assistant', content: response.content || [] });
    response = await request({ model: MODEL, max_tokens: 6000, system, messages, ...(tools ? { tools } : {}) });
  }
  if (response.stop_reason === 'pause_turn') throw new Error('Claude kon het bronnenonderzoek niet binnen de beschikbare tijd afronden.');
  const raw = textFrom(response).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Claude gaf geen geldige JSON terug. Probeer het onderwerp opnieuw.');
  }
}
