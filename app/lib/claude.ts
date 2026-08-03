import { activeProvider, failoverProvider, anthropicFailoverProvider, type ActiveProvider, type ProviderId } from './modelConfig';
import { usageLine, type ClaudeUsage } from './tokenCost';
import { conformsToSchema } from './jsonShape';

// claude-sonnet-4-20250514 is met pensioen (404 sinds juni 2026); Opus 4.8 is
// het huidige aanbevolen model. Override mogelijk via ANTHROPIC_MODEL.
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
// Voor stappen die een lang, ongestreamd antwoord in één keer genereren (een
// volledig artikel of lijstartikel): Opus 4.8 kan daar langer over doen dan
// de 60s function-timeout van de Vercel-serverless-functie toestaat. Sonnet 5
// is ruim snel genoeg voor "zet deze al-geverifieerde feiten om in lopende
// tekst" en voorkomt zo FUNCTION_INVOCATION_TIMEOUT.
export const FAST_WRITE_MODEL = process.env.ANTHROPIC_FAST_MODEL || 'claude-sonnet-5';
// Alleen voor de losse titel-generatie (writer.ts polishTitle). Deze call
// genereert VRIJ (geen structured-output / constrained decoding), zoals de
// oude n8n-workflow — dáár zit de titelwinst. Een titel is maar een paar
// honderd tokens, dus zelfs Sonnet 5 kost hier vrijwel niets; we kiezen het
// bewust voor maximale punch. Goedkoper kan met bv.
// ANTHROPIC_TITLE_MODEL=claude-haiku-4-5-20251001.
export const TITLE_MODEL = process.env.ANTHROPIC_TITLE_MODEL || 'claude-sonnet-5';

type ClaudeBlock = { type: string; text?: string };
type ClaudeResponse = {
  content?: ClaudeBlock[]; stop_reason?: string; usage?: ClaudeUsage; error?: { message?: string };
};

// HTTP-fout van een provider (Anthropic of Omniroute). Draagt de status en de
// provider-id mee zodat de aanroeper kan beslissen of een automatische failover
// zin heeft (zie isCreditOrRateError + de failover-logica hieronder). De
// .message behoudt de bestaande Nederlandse label/boodschap-vorm.
export class ProviderHttpError extends Error {
  status: number;
  providerId: ProviderId;
  constructor(message: string, status: number, providerId: ProviderId) {
    super(message);
    this.name = 'ProviderHttpError';
    this.status = status;
    this.providerId = providerId;
  }
}

// True als de fout wijst op opgeraakte credits of rate-limiting — de gevallen
// waarin een automatische failover naar Omniroute zin heeft:
//   - 429 (rate limit) of 529 (overloaded);
//   - 400/403 waarvan de boodschap "credit" bevat (Anthropic:
//     "Your credit balance is too low to access the Anthropic API").
// Duck-typed op { status, message } zodat het zowel een ProviderHttpError als
// een los foutobject herkent.
export function isCreditOrRateError(e: unknown): boolean {
  const err = e as { status?: unknown; message?: unknown } | null;
  const status = err && typeof err.status === 'number' ? err.status : 0;
  const msg = err && typeof err.message === 'string' ? err.message : '';
  if (status === 429 || status === 529) return true;
  if ((status === 400 || status === 403) && msg.toLowerCase().includes('credit')) return true;
  return false;
}

