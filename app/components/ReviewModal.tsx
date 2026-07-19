'use client';

import { useMemo, useState } from 'react';
import type { Topic } from '@/lib/types';
import { parseListState } from '@/lib/types';
import { toast } from './toast';

export default function ReviewModal({
  topic, onClose, onApproved,
}: {
  topic: Topic;
  onClose: () => void;
  onApproved: () => void;
}) {
  const state = useMemo(() => parseListState(topic), [topic]);
  const verified = useMemo(() => state?.items.filter(i => i.status === 'verified' || i.status === 'excluded') || [], [state]);
  const rejected = useMemo(() => state?.items.filter(i => i.status === 'rejected') || [], [state]);
  const [included, setIncluded] = useState<Set<string>>(
    () => new Set(verified.filter(i => i.status === 'verified').map(i => i.naam))
  );
  const [busy, setBusy] = useState(false);

  if (!state) return null;

  function toggle(naam: string) {
    setIncluded(prev => {
      const next = new Set(prev);
      if (next.has(naam)) next.delete(naam);
      else next.add(naam);
      return next;
    });
  }

  async function approve() {
    if (busy) return;
    if (included.size < 3) { toast('Minimaal 3 items nodig voor een lijstartikel', { kind: 'error' }); return; }
    setBusy(true);
    try {
      const res = await fetch(`/api/topics/${topic.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ include: [...included] }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Goedkeuren mislukt');
      toast(`${included.size} items goedgekeurd — Claude schrijft het artikel`);
      onApproved();
      onClose();
    } catch (e: any) {
      toast(e.message, { kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  const quoteCount = verified.filter(i => included.has(i.naam) && i.quote).length;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        style={{
          width: 'min(760px, 96vw)', background: 'var(--card)', borderRadius: 12,
          boxShadow: '0 24px 60px rgba(20,20,18,0.35)', overflow: 'hidden',
          maxHeight: '92vh', display: 'flex', flexDirection: 'column',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', padding: '16px 22px', borderBottom: '1px solid var(--border-light)' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800 }}>Items controleren — {topic.title}</div>
            <div style={{ fontSize: 12.5, color: 'var(--gray)', marginTop: 3 }}>
              Adressen zijn geverifieerd via een primaire bron. Vink uit wat niet in het artikel hoort; daarna schrijft Claude.
            </div>
          </div>
          <span style={{ marginLeft: 'auto', fontSize: 16, color: 'var(--gray)', cursor: 'pointer', padding: 8 }} onClick={onClose}>✕</span>
        </div>

        <div style={{ padding: '16px 22px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {verified.map(item => (
            <label
              key={item.naam}
              style={{
                display: 'flex', gap: 12, alignItems: 'flex-start', border: '1px solid var(--border-light)',
                borderRadius: 8, padding: '10px 14px', cursor: 'pointer',
                opacity: included.has(item.naam) ? 1 : 0.55, background: 'var(--card)',
              }}
            >
              <input type="checkbox" checked={included.has(item.naam)} onChange={() => toggle(item.naam)} style={{ marginTop: 3 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13.5, fontWeight: 700 }}>{item.naam}</span>
                  <span style={{ fontSize: 12, color: 'var(--gray)' }}>{[item.adres, item.buurt].filter(Boolean).join(', ')}</span>
                  {item.quote && <span className="chip-green" style={{ fontSize: 10.5 }}>quote · {item.quote.bron}</span>}
                </div>
                {item.extra_info && <div style={{ fontSize: 12, color: 'var(--gray)', marginTop: 2 }}>{item.extra_info}</div>}
                {item.bron && (
                  <a
                    href={item.bron} target="_blank" rel="noreferrer"
                    style={{ fontSize: 11.5, color: 'var(--gray)', textDecoration: 'underline' }}
                    onClick={e => e.stopPropagation()}
                  >
                    bron: {item.bron.replace(/^https?:\/\/(www\.)?/, '').split('/')[0]}
                  </a>
                )}
              </div>
            </label>
          ))}

          {rejected.length > 0 && (
            <>
              <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--red-dark)', marginTop: 8 }}>
                Afgevallen bij verificatie · {rejected.length}
              </div>
              {rejected.map(item => (
                <div key={item.naam} style={{ border: '1px solid var(--red-border)', background: '#fdf6f5', borderRadius: 8, padding: '10px 14px' }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--red-dark)', textDecoration: 'line-through' }}>{item.naam}</span>
                  <span style={{ fontSize: 12, color: 'var(--red-dark)', marginLeft: 10 }}>{item.reden}</span>
                </div>
              ))}
            </>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 22px', borderTop: '1px solid var(--border-light)', background: 'var(--panel)' }}>
          <span style={{ fontSize: 12.5, color: 'var(--gray)' }}>
            {included.size} item{included.size === 1 ? '' : 's'} geselecteerd · {quoteCount} met geverifieerde quote
            {quoteCount < Math.floor(included.size / 3) && ' (quote-norm wordt niet gehaald; het artikel krijgt een melding)'}
          </span>
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={onClose}>Later</button>
          <button className="btn-primary" disabled={busy || included.size < 3} onClick={approve}>
            {busy ? 'Bezig…' : `Schrijf artikel met ${included.size} items`}
          </button>
        </div>
      </div>
    </div>
  );
}
