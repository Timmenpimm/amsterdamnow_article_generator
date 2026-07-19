'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from './toast';

export default function ListArticleModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated?: () => void }) {
  const [title, setTitle] = useState('');
  const [itemsText, setItemsText] = useState('');
  const [weekendgids, setWeekendgids] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const items = useMemo(
    () => [...new Set(itemsText.split('\n').map(s => s.trim()).filter(Boolean))],
    [itemsText]
  );

  if (!open) return null;

  async function submit() {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/list-articles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), items, weekendgids }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Lijstartikel aanmaken mislukt');
      toast(items.length
        ? `Lijstartikel in wachtrij — ${items.length} items worden geverifieerd`
        : 'Lijstartikel in wachtrij — de AI stelt kandidaat-items voor');
      setTitle(''); setItemsText(''); setWeekendgids(false);
      onCreated?.();
      onClose();
    } catch (error: any) {
      toast(error.message, { kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        style={{
          width: 'min(680px, 96vw)', background: 'var(--card)', borderRadius: 12,
          boxShadow: '0 24px 60px rgba(20,20,18,0.35)', overflow: 'hidden',
          maxHeight: '92vh', display: 'flex', flexDirection: 'column',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', padding: '16px 22px', borderBottom: '1px solid var(--border-light)' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800 }}>Nieuw lijstartikel</div>
            <div style={{ fontSize: 12.5, color: 'var(--gray)', marginTop: 3 }}>
              De pipeline verifieert elk item apart (bestaat de zaak nog, klopt het adres) en legt de selectie eerst aan je voor.
            </div>
          </div>
          <span style={{ marginLeft: 'auto', fontSize: 16, color: 'var(--gray)', cursor: 'pointer', padding: 8 }} onClick={onClose}>✕</span>
        </div>

        <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto' }}>
          <div>
            <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--gray)', marginBottom: 6 }}>
              Thema
            </div>
            <input
              autoFocus
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="De beste ijssalons van Amsterdam"
              style={{
                width: '100%', border: '1.5px solid var(--ink)', borderRadius: 8, padding: '10px 14px',
                fontSize: 14, fontWeight: 600, outline: 'none',
              }}
            />
          </div>

          <div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--gray)' }}>
                Items — optioneel
              </span>
              <span style={{ fontSize: 12, color: 'var(--gray)' }}>
                {items.length
                  ? `${items.length} item${items.length === 1 ? '' : 's'} · selectiefase wordt overgeslagen`
                  : 'leeg laten = de AI stelt kandidaten voor'}
              </span>
            </div>
            <textarea
              value={itemsText}
              onChange={e => setItemsText(e.target.value)}
              placeholder={'Eén zaak of evenement per regel:\nMassimo Gelato\nIJscuypje\nMonte Pelmo\n…'}
              rows={7}
              style={{
                width: '100%', border: '1.5px dashed #b7b5ae', borderRadius: 8, background: 'var(--panel)',
                padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 12.5, lineHeight: 1.8,
                resize: 'vertical', outline: 'none',
              }}
            />
          </div>

          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', fontSize: 13 }}>
            <input type="checkbox" checked={weekendgids} onChange={e => setWeekendgids(e.target.checked)} style={{ marginTop: 2 }} />
            <span>
              <span style={{ fontWeight: 700 }}>Weekendgids</span>
              <span style={{ color: 'var(--gray)' }}>
                {' '}— extra strenge verificatie: elk item alleen met een bevestigde datum in het komende weekend; verlopen events vallen af.
              </span>
            </span>
          </label>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 22px', borderTop: '1px solid var(--border-light)', background: 'var(--panel)' }}>
          <span style={{ fontSize: 12.5, color: 'var(--gray)' }}>
            Na verificatie krijg je de items eerst ter controle voordat Claude schrijft.
          </span>
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={onClose}>Annuleren</button>
          <button className="btn-primary" disabled={!title.trim() || busy} onClick={submit}>
            {busy ? 'Aanmaken…' : 'In wachtrij zetten'}
          </button>
        </div>
      </div>
    </div>
  );
}