// True als de fout wijst op een infrastructuurprobleem van de Omniroute-
// gateway zelf — de gevallen waarin een automatische failover naar de
// directe Anthropic-provider zin heeft:
//   - de call kwam nooit bij een server aan (fetch/timeout/DNS/connectie-fout —
//     request() wikkelt dit altijd in "Omniroute onbereikbaar op ...", zie
//     hierboven);
//   - de gateway antwoordde wél, maar met een gateway-status (502/503/522/530).
// GEEN failover bij een andere HTTP-status (incl. alle overige 4xx: auth-,
// validatie- of quotafouten van Omniroute zelf) — die zijn betekenisvol en
// mogen niet stilzwijgend overschreven worden. Duck-typed op
// { status, message } zodat het zowel een ProviderHttpError als het
// "onbereikbaar"-foutobject uit request() herkent.
export function isOmnirouteInfraError(e: unknown): boolean {
  const err = e as { status?: unknown; message?: unknown } | null;
  const status = err && typeof err.status === 'number' ? err.status : 0;
  if (status) return status === 502 || status === 503 || status === 522 || status === 530;
  // Geen status = er kwam nooit een HTTP-respons — dat is per definitie een
  // bereikbaarheids-/timeoutprobleem, ongeacht de exacte foutmelding.
  const msg = err && typeof err.message === 'string' ? err.message : '';
  return msg.toLowerCase().includes('omniroute onbereikbaar');
}

// Verstuurt de call naar de actieve provider (Anthropic direct of Omniroute).
// `prov` bepaalt endpoint, headers en — via de aanroeper — welk model en welke
// capability-vlaggen gelden. Zie lib/modelConfig.ts.
async function request(body: Record<string, unknown>, prov: ActiveProvider, label = ''): Promise<ClaudeResponse> {
  if (prov.id === 'anthropic' && !prov.headers['x-api-key']) {
    throw new Error('Claude is niet geconfigureerd. Voeg ANTHROPIC_API_KEY toe aan de omgevingsvariabelen.');
  }
  const start = Date.now();
  let res: Response;
  try {
    res = await fetch(prov.messagesUrl, {
      method: 'POST',
      headers: prov.headers,
      body: JSON.stringify(body),
      cache: 'no-store',
      // Zonder timeout kan één hangende provider-call de hele fase-stap over de
      // functielimiet duwen: de functie wordt dan hard afgekapt en de
      // catch-blokken die het topic netjes op "mislukt" zetten worden nooit
      // bereikt. De wachtrij-routes draaien met maxDuration=300 (zie de
      // proces/worker-routes): 250s ligt daar ruim onder en boven elke
      // legitieme call. Die ruimte is nodig sinds de Omniroute-gateway achter
      // een lokaal model draait (~56 tok/s): een heel artikel kost daar
      // makkelijk 100-200s, waar de oude 55s-limiet een artikel stelselmatig
      // afkapte (of de call als "onbereikbaar" afbrak).
      signal: AbortSignal.timeout(250_000),
    });
  } catch (e) {
    // Meest voorkomende Omniroute-fout: de gateway draait niet of is (op
    // Vercel) onbereikbaar op localhost. Geef een duidelijke melding i.p.v.
    // een kale "fetch failed".
    if (prov.id === 'omniroute') {
      throw new Error(`Omniroute onbereikbaar op ${prov.messagesUrl}. Draait de gateway? (${(e as Error).message})`);
    }
    throw e;
  }
  const data = await res.json().catch(() => ({})) as ClaudeResponse;
  if (!res.ok) {
    const providerLabel = prov.id === 'omniroute' ? 'Omniroute' : 'Claude';
    throw new ProviderHttpError(`${providerLabel} ${res.status}: ${data.error?.message || 'onbekende fout'}`, res.status, prov.id);
  }
  // Eén tokenregel per call (zie lib/tokenCost.ts). Fail-open: een kapotte
  // logregel mag nooit een geslaagde call laten klappen.
  try {
    if (data.usage) {
      console.log(usageLine(label, String(body.model || 'onbekend'), data.usage, Date.now() - start, data.stop_reason));
    }
  } catch { /* logging is instrumentatie, geen functionaliteit */ }
  return data;
}

