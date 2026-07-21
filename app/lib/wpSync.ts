import { WP_URL, LIVE } from './wp';
import { decodeHtmlEntities } from './htmlEntities';
import { deleteWpPostsNotIn, getWpSyncState, upsertWpPosts } from './db';
import type { WpPostRow } from './db';

// Statussen die de dedup-index moet dekken. Zonder WP-credentials weigert
// WordPress' REST API elke status buiten 'publish' (401 rest_forbidden),
// dus dan vragen we alleen publish op — zie de LIVE-check in fetchAllPosts.
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

async function fetchPostsPage(pathname: string): Promise<WpApiPost[]> {
  const res = await fetch(`${WP_URL}/wp-json${pathname}`, {
    // Alleen een Authorization-header sturen als er echte credentials zijn.
    // Een header met "undefined:undefined" (LIVE = false) laat WordPress'
    // application-passwords-auth de hele request afwijzen — ook voor
    // publieke content — terwijl gewoon geen header sturen prima anoniem
    // werkt en publish-only teruggeeft.
    headers: LIVE ? { Authorization: authHeader() } : {},
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WordPress ${res.status} bij ${pathname}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function fetchAllPosts(modifiedAfter?: string): Promise<WpApiPost[]> {
  const statusParam = LIVE ? ALL_STATUSES : PUBLIC_STATUS;
  const out: WpApiPost[] = [];
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
    const batch = await fetchPostsPage(`/wp/v2/posts?${params.toString()}`);
    out.push(...batch);
    if (batch.length < PER_PAGE) return out;
  }
  throw new Error(`Meer dan ${MAX_PAGES * PER_PAGE} posts opgehaald — paginering-cap geraakt, controleer wpSync.fetchAllPosts.`);
}

export interface WpSyncResult {
  fetched: number;
  upserted: number;
  deleted: number;
  full: boolean;
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

  const posts = await fetchAllPosts(modifiedAfter);

  const rows: WpPostRow[] = posts.map(p => ({
    wp_id: p.id,
    title: decodeHtmlEntities(String(p.title?.rendered || '')),
    slug: p.slug || '',
    excerpt: stripHtml(p.excerpt?.rendered || ''),
    link: p.link || '',
    status: p.status || '',
    categories: JSON.stringify(p.categories || []),
    wp_modified: p.modified || '',
  }));

  const upserted = await upsertWpPosts(rows);

  let deleted = 0;
  if (full) {
    if (LIVE) {
      deleted = await deleteWpPostsNotIn(rows.map(r => r.wp_id));
    } else {
      // Een full sync zonder credentials ziet alleen publish-posts. Zou de
      // verwijderpas dan toch draaien, dan gooit hij elke bestaande
      // draft/pending/future-rij uit de index — dat is erger dan even geen
      // opschoning doen.
      console.warn('[wpSync] Full sync zonder WP-credentials: verwijderpas overgeslagen (zou drafts/pending/future onterecht wissen).');
    }
  }

  return { fetched: posts.length, upserted, deleted, full, tookMs: Date.now() - start };
}
