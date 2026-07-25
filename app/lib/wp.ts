import { demoDelete, demoGetAll, demoUpsert, ensureDemoSeed, STORAGE } from './db';
import { DEMO_ARTICLES, DEMO_TOPICS } from './demo-seed';
import { decodeHtmlEntities } from './htmlEntities';
import { cleanCredit } from './credit';
import { formatExistingStandardArticleHtml, hasEditorialFormatting } from './articleHtml';
import { imageAltName, imageFileName, MEDIA_MIME_EXT, type ImageNameContext } from './mediaName';
import { getWpConnection, type WpConnection } from './wpConfig';
import type { Article, MediaRef } from './types';

export { STORAGE };

// De WP-verbinding (URL + credentials) komt sinds juli 2026 per call uit
// lib/wpConfig.ts (opgeslagen instellingen met env-fallback) in plaats van
// module-constanten, zodat de koppeling in Instellingen aanpasbaar is zonder
// deploy. Zonder opgeslagen instelling is het gedrag identiek aan de oude
// env-only situatie (WP_URL/WP_USER/WP_APP_PASSWORD).
// De oude exports `WP_URL` en `LIVE` zijn vervangen door deze async accessors.
export async function getWpUrl(): Promise<string> {
  return (await getWpConnection()).url;
}

export async function isLive(): Promise<boolean> {
  return (await getWpConnection()).live;
}

function basicAuth(conn: WpConnection): string {
  return 'Basic ' + Buffer.from(`${conn.user}:${conn.appPassword}`).toString('base64');
}

