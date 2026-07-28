'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { Article, BoardData } from '@/lib/types';
import { articlePhase } from '@/lib/types';
import { getCarouselMetas, emptyCarouselMeta, EngineNotConfiguredError, type CarouselMeta } from '@/lib/carousel';

type Filter = 'all' | 'none' | 'published';

const SEARCH_PER_PAGE = 20;
const SEARCH_DEBOUNCE_MS = 300;

// Eén regelvorm voor beide bronnen: het bord (/api/board → Article) en het
// archiefzoeken (/api/wp/published → PublishedPost). Een zoekresultaat is
// altijd gepubliceerd; het bord kan ook "klaar voor publicatie" bevatten.
interface Row {
  id: number;
  title: string;
  date: string;
  sub: string;
  featuredUrl: string | null;
  published: boolean;
}

interface SearchHit {
  id: number;
  title: string;
  date: string;
  category: string;
  featured: { id: number; url: string } | null;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
}

// In het archief staan artikelen uit alle jaargangen, dus daar is het jaartal
// het interessante deel — bij het bord (alles van de afgelopen weken) juist niet.
function formatDateFull(iso: string): string {
  return new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });
}

function carouselChip(meta: CarouselMeta) {
  if (meta.status === 'published') {
    return <span className="chip-green">◆ Op Instagram{meta.publishedAt ? ` · ${formatDate(meta.publishedAt)}` : ''}</span>;
  }
  if (meta.status === 'ready') {
    return <span className="chip-amber">Klaargezet · wacht op plaatsing</span>;
  }
  if (meta.status === 'concept') {
    return (
      <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--gray)', background: 'var(--soft)', padding: '3px 10px', borderRadius: 999, whiteSpace: 'nowrap' }}>
        Concept · {meta.slidesDone}/{meta.slidesTotal || 5} slides
      </span>
    );
  }
  return (
    <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', border: '1px dashed var(--faint)', padding: '3px 10px', borderRadius: 999, whiteSpace: 'nowrap' }}>
      Nog geen carousel
    </span>
  );
}

function rowAction(id: number, meta: CarouselMeta) {
  if (meta.status === 'published') {
    return <Link href={`/carousel/${id}`} className="btn-small">Bekijken</Link>;
  }
  if (meta.status === 'ready') {
    return <Link href={`/carousel/${id}`} className="btn-primary" style={{ display: 'inline-block' }}>Openen →</Link>;
  }
  if (meta.status === 'concept') {
    return <Link href={`/carousel/${id}`} className="btn-primary" style={{ display: 'inline-block' }}>Verder →</Link>;
  }
  return <Link href={`/carousel/${id}`} className="btn-primary" style={{ display: 'inline-block' }}>Maak carousel</Link>;
}

function boardRow(a: Article): Row {
  return {
    id: a.id,
    title: a.title,
    sub: [a.category, a.district].filter(Boolean).join(' · ') + (a.date ? ` · ${formatDate(a.date)}` : ''),
    date: a.date,
    featuredUrl: a.featured?.url || null,
    published: articlePhase(a) === 'published',
  };
}

function searchRow(hit: SearchHit): Row {
  return {
    id: hit.id,
    title: hit.title,
    sub: [hit.category, hit.date ? formatDateFull(hit.date) : ''].filter(Boolean).join(' · '),
    date: hit.date,
    featuredUrl: hit.featured?.url || null,
    published: true,
  };
}

