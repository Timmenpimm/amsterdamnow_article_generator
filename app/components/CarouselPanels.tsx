'use client';

import Link from 'next/link';
import type { Article } from '@/lib/types';
import { articlePhase } from '@/lib/types';
import { CAROUSEL_TEMPLATES, type CarouselStatus, type CarouselTemplate, type GenerateProgress } from '@/lib/carousel-mock';

function fmtTime(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
}

export function SubContext({ article, status, savedAt }: { article: Article; status: CarouselStatus; savedAt: string | null }) {
  const phase = articlePhase(article);
  const statusText =
    status === 'published' ? `gepubliceerd op instagram${savedAt ? ` · ${fmtTime(savedAt)}` : ''}`
    : status === 'ready' ? 'klaargezet · wacht op plaatsing'
    : status === 'concept' ? `concept · laatst bewaard ${fmtTime(savedAt) || 'zonet'}`
    : 'nog niet gegenereerd';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 20px', borderBottom: '1px solid var(--border-light)', background: '#fff' }}>
      <Link href="/carousel" style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--gray)' }}>← Carousel</Link>
      <span style={{ width: 1, height: 18, background: 'var(--border-light)' }} />
      <span style={{ fontSize: 13.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 420 }}>{article.title}</span>
      <span className={phase === 'published' ? 'chip-green' : 'chip-amber'}>
        {phase === 'published' ? 'artikel gepubliceerd' : 'artikel klaar v. publicatie'}
      </span>
      <span style={{ marginLeft: 'auto', fontSize: 12.5, color: 'var(--muted)' }}>{statusText}</span>
    </div>
  );
}

export function TemplateStrip({
  template, setTemplate, slideCount, generatedAt, onRegenerateAll,
}: {
  template: CarouselTemplate;
  setTemplate: (t: CarouselTemplate) => void;
  slideCount: number;
  generatedAt: string | null;
  onRegenerateAll: () => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 20px', borderBottom: '1px solid var(--border-light)', background: 'var(--sidebar)' }}>
      <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--gray)' }}>Template</span>
      {CAROUSEL_TEMPLATES.map(t => (
        <button
          key={t.key}
          onClick={() => setTemplate(t.key)}
          style={{
            fontSize: 13, fontWeight: template === t.key ? 700 : 600, padding: '7px 14px', borderRadius: 999,
            background: template === t.key ? 'var(--ink)' : '#fff',
            color: template === t.key ? '#fff' : 'var(--gray)',
            border: template === t.key ? 'none' : '1px solid var(--border)',
          }}
        >
          {t.label}
        </button>
      ))}
      <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--gray)' }}>
        {slideCount} slides{generatedAt ? ` · gemaakt door Claude om ${fmtTime(generatedAt)}` : ''}
      </span>
      <button className="btn-small" onClick={onRegenerateAll}>↻ Genereer opnieuw</button>
    </div>
  );
}

export function BottomBar({
  status, onReady, onPublish,
}: {
  status: CarouselStatus;
  onReady: () => void;
  onPublish: () => void;
}) {
  if (status === 'published') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px', borderTop: '1px solid var(--border-light)', background: '#fff' }}>
        <span className="dot" style={{ background: 'var(--green)' }} />
        <span style={{ fontSize: 12.5, color: 'var(--gray)' }}>Gepubliceerd op Instagram — @amsterdamnow</span>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px', borderTop: '1px solid var(--border-light)', background: '#fff' }}>
      <span className="dot" style={{ background: status === 'ready' ? 'var(--amber)' : 'var(--amber)' }} />
      <span style={{ fontSize: 12.5, color: 'var(--gray)' }}>
        {status === 'ready' ? 'Klaargezet — wacht op handmatige plaatsing' : 'Concept — nog niet klaargezet'}
      </span>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
        {status !== 'ready' && <button className="btn" onClick={onReady}>Klaarzetten</button>}
        <button className="btn-primary" onClick={onPublish}>Publiceren op Instagram →</button>
      </div>
    </div>
  );
}

