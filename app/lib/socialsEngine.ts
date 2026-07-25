import { getSetting, setSetting } from './db';

// ---------------------------------------------------------------------------
// Koppeling met de socials-engine (Instellingen → "Instagram").
//
// Instagram is eigendom van de losse socials-engine
// (https://amsterdamnow-socials.vercel.app); de artikel-tool praat er
// uitsluitend server-side mee, met een Bearer-API-key die nooit naar de client
// lekt. Instellingen staan als JSON onder app_settings-key `socials_engine`,
// met env-fallback — zelfde patroon als wpConfig.ts/modelConfig.ts.
// ---------------------------------------------------------------------------

export interface SocialsEngineSettings {
  baseUrl: string; // origin van de engine, zonder trailing slash
  apiKey: string;  // Bearer-key (ENGINE_API_KEY aan de engine-kant)
}

export const DEFAULT_ENGINE_URL = 'https://amsterdamnow-socials.vercel.app';
const SETTING_KEY = 'socials_engine';

export function normalizeEngineUrl(raw: string): string {
  return (raw || '').trim().replace(/\/+$/, '');
}

export function isValidEngineUrl(raw: string): boolean {
  return /^https?:\/\/\S+$/i.test(normalizeEngineUrl(raw));
}

// Zelfde 10s-cache als modelConfig/wpConfig.
let cache: { at: number; value: SocialsEngineSettings } | null = null;
const TTL_MS = 10_000;

function coerceSaved(raw: unknown): SocialsEngineSettings {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    baseUrl: typeof obj.baseUrl === 'string' ? normalizeEngineUrl(obj.baseUrl) : '',
    apiKey: typeof obj.apiKey === 'string' ? obj.apiKey.trim() : '',
  };
}

async function readSaved(): Promise<SocialsEngineSettings> {
  const raw = await getSetting(SETTING_KEY);
  if (!raw) return { baseUrl: '', apiKey: '' };
  try {
    return coerceSaved(JSON.parse(raw));
  } catch {
    return { baseUrl: '', apiKey: '' };
  }
}

export async function getEngineSettings(): Promise<SocialsEngineSettings> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const saved = await readSaved();
  const value: SocialsEngineSettings = {
    baseUrl: saved.baseUrl || normalizeEngineUrl(process.env.SOCIALS_ENGINE_URL || '') || DEFAULT_ENGINE_URL,
    apiKey: saved.apiKey || (process.env.SOCIALS_ENGINE_API_KEY || '').trim(),
  };
  cache = { at: Date.now(), value };
  return value;
}

// Lege apiKey = bestaande behouden (zelfde conventie als wpConfig/modelConfig);
// baseUrl mag leeg gemaakt worden (= terugvallen op env/default).
export async function saveEngineSettings(partial: Partial<SocialsEngineSettings>): Promise<SocialsEngineSettings> {
  const saved = await readSaved();
  const next: SocialsEngineSettings = {
    baseUrl: partial.baseUrl !== undefined ? normalizeEngineUrl(partial.baseUrl) : saved.baseUrl,
    apiKey: partial.apiKey !== undefined && partial.apiKey.trim() ? partial.apiKey.trim() : saved.apiKey,
  };
  await setSetting(SETTING_KEY, JSON.stringify(next));
  cache = null;
  return getEngineSettings();
}

// Foutklasse zodat aanroepers een 401 (verkeerde key) kunnen onderscheiden van
// een onbereikbare engine of een inhoudelijke fout.
export class EngineError extends Error {
  status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.status = status;
  }
}

// Server-side fetch naar de engine. Plakt de Bearer-header erbij en gooit een
// informatieve EngineError bij !ok (body afgekapt, nooit de key zelf).
export async function engineFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { baseUrl, apiKey } = await getEngineSettings();
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(init.headers || {}),
      },
      cache: 'no-store',
      // Standaard 15s; langlopende calls (genereren/publiceren, tot ~60s aan
      // de engine-kant) geven zelf een ruimere AbortSignal.timeout mee.
      signal: init.signal ?? AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new EngineError(
      `Socials-engine onbereikbaar op ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
      null
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new EngineError(`Socials-engine ${res.status} bij ${path}: ${body.slice(0, 300)}`, res.status);
  }
  return res;
}
