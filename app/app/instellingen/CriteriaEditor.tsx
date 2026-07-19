'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from '@/components/toast';
import type { ConstraintKind, ConstraintVersion } from '@/lib/types';
import { STANDAARD_FIELDS, LIST_FIELDS, type FieldDef } from './criteria-fields';

const FIELD_GROUPS: Record<ConstraintKind, { section: string; fields: FieldDef<any>[] }[]> = {
  standaard: STANDAARD_FIELDS,
  lijst: LIST_FIELDS,
};

function parse(content: string): Record<string, any> {
  return JSON.parse(content);
}

export default function CriteriaEditor({ kind }: { kind: ConstraintKind }) {
  const [versions, setVersions] = useState<ConstraintVersion[]>([]);
  const [draft, setDraft] = useState<Record<string, any> | null>(null);
  const [viewing, setViewing] = useState<ConstraintVersion | null>(null);
  const [busy, setBusy] = useState(false);

  const active = versions.find(v => v.active === 1);
  const activeContent = active ? parse(active.content) : null;
  const dirty = Boolean(!viewing && active && draft && JSON.stringify(draft) !== JSON.stringify(activeContent));

  const load = useCallback(async (k: ConstraintKind) => {
    const res = await fetch(`/api/constraints?kind=${k}`);
    const data = await res.json();
    setVersions(data.versions);
    const act = (data.versions as ConstraintVersion[]).find(v => v.active === 1);
    setDraft(act ? parse(act.content) : null);
    setViewing(null);
  }, []);

  useEffect(() => { load(kind); }, [kind, load]);

  function updateField(key: string, value: any) {
    setDraft(prev => (prev ? { ...prev, [key]: value } : prev));
  }

  async function save() {
    if (!dirty || busy || !draft) return;
    const note = prompt('Korte omschrijving van de wijziging (voor de versiegeschiedenis):') || '';
    setBusy(true);
    try {
      await fetch('/api/constraints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, content: draft, note }),
      });
      toast(`Opgeslagen als v${(active?.version || 0) + 1} — geldt vanaf het volgende artikel`);
      load(kind);
    } finally {
      setBusy(false);
    }
  }

  async function rollback(v: ConstraintVersion) {
    if (!confirm(`v${v.version} terugzetten als actieve versie?`)) return;
    await fetch(`/api/constraints/${v.id}/activate`, { method: 'POST' });
    toast(`v${v.version} is nu actief`);
    load(kind);
  }

  if (!draft) return null;
  const shown = viewing ? parse(viewing.content) : draft;
  const groups = FIELD_GROUPS[kind];

  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      <div style={{ flex: 1, minWidth: 0, padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 18, background: 'var(--card)', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          {active && (
            <span className="chip-green" style={{ fontSize: 12 }}>
              v{active.version} · actief
            </span>
          )}
        </div>

        {viewing && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--soft)', border: '1px solid var(--border-light)', borderRadius: 8, padding: '9px 14px', fontSize: 12.5 }}>
            <span>Je bekijkt <b>v{viewing.version}</b> (alleen-lezen).</span>
            <button className="btn-small" style={{ marginLeft: 'auto' }} onClick={() => setViewing(null)}>Terug naar actieve versie</button>
            <button className="btn-primary" style={{ fontSize: 12.5, padding: '7px 14px' }} onClick={() => rollback(viewing)}>Terugzetten als actief</button>
          </div>
        )}

        {groups.map(group => (
          <div key={group.section} style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--border-light)', paddingTop: 16 }}>
            <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--gray)' }}>
              {group.section}
            </div>
            {group.fields.map(field => (
              <FieldRow
                key={String(field.key)}
                field={field}
                value={shown[field.key as string]}
                readOnly={Boolean(viewing)}
                onChange={value => updateField(field.key as string, value)}
              />
            ))}
          </div>
        ))}

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, borderTop: '1px solid var(--border-light)', padding: '14px 0 4px', marginTop: 'auto' }}>
          <span style={{ fontSize: 12.5, color: 'var(--gray)' }}>
            {active
              ? `Laatst gewijzigd ${new Date(active.created_at.replace(' ', 'T')).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })} · ${active.author}`
              : 'Nog geen versie'}
          </span>
          <button className="btn" style={{ marginLeft: 'auto' }} disabled={!dirty} onClick={() => setDraft(activeContent)}>
            Wijzigingen verwerpen
          </button>
          <button className="btn-primary" disabled={!dirty || busy} onClick={save}>
            {dirty ? `Opslaan als v${(active?.version || 0) + 1}` : 'Geen wijzigingen'}
          </button>
        </div>
      </div>

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
          <span style={{ fontWeight: 800 }}>Let op:</span> deze criteria gelden voor élk volgend artikel. Check na een wijziging het eerstvolgende draft-artikel extra goed.
        </div>
      </div>
    </div>
  );
}

