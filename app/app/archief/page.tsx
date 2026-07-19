'use client';

import { useEffect, useState } from 'react';
import type { BoardData } from '@/lib/types';
import { articlePhase } from '@/lib/types';
import TopBar from '@/components/TopBar';

export default function Archief() {
  const [data, setData] = useState<BoardData | null>(null);

  useEffect(() => {
    fetch('/api/board').then(r => r.json()).then(setData).catch(() => {});
  }, []);

  const published = (data?.articles || [])
    .filter(a => articlePhase(a) === 'published')
    .sort((a, b) => +new Date(b.date) - +new Date(a.date));

  return (
    <div style={{ minHeight: '100vh' }}>
      <TopBar mode={data?.mode} />
      <div style={{ padding: '24px 20px', maxWidth: 860 }}>
        <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.01em', marginBottom: 14 }}>Archief</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {published.map(a => (
            <div key={a.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '10px 14px' }}>
              {a.featured ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={a.featured.url} alt="" style={{ width: 64, height: 46, objectFit: 'cover', borderRadius: 5, flexShrink: 0 }} />
              ) : (
                <span className="hatch" style={{ width: 64, height: 46, borderRadius: 5, flexShrink: 0 }} />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35 }}>{a.title}</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3 }}>
                  {[a.category, a.district].filter(Boolean).join(' · ')} ·{' '}
                  {new Date(a.date).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' })}
                </div>
              </div>
              <a href={a.link} target="_blank" rel="noreferrer" style={{ fontSize: 12, fontWeight: 600, textDecoration: 'underline', whiteSpace: 'nowrap' }}>
                Bekijk live ↗
              </a>
            </div>
          ))}
          {data && published.length === 0 && (
            <div style={{ fontSize: 13, color: 'var(--gray)' }}>Nog geen gepubliceerde artikelen.</div>
          )}
        </div>
      </div>
    </div>
  );
}
