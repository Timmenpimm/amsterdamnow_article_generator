import { WP_URL, LIVE } from './wp';
import { decodeHtmlEntities } from './htmlEntities';
import { deleteWpPostsNotIn, getWpSyncState, upsertWpPosts } from './db';
import type { WpPostRow } from './db';

// Statussen die de dedup-index moet dekken. Zonder WP-credentials weigert
// WordPress' REST API elke status buiten 'publish' (401 rest_forbidden),
// dus dan vragen we alleen publish op — zie de LIVE-check hieronder.
const ALL_STATUSES = 'publish,draft,pending,future';
const PUBLIC_STATUS = 'publish';
const PER_PAGE = 100;
// Vangnet tegen posts die net ná de vorige sync gewijzigd zijn maar (door
// eventuele klok-/cache-verschillen) net vóór de opgeslagen max-modified
// binnenkwamen — 10 minuten marge dekt dat ruimschoots zonder de
// incrementele sync veel groter te maken.
const INCREMENTAL_BUFFER_MS = 10 * 60 * 1000;
// Zelfde vangnet-cap als wpFetchAllPages in wp.ts: normale werking stopt
// allang eerder (~11 pagina's voor de volledige backfill).
const MAX_PAGES = 40;

function authHeader(): string {
  return 'Basic ' + Buffer.from(`${process.env.WP_USER}:${process.env.WP_APP_PASSWORD}`).toString('base64');
}

