'use client';

import { useEffect, useMemo, useState } from 'react';
import TopBar from '@/components/TopBar';
import type { ConstraintKind, ConstraintVersion, PromptKind, PromptVersion } from '@/lib/types';
import { CONSTRAINT_KINDS, PROMPT_KINDS } from '@/lib/types';
import PromptEditor from './PromptEditor';
import CriteriaEditor from './CriteriaEditor';
import AutoPublishPanel from './AutoPublishPanel';
import PlaceholderPanel from './PlaceholderPanel';
import { RAIL_GROUPS, panelMeta, PLACEHOLDER_CARD, type RailKey } from './meta';

type Badge = { label: string; tone: 'muted' | 'green' };

function isConstraintKind(kind: RailKey): kind is ConstraintKind {
  return (CONSTRAINT_KINDS as string[]).includes(kind);
}
function isPromptKind(kind: RailKey): kind is PromptKind {
  return (PROMPT_KINDS as string[]).includes(kind);
}

// Diacritics-agnostische, case-insensitieve normalisatie voor het zoekveld.
function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function RailButton({
  label,
  badge,
  selected,
  onClick,
}: {
  label: string;
  badge?: Badge;
  selected: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  const badgeColor = selected ? '#b6b4ad' : badge?.tone === 'green' ? 'var(--green-dark)' : 'var(--muted)';
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', width: '100%', textAlign: 'left',
        fontSize: 13, fontWeight: selected ? 700 : 500,
        color: selected ? '#fff' : 'var(--text-soft)',
        background: selected ? 'var(--ink)' : hover ? '#eceae5' : 'transparent',
        padding: '8px 10px', borderRadius: 8, border: 'none',
      }}
    >
      {label}
      {badge?.label ? (
        <span style={{ marginLeft: 'auto', paddingLeft: 8, fontSize: 11.5, fontWeight: badge.tone === 'green' ? 700 : 600, color: badgeColor }}>
          {badge.label}
        </span>
      ) : null}
    </button>
  );
}

export default function Instellingen() {
  const [selected, setSelected] = useState<RailKey>('schrijf');
  const [query, setQuery] = useState('');
  const [badges, setBadges] = useState<Partial<Record<RailKey, Badge>>>({});
  const [tick, setTick] = useState(0);

  // Versiebadges + publiceren-status ophalen (en verversen na een wijziging).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [promptResults, constraintResults, publish] = await Promise.all([
        Promise.all(
          PROMPT_KINDS.map(k =>
            fetch(`/api/prompts?kind=${k}`).then(r => r.json()).then(d => [k, d] as const).catch(() => [k, null] as const)
          )
        ),
        Promise.all(
          CONSTRAINT_KINDS.map(k =>
            fetch(`/api/constraints?kind=${k}`).then(r => r.json()).then(d => [k, d] as const).catch(() => [k, null] as const)
          )
        ),
        fetch('/api/publish/settings').then(r => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      if (cancelled) return;
      const next: Partial<Record<RailKey, Badge>> = {};
      for (const [k, d] of promptResults) {
        const act = (d?.versions as PromptVersion[] | undefined)?.find(v => v.active === 1);
        next[k] = { label: act ? `v${act.version}` : '', tone: 'muted' };
      }
      for (const [k, d] of constraintResults) {
        const act = (d?.versions as ConstraintVersion[] | undefined)?.find(v => v.active === 1);
        next[k] = { label: act ? `v${act.version}` : '', tone: 'muted' };
      }
      next.publiceren = publish?.enabled ? { label: 'automatisch', tone: 'green' } : { label: 'uit', tone: 'muted' };
      next.variabelen = { label: 'context', tone: 'muted' };
      next.model = { label: 'Claude', tone: 'muted' };
      setBadges(next);
    })();
    return () => { cancelled = true; };
  }, [tick]);

  const onChanged = () => setTick(t => t + 1);

  const q = norm(query.trim());
  const filteredGroups = useMemo(
    () =>
      RAIL_GROUPS.map(group => ({
        ...group,
        items: q ? group.items.filter(it => norm(it.label).includes(q)) : group.items,
      })).filter(group => group.items.length > 0),
    [q]
  );

  const meta = panelMeta(selected);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <TopBar />
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* RAIL */}
        <div
          style={{
            width: 262, flexShrink: 0, borderRight: '1px solid var(--border-light)', background: 'var(--sidebar)',
            padding: '18px 14px 22px', display: 'flex', flexDirection: 'column', gap: 4, overflowY: 'auto',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, padding: '7px 10px', marginBottom: 6 }}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
              <circle cx="7" cy="7" r="4.6" stroke="var(--muted)" strokeWidth="1.5" />
              <path d="M10.5 10.5 L14 14" stroke="var(--muted)" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Zoek een instelling"
              style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', fontSize: 12.5, color: 'var(--ink)' }}
            />
          </div>

          {filteredGroups.map(group => (
            <div key={group.label} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted)', padding: '12px 10px 5px' }}>
                {group.label}
              </div>
              {group.items.map(item => (
                <RailButton
                  key={item.key}
                  label={item.label}
                  badge={badges[item.key]}
                  selected={selected === item.key}
                  onClick={() => setSelected(item.key)}
                />
              ))}
            </div>
          ))}
          {filteredGroups.length === 0 && (
            <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '12px 10px' }}>Geen instelling gevonden.</div>
          )}
        </div>

        {/* PANEEL (+ conditionele versielade zit in de editor-componenten) */}
        {selected === 'publiceren' ? (
          <AutoPublishPanel key="publiceren" eyebrow={meta.eyebrow} title={meta.title} description={meta.description} onChanged={onChanged} />
        ) : selected === 'variabelen' || selected === 'model' ? (
          <PlaceholderPanel
            key={selected}
            eyebrow={meta.eyebrow}
            title={meta.title}
            description={meta.description}
            cardText={PLACEHOLDER_CARD[selected]}
          />
        ) : isConstraintKind(selected) ? (
          <CriteriaEditor key={selected} kind={selected} eyebrow={meta.eyebrow} title={meta.title} description={meta.description} onChanged={onChanged} />
        ) : isPromptKind(selected) ? (
          <PromptEditor
            key={selected}
            kind={selected}
            eyebrow={meta.eyebrow}
            title={meta.title}
            description={meta.description}
            onNavigate={setSelected}
            onChanged={onChanged}
          />
        ) : null}
      </div>
    </div>
  );
}
