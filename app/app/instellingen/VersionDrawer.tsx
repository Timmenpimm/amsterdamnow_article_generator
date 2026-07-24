'use client';

// Minimale vorm die zowel PromptVersion als ConstraintVersion dekt.
export interface VersionLike {
  id: number;
  version: number;
  note: string;
  author: string;
  created_at: string;
  active: 0 | 1;
}

function fmtDate(created_at: string): string {
  return new Date(created_at.replace(' ', 'T')).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
}

// Versiegeschiedenis als derde kolom (320px, border-left). Verschijnt alleen
// wanneer de gebruiker via "Versies" de lade opent; ✕ sluit. Actieve versie met
// ink-border + groen "actief"; overige met acties Bekijk / Terugzetten. Onderaan
// de amber "Let op"-waarschuwing.
export default function VersionDrawer({
  subtitle,
  versions,
  warning,
  onClose,
  onView,
  onRollback,
}: {
  subtitle: string;
  versions: VersionLike[];
  warning: string;
  onClose: () => void;
  onView: (v: VersionLike) => void;
  onRollback: (v: VersionLike) => void;
}) {
  return (
    <div
      style={{
        width: 320, flexShrink: 0, background: 'var(--card)', borderLeft: '1px solid var(--border)',
        padding: 20, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto',
      }}
      className="desktop-only-flex"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 13.5, fontWeight: 800 }}>Versiegeschiedenis</span>
        <button
          onClick={onClose}
          aria-label="Versiegeschiedenis sluiten"
          style={{ marginLeft: 'auto', background: 'none', border: 'none', fontSize: 15, color: 'var(--muted)', padding: 0, lineHeight: 1 }}
        >
          ✕
        </button>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--gray)', lineHeight: 1.45 }}>{subtitle}</div>

      {versions.map(v => (
        <div
          key={v.id}
          style={{
            background: v.active ? 'var(--panel)' : 'var(--card)', borderRadius: 8, padding: '12px 14px',
            border: v.active ? '1.5px solid var(--ink)' : '1px solid var(--border-light)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 800 }}>v{v.version}</span>
            {v.active === 1 && <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--green-dark)' }}>actief</span>}
            <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--muted)' }}>
              {fmtDate(v.created_at)} · {v.author}
            </span>
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--text-soft)', marginTop: 5, lineHeight: 1.45 }}>
            {v.note || 'Geen omschrijving'}
          </div>
          {v.active !== 1 && (
            <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 12, fontWeight: 600 }}>
              <button onClick={() => onView(v)} style={{ background: 'none', border: 'none', padding: 0, fontWeight: 600, fontSize: 12, textDecoration: 'underline', color: 'var(--ink)' }}>
                Bekijk
              </button>
              <button onClick={() => onRollback(v)} style={{ background: 'none', border: 'none', padding: 0, fontWeight: 600, fontSize: 12, textDecoration: 'underline', color: 'var(--ink)' }}>
                Terugzetten
              </button>
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
        <span style={{ fontWeight: 800 }}>Let op:</span> {warning}
      </div>
    </div>
  );
}