// Claude plakt af en toe ongevraagd een categorie/tag-linkblok achter de
// artikeltekst (bv. "<p><a href="…/tag/musea-amsterdam/">Musea</a><br><a
// href="…/cultuur/">Cultuur</a></p>"), hoewel categorieën en tags al als
// WordPress-taxonomie meegaan. Dat mag nooit als klikbare tekst in de content
// zelf staan, dus dit blok wordt overal waar content gelezen of geschreven
// wordt weggeknipt.
const TAXONOMY_FOOTER = /(?:\s*<p>(?:\s*<a href="https?:\/\/(?:www\.)?amsterdamnow\.com\/[^"]*"[^>]*>[^<]*<\/a>\s*(?:<br\s*\/?>)?\s*)+<\/p>)+\s*$/i;

function stripTaxonomyFooter(html: string): string {
  return html.replace(TAXONOMY_FOOTER, '');
}

async function wpFetchRaw(pathname: string, init: RequestInit = {}): Promise<Response> {
  const conn = await getWpConnection();
  const res = await fetch(`${conn.url}/wp-json${pathname}`, {
    ...init,
    headers: {
      Authorization: basicAuth(conn),
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WordPress ${res.status} bij ${pathname}: ${body.slice(0, 300)}`);
  }
  return res;
}

async function wpFetch(pathname: string, init: RequestInit = {}): Promise<any> {
  const res = await wpFetchRaw(pathname, init);
  return res.json();
}

// Eén per_page-pagina volstond zolang het bord klein was, maar liet elke
// draft voorbij de 50 meest recent bewerkte stilzwijgend uit het bord en de
// backfill-scan vallen — geen fout, gewoon onzichtbaar. Stopt op WordPress'
// eigen X-WP-TotalPages-header zodra die bekend is, zodat nooit een pagina
// voorbij het einde wordt opgevraagd — dat geeft WP niet een lege lijst
// terug maar een harde 400 (rest_post_invalid_page_number), bijvoorbeeld
// precies wanneer het aantal drafts een veelvoud van perPage is. De
// batch.length-check blijft als fallback voor het geval de header ontbreekt;
// de iteratiecap is een vangnet tegen een onverwacht altijd-vol antwoord,
// niet een normale grens.
async function wpFetchAllPages(pathname: string, perPage = 50): Promise<any[]> {
  const sep = pathname.includes('?') ? '&' : '?';
  const out: any[] = [];
  let totalPages = Infinity;
  for (let page = 1; page <= 40 && page <= totalPages; page++) {
    const res = await wpFetchRaw(`${pathname}${sep}per_page=${perPage}&page=${page}`);
    const headerTotal = Number(res.headers.get('X-WP-TotalPages'));
    if (headerTotal) totalPages = headerTotal;
    const batch = await res.json();
    out.push(...batch);
    if (batch.length < perPage) return out;
  }
  if (totalPages > 40) {
    throw new Error(`Meer dan ${40 * perPage} draft-posts gevonden — paginering-cap geraakt, controleer wpFetchAllPages.`);
  }
  return out;
}

// ---------- inline-artikelbeeld ----------
// Het inline-beeld leeft ín de content-HTML als een gemarkeerde figure, net als
// itemfoto's bij lijstartikelen (lib/listHtml.ts). Deze twee functies zijn de
// enige plek die die markup schrijft/leest; de marker-strings
// (`figure.an-inline` + `wp-image-<id>`) zijn het contract met de UI.
const INLINE_FIGURE_RE = /\s*<figure class="an-inline">[\s\S]*?<\/figure>/i;

// Top-level blok-elementen van de artikeltekst. We tellen blokken, niet alleen
// </p>: de lede-alinea staat als <h2> in de content en de pull-quote als
// <blockquote>, dus louter </p> tellen zou het beeld een blok te laat plaatsen.
const BLOCK_RE = /<(p|h[1-6]|blockquote|ul|ol|figure|pre|table)\b[^>]*>[\s\S]*?<\/\1>/gi;

// Attribuutwaarde veilig maken. Alt-teksten komen uit de mediabibliotheek en
// kunnen dus alles bevatten wat een redacteur ooit in WordPress typte; zonder
// escapen breekt één aanhalingsteken de hele figure-markup (en daarmee
// parseInline hieronder).
function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// `alt` is optioneel: zonder waarde blijft het gedrag exact zoals het was
// (alt=""), zodat bestaande aanroepers niets hoeven te weten van de
// beeldnaamconventie. De attribuutvolgorde (class, src, alt) blijft bewust
// ongewijzigd: parseInline pakt met /src="([^"]+)"/ het eerste src-attribuut,
// en omdat de alt-waarde geëscaped is en ná src staat, blijft dat kloppen.
export function spliceInlineImage(html: string, media: MediaRef | null, alt?: string): string {
  const stripped = (html || '').replace(INLINE_FIGURE_RE, '');
  if (!media) return stripped;
  const fig = `<figure class="an-inline"><img class="wp-image-${media.id}" src="${media.url}" alt="${escapeAttr(alt || '')}" /></figure>`;
  // Eind-posities van top-level blokken; plaats de figure na het 2e blok
  // (= tussen de 2e en 3e alinea van de tekst).
  const ends: number[] = [];
  let m: RegExpExecArray | null;
  BLOCK_RE.lastIndex = 0;
  while ((m = BLOCK_RE.exec(stripped))) ends.push(m.index + m[0].length);
  if (ends.length >= 3) {
    const at = ends[1]; // na het 2e blok → tussen alinea 2 en 3
    return stripped.slice(0, at) + '\n' + fig + stripped.slice(at);
  }
  // < 3 blokken → achteraan (gekozen gedrag).
  return stripped.trimEnd() + (stripped.trim() ? '\n' : '') + fig;
}

function parseInline(contentHtml: string): MediaRef | null {
  const fig = (contentHtml || '').match(INLINE_FIGURE_RE);
  if (!fig) return null;
  const idM = fig[0].match(/wp-image-(\d+)/);
  const srcM = fig[0].match(/src="([^"]+)"/);
  if (!idM || !srcM) return null;
  return { id: Number(idM[1]), url: srcM[1] };
}

// ---------- taxonomy caches ----------

let catCache: Record<number, string> | null = null;
let districtCache: Record<number, string> | null = null;
let tagCache: Record<number, string> = {};
// Bestaande WP-tags waaruit de AI mag kiezen bij het classificeren van een
// artikel (zie taxonomyChoices). Eén pagina van 100 volstaat ruimschoots voor
// de huidige ~21 tags; stond eerder op 30, waardoor tags erbuiten stil uit de
// keuzelijst verdwenen. Sinds er nog maar één tag per artikel gekozen wordt is
// een incomplete kandidatenlijst niet langer een detail maar direct een fout.
let tagChoicesCache: string[] | null = null;

async function loadTaxonomies() {
  if (catCache && districtCache && tagChoicesCache) return;
  const wpUrl = await getWpUrl();
  const [cats, districts, tags] = await Promise.all([
    fetch(`${wpUrl}/wp-json/wp/v2/categories?per_page=100`, { cache: 'no-store' }).then(r => r.json()),
    fetch(`${wpUrl}/wp-json/wp/v2/district?per_page=100`, { cache: 'no-store' }).then(r => r.json()),
    fetch(`${wpUrl}/wp-json/wp/v2/tags?per_page=100`, { cache: 'no-store' }).then(r => r.json()),
  ]);
  catCache = Object.fromEntries(cats.map((c: any) => [c.id, c.name]));
  districtCache = Object.fromEntries(districts.map((d: any) => [d.id, d.name]));
  tagChoicesCache = tags.map((t: any) => decodeHtmlEntities(String(t.name)));
}

export async function taxonomyChoices(): Promise<{ categories: string[]; districts: string[]; tags: string[] }> {
  if (!(await isLive())) return {
    categories: ['Cultuur', 'Uitgaan', 'Restaurants', 'Lifestyle'],
    districts: ['Amsterdam Centrum', 'Amsterdam Noord', 'Amsterdam Oost', 'Amsterdam Zuid'],
    tags: ['Terras', 'Live muziek', 'Brunch', 'Hondvriendelijk'],
  };
  await loadTaxonomies();
  return { categories: Object.values(catCache || {}), districts: Object.values(districtCache || {}), tags: tagChoicesCache || [] };
}

// Eerst entities decoderen, dan pas normaliseren. WordPress levert taxonomie-
// namen HTML-geëncodeerd ("Cafés &amp; Bars"); de AI krijgt ze gedecodeerd
// aangeboden en geeft ze ook gedecodeerd terug. Zonder decode hier zou
// "cafés bars" nooit matchen met "cafés amp bars" en verdween de tag stil.
function normalized(value: string) {
  return decodeHtmlEntities(value).toLocaleLowerCase('nl-NL').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function idForName(items: Record<number, string>, name: string, type: string): number {
  const id = Object.entries(items).find(([, value]) => normalized(value) === normalized(name))?.[0];
  if (!id) throw new Error(`${type} “${name}” bestaat niet in WordPress.`);
  return Number(id);
}

function matchExistingTagId(existing: { id: number; name: string }[], name: string): number | null {
  const match = existing.find(tag => normalized(tag.name) === normalized(name));
  return match ? match.id : null;
}

// Precies één tag uit de modeloutput, als lijst van 0 of 1 element zodat de
// rest van de pipeline (GeneratedDraft.tags, de WordPress-payload) ongewijzigd
// blijft. Leest het nieuwe stringveld `tag`; werk dat al in de wachtrij stond
// heeft nog het oude array-veld `tags` in zijn opgeslagen state, dus daar
// vallen we op terug en nemen het eerste (door het model als meest relevant
// genoemde) element. Geen tag is een geldige uitkomst: dan gaat het artikel
// ongetagd weg, en dat is beter dan een tag die er niet bij past.
export function singleTag(source: Record<string, unknown>): string[] {
  const trimmed = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const tag = trimmed(source.tag);
  if (tag) return [tag];
  const legacy = (Array.isArray(source.tags) ? source.tags : []).map(trimmed).find(Boolean);
  return legacy ? [legacy] : [];
}

// Eén artikel krijgt hoogstens één tag: de best passende. De schema's dwingen
// dat al af aan de modelkant (RESEARCH_SCHEMA.tag, LIST_COMPOSE_FIRST_SCHEMA.tag);
// deze cap is het vangnet op het knooppunt waar beide schrijfpaden langskomen,
// zodat geen enkele toekomstige aanroeper er alsnog een reeks in kan duwen.
async function tagIdsForNames(names: string[]): Promise<number[]> {
  const name = names.map(n => n.trim()).find(Boolean);
  if (!name) return [];
  const existing = await wpFetch(`/wp/v2/tags?search=${encodeURIComponent(name)}&per_page=100`);
  const id = matchExistingTagId(existing, name);
  // Geen match → geen tag. Er wordt nooit automatisch een nieuwe WordPress-tag
  // aangemaakt vanuit het aanmaak-pad. Wel loggen: met één tag per artikel
  // betekent een mislukte match een artikel zonder tag, en dat ging voorheen
  // volledig ongemerkt voorbij.
  if (id === null) {
    console.warn(`[wp] Tag “${name}” niet gevonden in WordPress; artikel krijgt geen tag.`);
    return [];
  }
  return [id];
}

async function tagNames(ids: number[]): Promise<string[]> {
  const missing = ids.filter(id => !(id in tagCache));
  if (missing.length) {
    const tags = await fetch(`${await getWpUrl()}/wp-json/wp/v2/tags?include=${missing.join(',')}&per_page=100`, { cache: 'no-store' }).then(r => r.json());
    for (const t of tags) tagCache[t.id] = t.name;
  }
  return ids.map(id => tagCache[id]).filter(Boolean);
}

async function mediaRefs(ids: number[]): Promise<Record<number, MediaRef>> {
  if (!ids.length) return {};
  const out: Record<number, MediaRef> = {};
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
  for (const chunk of chunks) {
    const media = await wpFetch(`/wp/v2/media?include=${chunk.join(',')}&per_page=100&_fields=id,source_url,media_details`);
    for (const m of media) {
      const sized = m.media_details?.sizes?.large?.source_url || m.media_details?.sizes?.medium_large?.source_url;
      out[m.id] = { id: m.id, url: sized || m.source_url };
    }
  }
  return out;
}

// Haalt alleen de opgeslagen pixelafmetingen van media op (geen URL's), zodat
// een backfill kan bepalen welke bestaande beelden liggend genoeg zijn
// (zie lib/imageSearch.ts isLandscapeEnough) zonder de volledige mediaRefs-
// payload te hoeven laden. Zelfde chunk/aanpak als mediaRefs hierboven.
export async function mediaDimensions(ids: number[]): Promise<Map<number, { width: number; height: number }>> {
  const out = new Map<number, { width: number; height: number }>();
  if (!ids.length) return out;
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
  for (const chunk of chunks) {
    const media = await wpFetch(`/wp/v2/media?include=${chunk.join(',')}&per_page=100&_fields=id,media_details`);
    for (const m of media) {
      const width = Number(m.media_details?.width);
      const height = Number(m.media_details?.height);
      if (Number.isFinite(width) && Number.isFinite(height)) out.set(m.id, { width, height });
    }
  }
  return out;
}

// Haalt alleen de alt-teksten van media op. De mediabibliotheek is de enige
// bron van waarheid voor de beeldnaam (bestandsnaam == slug == titel == alt,
// zie de conventie bij setMediaMeta); wie het inline-beeld in de content
// (her)schrijft, leest de alt hier op in plaats van zelf een naam te
// verzinnen. Zelfde chunk-aanpak als mediaRefs/mediaDimensions hierboven:
// media zonder (lege) alt_text komen niet in de map, zodat een aanroeper met
// `?? ''` netjes op het oude gedrag terugvalt.
export async function mediaAltTexts(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!ids.length) return out;
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
  for (const chunk of chunks) {
    const media = await wpFetch(`/wp/v2/media?include=${chunk.join(',')}&per_page=100&_fields=id,alt_text`);
    for (const m of media) {
      const alt = typeof m.alt_text === 'string' ? m.alt_text.trim() : '';
      if (alt) out.set(m.id, alt);
    }
  }
  return out;
}

async function mapPost(p: any, media: Record<number, MediaRef>): Promise<Article> {
  const acf = p.acf || {};
  const sliderIds: number[] = Array.isArray(acf.slider) ? acf.slider : [];
  return {
    id: p.id,
    title: decodeHtmlEntities(p.title?.rendered || ''),
    subregel: acf.subregel || '',
    intro: acf.introductie_tekst || '',
    contentHtml: stripTaxonomyFooter(p.content?.rendered || ''),
    status: p.status === 'publish' ? 'publish' : 'draft',
    link: p.link,
    modified: p.modified,
    date: p.date,
    category: (p.categories || []).map((id: number) => catCache?.[id]).filter(Boolean).join(', '),
    district: (p.district || []).map((id: number) => districtCache?.[id]).filter(Boolean).join(', '),
    rubriek: acf.rubriek || '',
    featured: p.featured_media ? media[p.featured_media] || null : null,
    slider: sliderIds.map(id => media[id]).filter(Boolean),
    inline: parseInline(p.content?.rendered || ''),
    fotograaf: acf.fotograaf || '',
    naam_locatie: acf.naam_locatie || '',
    adres: acf.adres || '',
    stad: acf.stad || '',
    website: acf.website || '',
    cordA: acf.cord_A || '',
    cordB: acf.cord_B || '',
    tags: await tagNames(p.tags || []),
    focusKeyword: p.meta?.rank_math_focus_keyword || '',
    slug: p.slug || '',
    seoTitle: p.meta?.rank_math_title || '',
    metaDescription: p.meta?.rank_math_description || '',
    eventStart: acfDateToIso(acf.start_datum),
    eventEnd: acfDateToIso(acf.eind_datum),
    flags: {
      new_in_town: Boolean(acf.new_in_town),
      featured_item: Boolean(acf.featured_item),
      beste_van_amsterdam: Boolean(acf.beste_van_amsterdam),
      homepage_carousel: Boolean(acf.homepage_carousel),
    },
  };
}

// ---------- demo store ----------

async function demoArticles(): Promise<Article[]> {
  // Demo-wachtrij alleen in lokale SQLite seeden — nooit dummy-onderwerpen in de
  // gedeelde Supabase-database zetten, zodat demo-onderwerpen nooit als echte opdrachten worden verwerkt.
  await ensureDemoSeed(
    DEMO_ARTICLES.map(a => ({ id: a.id, json: JSON.stringify(a) })),
    STORAGE === 'sqlite' ? DEMO_TOPICS : []
  );
  return (await demoGetAll()).map(r => JSON.parse(r.json) as Article);
}

async function demoSave(a: Article) {
  await demoUpsert(a.id, JSON.stringify(a));
}

// ---------- public API ----------

// Zoekt een bestaand gepubliceerd AmsterdamNOW-artikel over een zaak, zodat
// lijstitems intern kunnen doorlinken (zoals in de bestaande lijstartikelen).
export async function findArticleLink(name: string): Promise<string | null> {
  if (!(await isLive())) return null;
  try {
    const hits = await wpFetch(`/wp/v2/posts?search=${encodeURIComponent(name)}&per_page=3&_fields=title,link`);
    const needle = name.toLocaleLowerCase('nl-NL');
    for (const hit of hits) {
      const title = decodeHtmlEntities(String(hit.title?.rendered || '')).toLocaleLowerCase('nl-NL');
      if (title.includes(needle)) return hit.link as string;
    }
  } catch { /* interne link is nice-to-have; nooit de run op laten falen */ }
  return null;
}

// `publishedPerPage`: hoeveel recent gepubliceerde artikelen worden meegeladen
// (naast álle drafts). Het bord heeft aan 15 genoeg, maar de auto-publisher
// heeft een langere terugkijk nodig voor de cluster-cooldown (zie de tick-route,
// die 50 opvraagt). Drafts blijven onveranderd — dit raakt alleen de
// published-tak.
export async function listArticles(publishedPerPage = 15): Promise<Article[]> {
  if (!(await isLive())) return demoArticles();
  await loadTaxonomies();
  const perPage = Math.max(1, Math.min(100, Math.trunc(publishedPerPage)));
  const [drafts, published] = await Promise.all([
    wpFetchAllPages(`/wp/v2/posts?status=draft&orderby=modified&context=edit`),
    wpFetch(`/wp/v2/posts?status=publish&per_page=${perPage}&orderby=date`),
  ]);
  const posts = [...drafts, ...published];
  const mediaIds = new Set<number>();
  for (const p of posts) {
    if (p.featured_media) mediaIds.add(p.featured_media);
    for (const id of p.acf?.slider || []) mediaIds.add(id);
  }
  const media = await mediaRefs([...mediaIds]);
  return Promise.all(posts.map((p: any) => mapPost(p, media)));
}

export async function getArticle(id: number): Promise<Article | null> {
  if (!(await isLive())) return (await demoArticles()).find(a => a.id === id) || null;
  await loadTaxonomies();
  const p = await wpFetch(`/wp/v2/posts/${id}?context=edit`);
  const ids = [p.featured_media, ...(p.acf?.slider || [])].filter(Boolean);
  const media = await mediaRefs(ids);
  return mapPost(p, media);
}

export interface ImageUpdate {
  featuredId?: number | null;
  sliderIds?: number[];
  inlineId?: number | null;
  fotograaf?: string;
}

export async function updateImages(id: number, upd: ImageUpdate, known: MediaRef[] = []): Promise<Article | null> {
  if (!(await isLive())) {
    const a = (await demoArticles()).find(x => x.id === id);
    if (!a) return null;
    const pool = new Map<number, MediaRef>();
    for (const m of [a.featured, ...a.slider, a.inline, ...known]) if (m) pool.set(m.id, m);
    if (upd.featuredId !== undefined) a.featured = upd.featuredId == null ? null : pool.get(upd.featuredId) || null;
    if (upd.sliderIds) a.slider = upd.sliderIds.map(i => pool.get(i)).filter(Boolean) as MediaRef[];
    if (upd.inlineId !== undefined) {
      a.inline = upd.inlineId == null ? null : pool.get(upd.inlineId) || null;
      // Demo-modus heeft geen mediabibliotheek om de alt uit te lezen en mag
      // daar ook geen WP-call voor doen; het beeld krijgt dus alt="" — precies
      // het gedrag van vóór deze wijziging.
      a.contentHtml = spliceInlineImage(a.contentHtml, a.inline);
    }
    if (upd.fotograaf !== undefined) a.fotograaf = cleanCredit(upd.fotograaf);
    a.modified = new Date().toISOString();
    await demoSave(a);
    return a;
  }
  const body: any = { acf: {} };
  if (upd.featuredId !== undefined) body.featured_media = upd.featuredId ?? 0;
  if (upd.sliderIds) body.acf.slider = upd.sliderIds;
  // Enige schrijfpad naar acf.fotograaf. De schoonmaak zit hier (en niet
  // alleen bij het opbouwen van de credit) zodat ook handmatig getypte of via
  // een ouder pad geërfde tekst nooit een onbevestigde licentieclaim in
  // WordPress zet. Zie lib/credit.ts.
  if (upd.fotograaf !== undefined) body.acf.fotograaf = cleanCredit(upd.fotograaf);
  if (upd.inlineId !== undefined) {
    const cur = await wpFetch(`/wp/v2/posts/${id}?context=edit&_fields=content`);
    const media = upd.inlineId == null ? null : (known.find(m => m.id === upd.inlineId) || null);
    // Alt-tekst uit de mediabibliotheek halen in plaats van hier een naam te
    // verzinnen: zo staat in de content exact dezelfde string als bij het
    // media-item (de conventie uit setMediaMeta) en krijgt ook beeld dat
    // eerder al geüpload was alsnog een kloppende alt. Nice-to-have, dus een
    // mislukte lookup mag de content-write nooit tegenhouden — dan valt het
    // beeld terug op alt="" (het oude gedrag).
    let alt = '';
    if (media) {
      try {
        alt = (await mediaAltTexts([media.id])).get(media.id) || '';
      } catch (err) {
        console.warn(`[wp] Alt-tekst van media #${media.id} niet opgehaald: ${err instanceof Error ? err.message : err}`);
      }
    }
    // Strip meteen het taxonomie-linkblok mee (consistent met de andere
    // schrijf-paden), zodat we dat niet opnieuw vastleggen bij het inline-write.
    body.content = stripTaxonomyFooter(spliceInlineImage(cur?.content?.raw ?? cur?.content?.rendered ?? '', media, alt));
  }
  await wpFetch(`/wp/v2/posts/${id}`, { method: 'POST', body: JSON.stringify(body) });
  return getArticle(id);
}

// Vervangt de volledige tag-set van een post. Gaat via tagIdsForNames, dus
// hetzelfde vangnet als bij het aanmaken van een artikel: namen die niet
// matchen op een bestaande WordPress-tag worden overgeslagen, nooit
// aangemaakt.
export async function updateArticleTags(id: number, tags: string[]): Promise<Article | null> {
  if (!(await isLive())) {
    const a = (await demoArticles()).find(x => x.id === id);
    if (!a) return null;
    a.tags = [...tags];
    a.modified = new Date().toISOString();
    await demoSave(a);
    return a;
  }
  const tagIds = await tagIdsForNames(tags);
  await wpFetch(`/wp/v2/posts/${id}`, { method: 'POST', body: JSON.stringify({ tags: tagIds }) });
  return getArticle(id);
}

// Normaliseert een door de redactie ingetypte website naar een absolute
// https-URL: "arcam.nl" → "https://arcam.nl". Leeg blijft leeg (veld wissen
// mag). Al aanwezige http(s)-schema's blijven ongemoeid.
function normalizeWebsite(raw: string): string {
  const s = (raw || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  return 'https://' + s.replace(/^\/+/, '');
}

export interface ArticleFieldUpdate {
  naamLocatie?: string;
  adres?: string;
  website?: string;
}

// Werkt de redactioneel corrigeerbare ACF-velden bij (naam_locatie, adres,
// website). Alleen meegegeven velden worden geschreven; de website wordt naar
// een absolute https-URL genormaliseerd. Zelfde patroon als updateArticleTags:
// PATcht via een POST op de post en geeft het verse artikel terug.
export async function updateArticleFields(id: number, upd: ArticleFieldUpdate): Promise<Article | null> {
  const acf: Record<string, string> = {};
  if (upd.naamLocatie !== undefined) acf.naam_locatie = upd.naamLocatie.trim();
  if (upd.adres !== undefined) acf.adres = upd.adres.trim();
  if (upd.website !== undefined) acf.website = normalizeWebsite(upd.website);

  if (!(await isLive())) {
    const a = (await demoArticles()).find(x => x.id === id);
    if (!a) return null;
    if (acf.naam_locatie !== undefined) a.naam_locatie = acf.naam_locatie;
    if (acf.adres !== undefined) a.adres = acf.adres;
    if (acf.website !== undefined) a.website = acf.website;
    a.modified = new Date().toISOString();
    await demoSave(a);
    return a;
  }
  if (Object.keys(acf).length) {
    await wpFetch(`/wp/v2/posts/${id}`, { method: 'POST', body: JSON.stringify({ acf }) });
  }
  return getArticle(id);
}

export interface SeoFields {
  focusKeyword: string;
  seoTitle: string;
  metaDescription: string;
}

// Vult alleen de RankMath-metavelden; slug blijft onaangeroerd (die wijzigen
// op een bestaand artikel breekt de URL, zie lib/seoBackfill.ts).
export async function updateArticleSeo(id: number, seo: SeoFields): Promise<void> {
  if (!(await isLive())) {
    const a = (await demoArticles()).find(x => x.id === id);
    if (!a) throw new Error('Artikel niet gevonden');
    a.focusKeyword = seo.focusKeyword;
    a.seoTitle = seo.seoTitle;
    a.metaDescription = seo.metaDescription;
    a.modified = new Date().toISOString();
    await demoSave(a);
    return;
  }
  await wpFetch(`/wp/v2/posts/${id}`, {
    method: 'POST',
    body: JSON.stringify({
      meta: {
        rank_math_focus_keyword: seo.focusKeyword,
        rank_math_title: seo.seoTitle,
        rank_math_description: seo.metaDescription,
      },
    }),
  });
}

export interface SeoStub { id: number; title: string; hasSeo: boolean }

// Lichtgewicht scan (_fields=id,title,meta, geen content/acf/media) over alle
// DRAFTS — dat zijn samen precies de twee bordkolommen "Klaar - beelden
// nodig" en "Klaar voor publicatie" (allebei gewoon status=draft, alleen een
// UI-groepering op beeldenaantal). Bewust NIET over gepubliceerde artikelen:
// die site heeft een lange geschiedenis van vóór deze tool, en de eerste
// versie hiervan (scannen + verwerken van ALLE gepubliceerde artikelen ooit)
// bleek zowel te traag (volle content per post liep vast op
// FUNCTION_INVOCATION_TIMEOUT) als simpelweg een veel grotere klus dan
// bedoeld — de scope is de eigen wachtrij van de tool, niet het hele archief.
export async function listSeoStubs(): Promise<SeoStub[]> {
  if (!(await isLive())) {
    const arts = await demoArticles();
    return arts.filter(a => a.status === 'draft').map(a => ({ id: a.id, title: a.title, hasSeo: Boolean(a.seoTitle) }));
  }
  const posts = await wpFetchAllPages(`/wp/v2/posts?status=draft&orderby=modified&context=edit&_fields=id,title,meta`);
  return posts.map((p: any) => ({
    id: p.id,
    title: decodeHtmlEntities(String(p.title?.raw ?? p.title?.rendered ?? `Artikel ${p.id}`)),
    hasSeo: Boolean(p.meta?.rank_math_title),
  }));
}

// Vervangt de volledige content-HTML van een post; gebruikt door het
// per-item-beeldwerk van lijstartikelen (content wordt opnieuw geassembleerd).
export async function updateArticleContent(id: number, html: string): Promise<void> {
  if (!(await isLive())) {
    const a = (await demoArticles()).find(x => x.id === id);
    if (!a) throw new Error('Artikel niet gevonden');
    a.contentHtml = html;
    a.modified = new Date().toISOString();
    await demoSave(a);
    return;
  }
  await wpFetch(`/wp/v2/posts/${id}`, { method: 'POST', body: JSON.stringify({ content: html }) });
}

export interface FormattingBackfillResult {
  scanned: number;
  updated: { id: number; title: string }[];
  skipped: { id: number; title: string; reason: string }[];
  done: boolean;
  remaining: number;
}

// Eenmalige, idempotente backfill voor oude AI-drafts. Alleen drafts zonder
// én H2 én blockquote komen in aanmerking: elke handmatig bewerkte of al
// opgemaakte post blijft dus onaangeroerd. Gepubliceerde artikelen worden
// bewust nooit door deze routine opgehaald.
export async function backfillDraftEditorialFormatting(dryRun = false): Promise<FormattingBackfillResult> {
  if (!(await isLive())) throw new Error('Backfill is alleen beschikbaar in live-modus.');
  // Gebruik exact dezelfde selectie als het kanbanbord. Daarmee zijn dit
  // uitsluitend de artikelen in “Klaar — beelden nodig” en “Klaar voor
  // publicatie”, nooit andere WordPress-drafts buiten de redactietool.
  const boardDrafts = (await listArticles()).filter(article => article.status === 'draft');
  const result: FormattingBackfillResult = { scanned: boardDrafts.length, updated: [], skipped: [], done: true, remaining: 0 };
  const todo: { id: number; title: string; content: string }[] = [];
  // Elke draft heeft een aparte WP-call nodig voor de volledige raw content
  // (het bordoverzicht bevat die niet). Nu het bord dankzij de paginering-fix
  // ook drafts voorbij de oude 50-cap laat zien, liep dit sequentieel ruim
  // over de 60s-serverless-limiet (159 drafts ⇒ FUNCTION_INVOCATION_TIMEOUT).
  // In chunks parallel blijft dit ruim binnen de limiet.
  const DETAIL_FETCH_CONCURRENCY = 15;
  for (let i = 0; i < boardDrafts.length; i += DETAIL_FETCH_CONCURRENCY) {
    const chunk = boardDrafts.slice(i, i + DETAIL_FETCH_CONCURRENCY);
    const posts = await Promise.all(
      chunk.map(a => wpFetch(`/wp/v2/posts/${a.id}?context=edit&_fields=id,title,content,acf`))
    );
    for (const post of posts) {
      const html = post.content?.raw ?? post.content?.rendered ?? '';
      const title = decodeHtmlEntities(String(post.title?.raw ?? post.title?.rendered ?? `Artikel ${post.id}`));
      if (hasEditorialFormatting(html)) {
        result.skipped.push({ id: post.id, title, reason: 'al redactioneel opgemaakt' });
        continue;
      }
      const formatted = formatExistingStandardArticleHtml(html, String(post.acf?.quote ?? ''));
      if (!formatted) {
        result.skipped.push({ id: post.id, title, reason: 'geen bruikbare quote of onvoldoende alinea’s' });
        continue;
      }
      todo.push({ id: post.id, title, content: formatted });
    }
  }
  if (dryRun) {
    result.updated = todo.map(({ id, title }) => ({ id, title }));
    result.remaining = todo.length;
    return result;
  }
  // Kleine batches houden de serverless-aanroep ruimschoots binnen de limiet.
  const batch = todo.slice(0, 8);
  for (const item of batch) {
    await wpFetch(`/wp/v2/posts/${item.id}`, { method: 'POST', body: JSON.stringify({ content: item.content }) });
    result.updated.push({ id: item.id, title: item.title });
  }
  result.done = todo.length <= batch.length;
  result.remaining = Math.max(0, todo.length - batch.length);
  return result;
}

export async function publishArticle(id: number): Promise<Article | null> {
  if (!(await isLive())) {
    const a = (await demoArticles()).find(x => x.id === id);
    if (!a) return null;
    a.status = 'publish';
    a.date = new Date().toISOString();
    a.link = `https://www.amsterdamnow.com/?p=${a.id}`;
    await demoSave(a);
    return a;
  }
  // Ouder klaargezette drafts (van vóór deze opschoning) kunnen het
  // ongewenste linkblok nog in de opgeslagen WordPress-content hebben staan.
  // Schoon dat bij publicatie definitief op, niet alleen in de weergave.
  const current = await wpFetch(`/wp/v2/posts/${id}?context=edit&_fields=content`);
  const cleanContent = stripTaxonomyFooter(current.content?.raw ?? current.content?.rendered ?? '');
  const body: Record<string, unknown> = { status: 'publish' };
  if (cleanContent !== (current.content?.raw ?? current.content?.rendered)) body.content = cleanContent;
  await wpFetch(`/wp/v2/posts/${id}`, { method: 'POST', body: JSON.stringify(body) });
  return getArticle(id);
}

// Verplaatst een draft (bv. eentje die nog op beelden wacht) naar de
// WordPress-prullenbak. Gepubliceerde artikelen horen hier niet doorheen —
// dat filtert de API-route af.
export async function deleteArticle(id: number): Promise<void> {
  if (!(await isLive())) {
    await demoDelete(id);
    return;
  }
  await wpFetch(`/wp/v2/posts/${id}`, { method: 'DELETE' });
}

export interface GeneratedDraft {
  title: string;
  subregel: string;
  intro: string;
  contentHtml: string;
  quote: string;
  focusKeyword: string;
  slug: string;
  seoTitle: string;
  metaDescription: string;
  categories: string[];
  // Altijd verplicht, behalve bij lijstartikelen: die kunnen over meerdere
  // stadsdelen tegelijk gaan, dus '' (geen district-toewijzing) is daar
  // legitiem. createDraft slaat de WordPress-districttoewijzing dan over.
  district: string;
  tags: string[];
  rubriek: string;
  naamLocatie: string;
  adres: string;
  stad: string;
  website: string;
  // Event-datums als JJJJ-MM-DD (of '' als het geen event met concrete datum
  // is). createDraft schrijft ze naar de ACF-velden start_datum/eind_datum in
  // het ACF-formaat Ymd. Optioneel: lijstartikelen leveren ze niet aan.
  startDatum?: string;
  eindDatum?: string;
  // Lijstartikelen krijgen bij aanmaak automatisch de flag "Beste van
  // Amsterdam" aan (redactionele afspraak: elk lijstje is per definitie
  // zo'n overzicht) — anders staat 'm elke keer weer aan te vinken in WP.
  isList?: boolean;
}

// Zet JJJJ-MM-DD om naar het ACF-date_picker-opslagformaat Ymd (JJJJMMDD),
// zoals WordPress de velden start_datum/eind_datum bewaart en teruggeeft.
// Ongeldige/lege invoer → null (veld wordt dan niet geschreven).
function toAcfDate(iso: string | undefined): string | null {
  const s = (iso || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.replace(/-/g, '') : null;
}

// Bouwt het ACF-datumdeel voor createDraft. Alleen bij een geldige start_datum;
// een ontbrekende eind_datum valt terug op start_datum (eendaags event). Geen
// start → leeg object, dus de velden blijven onaangeroerd (geen regressie voor
// niet-events of lijstartikelen).
function eventDateAcf(draft: GeneratedDraft): Record<string, string> {
  const start = toAcfDate(draft.startDatum);
  if (!start) return {};
  const eind = toAcfDate(draft.eindDatum) || start;
  return { start_datum: start, eind_datum: eind };
}

// Omgekeerd aan toAcfDate: het ACF-opslagformaat Ymd (JJJJMMDD) terug naar
// JJJJ-MM-DD, zodat de rest van de app (o.a. de auto-publisher) met het
// gebruikelijke ISO-formaat werkt. Onherkenbaar/leeg → ''.
function acfDateToIso(value: unknown): string {
  const s = typeof value === 'string' ? value.trim() : '';
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

export async function createDraft(draft: GeneratedDraft): Promise<Article> {
  const contentHtml = stripTaxonomyFooter(draft.contentHtml);
  if (!(await isLive())) {
    const articles = await demoArticles();
    const id = Math.max(Date.now() % 2147483647, ...articles.map(a => a.id + 1));
    const article: Article = {
      id,
      title: draft.title,
      subregel: draft.subregel,
      intro: draft.intro,
      contentHtml,
      status: 'draft',
      link: `https://www.amsterdamnow.com/?p=${id}`,
      modified: new Date().toISOString(),
      date: new Date().toISOString(),
      category: draft.categories.join(', '), district: draft.district, rubriek: draft.rubriek, featured: null, slider: [], inline: null, fotograaf: '',
      naam_locatie: draft.naamLocatie, adres: draft.adres, stad: draft.stad, website: draft.website, cordA: '', cordB: '', tags: draft.tags,
      focusKeyword: draft.focusKeyword, slug: draft.slug, seoTitle: draft.seoTitle,
      metaDescription: draft.metaDescription,
      eventStart: acfDateToIso(toAcfDate(draft.startDatum) || ''),
      eventEnd: acfDateToIso(toAcfDate(draft.eindDatum) || toAcfDate(draft.startDatum) || ''),
      flags: { new_in_town: false, featured_item: false, beste_van_amsterdam: Boolean(draft.isList), homepage_carousel: false },
    };
    await demoSave(article);
    return article;
  }

  await loadTaxonomies();
  const categoryIds = draft.categories.map(name => idForName(catCache || {}, name, 'Categorie'));
  // district is niet verplicht (zie GeneratedDraft): een lege waarde
  // (lijstartikelen die over meerdere stadsdelen gaan) slaat de WordPress-
  // districttoewijzing gewoon over, in plaats van te gokken.
  const districtId = draft.district ? idForName(districtCache || {}, draft.district, 'District') : null;
  const tagIds = await tagIdsForNames(draft.tags);
  const post = await wpFetch('/wp/v2/posts', {
    method: 'POST',
    body: JSON.stringify({
      status: 'draft',
      title: draft.title,
      content: contentHtml,
      excerpt: draft.intro,
      slug: draft.slug,
      categories: categoryIds,
      tags: tagIds,
      ...(districtId !== null ? { district: [districtId] } : {}),
      meta: {
        rank_math_focus_keyword: draft.focusKeyword,
        rank_math_title: draft.seoTitle,
        rank_math_description: draft.metaDescription,
      },
      acf: {
        subregel: draft.subregel,
        introductie_tekst: draft.intro,
        quote: draft.quote,
        rubriek: draft.rubriek,
        naam_locatie: draft.naamLocatie,
        adres: draft.adres,
        stad: draft.stad,
        website: draft.website,
        ...eventDateAcf(draft),
        ...(draft.isList ? { beste_van_amsterdam: true } : {}),
      },
    }),
  });
  const article = await getArticle(post.id);
  if (!article) throw new Error('WordPress heeft de nieuwe draft niet teruggegeven');
  return article;
}

const DEMO_UPLOAD_LIMIT = 3 * 1024 * 1024;

// Context waarmee een upload zijn naam volgens de AmsterdamNOW-conventie
// bepaalt (zie lib/mediaName.ts). `index` is de volgnummer-suffix binnen één
// artikel: featured = 1, daarna slider/inline/itemfoto's oplopend. Optioneel
// meegeven aan de upload-functies — zonder deze naming blijft alles zoals het
// was (rúwe bronnaam, geen metadata-write), zodat bestaande aanroepers niet
// breken.
export interface MediaNaming {
  ctx: ImageNameContext;
  index: number;
}

// Zet de beeldnaam op een media-item. AmsterdamNOW hanteert op alle oudere
// posts één string voor bestandsnaam, media-slug, media-titel én alt-tekst
// (bv. `stadsbakkerij-as-winkel-amsterdam_2`). WordPress leidt slug en titel
// zelf af uit de meegestuurde bestandsnaam, maar zet alt_text nooit vanzelf —
// vandaar deze expliciete write direct na de upload. Caption blijft bewust
// ongemoeid: de conventie zegt daar niets over, en meesturen zou een
// bestaande bijschrifttekst wissen.
//
// Fouten worden gelogd, niet gegooid: de afbeelding staat op dat moment al in
// WordPress, dus een harde throw zou de aanroeper een half geslaagde upload
// opleveren (beeld wel geüpload, maar geen media-ID terug om aan het artikel
// te hangen). Ontbrekende metadata is redactioneel herstelbaar; een verweesd
// media-item niet.
export async function setMediaMeta(id: number, name: string): Promise<void> {
  if (!(await isLive())) return;
  try {
    await wpFetch(`/wp/v2/media/${id}`, {
      method: 'POST',
      body: JSON.stringify({ alt_text: name, title: name, slug: name }),
    });
  } catch (err) {
    console.warn(`[wp] Beeldnaam “${name}” niet weggeschreven op media #${id}: ${err instanceof Error ? err.message : err}`);
  }
}

export async function uploadMediaFromBuffer(buf: Buffer, filename: string, mime: string, naming?: MediaNaming): Promise<MediaRef> {
  // Met naming wint de conventienaam van de meegegeven (bron)bestandsnaam:
  // WordPress leidt de media-slug en -titel af uit de bestandsnaam die in de
  // Content-Disposition staat, dus dat is de enige plek waar dit ingrijpt.
  const name = naming ? imageFileName(naming.ctx, naming.index, mime) : filename;
  if (!(await isLive())) {
    // Demo-modus: geen WordPress om naar te uploaden — bewaar als data-URL
    // (werkt ook op Vercel, waar het bestandssysteem alleen-lezen is).
    if (buf.length > DEMO_UPLOAD_LIMIT) {
      throw new Error('Demo-modus: afbeelding groter dan 3 MB. In live-modus (met WordPress-credentials) kan dit wel.');
    }
    const id = Date.now() % 2147483647;
    return { id, url: `data:${mime};base64,${buf.toString('base64')}` };
  }
  const conn = await getWpConnection();
  const res = await fetch(`${conn.url}/wp-json/wp/v2/media`, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(conn),
      'Content-Type': mime,
      'Content-Disposition': `attachment; filename="${name.replace(/"/g, '')}"`,
    },
    body: new Uint8Array(buf),
  });
  if (!res.ok) throw new Error(`Media-upload mislukt (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const m = await res.json();
  // Slug en titel heeft WordPress zojuist zelf uit de bestandsnaam afgeleid;
  // alt_text niet. Zet alle drie expliciet, zodat ze gegarandeerd identiek
  // zijn aan de bestandsnaam-zonder-extensie.
  if (naming) await setMediaMeta(m.id, imageAltName(naming.ctx, naming.index));
  return { id: m.id, url: m.media_details?.sizes?.large?.source_url || m.source_url };
}

/** filename uit een Content-Disposition-header (filename* heeft voorrang op filename). */
function filenameFromDisposition(disposition: string | null): string | null {
  if (!disposition) return null;
  const star = disposition.match(/filename\*\s*=\s*[^']*'[^']*'([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      return star[1].trim();
    }
  }
  const plain = disposition.match(/filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i);
  const name = plain?.[1] ?? plain?.[2];
  return name ? name.trim() : null;
}

/**
 * Maakt een bestandsnaam die WordPress accepteert. Veel CDN's (bijv. Rosewood's
 * picasso-transform-URLs) serveren afbeeldingen zonder extensie in het pad; zonder
 * extensie weigert WP de upload met `rest_upload_sideload_error`.
 *
 * De mime→extensie-tabel komt uit lib/mediaName.ts (MEDIA_MIME_EXT): daar
 * bepaalt dezelfde tabel de extensie van een conventienaam, en één tabel voor
 * beide upload-namen voorkomt dat ze uit elkaar gaan lopen.
 */
export function mediaFilenameFor(url: string, mime: string, disposition?: string | null): string {
  const ext = MEDIA_MIME_EXT[mime.toLowerCase()] || '';
  let base = filenameFromDisposition(disposition ?? null) || '';
  if (!base) {
    try {
      base = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    } catch {
      base = '';
    }
  }
  base = base.split('?')[0].split('#')[0].replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '');
  if (!base) base = 'afbeelding';
  const current = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : '';
  const knownExts = new Set(Object.values(MEDIA_MIME_EXT).concat(['jpeg']));
  if (ext && current !== ext && !(ext === 'jpg' && current === 'jpeg')) {
    // Geen (of verkeerde) extensie: hang de extensie van het echte mime-type eraan.
    base = current && knownExts.has(current) ? `${base.slice(0, base.lastIndexOf('.'))}.${ext}` : `${base}.${ext}`;
  } else if (!ext && !current) {
    base = `${base}.jpg`;
  }
  return base;
}

export async function uploadMediaFromUrl(url: string, naming?: MediaNaming): Promise<MediaRef> {
  if (!(await isLive())) {
    // Demo-modus: valideer alleen en verwijs direct naar de bron-URL.
    const head = await fetch(url, { method: 'HEAD' }).catch(() => null);
    const mime = head?.headers.get('content-type') || '';
    if (!head?.ok || !mime.startsWith('image/')) throw new Error('URL is geen (bereikbare) afbeelding');
    return { id: Date.now() % 2147483647, url };
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Afbeelding ophalen mislukt (${res.status})`);
  const mime = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim().toLowerCase();
  if (!mime.startsWith('image/')) throw new Error('URL is geen afbeelding');
  const buf = Buffer.from(await res.arrayBuffer());
  // Bewust altijd de bronnaam afleiden en `naming` gewoon doorgeven: de keuze
  // tussen conventienaam en bronnaam zit op één plek (uploadMediaFromBuffer),
  // zodat beide upload-ingangen niet uit elkaar kunnen lopen.
  const name = mediaFilenameFor(url, mime, res.headers.get('content-disposition'));
  return uploadMediaFromBuffer(buf, name, mime, naming);
}