export default function CarouselOverview() {
  const [data, setData] = useState<BoardData | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  // Carousel-status komt uit de socials-engine (batch via /api/carousel/status);
  // we verversen 'm zodra de gebruiker terugkomt van de generator (focus-tick).
  const [tick, setTick] = useState(0);
  const [metas, setMetas] = useState<Record<number, CarouselMeta> | null>(null);
  const [engineMissing, setEngineMissing] = useState(false);
  const [metaError, setMetaError] = useState('');

  // --- archiefzoeken -------------------------------------------------------
  // Het bord toont alleen de recente artikelen (listArticles laadt 15
  // publicaties). Wie een lijstje uit 2020 tot carousel wil maken, zoekt hier;
  // dat gaat via /api/wp/published rechtstreeks naar WordPress.
  const [query, setQuery] = useState('');
  const [term, setTerm] = useState('');
  const [page, setPage] = useState(1);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [hitsTotal, setHitsTotal] = useState(0);
  const [hitsPages, setHitsPages] = useState(0);
  const [searchMode, setSearchMode] = useState<'live' | 'demo' | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searchTick, setSearchTick] = useState(0);

  useEffect(() => {
    fetch('/api/board').then(r => r.json()).then(setData).catch(() => {});
  }, []);

  useEffect(() => {
    const onFocus = () => setTick(t => t + 1);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => { setTerm(query.trim()); setPage(1); }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (!term) {
      setHits(null); setHitsTotal(0); setHitsPages(0);
      setSearchError(''); setSearchLoading(false); setSearchMode(null);
      return;
    }
    let stale = false;
    setSearchLoading(true);
    fetch(`/api/wp/published?search=${encodeURIComponent(term)}&page=${page}&per_page=${SEARCH_PER_PAGE}`)
      .then(async r => {
        const body = await r.json().catch(() => null);
        if (!r.ok) throw new Error(body?.error || `Zoeken mislukte (${r.status}).`);
        return body;
      })
      .then(body => {
        if (stale) return;
        const batch: SearchHit[] = Array.isArray(body?.items) ? body.items : [];
        setSearchError('');
        setSearchMode(body?.mode === 'demo' ? 'demo' : 'live');
        setHitsTotal(Number(body?.total) || 0);
        setHitsPages(Number(body?.totalPages) || 0);
        // Pagina 1 vervangt, volgende pagina's plakken eronder ("Toon meer").
        setHits(prev => (page > 1 && prev ? [...prev, ...batch] : batch));
      })
      .catch(e => {
        if (stale) return;
        setSearchError(e?.message || 'Zoeken mislukte.');
        if (page === 1) { setHits(null); setHitsTotal(0); setHitsPages(0); }
      })
      .finally(() => { if (!stale) setSearchLoading(false); });
    return () => { stale = true; };
  }, [term, page, searchTick]);

  const searching = term.length > 0;

  const boardRows = (data?.articles || [])
    .filter(a => articlePhase(a) === 'published' || articlePhase(a) === 'ready')
    .sort((a, b) => +new Date(b.date) - +new Date(a.date))
    .map(boardRow);

  const candidates: Row[] = searching ? (hits || []).map(searchRow) : boardRows;
  const candidateKey = candidates.map(r => r.id).join(',');

  // Alleen de ids van wat nu getoond wordt gaan naar /api/carousel/status —
  // met 1124 archiefposts zou die querystring anders ~9 kB worden. De
  // chip-filters draaien op de status, dus filteren gebeurt ná deze call.
  useEffect(() => {
    const ids = candidateKey ? candidateKey.split(',').map(Number) : [];
    if (ids.length === 0) { setMetas({}); return; }
    let stale = false;
    setMetas(null);
    getCarouselMetas(ids)
      .then(m => { if (!stale) { setMetas(m); setEngineMissing(false); setMetaError(''); } })
      .catch(e => {
        if (stale) return;
        setMetas({});
        if (e instanceof EngineNotConfiguredError) { setEngineMissing(true); setMetaError(''); }
        else { setEngineMissing(false); setMetaError(e.message || 'Carousel-status kon niet geladen worden.'); }
      });
    return () => { stale = true; };
  }, [candidateKey, tick]);

  const withMeta = candidates.map(row => ({ row, meta: metas?.[row.id] ?? emptyCarouselMeta(row.id) }));

  const rows = withMeta.filter(({ meta }) => {
    if (filter === 'none') return meta.status === 'none';
    if (filter === 'published') return meta.status === 'published';
    return true;
  });

  const hasMore = searching && hitsPages > page && !searchLoading;
  const showEmptyBoard = !searching && data !== null && boardRows.length === 0;

  return (
    <div style={{ padding: '24px 20px', maxWidth: 1000 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <span style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.01em' }}>Carousel</span>
        <span style={{ fontSize: 13, color: 'var(--gray)' }}>welke artikelen zijn Instagram-klaar</span>
      </div>

      {engineMissing && (
        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', marginBottom: 14 }}>
          <span style={{ fontSize: 13, fontWeight: 800 }}>Socials-engine niet gekoppeld</span>
          <span style={{ fontSize: 12.5, color: 'var(--gray)' }}>De carousel-status kan niet geladen worden zonder koppeling.</span>
          <Link href="/instellingen" className="btn-small" style={{ marginLeft: 'auto', flexShrink: 0 }}>Naar Instellingen → Instagram</Link>
        </div>
      )}
      {metaError && (
        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', marginBottom: 14 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--red-dark)' }}>{metaError}</span>
          <button className="btn-small" style={{ marginLeft: 'auto', flexShrink: 0 }} onClick={() => setTick(t => t + 1)}>Opnieuw proberen</button>
        </div>
      )}

      {showEmptyBoard ? (
        <div className="card" style={{ padding: '56px 32px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, textAlign: 'center' }}>
          <span className="hatch" style={{ width: 56, height: 56, borderRadius: 12, display: 'grid', placeItems: 'center', fontSize: 22, color: '#b7b5ae' }}>◆</span>
          <span style={{ fontSize: 15, fontWeight: 800 }}>Nog geen artikelen klaar voor een carousel</span>
          <span style={{ fontSize: 13, color: 'var(--gray)', lineHeight: 1.6, maxWidth: 360 }}>
            Zodra een artikel gepubliceerd is of klaarstaat voor publicatie, verschijnt het hier. Werk eerst de pipeline af — de beelden moeten compleet zijn.
          </span>
          <Link href="/" className="btn-primary" style={{ marginTop: 4, display: 'inline-block' }}>→ Naar de pipeline</Link>
        </div>
      ) : (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 18px 12px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--gray)' }}>
              {searching ? 'Archief — zoekresultaten' : 'Artikelen — Instagram-klaar'}
            </span>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--gray)' }}>
              {searching ? `${candidates.length} van ${hitsTotal}` : candidates.length}
            </span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              {(['all', 'none', 'published'] as Filter[]).map(f => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  style={{
                    fontSize: 12.5, fontWeight: filter === f ? 700 : 600, padding: '6px 12px', borderRadius: 999,
                    background: filter === f ? 'var(--ink)' : 'transparent',
                    color: filter === f ? '#fff' : 'var(--gray)',
                    border: filter === f ? 'none' : '1px solid var(--border)',
                  }}
                >
                  {f === 'all' ? 'Alle' : f === 'none' ? 'Nog geen carousel' : 'Gepubliceerd'}
                </button>
              ))}
            </div>
          </div>

          <div style={{ padding: '0 18px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                flex: 1, display: 'flex', alignItems: 'center', gap: 10, maxWidth: 460,
                border: '1px solid var(--border)', borderRadius: 8, padding: '7px 12px', background: 'var(--card)',
              }}
            >
              <span style={{ fontSize: 13, color: 'var(--muted)' }}>⌕</span>
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Zoek in alle gepubliceerde artikelen — bv. “beste”…"
                style={{ flex: 1, border: 'none', outline: 'none', fontSize: 13, background: 'transparent', minWidth: 120 }}
              />
              {query && (
                <button
                  onClick={() => setQuery('')}
                  aria-label="Zoekopdracht wissen"
                  style={{ border: 'none', background: 'transparent', color: 'var(--muted)', fontSize: 14, lineHeight: 1, padding: 0 }}
                >
                  ✕
                </button>
              )}
            </div>
            <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
              {searchLoading
                ? 'Zoeken in WordPress…'
                : searching
                  ? `${hitsTotal} gevonden in het archief`
                  : 'Zonder zoekterm: de recente artikelen'}
            </span>
          </div>

          {searching && searchMode === 'demo' && (
            <div style={{ margin: '0 18px 12px', padding: '10px 12px', borderRadius: 6, background: 'var(--soft)', fontSize: 12, color: 'var(--gray)', lineHeight: 1.5 }}>
              Demo-modus: er is geen WordPress-koppeling ingesteld. Zoeken leest de publieke site, maar een carousel maken werkt pas met een koppeling.{' '}
              <Link href="/instellingen" style={{ fontWeight: 700 }}>Naar Instellingen → WordPress</Link>
            </div>
          )}

          {searchError && (
            <div style={{ margin: '0 18px 12px', padding: '10px 12px', borderRadius: 6, border: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--red-dark)' }}>{searchError}</span>
              <button className="btn-small" style={{ marginLeft: 'auto', flexShrink: 0 }} onClick={() => setSearchTick(t => t + 1)}>Opnieuw proberen</button>
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '0 18px 8px', borderBottom: '1px solid var(--border-light)' }}>
            <span style={{ width: 52, flexShrink: 0 }} />
            <span style={{ flex: 1, fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--muted)' }}>Artikel</span>
            <span style={{ width: 150, flexShrink: 0, fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--muted)' }}>WordPress</span>
            <span style={{ width: 190, flexShrink: 0, fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--muted)' }}>Carousel</span>
            <span style={{ width: 130, flexShrink: 0 }} />
          </div>

          {rows.map(({ row, meta }, i) => (
            <div
              key={row.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 16, padding: '10px 18px',
                borderBottom: i === rows.length - 1 ? 'none' : '1px solid var(--border-light)',
              }}
            >
              {row.featuredUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={row.featuredUrl} alt="" style={{ width: 52, height: 40, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }} />
              ) : (
                <span className="hatch" style={{ width: 52, height: 40, borderRadius: 6, flexShrink: 0 }} />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {row.title}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{row.sub}</div>
              </div>
              <div style={{ width: 150, flexShrink: 0 }}>
                <span className={row.published ? 'chip-green' : 'chip-amber'}>
                  {row.published ? 'Gepubliceerd' : 'Klaar v. publicatie'}
                </span>
              </div>
              <div style={{ width: 190, flexShrink: 0 }}>
                {metas === null && !engineMissing && !metaError
                  ? <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)' }}>Status laden…</span>
                  : carouselChip(meta)}
              </div>
              <div style={{ width: 130, flexShrink: 0 }}>{rowAction(row.id, meta)}</div>
            </div>
          ))}

          {/* Bij een zoekfout staat de uitleg al in de foutkaart hierboven; dan
              niet óók "niets gevonden" tonen — dat leest als een leeg archief. */}
          {rows.length === 0 && !(searchError && candidates.length === 0) && (
            <div style={{ fontSize: 12.5, color: 'var(--muted)', textAlign: 'center', padding: '18px 6px' }}>
              {searchLoading
                ? 'Zoeken…'
                : searching && candidates.length === 0
                  ? `Geen gepubliceerde artikelen gevonden voor “${term}”.`
                  : 'Geen artikelen in dit filter.'}
            </div>
          )}

          {hasMore && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '14px 6px 16px', borderTop: '1px solid var(--border-light)' }}>
              <button className="btn-small" onClick={() => setPage(p => p + 1)}>
                Toon meer — pagina {page + 1} van {hitsPages}
              </button>
            </div>
          )}
          {searching && searchLoading && candidates.length > 0 && (
            <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', padding: '12px 6px' }}>Laden…</div>
          )}
        </div>
      )}
    </div>
  );
}
