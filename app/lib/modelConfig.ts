import { getSetting, setSetting } from './db';

// ---------------------------------------------------------------------------
// Model-provider-schakelaar (Instellingen → "Model & koppelingen").
//
// De pipeline praat standaard rechtstreeks met de Anthropic Messages API
// (lib/claude.ts). Deze module laat de redactie dat verkeer via een
// zelf-gehoste gateway (Omniroute, http://localhost:20128) routeren zonder
// code te wijzigen — bedoeld om Anthropic-tokens te sparen door bv. Claude via
// de eigen GitHub-route of een goedkoper model te laten lopen.
//
// Kern: Omniroute's /v1/messages spreekt hetzelfde Anthropic-Messages-formaat
// (getest 2026-07-25: content[]{type:text}, stop_reason, usage), dus de
// request/response-afhandeling in claude.ts blijft identiek. Eén verschil is
// wél afgevangen via een capability-vlag hieronder:
//   - Omniroute negeert `output_config` (structured outputs): het antwoordt met
//     platte tekst i.p.v. gegarandeerde JSON. Daarom stuurt claude.ts bij
//     Omniroute géén output_config en valt het terug op het schemaloze pad
//     (extractJson + corrigerende herkansing) dat er toch al is.
// Omniroute negeert daarnaast `thinking:{type:disabled}` (het denkt toch); dat
// is onschadelijk want textFrom() filtert op type==='text'.
// ---------------------------------------------------------------------------

export type ProviderId = 'anthropic' | 'omniroute';

export interface OmnirouteConfig {
  baseUrl: string;   // origin, bv. http://localhost:20128 (zonder /v1/messages)
  apiKey: string;    // optioneel; leeg = geen auth (localhost)
  model: string;     // Omniroute-model-id voor tekst-calls, bv. auto/best-coding
  visionModel: string; // Omniroute-model-id voor beeld-calls, bv. auto/best-vision
}

export interface ModelSettings {
  provider: ProviderId;
  omniroute: OmnirouteConfig;
  // Automatische failover: als een directe Anthropic-call faalt door opgeraakte
  // credits of rate-limiting, draait claude.ts dezelfde call éénmalig opnieuw
  // via de Omniroute-config hierboven. Staat standaard aan.
  failover: boolean;
}

export const DEFAULT_OMNIROUTE: OmnirouteConfig = {
  baseUrl: process.env.OMNIROUTE_URL || 'https://jeff-regards-expanded-commerce.trycloudflare.com',
  apiKey: process.env.OMNIROUTE_API_KEY || '',
  model: 'auto/best-coding',
  visionModel: 'auto/best-vision',
};

export const DEFAULT_SETTINGS: ModelSettings = {
  provider: 'anthropic',
  omniroute: DEFAULT_OMNIROUTE,
  failover: true,
};

const SETTING_KEY = 'model_provider';

// Korte in-memory-cache: claude.ts leest de provider bij ELKE call, en de
// instelling verandert zelden. 10s TTL houdt de DB-druk laag terwijl een
// wissel in Instellingen binnen ~10s doorwerkt.
let cache: { at: number; value: ModelSettings } | null = null;
const TTL_MS = 10_000;

function nowMs(): number {
  return Date.now();
}

function coerce(raw: unknown): ModelSettings {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const provider: ProviderId = obj.provider === 'omniroute' ? 'omniroute' : 'anthropic';
  const o = (obj.omniroute && typeof obj.omniroute === 'object' ? obj.omniroute : {}) as Record<string, unknown>;
  return {
    provider,
    omniroute: {
      baseUrl: typeof o.baseUrl === 'string' && o.baseUrl.trim() ? o.baseUrl.trim() : DEFAULT_OMNIROUTE.baseUrl,
      apiKey: typeof o.apiKey === 'string' ? o.apiKey.trim() : DEFAULT_OMNIROUTE.apiKey,
      model: typeof o.model === 'string' && o.model.trim() ? o.model.trim() : DEFAULT_OMNIROUTE.model,
      visionModel: typeof o.visionModel === 'string' && o.visionModel.trim() ? o.visionModel.trim() : DEFAULT_OMNIROUTE.visionModel,
    },
    // Standaard aan; alleen een expliciete `false` zet failover uit.
    failover: typeof obj.failover === 'boolean' ? obj.failover : true,
  };
}

export async function getModelSettings(): Promise<ModelSettings> {
  if (cache && nowMs() - cache.at < TTL_MS) return cache.value;
  const raw = await getSetting(SETTING_KEY);
  let value: ModelSettings = DEFAULT_SETTINGS;
  if (raw) {
    try { value = coerce(JSON.parse(raw)); } catch { value = DEFAULT_SETTINGS; }
  }
  cache = { at: nowMs(), value };
  return value;
}

