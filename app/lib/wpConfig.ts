import { getSetting, setSetting } from './db';

// ---------------------------------------------------------------------------
// WordPress-koppeling (Instellingen → "WordPress").
//
// Historisch kwam de WP-verbinding uitsluitend uit env-vars (WP_URL/WP_USER/
// WP_APP_PASSWORD, gelezen als module-constanten in lib/wp.ts). Deze module
// maakt de koppeling in de UI instelbaar: opgeslagen instellingen (app_settings-
// key `wordpress_connection`) winnen per veld van de env-vars, en zonder
// opgeslagen instelling is het gedrag identiek aan de oude env-only situatie.
// lib/wp.ts en lib/wpSync.ts resolven de verbinding per call via
// getWpConnection() hieronder.
// ---------------------------------------------------------------------------

export interface WpConnectionSettings {
  url: string;         // site-origin, bv. https://www.amsterdamnow.com
  user: string;        // WP-gebruikersnaam
  appPassword: string; // WordPress application password
}

export type WpSource = 'settings' | 'env' | 'none';

export interface WpConnection extends WpConnectionSettings {
  // Waar de effectieve verbinding vandaan komt: opgeslagen instellingen,
  // env-vars, of niets (demo-modus op de default-URL).
  source: WpSource;
  // Zelfde betekenis als de oude module-constante LIVE: url + user + wachtwoord
  // allemaal aanwezig → de tool praat echt met WordPress.
  live: boolean;
}

const SETTING_KEY = 'wordpress_connection';
export const DEFAULT_WP_URL = 'https://www.amsterdamnow.com';

// Normaliseert een site-URL: whitespace + trailing slashes eruit. Validatie
// (http/https verplicht) zit in isValidWpUrl; de API-route wijst ongeldige
// invoer af vóór hij hier belandt.
export function normalizeWpUrl(raw: string): string {
  return (raw || '').trim().replace(/\/+$/, '');
}

export function isValidWpUrl(raw: string): boolean {
  return /^https?:\/\/\S+$/i.test(normalizeWpUrl(raw));
}

// Korte in-memory-cache, zelfde patroon als modelConfig.ts: wp.ts leest de
// verbinding bij élke WP-call en de instelling verandert zelden. 10s TTL houdt
// de DB-druk laag terwijl een wijziging in Instellingen binnen ~10s doorwerkt.
let cache: { at: number; value: WpConnection } | null = null;
const TTL_MS = 10_000;

function coerceSaved(raw: unknown): WpConnectionSettings {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    url: typeof obj.url === 'string' ? normalizeWpUrl(obj.url) : '',
    user: typeof obj.user === 'string' ? obj.user.trim() : '',
    appPassword: typeof obj.appPassword === 'string' ? obj.appPassword : '',
  };
}

async function readSaved(): Promise<WpConnectionSettings> {
  const raw = await getSetting(SETTING_KEY);
  if (!raw) return { url: '', user: '', appPassword: '' };
  try {
    return coerceSaved(JSON.parse(raw));
  } catch {
    return { url: '', user: '', appPassword: '' };
  }
}

function resolve(saved: WpConnectionSettings): WpConnection {
  const envUrl = normalizeWpUrl(process.env.WP_URL || '');
  const envUser = (process.env.WP_USER || '').trim();
  const envPass = process.env.WP_APP_PASSWORD || '';
  // Per veld: opgeslagen waarde wint, anders env, anders default/leeg — zodat
  // een redactie die alleen het wachtwoord ververst niet ook de URL hoeft
  // over te typen.
  const url = saved.url || envUrl || DEFAULT_WP_URL;
  const user = saved.user || envUser;
  const appPassword = saved.appPassword || envPass;
  const anySaved = Boolean(saved.url || saved.user || saved.appPassword);
  const anyEnv = Boolean(envUrl || envUser || envPass);
  return {
    url,
    user,
    appPassword,
    source: anySaved ? 'settings' : anyEnv ? 'env' : 'none',
    live: Boolean(url && user && appPassword),
  };
}

export async function getWpConnection(): Promise<WpConnection> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const value = resolve(await readSaved());
  cache = { at: Date.now(), value };
  return value;
}

// Slaat (een deel van) de verbinding op. Merge gebeurt tegen de OPGESLAGEN
// waarden, niet tegen de env-resolved verbinding — anders zouden env-waarden
// stilletjes als "eigen instelling" in de database belanden. Een lege
// appPassword laat het bestaande wachtwoord staan (zelfde conventie als de
// API-key in modelConfig/api-model); url en user mogen wél leeg worden gemaakt
// (= terugvallen op env).
export async function saveWpConnection(partial: Partial<WpConnectionSettings>): Promise<WpConnection> {
  const saved = await readSaved();
  const next: WpConnectionSettings = {
    url: partial.url !== undefined ? normalizeWpUrl(partial.url) : saved.url,
    user: partial.user !== undefined ? partial.user.trim() : saved.user,
    appPassword: partial.appPassword !== undefined && partial.appPassword.trim()
      ? partial.appPassword.trim()
      : saved.appPassword,
  };
  await setSetting(SETTING_KEY, JSON.stringify(next));
  cache = null;
  return getWpConnection();
}
