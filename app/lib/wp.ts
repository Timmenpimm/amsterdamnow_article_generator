import { demoGetAll, demoUpsert, ensureDemoSeed, STORAGE } from './db';
import { DEMO_ARTICLES, DEMO_TOPICS } from './demo-seed';
import type { Article, MediaRef } from './types';

export const WP_URL = process.env.WP_URL || 'https://www.amsterdamnow.com';
export const LIVE = Boolean(process.env.WP_USER && process.env.WP_APP_PASSWORD);
export { STORAGE };

function authHeader(): string {
  return 'Basic ' + Buffer.from(`${process.env.WP_USER}:${process.env.WP_APP_PASSWORD}`).toString('base64');
}

async function wpFetch(pathname: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${WP_URL}/wp-json${pathname}`, {
    ...init,
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WordPress ${res.status} bij ${pathname}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

// ---------- taxonomy caches ----------

let catCache: Record<number, string> | null = null;
let districtCache: Record<number, string> | null = null;
let tagCache: Record<number, string> = {};

async function loadTaxonomies() {
  if (catCache && districtCache) return;
  const [cats, districts] = await Promise.all([
    fetch(`${WP_URL}/wp-json/wp/v2/categories?per_page=100`, { cache: 'no-store' }).then(r => r.json()),
    fetch(`${WP_URL}/wp-json/wp/v2/district?per_page=100`, { cache: 'no-store' }).then(r => r.json()),
  ]);
  catCache = Object.fromEntries(cats.map((c: any) => [c.id, c.name]));
  districtCache = Object.fromEntries(districts.map((d: any) => [d.id, d.name]));
}

export async function taxonomyChoices(): Promise<{ categories: string[]; districts: string[] }> {
  if (!LIVE) return { categories: ['Cultuur', 'Uitgaan', 'Restaurants', 'Lifestyle'], districts: ['Amsterdam Centrum', 'Amsterdam Noord', 'Amsterdam Oost', 'Amsterdam Zuid'] };
  await loadTaxonomies();
  return { categories: Object.values(catCache || {}), districts: Object.values(districtCache || {}) };
}

function normalized(value: string) {
  return value.toLocaleLowerCase('nl-NL').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function idForName(items: Record<number, string>, name: string, type: string): number {
  const id = Object.entries(items).find(([, value]) => normalized(value) === normalized(name))?.[0];
  if (!id) throw new Error(`${type} “${name}” bestaat niet in WordPress.`);
  return Number(id);
}

async function tagIdsForNames(names: string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const name of [...new Set(names.map(n => n.trim()).filter(Boolean))]) {
    const existing = await wpFetch(`/wp/v2/tags?search=${encodeURIComponent(name)}&per_page=100`);
    const match = existing.find((tag: any) => normalized(tag.name) === normalized(name));
    if (match) ids.push(match.id);
    else {
      const created = await wpFetch('/wp/v2/tags', { method: 'POST', body: JSON.stringify({ name }) });
      ids.push(created.id);
    }
  }
  return ids;
}

async function tagNames(ids: number[]): Promise<string[]> {
  const missing = ids.filter(id => !(id in tagCache));
  if (missing.length) {
    const tags = await fetch(`${WP_URL}/wp-json/wp/v2/tags?include=${missing.join(',')}&per_page=100`, { cache: 'no-store' }).then(r => r.json());
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

async function mapPost(p: any, media: Record<number, MediaRef>): Promise<Article> {
  const acf = p.acf || {};
  const sliderIds: number[] = Array.isArray(acf.slider) ? acf.slider : [];
  return {
    id: p.id,
    title: p.title?.rendered || '',
    subregel: acf.subregel || '',
    intro: acf.introductie_tekst || '',
    contentHtml: p.content?.rendered || '',
    status: p.status === 'publish' ? 'publish' : 'draft',
    link: p.link,
    modified: p.modified,
    date: p.date,
    category: (p.categories || []).map((id: number) => catCache?.[id]).filter(Boolean).join(', '),
    district: (p.district || []).map((id: number) => districtCache?.[id]).filter(Boolean).join(', '),
    rubriek: acf.rubriek || '',
    featured: p.featured_media ? media[p.featured_media] || null : null,
    slider: sliderIds.map(id => media[id]).filter(Boolean),
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

export async function listArticles(): Promise<Article[]> {
  if (!LIVE) return demoArticles();
  await loadTaxonomies();
  const [drafts, published] = await Promise.all([
    wpFetch(`/wp/v2/posts?status=draft&per_page=50&orderby=modified&context=edit`),
    wpFetch(`/wp/v2/posts?status=publish&per_page=15&orderby=date`),
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
  if (!LIVE) return (await demoArticles()).find(a => a.id === id) || null;
  await loadTaxonomies();
  const p = await wpFetch(`/wp/v2/posts/${id}?context=edit`);
  const ids = [p.featured_media, ...(p.acf?.slider || [])].filter(Boolean);
  const media = await mediaRefs(ids);
  return mapPost(p, media);
}

export interface ImageUpdate {
  featuredId?: number | null;
  sliderIds?: number[];
  fotograaf?: string;
}

export async function updateImages(id: number, upd: ImageUpdate, known: MediaRef[] = []): Promise<Article | null> {
  if (!LIVE) {
    const a = (await demoArticles()).find(x => x.id === id);
    if (!a) return null;
    const pool = new Map<number, MediaRef>();
    for (const m of [a.featured, ...a.slider, ...known]) if (m) pool.set(m.id, m);
    if (upd.featuredId !== undefined) a.featured = upd.featuredId == null ? null : pool.get(upd.featuredId) || null;
    if (upd.sliderIds) a.slider = upd.sliderIds.map(i => pool.get(i)).filter(Boolean) as MediaRef[];
    if (upd.fotograaf !== undefined) a.fotograaf = upd.fotograaf;
    a.modified = new Date().toISOString();
    await demoSave(a);
    return a;
  }
  const body: any = { acf: {} };
  if (upd.featuredId !== undefined) body.featured_media = upd.featuredId ?? 0;
  if (upd.sliderIds) body.acf.slider = upd.sliderIds;
  if (upd.fotograaf !== undefined) body.acf.fotograaf = upd.fotograaf;
  await wpFetch(`/wp/v2/posts/${id}`, { method: 'POST', body: JSON.stringify(body) });
  return getArticle(id);
}

export async function publishArticle(id: number): Promise<Article | null> {
  if (!LIVE) {
    const a = (await demoArticles()).find(x => x.id === id);
    if (!a) return null;
    a.status = 'publish';
    a.date = new Date().toISOString();
    a.link = `https://www.amsterdamnow.com/?p=${a.id}`;
    await demoSave(a);
    return a;
  }
  await wpFetch(`/wp/v2/posts/${id}`, { method: 'POST', body: JSON.stringify({ status: 'publish' }) });
  return getArticle(id);
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
  district: string;
  tags: string[];
  rubriek: string;
  naamLocatie: string;
  adres: string;
  stad: string;
  website: string;
}

