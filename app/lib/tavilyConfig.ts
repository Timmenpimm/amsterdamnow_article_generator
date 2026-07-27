import { getSetting, setSetting } from './db';

// ---------------------------------------------------------------------------
// Tavily-API-key (Instellingen → "Tavily").
//
// Historisch kwam de key uitsluitend uit de env-var TAVILY_API_KEY. Deze module
// maakt hem in de UI instelbaar (app_settings-key `tavily_api_key`), zodat de
// redactie bij een op quotum (HTTP 432) snel naar een andere key kan wisselen
// zonder Vercel-env-vars aan te raken. Een opgeslagen key wint van de env-var;
// zonder opgeslagen key is het gedrag identiek aan de oude env-only situatie.
// lib/tavily.ts resolvet de key per call via getTavilyApiKey() hieronder.
// ---------------------------------------------------------------------------

export type TavilySource = 'settings' | 'env' | 'none';

export interface TavilyKeyStatus {
  configured: boolean;
  source: TavilySource;
  // Alleen de laatste 4 tekens van de effectieve key — de volledige key
  // verlaat de server nooit.
  maskedKey: string;
  // Is er een env-var om op terug te vallen als de override wordt verwijderd?
  hasEnvFallback: boolean;
}

const SETTING_KEY = 'tavily_api_key';

// Korte in-memory-cache, zelfde patroon als wpConfig.ts: de writer leest de
// key bij élke research-call en de instelling verandert zelden. 10s TTL houdt
// de DB-druk laag terwijl een wissel in Instellingen binnen ~10s doorwerkt.
let cache: { at: number; value: string } | null = null;
const TTL_MS = 10_000;

async function readSaved(): Promise<string> {
  const raw = await getSetting(SETTING_KEY);
  return (raw || '').trim();
}

// De effectieve key: opgeslagen instelling wint, anders de env-var, anders
// leeg (callers behandelen leeg als "niet geconfigureerd").
export async function getTavilyApiKey(): Promise<string> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const saved = await readSaved();
  const value = saved || (process.env.TAVILY_API_KEY || '').trim();
  cache = { at: Date.now(), value };
  return value;
}

export function maskKey(key: string): string {
  if (!key) return '';
  return `…${key.slice(-4)}`;
}

export async function getTavilyKeyStatus(): Promise<TavilyKeyStatus> {
  const saved = await readSaved();
  const env = (process.env.TAVILY_API_KEY || '').trim();
  const effective = saved || env;
  return {
    configured: Boolean(effective),
    source: saved ? 'settings' : env ? 'env' : 'none',
    maskedKey: maskKey(effective),
    hasEnvFallback: Boolean(env),
  };
}

export async function saveTavilyApiKey(key: string): Promise<TavilyKeyStatus> {
  await setSetting(SETTING_KEY, key.trim());
  cache = null;
  return getTavilyKeyStatus();
}

// Verwijdert de override — een lege waarde in app_settings laat
// getTavilyApiKey() weer op de env-var terugvallen.
export async function clearTavilyApiKey(): Promise<TavilyKeyStatus> {
  await setSetting(SETTING_KEY, '');
  cache = null;
  return getTavilyKeyStatus();
}
