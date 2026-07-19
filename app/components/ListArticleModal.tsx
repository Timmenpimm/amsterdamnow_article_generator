'use client';

import { useEffect, useState } from 'react';
import { toast } from './toast';

export default function ListArticleModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated?: () => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  async function submit() {
    const text = value.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/list-articles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exportText: text }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Lijstartikel maken mislukt');
      toast(`Lijstartikel gemaakt: ${body.article?.title || 'draft'}`);
      onCreated?.();
      onClose();
    } catch (error: any) {
      toast(error.message || 'Lijstartikel maken mislukt', { kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15, 15, 14, 0.55)', display: 'grid', placeItems: 'center', zIndex: 50, padding: 20 }}>
      <div style={{ width: 'min(860px, 100%)', background: 'var(--card)', borderRadius: 16, border: '1px solid var(--border-light)', boxShadow: '0 16px 56px rgba(0,0,0,0.16)', overflow: 'hidden' }}>
        <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--border-light)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800 }}>Nieuwe lijstartikelpipeline</div>
            <div style={{ fontSize: 12.5, color: 'var(--gray)', marginTop: 4 }}>Plak hier de export van de chat en maak direct een draft artikel aan.</div>
          </div>
          <button className="btn-small" onClick={onClose}>Sluiten</button>
        </div>
        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <textarea
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder="Plak de volledige chat-export van het lijstartikel hier..."
            rows={18}
            style={{ width: '100%', resize: 'vertical', border: '1px solid var(--border-light)', borderRadius: 8, padding: 12, fontFamily: 'var(--mono)', fontSize: 12.5, lineHeight: 1.45 }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 12, color: 'var(--gray)', lineHeight: 1.45 }}>
              De parser zet de export om in titel, subregel, intro, hoofdtekst en SEO-velden. Daarna verschijnt het artikel in de pipeline.
            </div>
            <button className="btn-primary" disabled={busy || !value.trim()} onClick={submit}>
              {busy ? 'Aanmaken…' : 'Maak lijstartikel'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