export function PreGeneratePanel({
  template, setTemplate, onGenerate,
}: {
  template: CarouselTemplate | null;
  setTemplate: (t: CarouselTemplate) => void;
  onGenerate: () => void;
}) {
  return (
    <div style={{ padding: '48px 32px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, textAlign: 'center' }}>
      <span style={{ fontSize: 16, fontWeight: 800 }}>Kies een template om te beginnen</span>
      <span style={{ fontSize: 13, color: 'var(--gray)', maxWidth: 420, lineHeight: 1.55 }}>
        Claude schrijft 5 slides uit dit artikel — titel, intro, beelden zijn al bekend. Kies eerst een template.
      </span>
      <div style={{ display: 'flex', gap: 8 }}>
        {CAROUSEL_TEMPLATES.map(t => (
          <button
            key={t.key}
            onClick={() => setTemplate(t.key)}
            style={{
              fontSize: 13, fontWeight: template === t.key ? 700 : 600, padding: '9px 16px', borderRadius: 999,
              background: template === t.key ? 'var(--ink)' : '#fff',
              color: template === t.key ? '#fff' : 'var(--gray)',
              border: template === t.key ? 'none' : '1px solid var(--border)',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <button className="btn-primary" disabled={!template} onClick={onGenerate} style={{ marginTop: 6 }}>
        Genereer carousel
      </button>
    </div>
  );
}

export function LoadingPanel({ progress, onCancel }: { progress: GenerateProgress; onCancel: () => void }) {
  return (
    <div style={{ background: 'var(--sidebar)', padding: '44px 40px 48px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20 }}>
      <span style={{ width: 46, height: 46, borderRadius: '50%', border: '4px solid var(--border-light)', borderTopColor: 'var(--ink)' }} className="spin" />
      <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 5 }}>
        <span style={{ fontSize: 17, fontWeight: 800 }}>{progress.headline}</span>
        <span style={{ fontSize: 13, color: 'var(--gray)' }}>{progress.detail}</span>
      </div>
      {progress.steps.length > 0 && (
        <div style={{ width: '100%', maxWidth: 420, background: '#fff', border: '1px solid var(--border-light)', borderRadius: 10, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {progress.steps.map(step => (
            <div key={step.label} style={{ display: 'flex', alignItems: 'center', gap: 10, opacity: step.state === 'pending' ? 0.5 : 1 }}>
              {step.state === 'done' && (
                <span style={{ width: 18, height: 18, borderRadius: '50%', background: 'var(--green-bg)', color: 'var(--green-dark)', display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 800 }}>✓</span>
              )}
              {step.state === 'active' && (
                <span style={{ width: 18, height: 18, borderRadius: '50%', border: '3px solid var(--border-light)', borderTopColor: 'var(--ink)' }} className="spin" />
              )}
              {step.state === 'pending' && <span style={{ width: 18, height: 18, borderRadius: '50%', border: '2px solid var(--faint)' }} />}
              <span style={{ fontSize: 13, fontWeight: step.state === 'active' ? 700 : 600 }}>{step.label}</span>
              {step.detail && <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--gray)', fontWeight: 600 }}>{step.detail}</span>}
            </div>
          ))}
          <div style={{ height: 4, background: 'var(--border-light)', borderRadius: 2, overflow: 'hidden', marginTop: 2 }}>
            <div className="progress-pulse" style={{ width: `${progress.pct}%`, height: '100%', background: 'var(--ink)', borderRadius: 2 }} />
          </div>
        </div>
      )}
      <span style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', lineHeight: 1.5, maxWidth: 400 }}>
        Duurt ±20 sec. Renderen gebeurt in de socials-service — de tool wacht en toont het resultaat zodra het klaar is.
      </span>
      <button className="btn" onClick={onCancel}>Annuleren</button>
    </div>
  );
}

export function GenerateErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div style={{ background: 'var(--sidebar)', padding: '40px 40px 48px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, textAlign: 'center' }}>
      <span style={{ width: 56, height: 56, borderRadius: '50%', background: 'var(--red-bg)', display: 'grid', placeItems: 'center', fontSize: 26, color: 'var(--red)', fontWeight: 800 }}>!</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 16, fontWeight: 800 }}>Genereren mislukt</span>
        <span style={{ fontSize: 13.5, color: 'var(--gray)', lineHeight: 1.6, maxWidth: 400 }}>
          {message} Je concept en eerdere slides zijn bewaard, er is niets verloren.
        </span>
      </div>
      <div style={{ background: '#fff', border: '1px solid var(--red-border)', borderRadius: 8, padding: '10px 14px', fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--red-dark)' }}>
        socials-service · 504 gateway time-out · {fmtTime(new Date().toISOString())}
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
        <button className="btn-primary" onClick={onRetry}>Opnieuw proberen</button>
        <Link href="/carousel" className="btn">Terug naar overzicht</Link>
      </div>
    </div>
  );
}

export function LoadErrorPanel({ message }: { message: string }) {
  return (
    <div style={{ padding: 40, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span style={{ fontWeight: 800, color: 'var(--red-dark)' }}>Kan artikel niet laden</span>
      <span style={{ fontSize: 13, color: 'var(--gray)' }}>{message}</span>
      <Link href="/carousel" className="btn" style={{ alignSelf: 'flex-start', marginTop: 8 }}>← Terug naar carousel-overzicht</Link>
    </div>
  );
}

export function PublishModal({
  slideCount, publishing, onCancel, onConfirm,
}: {
  slideCount: number;
  publishing: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        style={{ width: 'min(440px, 94vw)', background: '#fff', borderRadius: 14, boxShadow: '0 24px 60px rgba(20,20,18,0.34)', overflow: 'hidden' }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ padding: '22px 24px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <span style={{ fontSize: 18, fontWeight: 800 }}>Publiceren op Instagram?</span>
          <span style={{ fontSize: 13.5, lineHeight: 1.55, color: 'var(--text-soft)' }}>
            De carousel van <strong>{slideCount} slides</strong> en het onderschrift worden nu geplaatst op <strong>@amsterdamnow</strong>. Plaatsen kan niet ongedaan gemaakt worden.
          </span>
          <div style={{ background: 'var(--amber-bg)', border: '1px solid var(--amber-border)', borderRadius: 8, padding: '10px 12px', fontSize: 12.5, lineHeight: 1.5, color: 'var(--amber-dark)' }}>
            <span style={{ fontWeight: 800 }}>Controleer eerst:</span> na plaatsing zijn onderschrift en hashtags alleen nog in de Instagram-app te wijzigen.
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 24px', borderTop: '1px solid var(--border-light)', background: 'var(--panel)' }}>
          <button className="btn" style={{ marginLeft: 'auto' }} disabled={publishing} onClick={onCancel}>Annuleren</button>
          <button className="btn-green" style={{ width: 'auto', padding: '9px 18px' }} disabled={publishing} onClick={onConfirm}>
            {publishing ? 'Bezig…' : 'Ja, publiceren'}
          </button>
        </div>
      </div>
    </div>
  );
}
