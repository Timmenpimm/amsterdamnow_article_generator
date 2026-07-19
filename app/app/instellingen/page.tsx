'use client';

import { useCallback, useEffect, useState } from 'react';
import TopBar from '@/components/TopBar';
import { toast } from '@/components/toast';
import type { PromptVersion } from '@/lib/types';

type PromptKind = 'research' | 'schrijf' | 'seo';

const VARS: Record<PromptKind, string[]> = {
  research: ['{{onderwerp}}', '{{tavily_bronnen}}', '{{categorieën}}', '{{districten}}'],
  schrijf: ['{{onderwerp}}', '{{research}}', '{{categorieën}}', '{{districten}}'],
  seo: ['{{post_title}}', '{{post_content}}', '{{category}}', '{{district}}'],
};

export default function Instellingen() {
  const [kind, setKind] = useState<PromptKind>('research');
  const [versions, setVersions] = useState<PromptVersion[]>([]);
  const [content, setContent] = useState('');
  const [viewing, setViewing] = useState<PromptVersion | null>(null);
  const [busy, setBusy] = useState(false);

  const active = versions.find(v => v.active === 1);
  const dirty = !viewing && active && content !== active.content;

  const load = useCallback(async (k: PromptKind) => {
    const res = await fetch(`/api/prompts?kind=${k}`);
    const data = await res.json();
    setVersions(data.versions);
    const act = (data.versions as PromptVersion[]).find(v => v.active === 1);
    setContent(act?.content || '');
    setViewing(null);
  }, []);

  useEffect(() => { load(kind); }, [kind, load]);

  async function save() {
    if (!dirty || busy) return;
    const note = prompt('Korte omschrijving van de wijziging (voor de versiegeschiedenis):') || '';
    setBusy(true);
    try {
      await fetch('/api/prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, content, note }),
      });
      toast(`Opgeslagen als v${(active?.version || 0) + 1} — geldt vanaf het volgende Claude-artikel`);
      load(kind);
    } finally {
      setBusy(false);
    }
  }

  async function rollback(v: PromptVersion) {
    if (!confirm(`v${v.version} terugzetten als actieve prompt?`)) return;
    await fetch(`/api/prompts/${v.id}/activate`, { method: 'POST' });
    toast(`v${v.version} is nu actief`);
    load(kind);
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <TopBar />
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* editor */}
        <div style={{ flex: 1, minWidth: 0, padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14, background: 'var(--card)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              onClick={() => setKind('research')}
              style={{
                fontSize: 13, fontWeight: kind === 'research' ? 700 : 600, padding: '7px 14px', borderRadius: 999,
                background: kind === 'research' ? 'var(--ink)' : 'transparent', color: kind === 'research' ? '#fff' : 'var(--gray)',
                border: kind === 'research' ? 'none' : '1px solid var(--border)',
              }}
            >
              Research-prompt
            </button>
            <button
              onClick={() => setKind('schrijf')}
              style={{
                fontSize: 13, fontWeight: kind === 'schrijf' ? 700 : 600, padding: '7px 14px', borderRadius: 999,
                background: kind === 'schrijf' ? 'var(--ink)' : 'transparent',
                color: kind === 'schrijf' ? '#fff' : 'var(--gray)',
                border: kind === 'schrijf' ? 'none' : '1px solid var(--border)',
              }}
            >
              Schrijf-prompt
            </button>
            <button
              onClick={() => setKind('seo')}
              style={{
                fontSize: 13, fontWeight: kind === 'seo' ? 700 : 600, padding: '7px 14px', borderRadius: 999,
                background: kind === 'seo' ? 'var(--ink)' : 'transparent',
                color: kind === 'seo' ? '#fff' : 'var(--gray)',
                border: kind === 'seo' ? 'none' : '1px solid var(--border)',
              }}
            >
              SEO-prompt
            </button>
            {active && (
              <span className="chip-green" style={{ marginLeft: 'auto', fontSize: 12 }}>
                v{active.version} · actief
              </span>
            )}
          </div>

          {viewing && (
            <div
              style={{
                display: 'flex', alignItems: 'center', gap: 10, background: 'var(--soft)',
                border: '1px solid var(--border-light)', borderRadius: 8, padding: '9px 14px', fontSize: 12.5,
              }}
            >
              <span>
                Je bekijkt <b>v{viewing.version}</b> (alleen-lezen).
              </span>
              <button className="btn-small" style={{ marginLeft: 'auto' }} onClick={() => { setViewing(null); setContent(active?.content || ''); }}>
                Terug naar actieve versie
              </button>
              <button className="btn-primary" style={{ fontSize: 12.5, padding: '7px 14px' }} onClick={() => rollback(viewing)}>
                Terugzetten als actief
              </button>
            </div>
          )}

          <textarea
            className="prompt-editor"
            style={{ flex: 1, minHeight: 380 }}
            value={viewing ? viewing.content : content}
            readOnly={Boolean(viewing)}
            onChange={e => setContent(e.target.value)}
            spellCheck={false}
          />

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: 'var(--gray)', fontWeight: 600 }}>Variabelen — Claude vult deze bij elke run in:</span>
            {VARS[kind].map(v => (
              <span
                key={v}
                style={{
                  fontFamily: 'var(--mono)', fontSize: 11.5, fontWeight: 600, background: 'var(--soft)',
                  border: '1px solid var(--border-light)', padding: '3px 8px', borderRadius: 5,
                }}
              >
                {v}
              </span>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, borderTop: '1px solid var(--border-light)', padding: '14px 0 4px' }}>
            <span style={{ fontSize: 12.5, color: 'var(--gray)' }}>
              {active
                ? `Laatst gewijzigd ${new Date(active.created_at.replace(' ', 'T')).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })} · ${active.author}`
                : 'Nog geen versie'}
            </span>
            <button
              className="btn"
              style={{ marginLeft: 'auto' }}
              disabled={!dirty}
              onClick={() => setContent(active?.content || '')}
            >
              Wijzigingen verwerpen
            </button>
            <button className="btn-primary" disabled={!dirty || busy} onClick={save}>
              {dirty ? `Opslaan als v${(active?.version || 0) + 1}` : 'Geen wijzigingen'}
            </button>
          </div>
        </div>

        {/* versiegeschiedenis */}
        <div
          style={{
            width: 340, flexShrink: 0, borderLeft: '1px solid var(--border-light)', background: 'var(--sidebar)',
            padding: 20, display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto',
          }}
          className="desktop-only-flex"
        >
          <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--gray)' }}>
            Versiegeschiedenis
          </div>
          {versions.map(v => (
            <div
              key={v.id}
              style={{
                background: 'var(--card)', borderRadius: 8, padding: '12px 14px',
                border: v.active ? '1.5px solid var(--ink)' : '1px solid var(--border-light)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 800 }}>v{v.version}</span>
                {v.active === 1 && <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--green-dark)' }}>actief</span>}
                <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--muted)' }}>
                  {new Date(v.created_at.replace(' ', 'T')).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })} · {v.author}
                </span>
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--text-soft)', marginTop: 5, lineHeight: 1.45 }}>
                {v.note || 'Geen omschrijving'}
              </div>
              {v.active !== 1 && (
                <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 12, fontWeight: 600 }}>
                  <span style={{ textDecoration: 'underline', cursor: 'pointer' }} onClick={() => setViewing(v)}>Bekijk</span>
                  <span style={{ textDecoration: 'underline', cursor: 'pointer' }} onClick={() => rollback(v)}>Terugzetten</span>
                </div>
              )}
            </div>
          ))}
          <div
            style={{
              background: 'var(--amber-bg)', border: '1px solid var(--amber-border)', borderRadius: 8,
              padding: '12px 14px', fontSize: 12.5, lineHeight: 1.5, color: 'var(--amber-dark)',
            }}
          >
            <span style={{ fontWeight: 800 }}>Let op:</span> de prompt geldt voor élk volgend artikel. Check na een wijziging het eerstvolgende draft-artikel extra goed.
          </div>
          <div style={{ fontSize: 12, color: 'var(--gray)', lineHeight: 1.5 }}>
            {kind === 'research'
              ? 'De research-prompt zet Tavily-bronnen om naar controleerbare feiten en WordPress-metadata.'
              : kind === 'schrijf'
                ? 'De SEO-prompt (RankMath-titel, meta description, focus keyword, slug) staat in het derde tabblad en werkt op dezelfde manier.'
                : 'De schrijf-prompt (titel, subregel, intro, artikeltekst, quote) staat in het tweede tabblad en werkt op dezelfde manier.'}
          </div>
        </div>
      </div>
    </div>
  );
}
