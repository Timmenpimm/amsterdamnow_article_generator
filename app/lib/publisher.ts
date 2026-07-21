// Auto-publisher: publiceert zelf artikelen uit "Klaar voor publicatie" op een
// instelbaar interval. Zie docs/superpowers/specs voor de volledige spec.
// Drie onderdelen: instellingen (app_settings, key 'autopublish'),
// classificatie (evergreen/event_date per artikel, publish_meta) en selectie
// (pickNextForPublish — een pure functie, los te testen/redeneren).
import type { Article } from './types';
import { getSetting, setSetting, claimSetting, getPublishMetaByIds, upsertPublishMeta, type PublishMetaRow } from './db';
import { askClaudeJson } from './claude';
import { AUTOPUBLISH_CLASSIFY_SCHEMA } from './schemas';

const SETTINGS_KEY = 'autopublish';

export interface AutoPublishSettings {
  enabled: boolean;
  intervalMinutes: number;
  lastPublishedAt: string | null;
}

const DEFAULT_SETTINGS: AutoPublishSettings = {
  enabled: false,
  intervalMinutes: 120,
  lastPublishedAt: null,
};

// Zelfde ruwe JSON-string als opgeslagen onder app_settings.autopublish,
// zodat de tick-route 'm kan gebruiken als CAS-basiswaarde (claimAutoPublishTick
// hieronder) — getAutoPublishSettings() geeft alleen de geparste instellingen.
export async function getAutoPublishSettingsRaw(): Promise<{ settings: AutoPublishSettings; raw: string | null }> {
  const raw = await getSetting(SETTINGS_KEY);
  if (!raw) return { settings: { ...DEFAULT_SETTINGS }, raw: null };
  try {
    return { settings: { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }, raw };
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, raw };
  }
}

export async function getAutoPublishSettings(): Promise<AutoPublishSettings> {
  return (await getAutoPublishSettingsRaw()).settings;
}