// Draait `run(prov)` tegen de actieve provider. Twee failover-richtingen,
// allebei maximaal één herkansing (mislukt ook de fallback, dan propageert
// die fout ongewijzigd):
//   - Anthropic direct actief + credit-/rate-fout + failover aan
//     -> éénmalig opnieuw via de Omniroute-provider (bestaand gedrag).
//   - Omniroute actief + infra-fout (onbereikbaar/timeout/gateway-5xx) + de
//     failover-instelling aan -> éénmalig opnieuw via het bestaande directe
//     Anthropic-pad (alleen als er een ANTHROPIC_API_KEY is). Géén failover bij
//     een 4xx van Omniroute zelf (auth-, validatie- of quotafouten — die zijn
//     betekenisvol) en géén failover met failover uit: een Omniroute-storing
//     wordt dan netjes als infra-fout doorgegeven (herkansing i.p.v. een
//     misleidende "Claude-tegoed is op"-pauze).
// `run` leidt zijn model/capability-vlaggen af uit de meegegeven `prov`, dus
// bij een retry gelden automatisch de capabilities van de nieuwe provider
// (bv. Omniroute's ontbrekende output_config, of Anthropic's model-override).
async function withFailover<T>(run: (prov: ActiveProvider) => Promise<T>): Promise<T> {
  const prov = await activeProvider();
  try {
    return await run(prov);
  } catch (e) {
    if (prov.id === 'anthropic' && isCreditOrRateError(e)) {
      const fallback = await failoverProvider();
      if (fallback) return run(fallback);
    }
    if (prov.id === 'omniroute' && isOmnirouteInfraError(e)) {
      const fallback = await anthropicFailoverProvider();
      if (fallback) {
        console.warn(`[claude] Omniroute infra-fout, val terug op directe Anthropic-provider (provider=omniroute -> anthropic). Reden: ${(e as Error)?.message || e}`);
        return run(fallback);
      }
    }
    throw e;
  }
}

function textFrom(response: ClaudeResponse): string {
  return (response.content || []).filter(b => b.type === 'text').map(b => b.text || '').join('').trim();
}