function FieldRow({ field, value, readOnly, onChange }: { field: FieldDef<any>; value: any; readOnly: boolean; onChange: (value: any) => void }) {
  if (field.type === 'range') {
    const r = value as { min: number; max: number };
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--border-light)' }}>
        <span style={{ fontSize: 13.5, fontWeight: 500, flex: 1 }}>{field.label}</span>
        <input
          type="number"
          value={r.min}
          disabled={readOnly}
          onChange={e => onChange({ ...r, min: Number(e.target.value) })}
          style={{ width: 58, textAlign: 'center', fontSize: 13.5, fontWeight: 600, border: '1px solid var(--border)', borderRadius: 7, padding: '6px 0' }}
        />
        <span style={{ fontSize: 12.5, color: 'var(--gray)' }}>t/m</span>
        <input
          type="number"
          value={r.max}
          disabled={readOnly}
          onChange={e => onChange({ ...r, max: Number(e.target.value) })}
          style={{ width: 58, textAlign: 'center', fontSize: 13.5, fontWeight: 600, border: '1px solid var(--border)', borderRadius: 7, padding: '6px 0' }}
        />
        <span style={{ fontSize: 12.5, color: 'var(--gray)', width: 60 }}>{field.unit}</span>
      </div>
    );
  }

  if (field.type === 'number') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--border-light)' }}>
        <span style={{ fontSize: 13.5, fontWeight: 500, flex: 1 }}>{field.label}</span>
        <input
          type="number"
          value={value as number}
          disabled={readOnly}
          onChange={e => onChange(Number(e.target.value))}
          style={{ width: 58, textAlign: 'center', fontSize: 13.5, fontWeight: 600, border: '1px solid var(--border)', borderRadius: 7, padding: '6px 0' }}
        />
        <span style={{ fontSize: 12.5, color: 'var(--gray)', width: 84 }}>{field.unit}</span>
      </div>
    );
  }

  if (field.type === 'tags') {
    const tags = value as string[];
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 12.5, color: 'var(--gray)', lineHeight: 1.45 }}>{field.hint}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {tags.map((tag, i) => (
            <span key={tag} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, background: 'var(--soft)', borderRadius: 5, padding: '4px 8px' }}>
              {tag}
              {!readOnly && (
                <span style={{ color: 'var(--muted)', cursor: 'pointer', fontSize: 12 }} onClick={() => onChange(tags.filter((_, j) => j !== i))}>
                  ✕
                </span>
              )}
            </span>
          ))}
          {!readOnly && (
            <input
              placeholder={field.placeholder}
              onKeyDown={e => {
                if (e.key !== 'Enter') return;
                const el = e.currentTarget;
                const next = el.value.trim();
                if (next) onChange([...tags, next]);
                el.value = '';
              }}
              style={{
                fontSize: 12.5, color: 'var(--gray)', border: '1px dashed var(--faint)', borderRadius: 5,
                padding: '4px 10px', background: 'transparent', minWidth: 160,
              }}
            />
          )}
        </div>
      </div>
    );
  }

  const on = Boolean(value);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, padding: '11px 0', borderBottom: '1px solid var(--border-light)' }}>
      <button
        onClick={() => !readOnly && onChange(!on)}
        disabled={readOnly}
        style={{
          width: 34, height: 20, borderRadius: 999, border: 'none', position: 'relative', flexShrink: 0, marginTop: 1,
          background: on ? 'var(--ink)' : 'var(--border)', cursor: readOnly ? 'default' : 'pointer', padding: 0,
        }}
      >
        <span style={{ position: 'absolute', top: 2, left: on ? 16 : 2, width: 16, height: 16, borderRadius: '50%', background: '#fff' }} />
      </button>
      <div>
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>{field.label}</div>
        <div style={{ fontSize: 12.5, color: 'var(--gray)', lineHeight: 1.45, marginTop: 2 }}>{field.hint}</div>
      </div>
    </div>
  );
}
