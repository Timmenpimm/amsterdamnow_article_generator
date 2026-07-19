'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { toast } from './toast';

const LOGO = 'https://cdn.amsterdamnow.com/media/ams-logo-now.png';

export default function TopBar({
  onAdded,
  onBulk,
  onList,
  mode,
}: {
  onAdded?: () => void;
  onBulk?: () => void;
  onList?: () => void;
  mode?: 'live' | 'demo';
}) {
  const pathname = usePathname();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      if (e.key.toLowerCase() === 'n' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  async function submit() {
    const title = value.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/topics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ titles: [title] }),
      });
      const data = await res.json();
      if (data.skipped?.length) {
        toast('Onderwerp staat al in de wachtrij', { kind: 'error' });
      } else {
        toast('Toegevoegd aan de wachtrij');
        setValue('');
        onAdded?.();
      }
    } finally {
      setBusy(false);
    }
  }

  const showQuickAdd = Boolean(onAdded);

  return (
    <div
      className="topbar"
      style={{
        display: 'flex', alignItems: 'center', gap: 20, padding: '12px 20px',
        borderBottom: '1px solid var(--border-light)', background: 'var(--card)',
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={LOGO} alt="Amsterdam NOW" style={{ height: 22, width: 'auto', filter: 'invert(1)' }} />
      <nav style={{ display: 'flex', gap: 4 }}>
        <Link href="/" className={`navlink${pathname === '/' ? ' active' : ''}`}>Pipeline</Link>
        <Link href="/archief" className={`navlink${pathname === '/archief' ? ' active' : ''}`}>Archief</Link>
        <Link href="/instellingen" className={`navlink${pathname === '/instellingen' ? ' active' : ''}`}>
          Prompt &amp; instellingen
        </Link>
      </nav>
      {showQuickAdd && (
        <div className="desktop-only">
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, maxWidth: 640, marginLeft: 12 }}>
            <div
              style={{
                flex: 1, display: 'flex', alignItems: 'center', gap: 10,
                border: '1.5px solid var(--ink)', borderRadius: 8, padding: '8px 14px', background: 'var(--card)',
              }}
              onClick={() => inputRef.current?.focus()}
            >
              <span style={{ fontSize: 15, fontWeight: 700 }}>＋</span>
              <input
                ref={inputRef}
                value={value}
                onChange={e => setValue(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && submit()}
                placeholder="Nieuw onderwerp — typ en druk op Enter…"
                style={{ flex: 1, border: 'none', outline: 'none', fontSize: 13.5, background: 'transparent', minWidth: 220 }}
              />
              <span
                style={{
                  fontSize: 11, color: 'var(--muted)', border: '1px solid var(--border-light)',
                  borderRadius: 4, padding: '1px 6px', fontWeight: 600,
                }}
              >
                N
              </span>
            </div>
            <button className="btn" style={{ whiteSpace: 'nowrap' }} onClick={onBulk}>
              Bulk toevoegen
            </button>
            <button className="btn" style={{ whiteSpace: 'nowrap' }} onClick={onList}>
              Lijstartikel
            </button>
          </div>
        </div>
      )}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14 }}>
        {mode === 'demo' ? (
          <span
            style={{
              fontSize: 11.5, fontWeight: 700, color: 'var(--amber-dark)', background: 'var(--amber-bg)',
              padding: '3px 9px', borderRadius: 999,
            }}
            title="Geen WordPress-credentials ingesteld (.env) — de tool draait op demo-data"
          >
            demo-modus
          </span>
        ) : (
          <span className="desktop-only">
            <span style={{ fontSize: 12.5, color: 'var(--gray)' }}>Claude gekoppeld · schrijven vanuit de wachtrij</span>
          </span>
        )}
        <span className="dot" style={{ background: mode === 'demo' ? 'var(--amber)' : 'var(--green)' }} />
        <span
          style={{
            width: 30, height: 30, borderRadius: '50%', background: 'var(--ink)', color: '#fff',
            display: 'grid', placeItems: 'center', fontSize: 12.5, fontWeight: 700,
          }}
        >
          M
        </span>
      </div>
    </div>
  );
}
