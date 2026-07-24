'use client';

import type { ReactNode } from 'react';

// Gedeelde paneel-header (eyebrow / titel / omschrijving + optionele rechterkant).
// `divider` = border-bottom onder de header (prompt/publiceren: aan;
// criteria: uit, want de anker-pillrij eronder draagt de scheiding).
export default function PanelHeader({
  eyebrow,
  title,
  description,
  right,
  divider = true,
}: {
  eyebrow: string;
  title: string;
  description: string;
  right?: ReactNode;
  divider?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 20,
        padding: divider ? '22px 28px 18px' : '22px 28px 16px',
        borderBottom: divider ? '1px solid var(--border-light)' : undefined,
      }}
    >
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
        <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--muted)' }}>
          {eyebrow}
        </div>
        <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: '-0.015em' }}>{title}</div>
        <div style={{ fontSize: 13, color: 'var(--gray)', lineHeight: 1.5, maxWidth: 520 }}>{description}</div>
      </div>
      {right && (
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {right}
        </div>
      )}
    </div>
  );
}