export async function saveAutoPublishSettings(partial: Partial<AutoPublishSettings>): Promise<AutoPublishSettings> {
  const current = await getAutoPublishSettings();
  const next = { ...current, ...partial };
  await setSetting(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

// Optimistische claim tegen gelijktijdige tikken: zet lastPublishedAt = nu,
// maar alleen als de opgeslagen instellingen sinds het lezen (getAutoPublish-
// SettingsRaw, vóór deze aanroep) niet zijn gewijzigd. Wint maar één van twee
// gelijktijdige polls de rest van de tik (classificeren kost een Haiku-call,
// zie classifyArticles) — de verliezer stopt meteen. Mislukt het publiceren
// alsnog, of blijkt er niets te publiceren, dan draait de tick-route de claim
// terug via saveAutoPublishSettings({ lastPublishedAt: <oude waarde> }).
export async function claimAutoPublishTick(
  raw: string | null, settings: AutoPublishSettings, nowIso: string
): Promise<boolean> {
  const next = JSON.stringify({ ...settings, lastPublishedAt: nowIso });
  return claimSetting(SETTINGS_KEY, raw, next);
}

// "Vandaag" in Europe/Amsterdam (niet UTC): new Date().toISOString() loopt
// tussen middernacht UTC en middernacht lokale tijd een dag achter/voor,
// wat zowel de classificatieprompt als het event-tijdvenster op de verkeerde
// dag zou laten rekenen. sv-SE formatteert standaard als "JJJJ-MM-DD".
export function todayInAmsterdam(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam' }).format(date);
}

// Volgende geplande tik, uitsluitend informatief (voor de UI) — de tick-route
// zelf herberekent onafhankelijk of het interval echt verstreken is.
export function nextRunAt(settings: AutoPublishSettings): string | null {
  if (!settings.lastPublishedAt) return null;
  const last = new Date(settings.lastPublishedAt).getTime();
  if (!Number.isFinite(last)) return null;
  return new Date(last + settings.intervalMinutes * 60_000).toISOString();
}

// ---------- classificatie ----------

const CLASSIFY_MODEL = 'claude-haiku-4-5-20251001';
// Eén Claude-call per tik (60s-serverless-limiet), dus maximaal 8 artikelen
// per batch — ruim genoeg om de wachtrij binnen een paar tikken bij te werken.
const MAX_CLASSIFY_PER_TICK = 8;
const CLASSIFY_MAX_TOKENS = 2000;

const CLASSIFY_SYSTEM = `Je beoordeelt voor de redactie van amsterdamnow.com per artikel of het "evergreen" is.

Evergreen = tijdloos: gidsen, lijstjes, portretten van vaste zaken/venues — blijft altijd relevant, ongeacht wanneer iemand het leest.
Niet-evergreen = nieuws, openingen, tijdgebonden content — verliest relevantie na een periode of hoort bij een specifieke gebeurtenis.

Gaat het artikel over een specifieke aankomende gebeurtenis of datum, geef die dan terug als "event_date" in het formaat "YYYY-MM-DD". Gaat het niet over een specifieke datum (of is het evergreen), geef dan event_date: null.

Antwoord uitsluitend met geldig JSON conform het schema: een array "classifications" met per artikel {id, evergreen, event_date}, in dezelfde volgorde als de aangeleverde artikelen.`;

function buildClassifyPrompt(articles: Article[], todayIso: string): string {
  const lines = articles.map(a => {
    const intro = (a.intro || '').slice(0, 300);
    return `- id ${a.id} (categorie: ${a.category || 'onbekend'}): "${a.title}"${intro ? `\n  Intro: ${intro}` : ''}`;
  }).join('\n');
  return `Vandaag is ${todayIso}.\n\nBeoordeel elk van deze artikelen:\n${lines}`;
}

function isValidEventDate(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

// Classificeert artikelen die nog geen publish_meta-rij hebben, in maximaal
// ÉÉN Haiku-call (max 8 per tik). Fail-open: mislukt de call, dan blijven de
// betrokken artikelen ongeclassificeerd — pickNextForPublish behandelt ze dit
// tik als { evergreen: false, event_date: null } (worden gewoon opnieuw
// geprobeerd op de volgende tik, zie tick-route).
export async function classifyArticles(articles: Article[]): Promise<Map<number, PublishMetaRow>> {
  const ids = articles.map(a => a.id);
  const known = await getPublishMetaByIds(ids);
  const unclassified = articles.filter(a => !known.has(a.id)).slice(0, MAX_CLASSIFY_PER_TICK);
  if (!unclassified.length) return known;

  try {
    const today = todayInAmsterdam();
    const prompt = buildClassifyPrompt(unclassified, today);
    const result = await askClaudeJson(
      CLASSIFY_SYSTEM, prompt, false, CLASSIFY_MODEL, CLASSIFY_MAX_TOKENS, AUTOPUBLISH_CLASSIFY_SCHEMA
    );
    const list = Array.isArray(result.classifications) ? result.classifications : [];
    const askedIds = new Set(unclassified.map(a => a.id));
    for (const raw of list as Record<string, unknown>[]) {
      const id = Number(raw.id);
      if (!askedIds.has(id)) continue; // defensief: alleen ids verwerken die we ook vroegen
      const evergreen = raw.evergreen === true;
      const event_date = isValidEventDate(raw.event_date) ? raw.event_date : null;
      await upsertPublishMeta(id, evergreen, event_date);
      known.set(id, { evergreen, event_date });
    }
  } catch (err) {
    console.warn('[publisher] classificatie mislukt, artikelen blijven ongeclassificeerd (fail-open)', err);
  }
  return known;
}

// ---------- selectie ----------

// Binnen dit venster (dagen) telt een aankomend event als "urgent". Buiten dit
// venster (of onbekend/voorbij) is het gewoon een reguliere niet-evergreen tier.
const EVENT_WINDOW_DAYS = 21;
// Categorie-balansbonus: max 72 uur sinds laatste publicatie in die categorie.
// Kleiner dan het tiergat (100), dus deze bonus kan nooit een tier overslaan —
// bewust, zie spec.
const CATEGORY_BONUS_CAP_HOURS = 72;

function daysUntil(dateStr: string, today: Date): number {
  const target = new Date(`${dateStr}T00:00:00Z`).getTime();
  const todayMidnight = new Date(`${todayInAmsterdam(today)}T00:00:00Z`).getTime();
  return Math.round((target - todayMidnight) / 86_400_000);
}

function tierScore(meta: PublishMetaRow | undefined, today: Date): number {
  const evergreen = meta?.evergreen ?? false;
  const eventDate = meta?.event_date ?? null;
  if (!evergreen && eventDate) {
    const days = daysUntil(eventDate, today);
    if (days >= 0 && days <= EVENT_WINDOW_DAYS) return 300 + (EVENT_WINDOW_DAYS - days);
  }
  if (!evergreen) return 200;
  return 100;
}

// "Laatst gepubliceerd" per categorie, uit de al gepubliceerde artikelen op
// het bord (status 'publish'). Categorie nooit gepubliceerd → geen entry →
// aanroeper geeft de volle bonus.
function lastPublishedByCategory(published: Pick<Article, 'category' | 'date'>[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const a of published) {
    const cat = a.category || '';
    const t = new Date(a.date).getTime();
    if (!Number.isFinite(t)) continue;
    const prev = map.get(cat);
    if (prev === undefined || t > prev) map.set(cat, t);
  }
  return map;
}

// Pure functie: geen DB/netwerk, dus makkelijk te redeneren en (met fixtures)
// te testen. `ready` = artikelen in de "Klaar voor publicatie"-kolom,
// `metaById` = classificatie per artikel-id (ontbrekend = nog niet
// geclassificeerd, telt als niet-evergreen zonder event), `published` = alle
// al gepubliceerde artikelen op het bord (voor de categorie-balans).
export function pickNextForPublish(
  ready: Article[],
  metaById: Map<number, PublishMetaRow>,
  published: Pick<Article, 'category' | 'date'>[],
  now: Date = new Date()
): Article | null {
  if (!ready.length) return null;
  const lastByCategory = lastPublishedByCategory(published);

  let best: Article | null = null;
  let bestScore = -Infinity;
  let bestDateMs = Infinity;

  for (const a of ready) {
    const tier = tierScore(metaById.get(a.id), now);
    const lastMs = lastByCategory.get(a.category || '');
    const bonus = lastMs === undefined
      ? CATEGORY_BONUS_CAP_HOURS
      : Math.min(CATEGORY_BONUS_CAP_HOURS, (now.getTime() - lastMs) / 3_600_000);
    const score = tier + bonus;
    const dateMs = new Date(a.date).getTime();
    const dateKey = Number.isFinite(dateMs) ? dateMs : Infinity;

    if (score > bestScore || (score === bestScore && dateKey < bestDateMs)) {
      best = a;
      bestScore = score;
      bestDateMs = dateKey;
    }
  }
  return best;
}
