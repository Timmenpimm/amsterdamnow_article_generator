'use client';

import PanelHeader from './PanelHeader';

// Placeholder-paneel voor nog-niet-gebouwde schermen (variabelen, model):
// header-chrome + een gecentreerde "Binnenkort"-kaart. Geen footer, geen
// versies-knop, geen lade.
export default function PlaceholderPanel({
  eyebrow,
  title,
  description,
  cardText,
}: {
  eyebrow: string;
  title: string;
  description: string;
  cardText: string;
}) {
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--card)' }}>
      <PanelHeader eyebrow={eyebrow} title={title} description={description} />
      <div style={{ flex: 1, minHeight: 0, display: 'grid', placeItems: 'center', padding: '32px 28px' }}>
        <div className="card" style={{ maxWidth: 420, padding: '22px 24px', display: 'flex', flexDirection: 'column', gap: 8, textAlign: 'center' }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>
            Binnenkort
          </div>
          <div style={{ fontSize: 13, color: 'var(--gray)', lineHeight: 1.6 }}>{cardText}</div>
        </div>
      </div>
    </div>
  );
}
