import type { Article, ImageCandidateDraft } from './types';

// Zoekt rechtenvrije kandidaat-beelden bij een artikel. Vier providers:
// - Openverse (geen key; alleen licenties die commercieel gebruik toestaan)
// - Wikimedia Commons (geen key; licentie uit extmetadata gefilterd)
// - Pexels (alleen als PEXELS_API_KEY is gezet; Pexels-licentie is vrij)
// - Google Beeldzoeken via Serper.dev (alleen als SERPER_API_KEY is gezet).
//   Waarom niet Googles eigen API: de Programmable Search Engine kan sinds
//   20-1-2026 voor nieuwe engines niet meer het hele web doorzoeken en de
//   Custom Search JSON API is dicht voor nieuwe aanmeldingen (hele feature
//   stopt 1-1-2027; de enterprise-opvolger begint bij $30k/maand). Serper
//   levert dezelfde Google Images-resultaten. Googles Creative Commons-
//   rechtenfilter (tbs=il:cl) staat vast aan — zonder dat filter is vrijwel
//   alles op Google Images auteursrechtelijk beschermd. Die licentie-info
//   komt van paginamarkup en is indicatief; de redactie kan via de
//   bronpagina-link controleren vóór publicatie.
// Harde eis van de redactie: beeld moet liggend/rechthoekig zijn. Een enkel
// minimum op béide zijden werkt averechts (het gooit 1600×800 weg maar laat
// 1000×2000 toe). We eisen daarom een landscape-ratio plus een minimum op de
// lange én — veel lager — de korte zijde, zodat een normale liggende foto
// (1600×900, 1200×800) slaagt en een vierkant/staand beeld faalt.
const MIN_LONG_EDGE = 1200;
const MIN_SHORT_EDGE = 700;
const LANDSCAPE_RATIO = 1.3;

// Geldig = duidelijk liggend én groot genoeg. width/height zitten al in de
// candidate-metadata van elke provider, dus deze centrale guard vangt ook
// Wikimedia Commons af (dat geen oriëntatie-zoekparam heeft).
export function isLandscapeEnough(width: number, height: number): boolean {
  const w = Number(width), h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return false;
  return w >= h * LANDSCAPE_RATIO && w >= MIN_LONG_EDGE && h >= MIN_SHORT_EDGE;
}
const PER_QUERY = 20;
const FETCH_TIMEOUT_MS = 8000;
// Bovengrens op het aantal kandidaten dat doorgaat naar scoring. Scoren kost
// ~300-500 tokens per beeld en de redactie kiest er uiteindelijk ~3 uit —
// 48 kandidaten is dus ruim, terwijl 4 zoektermen × 4 providers × 20 per
// query in het slechtste geval 100+ ongescoorde kandidaten zou opleveren.
const MAX_CANDIDATES = 48;

// Licenties op Commons die commercieel gebruik + bewerking toestaan.
const COMMONS_LICENSE_OK = /^(cc0|cc[ -]by(?:[ -]sa)?(?:[ -]\d\.\d)?|public domain|pd)/i;

function timeoutFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, cache: 'no-store', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

// Zoektermen uit de artikelgegevens, specifiek → generiek. Geen Claude-call
// nodig: de metadata die de schrijf-pipeline al invulde is precies wat we
// willen zoeken (venue, buurt, onderwerp).
export function buildImageQueries(article: Pick<Article, 'title' | 'naam_locatie' | 'district' | 'tags' | 'category'>): string[] {
  const queries: string[] = [];
  const add = (q: string | undefined | null) => {
    const t = (q || '').trim().replace(/\s+/g, ' ');
    if (t.length > 2 && !queries.some(x => x.toLowerCase() === t.toLowerCase())) queries.push(t);
  };
  if (article.naam_locatie) add(`${article.naam_locatie} Amsterdam`);
  add(article.title);
  const thema = article.tags?.find(t => t.toLowerCase() !== 'amsterdam');
  if (thema) add(`${thema} Amsterdam`);
  if (article.district) add(`${article.district} Amsterdam`);
  return queries.slice(0, 4);
}

type Draft = ImageCandidateDraft;

async function searchOpenverse(query: string): Promise<Draft[]> {
  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&license_type=commercial&aspect_ratio=wide&page_size=${PER_QUERY}`;
  const res = await timeoutFetch(url, { headers: { 'User-Agent': 'AmsterdamNOW-beeldselectie' } });
  if (!res.ok) throw new Error(`Openverse ${res.status}`);
  const data = await res.json() as { results?: any[] };
  return (data.results || [])
    .filter(r => r.url && !/\.svg(\?|$)/i.test(r.url))
    .map(r => ({
      url: r.url as string,
      thumb_url: (r.thumbnail || r.url) as string,
      width: Number(r.width), height: Number(r.height),
      source: `Openverse · ${r.source || r.provider || 'onbekend'}`,
      source_page: (r.foreign_landing_url || r.url) as string,
      license: `${String(r.license || '').toUpperCase()}${r.license_version ? ` ${r.license_version}` : ''}`.trim(),
      license_url: (r.license_url || '') as string,
      author: (r.creator || '') as string,
      title: (r.title || '') as string,
      query,
    }));
}

async function searchCommons(query: string): Promise<Draft[]> {
  const params = new URLSearchParams({
    action: 'query', format: 'json', origin: '*',
    generator: 'search', gsrnamespace: '6', gsrlimit: String(PER_QUERY),
    gsrsearch: `filetype:bitmap ${query}`,
    prop: 'imageinfo', iiprop: 'url|size|extmetadata', iiurlwidth: '640',
  });
  const res = await timeoutFetch(`https://commons.wikimedia.org/w/api.php?${params}`, {
    headers: { 'User-Agent': 'AmsterdamNOW-beeldselectie (redactie@amsterdamnow.com)' },
  });
  if (!res.ok) throw new Error(`Commons ${res.status}`);
  const data = await res.json() as { query?: { pages?: Record<string, any> } };
  const out: Draft[] = [];
  for (const page of Object.values(data.query?.pages || {})) {
    const info = page.imageinfo?.[0];
    if (!info?.url) continue;
    if (!/\.(jpe?g|png|webp)$/i.test(info.url)) continue;
    const meta = info.extmetadata || {};
    const license = String(meta.LicenseShortName?.value || '');
    if (!COMMONS_LICENSE_OK.test(license)) continue;
    const author = String(meta.Artist?.value || '').replace(/<[^>]+>/g, '').trim();
    out.push({
      url: info.url, thumb_url: info.thumburl || info.url,
      width: Number(info.width), height: Number(info.height),
      source: 'Wikimedia Commons',
      source_page: info.descriptionurl || info.url,
      license, license_url: String(meta.LicenseUrl?.value || ''),
      author: author.slice(0, 120),
      title: String(page.title || '').replace(/^File:/, ''),
      query,
    });
  }
  return out;
}