// Probeert een JSON-object uit de ruwe modeltekst te halen: eerst direct
// parsen (na het strippen van een eventueel markdown-codeblok), anders het
// object tussen de eerste { en de laatste } isoleren (voor het geval er
// tekst omheen staat). Geeft null als er geen geldig object in zit.
// Repareert ontsnappingsloze control karakters die het lokale Omniroute-model
// (huihui-qwen3.5-35b) in JSON-strings zet (letterlijke newlines/tabs/CR in
// content-tekst). Die zijn in JSON ongeldig en laten JSON.parse klappen, ook na
// het isoleren van het object. Loop met een string-state-machine: buiten een
// string onveranderd doorgeven, binnen een string elke control char (<0x20)
// vervangen door zijn escaped vorm (\\n, \\t, \\r of \\uXXXX).
function repairControlChars(s: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === '\\') {
        out += c + (s[i + 1] ?? '');
        i++;
        continue;
      }
      if (c === '"') {
        inString = false;
        out += c;
        continue;
      }
      const code = c.charCodeAt(0);
      if (code < 0x20) {
        out += code === 0x0a ? '\\n' : code === 0x0d ? '\\r' : code === 0x09 ? '\\t' : `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
      out += c;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else {
      out += c;
    }
  }
  return out;
}

function extractJson(raw: string): Record<string, unknown> | null {
  const cleaned = repairControlChars(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
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

// Eén beeld voor een vision-call, als base64. Beelden gaan bewust NIET als
// URL-source naar de API: Anthropic haalt URL's zelf op en weigert hosts
// waarvan robots.txt dat verbiedt ("Claude 400: This URL is disallowed by
// the website's robots.txt file") — o.a. de gstatic-thumbnails van Google-
// resultaten. Eén zo'n URL liet de hele batch-call klappen. De aanroeper
// haalt de beelden dus zelf op en levert base64 aan.
export type ClaudeImage = { media_type: string; data: string };

// Extractie van JSON uit een modelrespons, geëxporteerd voor de hermetische
// test (scripts/claude-json.test.mjs). Nieuwe responsvormen uitproberen via
// die test i.p.v. live op de schrijffase.
export { extractJson };

// Structured outputs van de Messages API: met output_config.format garandeert
// de API dat het (enige) text-block geldige JSON is conform het schema — dus
// direct JSON.parse, zonder markdown-stripping of extractie. Dit vervangt het
// corrigerende-herkansingspad hieronder. Let op: bij stop_reason 'max_tokens'
// kan de JSON alsnog afgekapt zijn (die throw blijft dus gelden). De eerste
// call met een nieuw schema kent een eenmalige compilatie-latency; daarna
// geldt een schema-cache van ~24u (relevant i.v.m. de 60s-serverless-limiet).
function outputConfig(schema?: Record<string, unknown>): Record<string, unknown> {
  return schema ? { output_config: { format: { type: 'json_schema', schema } } } : {};
}

// Thinking per call aan of uit. Sonnet 5 draait "adaptive thinking" zodra het
// thinking-veld ontbreekt (Opus 4.8 juist niet), en die denktokens tellen mee
// in max_tokens én in de output-facturering. Op productie gezien (2026-07-20):
// mét (impliciet) thinking sprong de research-output van ~1100 naar ~1500-2600
// tokens en liep de schrijffase bij muziekonderwerpen tegen de 3000-token-cap.
// Expliciet adaptive thinking + structured outputs bleek nog slechter: élke
// schrijfcall werd afgekapt, zelfs op 4500 tokens (4/4 getest op productie,
// 2026-07-20). Daarom staat thinking overal uit; near-miss-afkeuringen worden
// opgevangen met extra herkansingsrondes (zie writer.ts). De withThinking-
// parameter blijft beschikbaar voor toekomstige, gerichte experimenten.
// Expliciet 'disabled' wordt door Sonnet 5 én Opus 4.8 geaccepteerd.
function thinkingConfig(withThinking: boolean): Record<string, unknown> {
  return { thinking: { type: withThinking ? 'adaptive' : 'disabled' } };
}

// Als askClaudeJson, maar met genummerde beelden vóór de vraag.
// Voor de beeldselectie: één vision-call per request houdt ons binnen de
// 60s-limiet; de aanroeper batcht zelf (max ~12 beelden per call).
// Met `schema` gebruikt de call structured outputs (gegarandeerd geldige JSON,
// geen herkansing); zonder schema geldt het schemaloze vangnetgedrag.
// `label` is puur voor de tokenlogging (zie lib/tokenCost.ts): `<fase>#<id>`.
export async function askClaudeJsonWithImages(
  system: string, prompt: string, images: ClaudeImage[], model = FAST_WRITE_MODEL,
  schema?: Record<string, unknown>, label = ''
): Promise<Record<string, unknown>> {
  // De provider (incl. model + capability-vlaggen) wordt binnen askImagesWith
  // opnieuw afgeleid, zodat een failover-retry de Omniroute-capabilities krijgt.
  return withFailover(prov => askImagesWith(prov, system, prompt, images, model, schema, label));
}

// Eén beeld-call tegen een concrete provider. Alle provider-afhankelijke
// waarden (activeModel, useStructured, format) worden hier uit `prov` bepaald,
// zodat withFailover dit bij een retry ongewijzigd tegen Omniroute kan draaien.
async function askImagesWith(
  prov: ActiveProvider, system: string, prompt: string, images: ClaudeImage[],
  model: string, schema?: Record<string, unknown>, label = ''
): Promise<Record<string, unknown>> {
  const content: unknown[] = images.flatMap((img, i) => ([
    { type: 'text', text: `Beeld ${i + 1}:` },
    { type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } },
  ]));
  content.push({ type: 'text', text: prompt });
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [{ role: 'user', content }];

  const activeModel = prov.modelFor(model, true); // vision-call
  // Alleen structured outputs sturen als de provider ze ondersteunt (Anthropic
  // wel, Omniroute niet — die valt op het schemaloze pad terug).
  const useStructured = Boolean(schema) && prov.supportsStructuredOutputs;
  const format = useStructured ? outputConfig(schema) : {};

  const response = await request({ model: activeModel, max_tokens: 4000, system, messages, ...thinkingConfig(false), ...format }, prov, label);
  if (response.stop_reason === 'max_tokens') {
    throw new Error('Claude-respons afgekapt op max_tokens (4000) bij het beoordelen van de beelden.');
  }
  const raw = textFrom(response);
  // Met (ondersteunde) structured outputs is het text-block gegarandeerd
  // geldige JSON: direct parsen.
  if (useStructured) return JSON.parse(raw);
  const parsed = extractJson(raw);
  if (parsed) return parsed;

  // Schemaloos vangnet: corrigerende herkansing als het model met tekst i.p.v.
  // een JSON-object antwoordde.
  messages.push({ role: 'assistant', content: raw });
  messages.push({
    role: 'user',
    content: 'Dit is geen geldig JSON-object. Antwoord nu ALLEEN met het JSON-object uit de instructie hierboven — geen uitleg, geen tekst ervoor of erna, geen markdown-codeblok.',
  });
  const retry = await request({ model: activeModel, max_tokens: 4000, system, messages }, prov, `${label}-json-retry`);
  const retryParsed = extractJson(textFrom(retry));
  if (retryParsed) return retryParsed;
  throw new Error('Claude gaf geen geldige JSON terug bij het beoordelen van de beelden.');
}