function stripHtml(html: string): string {
  return decodeHtmlEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

interface WpApiPost {
  id: number;
  slug?: string;
  title?: { rendered?: string };
  excerpt?: { rendered?: string };
  link?: string;
  status?: string;
  categories?: number[];
  modified?: string;
}

interface WpPage {
  posts: WpApiPost[];
  // WordPress stuurt de X-WP-Total-header mee op elke collectie-respons: het
  // aantal items dat bij de huidige queryfilters hoort (status + evt.
  // modified_after), los van paginering. Gebruikt door de self-heal-check
  // hieronder om de lokale rijcount tegen WP's eigen totaal te leggen.
  total: number | null;
}

async function fetchPostsPage(pathname: string): Promise<WpPage> {
  const res = await fetch(`${WP_URL}/wp-json${pathname}`, {
    // Alleen een Authorization-header sturen als er echte credentials zijn.
    // Een header met "undefined:undefined" (LIVE = false) laat WordPress'
    // application-passwords-auth de hele request afwijzen — ook voor
    // publieke content — terwijl gewoon geen header sturen prima anoniem
    // werkt en publish-only teruggeeft.
    headers: LIVE ? { Authorization: authHeader() } : {},
    cache: 'no-store',
    // Voorkomt dat een hangende WP-respons de hele requestpath (incl. de
    // staleness-guard in dedup.ts, die dit synchroon awaited) onbeperkt blokkeert.
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WordPress ${res.status} bij ${pathname}: ${body.slice(0, 300)}`);
  }
  const totalHeader = res.headers.get('X-WP-Total');
  const total = totalHeader != null ? Number(totalHeader) : null;
  const posts = await res.json();
  return { posts, total: total != null && Number.isFinite(total) ? total : null };
}

function toRows(posts: WpApiPost[]): WpPostRow[] {
  return posts.map(p => ({
    wp_id: p.id,
    title: decodeHtmlEntities(String(p.title?.rendered || '')),
    slug: p.slug || '',
    excerpt: stripHtml(p.excerpt?.rendered || ''),
    link: p.link || '',
    status: p.status || '',
    categories: JSON.stringify(p.categories || []),
    wp_modified: p.modified || '',
  }));
}

interface FetchAndUpsertResult {
  posts: WpApiPost[];
  total: number | null;
  upserted: number;
}

// Haalt alle pagina's op én schrijft elke pagina meteen weg (upsert) zodra
// hij binnenkomt, in plaats van te wachten tot de hele backfill klaar is.
// Zo overleeft een functie die alsnog gekilld wordt (60s-limiet) de al
// opgehaalde/weggeschreven pagina's — de self-heal-check in syncWpPosts (en
// anders de eerstvolgende sync-run) pakt de rest op. Zie productie-incident
// 2026-07-21 in docs/superpowers/specs/2026-07-21-wp-dedup-index-design.md.
async function fetchAndUpsertAllPosts(modifiedAfter?: string): Promise<FetchAndUpsertResult> {
  const statusParam = LIVE ? ALL_STATUSES : PUBLIC_STATUS;
  const out: WpApiPost[] = [];
  let total: number | null = null;
  let upserted = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = new URLSearchParams({
      _fields: 'id,slug,title,excerpt,link,status,categories,modified',
      status: statusParam,
      per_page: String(PER_PAGE),
      page: String(page),
      orderby: 'modified',
      order: 'asc',
    });
    if (modifiedAfter) params.set('modified_after', modifiedAfter);
    const { posts: batch, total: pageTotal } = await fetchPostsPage(`/wp/v2/posts?${params.toString()}`);
    if (page === 1) total = pageTotal;
    out.push(...batch);
    if (batch.length) upserted += await upsertWpPosts(toRows(batch));
    if (batch.length < PER_PAGE) return { posts: out, total, upserted };
  }
  throw new Error(`Meer dan ${MAX_PAGES * PER_PAGE} posts opgehaald — paginering-cap geraakt, controleer wpSync.fetchAndUpsertAllPosts.`);
}

// Lichte, aparte call (per_page=1) puur om WP's eigen totaal voor de huidige
// statusscope te weten — los van een eventueel modified_after-filter, want
// dát total zou alleen "hoeveel is er recent gewijzigd" zijn, niet "hoeveel
// posts staan er in totaal op WP" (wat de self-heal-check nodig heeft).
async function fetchExpectedTotal(): Promise<number | null> {
  const statusParam = LIVE ? ALL_STATUSES : PUBLIC_STATUS;
  const params = new URLSearchParams({
    _fields: 'id',
    status: statusParam,
    per_page: '1',
    page: '1',
  });
  const { total } = await fetchPostsPage(`/wp/v2/posts?${params.toString()}`);
  return total;
}

export interface WpSyncResult {
  fetched: number;
  upserted: number;
  deleted: number;
  full: boolean;
  // true als de self-heal-check een tekort t.o.v. WP's totaal signaleerde en
  // binnen deze aanroep alsnog een volledige fetch+upsert heeft gedaan.
  selfHealed: boolean;
  tookMs: number;
}

// Sync van WordPress-posts naar de lokale dedup-index (wp_posts).
// - Incrementeel (default): haalt alleen posts op die gewijzigd zijn sinds
//   de laatst bekende wp_modified (min. 10 minuten marge). Is de tabel leeg,
//   dan wordt geen modified_after meegegeven — dat gedraagt zich als een
//   volledige fetch, maar zónder verwijderpas (die vereist een compleet
//   beeld van alle huidige WP-id's, en met een lege tabel is dat er al).
// - Full (`full: true`): haalt alles op, upsert, en verwijdert lokaal wat
//   niet meer terugkwam (vangt op WP verwijderde posts af).
export async function syncWpPosts({ full = false }: { full?: boolean } = {}): Promise<WpSyncResult> {
  const start = Date.now();
  if (!LIVE) {
    console.warn('[wpSync] WP_USER/WP_APP_PASSWORD ontbreken — sync beperkt tot gepubliceerde posts (drafts/pending/future blijven buiten beeld).');
  }

  let modifiedAfter: string | undefined;
  if (!full) {
    const state = await getWpSyncState();
    if (state.count > 0 && state.maxModified) {
      modifiedAfter = new Date(new Date(state.maxModified).getTime() - INCREMENTAL_BUFFER_MS).toISOString();
    }
  }

  const { posts, total: pageTotal, upserted: firstUpserted } = await fetchAndUpsertAllPosts(modifiedAfter);
  let fetched = posts.length;
  let upserted = firstUpserted;
  let selfHealed = false;

  let deleted = 0;
  if (full) {
    if (posts.length === 0) {
      // Een 200-respons met een lege body (of een lege pagina) mag de hele
      // wp_posts-index nooit leegtrekken — deleteWpPostsNotIn([]) verwijdert
      // dan namelijk gewoon alles. Zie ook de lege-ids-guard in db.ts.
      console.warn('[wpSync] Full sync leverde nul posts op — verwijderpas overgeslagen (zou de hele wp_posts-index wissen).');
    } else if (LIVE) {
      deleted = await deleteWpPostsNotIn(posts.map(p => p.id));
    } else {
      // Een full sync zonder credentials ziet alleen publish-posts. Zou de
      // verwijderpas dan toch draaien, dan gooit hij elke bestaande
      // draft/pending/future-rij uit de index — dat is erger dan even geen
      // opschoning doen.
      console.warn('[wpSync] Full sync zonder WP-credentials: verwijderpas overgeslagen (zou drafts/pending/future onterecht wissen).');
    }
  } else {
    // Self-heal (productie-incident 2026-07-21, zie het spec-document): een
    // eerdere sync die halverwege gekilld werd kan een gedeeltelijke index
    // achterlaten die er voor de staleness-guard "vers" uitziet (count>0,
    // recente synced_at) — de sync herstelt zichzelf dan nooit, omdat
    // modified_after de ontbrekende rijen structureel blijft missen. Elke
    // incrementele sync (dus ook elke cron-tik) checkt daarom de lokale
    // rijcount tegen WP's eigen totaal en escaleert bij een tekort binnen
    // dezelfde aanroep naar een volledige fetch+upsert. Met de batching in
    // upsertWpPosts (db.ts) blijft ook zo'n escalatie ruim binnen 60s.
    const expectedTotal = modifiedAfter != null ? await fetchExpectedTotal() : pageTotal;
    if (expectedTotal != null) {
      const state = await getWpSyncState();
      // Alleen groeien vanuit incrementele syncs; verwijderingen verwerkt
      // uitsluitend de full-syncverwijderpas hierboven. Een tekort (lokaal <
      // WP-totaal) betekent dus altijd ontbrekende rijen, nooit "WP heeft
      // intussen posts verwijderd".
      if (state.count < expectedTotal) {
        console.warn(`[wpSync] self-heal: lokale index (${state.count}) < WP-totaal (${expectedTotal}) — volledige fetch+upsert binnen dezelfde aanroep.`);
        const heal = await fetchAndUpsertAllPosts(undefined);
        fetched += heal.posts.length;
        upserted += heal.upserted;
        selfHealed = true;
        // Bewust geen deleteWpPostsNotIn hier: dit is een escalatie binnen
        // een incrementele run, geen door de aanroeper gevraagde full sync
        // (?full=1) — verwijderen blijft uitsluitend daarvan het werk.
      }
    }
  }

  return { fetched, upserted, deleted, full, selfHealed, tookMs: Date.now() - start };
}