async function searchPexels(query: string): Promise<Draft[]> {
  const key = process.env.PEXELS_API_KEY;
  if (!key) return [];
  const res = await timeoutFetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&orientation=landscape&per_page=${PER_QUERY}`, {
    headers: { Authorization: key },
  });
  if (!res.ok) throw new Error(`Pexels ${res.status}`);
  const data = await res.json() as { photos?: any[] };
  return (data.photos || [])
    .map(p => ({
      url: (p.src?.original || p.src?.large2x) as string,
      thumb_url: (p.src?.medium || p.src?.large) as string,
      width: Number(p.width), height: Number(p.height),
      source: 'Pexels',
      source_page: p.url as string,
      license: 'Pexels-licentie (vrij te gebruiken)',
      license_url: 'https://www.pexels.com/license/',
      author: (p.photographer || '') as string,
      title: (p.alt || '') as string,
      query,
    }));
}

async function searchGoogle(query: string): Promise<Draft[]> {
  const key = process.env.SERPER_API_KEY;
  if (!key) return [];
  const res = await timeoutFetch('https://google.serper.dev/images', {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    // tbs=il:cl is Googles eigen "Creative Commons-licenties"-beeldfilter;
    // iar:w voegt Googles "wide/liggend"-beeldvormfilter toe.
    body: JSON.stringify({ q: query, gl: 'nl', hl: 'nl', num: PER_QUERY, tbs: 'il:cl,iar:w' }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(`Google (Serper) ${res.status}${body.message ? `: ${body.message.slice(0, 80)}` : ''}`);
  }
  const data = await res.json() as { images?: any[] };
  return (data.images || [])
    .filter(it => it.imageUrl && !/\.svg(\?|$)/i.test(it.imageUrl))
    .map(it => ({
      url: it.imageUrl as string,
      thumb_url: (it.thumbnailUrl || it.imageUrl) as string,
      width: Number(it.imageWidth), height: Number(it.imageHeight),
      source: `Google · ${it.domain || it.source || 'onbekend'}`,
      source_page: (it.link || it.imageUrl) as string,
      license: 'Creative Commons (Google-rechtenfilter — check de bronpagina)',
      license_url: '',
      author: (it.source || it.domain || '') as string,
      title: (it.title || '') as string,
      query,
    }));
}

// Alle providers × alle zoektermen parallel; een falende provider breekt de
// ronde niet. Dedup op URL, specifiekste zoekterm (eerste) wint.
export async function searchImageCandidates(
  article: Pick<Article, 'title' | 'naam_locatie' | 'district' | 'tags' | 'category'>
): Promise<{ drafts: Draft[]; queries: string[]; errors: string[] }> {
  const queries = buildImageQueries(article);
  if (!queries.length) throw new Error('Geen bruikbare zoektermen: artikel heeft titel noch locatie.');

  const jobs = queries.flatMap(q => [
    { name: 'Openverse', p: searchOpenverse(q) },
    { name: 'Wikimedia Commons', p: searchCommons(q) },
    { name: 'Pexels', p: searchPexels(q) },
    { name: 'Google', p: searchGoogle(q) },
  ]);
  const settled = await Promise.allSettled(jobs.map(j => j.p));

  const errors: string[] = [];
  const seen = new Set<string>();
  const drafts: Draft[] = [];
  settled.forEach((s, i) => {
    if (s.status === 'rejected') {
      const msg = `${jobs[i].name}: ${s.reason?.message || 'niet bereikbaar'}`;
      if (!errors.includes(msg)) errors.push(msg);
      return;
    }
    for (const d of s.value) {
      // Centrale liggend-guard: alleen duidelijk rechthoekige, liggende
      // beelden die groot genoeg zijn gaan door naar scoring.
      if (!isLandscapeEnough(d.width, d.height)) continue;
      const key = d.url.split('?')[0];
      if (seen.has(key)) continue;
      seen.add(key);
      drafts.push(d);
    }
  });
  // jobs (en dus drafts) volgen de queryvolgorde van buildImageQueries, die
  // specifiek → generiek levert. Afkappen op MAX_CANDIDATES behoudt zo de
  // meest specifieke resultaten (venue/locatie) en offert alleen de
  // generiekste kandidaten op.
  return { drafts: drafts.slice(0, MAX_CANDIDATES), queries, errors };
}
