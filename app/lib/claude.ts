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

// Tijdelijke timing-instrumentatie (2026-07-20): productie zag na de
// fase-opsplitsing nog altijd 60s-timeouts op een fase die maar 1 Claude-
// call doet, dus het knelpunt zit ergens tussen "request start" en "response
// klaar" — dit maakt zichtbaar in de Vercel-logs of dat de Anthropic-call
// zelf is, of iets anders. Verwijderen zodra de oorzaak vaststaat.
async function request(body: Record<string, unknown>): Promise<ClaudeResponse> {
  const start = Date.now();
  const model = body.model;
  try {
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
    console.log(`[claude] ${model} ${res.status} in ${Date.now() - start}ms stop_reason=${data.stop_reason}`);
    if (!res.ok) throw new Error(`Claude ${res.status}: ${data.error?.message || 'onbekende fout'}`);
    return data;
  } catch (error: any) {
    console.log(`[claude] ${model} FAILED after ${Date.now() - start}ms: ${error.message}`);
    throw error;
  }
}

function textFrom(response: ClaudeResponse): string {
  return (response.content || []).filter(b => b.type === 'text').map(b => b.text || '').join('').trim();
}

// Probeert een JSON-object uit de ruwe modeltekst te halen: eerst direct
// parsen (na het strippen van een eventueel markdown-codeblok), anders het
// object tussen de eerste { en de laatste } isoleren (voor het geval er
// tekst omheen staat). Geeft null als er geen geldig object in zit.
function extractJson(raw: string): Record<string, unknown> | null {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch { /* probeer te isoleren */ }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch { /* geen geldig object te isoleren */ }
  }
  return null;
}

// Als askClaudeJson, maar met genummerde beelden (URL-blocks) vóór de vraag.
// Voor de beeldselectie: één vision-call per request houdt ons binnen de
// 60s-limiet; de aanroeper batcht zelf (max ~12 beelden per call).
export async function askClaudeJsonWithImages(
  system: string, prompt: string, imageUrls: string[], model = FAST_WRITE_MODEL
): Promise<Record<string, unknown>> {
  const content: unknown[] = imageUrls.flatMap((url, i) => ([
    { type: 'text', text: `Beeld ${i + 1}:` },
    { type: 'image', source: { type: 'url', url } },
  ]));
  content.push({ type: 'text', text: prompt });
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [{ role: 'user', content }];

  const response = await request({ model, max_tokens: 4000, system, messages });
  const raw = textFrom(response);
  const parsed = extractJson(raw);
  if (parsed) return parsed;

  messages.push({ role: 'assistant', content: raw });
  messages.push({
    role: 'user',
    content: 'Dit is geen geldig JSON-object. Antwoord nu ALLEEN met het JSON-object uit de instructie hierboven — geen uitleg, geen tekst ervoor of erna, geen markdown-codeblok.',
  });
  const retry = await request({ model, max_tokens: 4000, system, messages });
  const retryParsed = extractJson(textFrom(retry));
  if (retryParsed) return retryParsed;
  throw new Error('Claude gaf geen geldige JSON terug bij het beoordelen van de beelden.');
}

export async function askClaudeJson(
  system: string, prompt: string, withResearch = false, model = MODEL, maxTokens = 6000
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

  async function requestUntilDone(): Promise<string> {
    let response = await request({ model, max_tokens: maxTokens, system: systemBlocks, messages, ...(tools ? { tools } : {}) });
    // Server-side web search can pause a long-running turn. Continue it with
    // the returned content, as prescribed by the Messages API, up to two times.
    for (let attempt = 0; response.stop_reason === 'pause_turn' && attempt < 2; attempt++) {
      messages.push({ role: 'assistant', content: response.content || [] });
      response = await request({ model, max_tokens: maxTokens, system: systemBlocks, messages, ...(tools ? { tools } : {}) });
    }
    if (response.stop_reason === 'pause_turn') throw new Error('Claude kon het bronnenonderzoek niet binnen de beschikbare tijd afronden.');
    // Bij max_tokens is de respons per definitie afgekapt (onvolledige JSON) —
    // gezien op productie: het model liep hier soms tot 58s over voordat de
    // limiet werd geraakt, wat de 60s-functielimiet in gevaar bracht. Direct
    // falen i.p.v. de afgekapte tekst te laten stranden op een JSON-parsefout
    // (die alsnog een 2e, even lange poging zou triggeren).
    if (response.stop_reason === 'max_tokens') {
      throw new Error(`Claude-respons afgekapt op max_tokens (${maxTokens}) — antwoord werd te lang.`);
    }
    return textFrom(response);
  }

  const raw = await requestUntilDone();
  const parsed = extractJson(raw);
  if (parsed) return parsed;

  // Corrigerende herkansing: het model antwoordde met uitleg/redenering in
  // lopende tekst in plaats van het gevraagde JSON-object — gebeurt af en toe,
  // ook met een expliciete "alleen JSON"-instructie in de prompt. De eigen
  // foute respons teruggeven en expliciet om alleen JSON vragen lost dit
  // vrijwel altijd op, zonder dat elke aanroeper deze logica zelf hoeft te
  // implementeren.
  messages.push({ role: 'assistant', content: raw });
  messages.push({
    role: 'user',
    content: 'Dit is geen geldig JSON-object. Antwoord nu ALLEEN met het JSON-object uit de instructie hierboven — geen uitleg, geen tekst ervoor of erna, geen markdown-codeblok.',
  });
  const retryRaw = await requestUntilDone();
  const retryParsed = extractJson(retryRaw);
  if (retryParsed) return retryParsed;

  throw new Error(`Claude gaf geen geldige JSON terug, ook niet na een herkansing (respons begint met: ${retryRaw.slice(0, 120)}…)`);
}