export async function createDraft(draft: GeneratedDraft): Promise<Article> {
  if (!LIVE) {
    const articles = await demoArticles();
    const id = Math.max(Date.now() % 2147483647, ...articles.map(a => a.id + 1));
    const article: Article = {
      id,
      title: draft.title,
      subregel: draft.subregel,
      intro: draft.intro,
      contentHtml: draft.contentHtml,
      status: 'draft',
      link: `https://www.amsterdamnow.com/?p=${id}`,
      modified: new Date().toISOString(),
      date: new Date().toISOString(),
      category: draft.categories.join(', '), district: draft.district, rubriek: draft.rubriek, featured: null, slider: [], fotograaf: '',
      naam_locatie: draft.naamLocatie, adres: draft.adres, stad: draft.stad, website: draft.website, cordA: '', cordB: '', tags: draft.tags,
      focusKeyword: draft.focusKeyword, slug: draft.slug, seoTitle: draft.seoTitle,
      metaDescription: draft.metaDescription,
      flags: { new_in_town: false, featured_item: false, beste_van_amsterdam: false, homepage_carousel: false },
    };
    await demoSave(article);
    return article;
  }

  await loadTaxonomies();
  const categoryIds = draft.categories.map(name => idForName(catCache || {}, name, 'Categorie'));
  const districtId = idForName(districtCache || {}, draft.district, 'District');
  const tagIds = await tagIdsForNames(draft.tags);
  const post = await wpFetch('/wp/v2/posts', {
    method: 'POST',
    body: JSON.stringify({
      status: 'draft',
      title: draft.title,
      content: draft.contentHtml,
      excerpt: draft.intro,
      slug: draft.slug,
      categories: categoryIds,
      tags: tagIds,
      district: [districtId],
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
      },
    }),
  });
  const article = await getArticle(post.id);
  if (!article) throw new Error('WordPress heeft de nieuwe draft niet teruggegeven');
  return article;
}

const DEMO_UPLOAD_LIMIT = 3 * 1024 * 1024;

export async function uploadMediaFromBuffer(buf: Buffer, filename: string, mime: string): Promise<MediaRef> {
  if (!LIVE) {
    // Demo-modus: geen WordPress om naar te uploaden — bewaar als data-URL
    // (werkt ook op Vercel, waar het bestandssysteem alleen-lezen is).
    if (buf.length > DEMO_UPLOAD_LIMIT) {
      throw new Error('Demo-modus: afbeelding groter dan 3 MB. In live-modus (met WordPress-credentials) kan dit wel.');
    }
    const id = Date.now() % 2147483647;
    return { id, url: `data:${mime};base64,${buf.toString('base64')}` };
  }
  const res = await fetch(`${WP_URL}/wp-json/wp/v2/media`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': mime,
      'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
    },
    body: new Uint8Array(buf),
  });
  if (!res.ok) throw new Error(`Media-upload mislukt (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const m = await res.json();
  return { id: m.id, url: m.media_details?.sizes?.large?.source_url || m.source_url };
}

export async function uploadMediaFromUrl(url: string): Promise<MediaRef> {
  if (!LIVE) {
    // Demo-modus: valideer alleen en verwijs direct naar de bron-URL.
    const head = await fetch(url, { method: 'HEAD' }).catch(() => null);
    const mime = head?.headers.get('content-type') || '';
    if (!head?.ok || !mime.startsWith('image/')) throw new Error('URL is geen (bereikbare) afbeelding');
    return { id: Date.now() % 2147483647, url };
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Afbeelding ophalen mislukt (${res.status})`);
  const mime = res.headers.get('content-type') || 'image/jpeg';
  if (!mime.startsWith('image/')) throw new Error('URL is geen afbeelding');
  const buf = Buffer.from(await res.arrayBuffer());
  const name = (new URL(url).pathname.split('/').pop() || 'upload.jpg').split('?')[0];
  return uploadMediaFromBuffer(buf, name, mime);
}
