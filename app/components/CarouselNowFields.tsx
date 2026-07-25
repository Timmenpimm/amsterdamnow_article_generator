'use client';

import type { CSSProperties } from 'react';
import { findNowStep, type NowCarouselSlide, type NowFamilySpec, type NowPlaceholderSpec } from '@/lib/carousel';

// ---------------------------------------------------------------------------
// Velden-editor voor één slide van een Amsterdam NOW-carousel.
//
// Een NOW-slide heeft geen kop/body maar tokens: per slidetype levert de engine
// (via NowFamilySpec → NowStepSpec.placeholders) de lijst met velden, inclusief
// beschrijving, enum-waarden, url-vlag en zero-padding. Dit component rendert
// per placeholder het passende veld en schrijft terug via dezelfde
// onChange-callback als de satori-editor — de parent bewaart met de bestaande
// PATCH-autosave, hier dus géén eigen save-call.
// ---------------------------------------------------------------------------

// Tokens met een zin/tekst/tekenlimiet in de beschrijving (of met toegestane
// regelafbrekingen) krijgen een textarea in plaats van een enkele regel.
const MULTILINE_HINT =
  /(zin|zinnen|volzin|tekens|karakters|characters|sentence|body|alinea|paragraph|beschrijving|omschrijving|samenvatting|intro)/i;

function isMultiline(p: NowPlaceholderSpec): boolean {
  return p.allowsLineBreak || MULTILINE_HINT.test(p.description || '');
}

// "max. 90 tekens" → 90, zodat we een teller kunnen tonen.
function charLimit(description: string): number | null {
  const m = /(\d{2,4})\s*(tekens|karakters|characters)/i.exec(description || '');
  return m ? Number(m[1]) : null;
}

function fieldLabel(name: string): string {
  return name.replace(/[-_]/g, ' ').replace(/^\w/, c => c.toUpperCase());
}

const inputStyle: CSSProperties = {
  border: '1px solid var(--border)', borderRadius: 8, padding: '9px 12px', background: '#fff',
  fontSize: 13, lineHeight: 1.45, fontFamily: 'inherit', width: '100%',
};

function Helper({ text }: { text: string }) {
  if (!text) return null;
  return <span style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.45 }}>{text}</span>;
}

function Field({
  placeholder, value, onChange,
}: {
  placeholder: NowPlaceholderSpec;
  value: string;
  onChange: (v: string) => void;
}) {
  const limit = charLimit(placeholder.description);
  const padded = placeholder.zeroPadTo != null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--gray)' }}>{fieldLabel(placeholder.name)}</span>
        {limit != null && (
          <span style={{ marginLeft: 'auto', fontSize: 11, color: value.length > limit ? 'var(--red-dark)' : 'var(--muted)' }}>
            {value.length} / {limit} tekens
          </span>
        )}
      </div>

      {placeholder.enumValues && placeholder.enumValues.length > 0 ? (
        // Segmented control: vaste keuzelijst uit het manifest.
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, border: '1px solid var(--border)', borderRadius: 8, padding: 3, background: 'var(--panel)' }}>
          {placeholder.enumValues.map(option => {
            const active = value === option;
            return (
              <button
                key={option}
                type="button"
                onClick={() => onChange(option)}
                style={{
                  flex: '1 1 auto', fontSize: 12, fontWeight: 700, padding: '6px 10px', borderRadius: 6,
                  border: 'none', cursor: 'pointer',
                  background: active ? 'var(--ink)' : 'transparent',
                  color: active ? '#fff' : 'var(--gray)',
                }}
              >
                {option}
              </button>
            );
          })}
        </div>
      ) : padded ? (
        // Zero-padding doet de engine; hier alleen tonen.
        <input
          value={value}
          readOnly
          style={{ ...inputStyle, background: 'var(--panel)', color: 'var(--gray)' }}
        />
      ) : placeholder.isUrl ? (
        <input
          type="url"
          inputMode="url"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="https://"
          style={{ ...inputStyle, fontFamily: 'var(--mono)', fontSize: 12 }}
        />
      ) : isMultiline(placeholder) ? (
        <textarea
          value={value}
          onChange={e => onChange(e.target.value)}
          rows={3}
          style={{ ...inputStyle, resize: 'vertical' }}
        />
      ) : (
        <input value={value} onChange={e => onChange(e.target.value)} style={inputStyle} />
      )}

      <Helper
        text={
          padded
            ? `${placeholder.description} — de engine vult dit automatisch aan tot ${placeholder.zeroPadTo} cijfers.`
            : placeholder.description
        }
      />
    </div>
  );
}

export default function CarouselNowFields({
  slide, spec, onChangeValues,
}: {
  slide: NowCarouselSlide;
  spec: NowFamilySpec;
  onChangeValues: (values: Record<string, string>) => void;
}) {
  const step = findNowStep(spec, slide.slideType);
  const values = slide.values || {};

  if (!step) {
    return (
      <div style={{ fontSize: 12.5, color: 'var(--red-dark)', background: 'var(--red-bg)', border: '1px solid var(--red-border)', borderRadius: 8, padding: '10px 12px', lineHeight: 1.5 }}>
        Onbekend slidetype “{slide.slideType}” voor template {spec.label} — dit ontwerp kent dit slidetype niet (meer).
      </div>
    );
  }
  if (step.placeholders.length === 0) {
    return <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>Deze slide heeft geen invulbare velden.</span>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {step.placeholders.map(p => (
        <Field
          key={p.name}
          placeholder={p}
          value={values[p.name] ?? ''}
          onChange={v => onChangeValues({ ...values, [p.name]: v })}
        />
      ))}
    </div>
  );
}
