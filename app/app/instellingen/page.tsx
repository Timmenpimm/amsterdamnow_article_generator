'use client';

import { useState } from 'react';
import TopBar from '@/components/TopBar';
import type { ConstraintKind, PromptKind } from '@/lib/types';
import { CONSTRAINT_KINDS } from '@/lib/types';
import PromptEditor from './PromptEditor';
import CriteriaEditor from './CriteriaEditor';
import AutoPublishPanel from './AutoPublishPanel';

type Section = PromptKind | ConstraintKind | 'publiceren';

const TAB_GROUPS: { label: string; tabs: { key: Section; label: string }[] }[] = [
  {
    label: 'Standaard',
    tabs: [
      { key: 'research', label: 'Research' },
      { key: 'schrijf', label: 'Schrijven' },
      { key: 'seo', label: 'SEO' },
    ],
  },
  {
    label: 'Lijstartikelen',
    tabs: [
      { key: 'lijst-selectie', label: 'Selectie' },
      { key: 'lijst-research', label: 'Verificatie' },
      { key: 'lijst-schrijf', label: 'Schrijven' },
      { key: 'lijst-seo', label: 'SEO' },
    ],
  },
  {
    label: 'Criteria',
    tabs: [
      { key: 'standaard', label: 'Standaard artikel' },
      { key: 'lijst', label: 'Lijstartikel' },
    ],
  },
  {
    label: 'Publiceren',
    tabs: [
      { key: 'publiceren', label: 'Automatisch publiceren' },
    ],
  },
];

function isConstraintKind(kind: Section): kind is ConstraintKind {
  return (CONSTRAINT_KINDS as string[]).includes(kind);
}

export default function Instellingen() {
  const [kind, setKind] = useState<Section>('research');

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <TopBar />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', padding: '20px 24px 0', background: 'var(--card)' }}>
          {TAB_GROUPS.map(group => (
            <div key={group.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--muted)', marginRight: 2 }}>
                {group.label}
              </span>
              {group.tabs.map(tab => (
                <button
                  key={tab.key}
                  onClick={() => setKind(tab.key)}
                  style={{
                    fontSize: 13, fontWeight: kind === tab.key ? 700 : 600, padding: '7px 14px', borderRadius: 999,
                    background: kind === tab.key ? 'var(--ink)' : 'transparent',
                    color: kind === tab.key ? '#fff' : 'var(--gray)',
                    border: kind === tab.key ? 'none' : '1px solid var(--border)',
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          ))}
        </div>
        {kind === 'publiceren' ? (
          <AutoPublishPanel />
        ) : isConstraintKind(kind) ? (
          <CriteriaEditor kind={kind} />
        ) : (
          <PromptEditor kind={kind} />
        )}
      </div>
    </div>
  );
}
