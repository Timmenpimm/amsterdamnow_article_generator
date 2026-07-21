'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { Article, BoardData } from '@/lib/types';
import { articlePhase } from '@/lib/types';
import { getCarouselMeta, type CarouselMeta } from '@/lib/carousel-mock';

type Filter = 'all' | 'none' | 'published';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
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

function rowAction(article: Article, meta: CarouselMeta) {
  if (meta.status === 'published') {
    return <Link href={`/carousel/${article.id}`} className="btn-small">Bekijken</Link>;
  }
  if (meta.status === 'ready') {
    return <Link href={`/carousel/${article.id}`} className="btn-primary" style={{ display: 'inline-block' }}>Openen →</Link>;
  }
  if (meta.status === 'concept') {
    return <Link href={`/carousel/${article.id}`} className="btn-primary" style={{ display: 'inline-block' }}>Verder →</Link>;
  }
  return <Link href={`/carousel/${article.id}`} className="btn-primary" style={{ display: 'inline-block' }}>Maak carousel</Link>;
}

export default function CarouselOverview() {
  const [data, setData] = useState<BoardData | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  // meta komt uit de mock-store, dus we lezen 'm pas ná mount (client-only)
  // en forceren een re-render zodra de gebruiker terugkomt van de generator.
  const [tick, setTick] = useState(0);

  useEffect(() => {
    fetch('/api/board').then(r => r.json()).then(setData).catch(() => {});
  }, []);

  useEffect(() => {
    const onFocus = () => setTick(t => t + 1);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const eligible = (data?.articles || [])
    .filter(a => articlePhase(a) === 'published' || articlePhase(a) === 'ready')
    .map(a => ({ article: a, meta: getCarouselMeta(a.id) }))
    .sort((a, b) => +new Date(b.article.date) - +new Date(a.article.date));

  void tick; // gebruikt alleen om de mock-lookup opnieuw te draaien

  const rows = eligible.filter(({ meta }) => {
    if (filter === 'none') return meta.status === 'none';
    if (filter === 'published') return meta.status === 'published';
    return true;
  });

  return (
    <div style={{ padding: '24px 20px', maxWidth: 1000 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <span style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.01em' }}>Carousel</span>
        <span style={{ fontSize: 13, color: 'var(--gray)' }}>welke artikelen zijn Instagram-klaar</span>
      </div>

      {data && eligible.length === 0 ? (
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 18px 12px' }}>
            <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--gray)' }}>
              Artikelen — Instagram-klaar
            </span>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--gray)' }}>{eligible.length}</span>
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

          <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '0 18px 8px', borderBottom: '1px solid var(--border-light)' }}>
            <span style={{ width: 52, flexShrink: 0 }} />
            <span style={{ flex: 1, fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--muted)' }}>Artikel</span>
            <span style={{ width: 150, flexShrink: 0, fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--muted)' }}>WordPress</span>
            <span style={{ width: 190, flexShrink: 0, fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--muted)' }}>Carousel</span>
            <span style={{ width: 130, flexShrink: 0 }} />
          </div>

          {rows.map(({ article, meta }, i) => (
            <div
              key={article.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 16, padding: '10px 18px',
                borderBottom: i === rows.length - 1 ? 'none' : '1px solid var(--border-light)',
              }}
            >
              {article.featured ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={article.featured.url} alt="" style={{ width: 52, height: 40, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }} />
              ) : (
                <span className="hatch" style={{ width: 52, height: 40, borderRadius: 6, flexShrink: 0 }} />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {article.title}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                  {[article.category, article.district].filter(Boolean).join(' · ')}
                  {article.date ? ` · ${formatDate(article.date)}` : ''}
                </div>
              </div>
              <div style={{ width: 150, flexShrink: 0 }}>
                <span className={articlePhase(article) === 'published' ? 'chip-green' : 'chip-amber'}>
                  {articlePhase(article) === 'published' ? 'Gepubliceerd' : 'Klaar v. publicatie'}
                </span>
              </div>
              <div style={{ width: 190, flexShrink: 0 }}>{carouselChip(meta)}</div>
              <div style={{ width: 130, flexShrink: 0 }}>{rowAction(article, meta)}</div>
            </div>
          ))}

          {rows.length === 0 && (
            <div style={{ fontSize: 12.5, color: 'var(--muted)', textAlign: 'center', padding: '18px 6px' }}>
              Geen artikelen in dit filter.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
