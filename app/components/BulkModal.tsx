'use client';

import { useMemo, useState } from 'react';
import { toast } from './toast';

interface Row {
  title: string;
  duplicate: boolean;
  removed: boolean;
}

// Zie POST /api/topics (app/app/api/topics/route.ts) en
// docs/superpowers/specs/2026-07-21-wp-dedup-index-design.md §4 — vorm van
// de `duplicates`-array in de response.
interface WpDuplicate {
  title: string;
  existing: { wp_id: number; title: string; link: string; status: string };
  reason: string;
}

function statusLabel(status: string): string {
  if (status === 'draft' || status === 'pending') return 'concept';
  if (status === 'future') return 'gepland';
  if (status === 'publish') return 'gepubliceerd';
  return status;
}

export default function BulkModal({
  existing,
  onClose,
  onAdded,
}: {
  existing: string[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [text, setText] = useState('');
  const [removed, setRemoved] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [wpDuplicates, setWpDuplicates] = useState<WpDuplicate[]>([]);
  const [forcing, setForcing] = useState<Set<string>>(new Set());

  const rows: Row[] = useMemo(() => {
    const seen = new Set(existing.map(t => t.trim().toLowerCase()));
    return text
      .split('\n')
      .map(l => l.replace(/^["']|["']$/g, '').trim())
      .filter(Boolean)
      .map((title, i) => {
        const key = title.toLowerCase();
        const duplicate = seen.has(key);
        if (!duplicate) seen.add(key);
        return { title, duplicate, removed: removed.has(i) };
      });
  }, [text, existing, removed]);

  const emptySkipped = text ? text.split('\n').filter(l => !l.trim()).length : 0;
  const dupes = rows.filter(r => r.duplicate).length;
  const toAdd = rows.filter(r => !r.duplicate && !r.removed);

  async function submit() {
    if (!toAdd.length || busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/topics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ titles: toAdd.map(r => r.title) }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || 'Toevoegen mislukt');
      }
      const body = await res.json();
      const added: unknown[] = Array.isArray(body.added) ? body.added : [];
      const duplicates: WpDuplicate[] = Array.isArray(body.duplicates) ? body.duplicates : [];

      if (added.length) {
        toast(`${added.length} onderwerp${added.length > 1 ? 'en' : ''} toegevoegd aan de wachtrij`);
      }
      onAdded();

      if (duplicates.length) {
        // Blijf open zodat de redactie per titel kan besluiten om 'm alsnog
        // toe te voegen ("Toch toevoegen") — zie spec §4/§5.
        setWpDuplicates(duplicates);
        setText('');
        setRemoved(new Set());
      } else {
        onClose();
      }
    } catch (e: any) {
      // Niet-OK response of netwerkfout: modal blijft open (geen onClose/
      // onAdded) zodat de redactie het niet ongemerkt als "gelukt" leest.
      toast(e.message || 'Toevoegen mislukt', { kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function forceAdd(dup: WpDuplicate) {
    if (forcing.has(dup.title)) return;
    setForcing(prev => new Set(prev).add(dup.title));
    try {
      const res = await fetch('/api/topics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ titles: [dup.title], forceTitles: [dup.title] }),
      });
      const body = await res.json();
      if (!res.ok || !body.added?.length) {
        throw new Error(body.error || 'Toevoegen mislukt');
      }
      toast(`"${dup.title}" toegevoegd aan de wachtrij`);
      setWpDuplicates(prev => prev.filter(d => d.title !== dup.title));
      onAdded();
    } catch (e: any) {
      toast(e.message || 'Toevoegen mislukt', { kind: 'error' });
    } finally {
      setForcing(prev => {
        const next = new Set(prev);
        next.delete(dup.title);
        return next;
      });
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        style={{
          width: 'min(840px, 96vw)', background: 'var(--card)', borderRadius: 12,
          boxShadow: '0 24px 60px rgba(20,20,18,0.35)', overflow: 'hidden',
          maxHeight: '90vh', display: 'flex', flexDirection: 'column',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', padding: '16px 22px', borderBottom: '1px solid var(--border-light)' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800 }}>Onderwerpen in bulk toevoegen</div>
            <div style={{ fontSize: 12.5, color: 'var(--gray)', marginTop: 3 }}>
              Plak uit Excel, een CSV of gewoon losse regels — één onderwerp per regel. Categorie, district en tags bepaalt de AI daarna volledig zelf.
            </div>
          </div>
          <span
            style={{ marginLeft: 'auto', fontSize: 16, color: 'var(--gray)', cursor: 'pointer', padding: 8 }}
            onClick={onClose}
          >
            ✕
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', minHeight: 380, flex: 1, overflow: 'hidden' }}>
          <div style={{ borderRight: '1px solid var(--border-light)', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--gray)' }}>
              Plak hier
            </div>
            <textarea
              autoFocus
              value={text}
              onChange={e => { setText(e.target.value); setRemoved(new Set()); }}
              placeholder={'MAS Atelier: zuurdesembakkerij in Oost\nNieuwe expo Foam: Martin Parr\nWolff & Beer: bruine kroeg in De Baarsjes\n…'}
              style={{
                flex: 1, border: '1.5px dashed #b7b5ae', borderRadius: 8, background: 'var(--panel)',
                padding: '12px 14px', fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.9,
                color: 'var(--text-soft)', resize: 'none', outline: 'none',
              }}
            />
          </div>
          <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 8, overflow: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--gray)' }}>
                Preview
              </div>
              <div style={{ fontSize: 12, color: 'var(--gray)' }}>
                {toAdd.length} onderwerpen
                {emptySkipped > 0 && ` · ${emptySkipped} lege regel${emptySkipped > 1 ? 's' : ''} overgeslagen`}
                {dupes > 0 && (
                  <>
                    {' · '}
                    <span style={{ color: 'var(--red-dark)', fontWeight: 600 }}>
                      {dupes} dubbel{dupes > 1 ? 'e' : 'e'}
                    </span>
                  </>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {rows.length === 0 && (
                <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '20px 0' }}>
                  De preview verschijnt hier zodra je iets plakt.
                </div>
              )}
              {rows.map((r, i) =>
                r.duplicate ? (
                  <div
                    key={i}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, border: '1px solid var(--red-border)',
                      background: '#fdf6f5', borderRadius: 7, padding: '8px 11px',
                    }}
                  >
                    <span style={{ fontSize: 12.5, fontWeight: 600, flex: 1, color: 'var(--red-dark)', textDecoration: 'line-through' }}>
                      {r.title}
                    </span>
                    <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--red-dark)' }}>dubbel — overgeslagen</span>
                  </div>
                ) : r.removed ? null : (
                  <div
                    key={i}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid var(--border-light)', borderRadius: 7, padding: '8px 11px' }}
                  >
                    <span style={{ fontSize: 12.5, fontWeight: 600, flex: 1 }}>{r.title}</span>
                    <span
                      style={{ fontSize: 12, color: 'var(--muted)', cursor: 'pointer' }}
                      onClick={() => setRemoved(s => new Set([...s, i]))}
                    >
                      ✕
                    </span>
                  </div>
                )
              )}
            </div>
          </div>
        </div>
        {wpDuplicates.length > 0 && (
          <div
            style={{
              padding: '14px 22px', borderTop: '1px solid var(--amber-border)', background: 'var(--amber-col)',
              display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 220, overflowY: 'auto',
            }}
          >
            <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--amber-dark)' }}>
              Bestaat al op de site · {wpDuplicates.length}
            </div>
            {wpDuplicates.map(dup => (
              <div
                key={dup.title}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, border: '1px solid var(--amber-border)',
                  background: 'var(--card)', borderRadius: 7, padding: '8px 11px',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>{dup.title}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--gray)', marginTop: 2 }}>
                    al op de site als{' '}
                    <a href={dup.existing.link} target="_blank" rel="noreferrer" style={{ color: 'var(--amber-dark)', textDecoration: 'underline' }}>
                      {dup.existing.title}
                    </a>
                    {' '}<span className="chip-amber">{statusLabel(dup.existing.status)}</span>
                    {dup.reason && <span> — {dup.reason}</span>}
                  </div>
                </div>
                <button
                  className="btn-small"
                  disabled={forcing.has(dup.title)}
                  onClick={() => forceAdd(dup)}
                >
                  {forcing.has(dup.title) ? 'Bezig…' : 'Toch toevoegen'}
                </button>
              </div>
            ))}
          </div>
        )}
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 12, padding: '14px 22px',
            borderTop: '1px solid var(--border-light)', background: 'var(--panel)',
          }}
        >
          <span style={{ fontSize: 12.5, color: 'var(--gray)' }}>
            Nieuwe onderwerpen komen onderaan de wachtrij; versleep ze daarna om prioriteit te geven.
          </span>
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={onClose}>{wpDuplicates.length > 0 ? 'Sluiten' : 'Annuleren'}</button>
          <button className="btn-primary" disabled={!toAdd.length || busy} onClick={submit}>
            {toAdd.length ? `${toAdd.length} onderwerp${toAdd.length > 1 ? 'en' : ''} toevoegen` : 'Niets toe te voegen'}
          </button>
        </div>
      </div>
    </div>
  );
}
