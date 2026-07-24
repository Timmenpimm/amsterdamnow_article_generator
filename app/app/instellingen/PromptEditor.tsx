'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from '@/components/toast';
import type { PromptKind, PromptVersion } from '@/lib/types';
import PanelHeader from './PanelHeader';
import VersionDrawer from './VersionDrawer';
import type { RailKey } from './meta';

const VARS: Record<PromptKind, string[]> = {
  research: ['onderwerp', 'tavily_bronnen', 'categorieën', 'districten'],
  schrijf: ['onderwerp', 'research', 'categorieën', 'districten'],
  seo: ['post_title', 'post_content', 'category', 'district'],
  'lijst-selectie': ['thema', 'tavily_bronnen'],
  'lijst-research': ['thema', 'item', 'tavily_bronnen', 'doelweekend'],
  'lijst-schrijf': ['thema', 'items_research', 'categorieën', 'districten'],
  'lijst-seo': ['titel', 'intro', 'items'],
};

export default function PromptEditor({
  kind,
  eyebrow,
  title,
  description,
  onNavigate,
  onChanged,
}: {
  kind: PromptKind;
  eyebrow: string;
  title: string;
  description: string;
  onNavigate: (key: RailKey) => void;
  onChanged: () => void;
}) {
  const [versions, setVersions] = useState<PromptVersion[]>([]);
  const [content, setContent] = useState('');
  const [viewing, setViewing] = useState<PromptVersion | null>(null);
  const [busy, setBusy] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

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
      await load(kind);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function rollback(v: PromptVersion) {
    if (!confirm(`v${v.version} terugzetten als actieve prompt?`)) return;
    await fetch(`/api/prompts/${v.id}/activate`, { method: 'POST' });
    toast(`v${v.version} is nu actief`);
    await load(kind);
    onChanged();
  }

  const headerRight = (
    <>
      {dirty ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: 'var(--amber-dark)', background: 'var(--amber-bg)', padding: '5px 10px', borderRadius: 999 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--amber)' }} />
          niet-opgeslagen
        </span>
      ) : active ? (
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--green-dark)', background: 'var(--green-bg)', padding: '5px 10px', borderRadius: 999 }}>
          v{active.version} · actief
        </span>
      ) : null}
      <button
        onClick={() => setDrawerOpen(o => !o)}
        style={{
          fontSize: 12.5, fontWeight: drawerOpen ? 700 : 600, padding: '7px 12px', borderRadius: 8,
          background: drawerOpen ? 'var(--ink)' : 'var(--card)', color: drawerOpen ? '#fff' : 'var(--ink)',
          border: drawerOpen ? '1px solid var(--ink)' : '1px solid var(--border)',
        }}
      >
        Versies ({versions.length})
      </button>
    </>
  );

  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--card)' }}>
        <PanelHeader eyebrow={eyebrow} title={title} description={description} right={headerRight} />

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '20px 28px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {viewing && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--soft)', border: '1px solid var(--border-light)', borderRadius: 8, padding: '9px 14px', fontSize: 12.5 }}>
              <span>Je bekijkt <b>v{viewing.version}</b> (alleen-lezen).</span>
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
            <span style={{ fontSize: 12, color: 'var(--gray)', fontWeight: 600 }}>n8n vult elke run in:</span>
            {VARS[kind].map(v => (
              <span
                key={v}
                style={{
                  fontFamily: 'var(--mono)', fontSize: 11.5, fontWeight: 600, background: 'var(--soft)',
                  border: '1px solid var(--border-light)', padding: '3px 8px', borderRadius: 5,
                }}
              >
                {`{{${v}}}`}
              </span>
            ))}
            <button
              onClick={() => onNavigate('variabelen')}
              style={{ fontSize: 12, color: 'var(--muted)', textDecoration: 'underline', background: 'none', border: 'none', padding: 0 }}
            >
              beheer
            </button>
          </div>
        </div>

        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 12, borderTop: '1px solid var(--border-light)',
            background: dirty ? 'var(--amber-col)' : 'var(--panel)', padding: '13px 28px',
          }}
        >
          <span style={{ fontSize: 12.5, color: dirty ? 'var(--amber-dark)' : 'var(--gray)', fontWeight: dirty ? 700 : 400 }}>
            {active
              ? `Opgeslagen · ${new Date(active.created_at.replace(' ', 'T')).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })} door ${active.author}`
              : 'Nog geen versie'}
          </span>
          <span style={{ fontSize: 12.5, color: dirty ? 'var(--amber-dark)' : 'var(--muted)', minWidth: 0 }}>
            Wijzigingen gaan mee vanaf de volgende n8n-run.
          </span>
          <button className="btn" style={{ marginLeft: 'auto' }} disabled={!dirty} onClick={() => setContent(active?.content || '')}>
            Verwerpen
          </button>
          <button className="btn-primary" disabled={!dirty || busy} onClick={save}>
            {dirty ? `Opslaan als v${(active?.version || 0) + 1}` : 'Geen wijzigingen'}
          </button>
        </div>
      </div>

      {drawerOpen && (
        <VersionDrawer
          subtitle={title}
          versions={versions}
          warning="de prompt geldt voor élk volgend artikel. Check na een wijziging het eerstvolgende draft-artikel extra goed."
          onClose={() => setDrawerOpen(false)}
          onView={v => setViewing(v as PromptVersion)}
          onRollback={v => rollback(v as PromptVersion)}
        />
      )}
    </div>
  );
}