// Met `schema` gebruikt de call structured outputs: de API garandeert geldige
// JSON conform het schema, dus direct JSON.parse en géén herkansing. Zonder
// schema geldt het ongewijzigde vangnetgedrag (extractJson + herkansing).
// `label` is puur voor de tokenlogging (zie lib/tokenCost.ts): `<fase>#<id>`.
export async function askClaudeJson(
  system: string, prompt: string, model = MODEL, maxTokens = 6000,
  schema?: Record<string, unknown>, withThinking = false, label = ''
): Promise<Record<string, unknown>> {
  // Provider (incl. model + capability-vlaggen) wordt binnen askJsonWith
  // afgeleid, zodat een failover-retry de Omniroute-capabilities krijgt.
  return withFailover(prov => askJsonWith(prov, system, prompt, model, maxTokens, schema, withThinking, label));
}

// Eén JSON-call tegen een concrete provider. Alle provider-afhankelijke waarden
// (activeModel, useStructured, format) worden hier uit `prov` bepaald, zodat
// withFailover dit bij een retry ongewijzigd tegen Omniroute kan draaien.
async function askJsonWith(
  prov: ActiveProvider, system: string, prompt: string, model: string, maxTokens: number,
  schema?: Record<string, unknown>, withThinking = false, label = ''
): Promise<Record<string, unknown>> {
  const activeModel = prov.modelFor(model, false);
  // Structured outputs alleen als de provider ze ondersteunt (zie modelConfig).
  const useStructured = Boolean(schema) && prov.supportsStructuredOutputs;
  const format = useStructured ? outputConfig(schema) : {};
  const thinking = thinkingConfig(withThinking);
  // Prompt caching op de systeem-prompt. Dezelfde prompt wordt binnen één
  // artikel vaak herhaald (bv. de verificatie-prompt bij elk item, de
  // lijst-schrijf-prompt bij elk compose-blok) én tussen opeenvolgende
  // artikelen. Door de systeem-prompt als cacheerbaar blok te sturen betaal je
  // 'm één keer vol; volgende calls binnen ~5 minuten lezen 'm ~90% goedkoper.
  // Zonder gedragsverandering: de inhoud die het model ziet is identiek.
  const systemBlocks = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [{ role: 'user', content: prompt }];

  async function requestUntilDone(attempt = ''): Promise<string> {
    const response = await request({ model: activeModel, max_tokens: maxTokens, system: systemBlocks, messages, ...thinking, ...format }, prov, `${label}${attempt}`);
    // Bij max_tokens is de respons per definitie afgekapt (onvolledige JSON) —
    // gezien op productie: het model liep hier soms tot 58s over voordat de
    // limiet werd geraakt, wat de 60s-functielimiet in gevaar bracht. Direct
    // falen i.p.v. de afgekapte tekst te laten stranden op een JSON-parsefout
    // (die alsnog een 2e, even lange poging zou triggeren). Anthropic meldt
    // dit als stop_reason 'max_tokens'; de Omniroute-gateway rapporteert
    // hetzelfde als 'length' (OpenAI-stijl). Zonder 'length' te herkennen
    // glipt een afgekapte respons door deze guard heen en faalt het
    // extractJson-vangnet daarna (plus een tweede, even afgekapte herkansing).
    if (response.stop_reason === 'max_tokens' || response.stop_reason === 'length') {
      throw new Error(`Claude-respons afgekapt op max_tokens (${maxTokens}) — het antwoord werd te lang.`);
    }
    return textFrom(response);
  }

  const raw = await requestUntilDone();
  // Met (ondersteunde) structured outputs is de respons gegarandeerd geldige
  // JSON conform het schema: direct parsen, geen extractie en geen herkansing.
  // Bij Omniroute (geen structured outputs) valt dit door naar het schemaloze
  // pad hieronder, ook als er een schema was meegegeven.
  if (useStructured) return JSON.parse(raw);
  const parsed = extractJson(raw);
  // Schemaloze provider + schema meegegeven: de JSON kan geldig zijn maar niet
  // aan het schema voldoen (bv. categories als string in plaats van array —
  // gezien met het kleine lokale model, 2026-08-03). Zo'n vormfout laten we de
  // corrigerende herkansing hieronder triggeren i.p.v. hem door te laten lekken
  // naar een latere fase die dan pas met een cryptische validatie-fout knalt.
  const shapeError = schema ? conformsToSchema(parsed ?? null, schema) : null;
  if (parsed && !shapeError) return parsed;

  // Schemaloos vangnet — corrigerende herkansing: het model antwoordde met
  // uitleg/redenering in lopende tekst in plaats van het gevraagde JSON-object,
  // óf met een JSON-object dat niet aan het schema voldoet — gebeurt af en toe,
  // ook met een expliciete "alleen JSON"-instructie in de prompt. De eigen
  // foute respons teruggeven en expliciet om alleen (correct) JSON vragen lost
  // dit vrijwel altijd op, zonder dat elke aanroeper deze logica zelf hoeft te
  // implementeren.
  messages.push({ role: 'assistant', content: raw });
  messages.push({
    role: 'user',
    content: shapeError
      ? `Het JSON-object voldoet niet aan het gevraagde formaat: ${shapeError}. Antwoord nu ALLEEN met een correct JSON-object conform de instructie — geen uitleg, geen tekst ervoor of erna, geen markdown-codeblok.`
      : 'Dit is geen geldig JSON-object. Antwoord nu ALLEEN met het JSON-object uit de instructie hierboven — geen uitleg, geen tekst ervoor of erna, geen markdown-codeblok.',
  });
  const retryRaw = await requestUntilDone('-json-retry');
  const retryParsed = extractJson(retryRaw);
  const retryShapeError = schema ? conformsToSchema(retryParsed ?? null, schema) : null;
  if (retryParsed && !retryShapeError) return retryParsed;

  throw new Error(`Claude gaf geen geldige JSON terug, ook niet na een herkansing${shapeError || retryShapeError ? ` (${shapeError || retryShapeError})` : ''} (respons begint met: ${retryRaw.slice(0, 120)}…)`);
}
