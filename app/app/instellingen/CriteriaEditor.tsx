'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '@/components/toast';
import type { ConstraintKind, ConstraintVersion } from '@/lib/types';
import { STANDAARD_FIELDS, LIST_FIELDS, type FieldDef } from './criteria-fields';
import PanelHeader from './PanelHeader';
import VersionDrawer from './VersionDrawer';

const FIELD_GROUPS: Record<ConstraintKind, { section: string; fields: FieldDef<any>[] }[]> = {
  standaard: STANDAARD_FIELDS,
  lijst: LIST_FIELDS,
};

function parse(content: string): Record<string, any> {
  return JSON.parse(content);
}

export default function CriteriaEditor({
  kind,
  eyebrow,
  title,
  description,
  onChanged,
}: {
  kind: ConstraintKind;
  eyebrow: string;
  title: string;
  description: string;
  onChanged: () => void;
}) {
  const groups = FIELD_GROUPS[kind];
  const [versions, setVersions] = useState<ConstraintVersion[]>([]);
  const [draft, setDraft] = useState<Record<string, any> | null>(null);
  const [viewing, setViewing] = useState<ConstraintVersion | null>(null);
  const [busy, setBusy] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeSection, setActiveSection] = useState(groups[0].section);

  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const active = versions.find(v => v.active === 1);
  const activeContent = active ? parse(active.content) : null;
  const changedCount = draft && activeContent
    ? Object.keys(draft).filter(k => JSON.stringify(draft[k]) !== JSON.stringify(activeContent[k])).length
    : 0;
  const dirty = Boolean(!viewing && active && draft && changedCount > 0);

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

  function scrollToSection(section: string) {
    setActiveSection(section);
    sectionRefs.current[section]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
      await load(kind);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function rollback(v: ConstraintVersion) {
    if (!confirm(`v${v.version} terugzetten als actieve versie?`)) return;
    await fetch(`/api/constraints/${v.id}/activate`, { method: 'POST' });
    toast(`v${v.version} is nu actief`);
    await load(kind);
    onChanged();
  }

  const changeLabel = `${changedCount} wijziging${changedCount === 1 ? '' : 'en'}`;

  const headerRight = (
    <>
      {dirty ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: 'var(--amber-dark)', background: 'var(--amber-bg)', padding: '5px 10px', borderRadius: 999 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--amber)' }} />
          {changeLabel}
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

  const shown = viewing ? parse(viewing.content) : draft;

  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--card)' }}>
        <PanelHeader eyebrow={eyebrow} title={title} description={description} right={headerRight} divider={false} />

        {/* Anker-pills — smooth-scroll naar de secties binnen de body-scrollcontainer */}
        <div style={{ display: 'flex', gap: 6, padding: '0 28px 16px', borderBottom: '1px solid var(--border-light)', flexWrap: 'wrap' }}>
          {groups.map(group => {
            const on = activeSection === group.section;
            return (
              <button
                key={group.section}
                onClick={() => scrollToSection(group.section)}
                style={{
                  fontSize: 12.5, fontWeight: on ? 700 : 500, padding: '6px 12px', borderRadius: 999, border: 'none',
                  background: on ? 'var(--soft)' : 'transparent', color: on ? 'var(--ink)' : 'var(--gray)',
                }}
              >
                {group.section}
              </button>
            );
          })}
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '20px 28px 24px', display: 'flex', flexDirection: 'column', gap: 22 }}>
          {viewing && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--soft)', border: '1px solid var(--border-light)', borderRadius: 8, padding: '9px 14px', fontSize: 12.5 }}>
              <span>Je bekijkt <b>v{viewing.version}</b> (alleen-lezen).</span>
              <button className="btn-small" style={{ marginLeft: 'auto' }} onClick={() => setViewing(null)}>Terug naar actieve versie</button>
              <button className="btn-primary" style={{ fontSize: 12.5, padding: '7px 14px' }} onClick={() => rollback(viewing)}>Terugzetten als actief</button>
            </div>
          )}

          {shown && groups.map((group, i) => (
            <div
              key={group.section}
              ref={el => { sectionRefs.current[group.section] = el; }}
              style={{
                display: 'flex', flexDirection: 'column', gap: 8,
                borderTop: i === 0 ? undefined : '1px solid var(--border-light)',
                paddingTop: i === 0 ? 0 : 18,
              }}
            >
              <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--gray)', paddingBottom: 6 }}>
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
        </div>

        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 12, borderTop: '1px solid var(--border-light)',
            background: dirty ? 'var(--amber-col)' : 'var(--panel)', padding: '13px 28px',
          }}
        >
          {dirty ? (
            <>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 700, color: 'var(--amber-dark)' }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--amber)' }} />
                {changedCount} niet-opgeslagen wijziging{changedCount === 1 ? '' : 'en'}
              </span>
              <span style={{ fontSize: 12.5, color: 'var(--amber-dark)', minWidth: 0 }}>Geldt vanaf de volgende n8n-run.</span>
            </>
          ) : (
            <span style={{ fontSize: 12.5, color: 'var(--gray)' }}>
              {active
                ? `Opgeslagen · ${new Date(active.created_at.replace(' ', 'T')).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })} door ${active.author}`
                : 'Nog geen versie'}
            </span>
          )}
          <button className="btn" style={{ marginLeft: 'auto' }} disabled={!dirty} onClick={() => setDraft(activeContent)}>
            Verwerpen
          </button>
          <button className="btn-primary" disabled={!dirty || busy} onClick={save}>
            {dirty ? `Opslaan als v${(active?.version || 0) + 1}` : 'Geen wijzigingen'}
          </button>
        </div>
      </div>

      {drawerOpen && (
        <VersionDrawer
          subtitle={`Criteria · ${kind === 'lijst' ? 'lijstartikel' : 'standaardartikel'}`}
          versions={versions}
          warning="deze criteria gelden voor élk volgend artikel. Check na een wijziging het eerstvolgende draft-artikel extra goed."
          onClose={() => setDrawerOpen(false)}
          onView={v => setViewing(v as ConstraintVersion)}
          onRollback={v => rollback(v as ConstraintVersion)}
        />
      )}
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