export async function saveModelSettings(partial: Partial<ModelSettings>): Promise<ModelSettings> {
  const current = await getModelSettings();
  const next: ModelSettings = coerce({
    provider: partial.provider ?? current.provider,
    omniroute: { ...current.omniroute, ...(partial.omniroute || {}) },
    failover: partial.failover ?? current.failover,
  });
  await setSetting(SETTING_KEY, JSON.stringify(next));
  cache = { at: nowMs(), value: next };
  return next;
}

// Runtime-view die claude.ts gebruikt om een enkele call te richten.
export interface ActiveProvider {
  id: ProviderId;
  messagesUrl: string;
  headers: Record<string, string>;
  supportsStructuredOutputs: boolean;
  // Kiest het uiteindelijke model-id. Bij Anthropic: het door de aanroeper
  // gevraagde model (ongewijzigd). Bij Omniroute: het in Instellingen gekozen
  // (vision-)model — de per-stap Anthropic-modelnamen worden dan genegeerd.
  modelFor: (requested: string, isVision: boolean) => string;
}

function anthropicProvider(): ActiveProvider {
  const key = process.env.ANTHROPIC_API_KEY;
  return {
    id: 'anthropic',
    messagesUrl: 'https://api.anthropic.com/v1/messages',
    headers: {
      'content-type': 'application/json',
      ...(key ? { 'x-api-key': key } : {}),
      'anthropic-version': '2023-06-01',
    },
    supportsStructuredOutputs: true,
    modelFor: (requested) => requested,
  };
}

// Normaliseert een Omniroute-base-URL naar de kale origin. De tool plakt zelf
// `/v1/messages` resp. `/v1/models` erachter, dus een ingevulde URL die al op
// `/v1`, `/v1/messages` of `/v1/models` eindigt zou anders `/v1/v1/...` geven.
// Strip daarom trailing slashes én zo'n afsluitend /v1(-pad). Idempotent.
export function omnirouteOrigin(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v1(?:\/(?:messages|models))?$/i, '')
    .replace(/\/+$/, '');
}

function omnirouteProvider(cfg: OmnirouteConfig): ActiveProvider {
  const origin = omnirouteOrigin(cfg.baseUrl);
  return {
    id: 'omniroute',
    messagesUrl: `${origin}/v1/messages`,
    headers: {
      'content-type': 'application/json',
      ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
      'anthropic-version': '2023-06-01',
    },
    supportsStructuredOutputs: false,
    modelFor: (_requested, isVision) => (isVision ? cfg.visionModel : cfg.model) || cfg.model,
  };
}

export async function activeProvider(): Promise<ActiveProvider> {
  const s = await getModelSettings();
  return s.provider === 'omniroute' ? omnirouteProvider(s.omniroute) : anthropicProvider();
}

// Directe Anthropic-provider, ongeacht de actieve instelling. Gebruikt door
// claude.ts als failover-doel wanneer Omniroute de actieve provider is maar
// een infra-fout geeft (onbereikbaar/timeout/5xx van de gateway zelf) — zie
// isOmnirouteInfraError in claude.ts. Bouwt geen nieuwe client, hergebruikt
// dezelfde anthropicProvider() als het normale directe pad.
export function directAnthropicProvider(): ActiveProvider {
  return anthropicProvider();
}

// Bouwt een Omniroute-ActiveProvider uit de gegeven instellingen, óók als de
// actieve provider 'anthropic' is. Nodig voor de automatische failover in
// claude.ts: die moet een Omniroute-route kunnen samenstellen terwijl Anthropic
// de standaardkeuze blijft.
export function omnirouteProviderFromSettings(s: ModelSettings): ActiveProvider {
  return omnirouteProvider(s.omniroute);
}

// Geeft de Omniroute-ActiveProvider terug als automatische failover aan staat,
// anders null. claude.ts gebruikt dit om na een credit-/rate-fout op Anthropic
// éénmalig naar Omniroute over te schakelen.
export async function failoverProvider(): Promise<ActiveProvider | null> {
  const s = await getModelSettings();
  if (!s.failover) return null;
  return omnirouteProviderFromSettings(s);
}

// Spiegelbeeld van failoverProvider(): geeft de directe Anthropic-provider
// terug als automatische failover aan staat én er een ANTHROPIC_API_KEY is,
// anders null. claude.ts gebruikt dit om na een Omniroute-infra-fout
// (onbereikbaar/timeout/gateway-5xx) éénmalig naar het directe Anthropic-pad
// over te schakelen. Dezelfde failover-setting geldt dus voor beide
// richtingen: met failover uit mag een Omniroute-storing nooit stilzwijgend
// als een Anthropic-call worden afgehandeld (die rekent bv. tegen een account
// zonder tegoed, wat de wachtrij op "Claude-tegoed is op" zet terwijl
// Omniroute het probleem is).
export async function anthropicFailoverProvider(): Promise<ActiveProvider | null> {
  const s = await getModelSettings();
  if (!s.failover) return null;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return directAnthropicProvider();
}

