'use client';

import Link from 'next/link';
import type { Article } from '@/lib/types';
import { articlePhase } from '@/lib/types';
import {
  isNowTemplate, MAX_IG_SLIDES,
  type CarouselStatus, type CarouselTemplate, type GenerateProgress, type NowFamilySpec,
} from '@/lib/carousel';

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

// --- Template-pillen -------------------------------------------------------
// Eén visuele taal voor beide plekken waar je een template kiest (de strip
// boven de editor en het pre-generate-paneel). De Amsterdam NOW-families komen
// uit het engine-manifest en staan altijd vóór de generieke satori-templates.

function TemplatePill({
  label, active, onClick, size = 'sm',
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  size?: 'sm' | 'md';
}) {
  return (
    <button
      onClick={onClick}
      style={{
        fontSize: 13, fontWeight: active ? 700 : 600,
        padding: size === 'md' ? '9px 16px' : '7px 14px', borderRadius: 999,
        background: active ? 'var(--ink)' : '#fff',
        color: active ? '#fff' : 'var(--gray)',
        border: active ? 'none' : '1px solid var(--border)',
      }}
    >
      {label}
    </button>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--muted)' }}>
      {children}
    </span>
  );
}

// Grijze placeholder-pillen terwijl het manifest nog laadt.
function PillSkeleton({ width }: { width: number }) {
  return <span style={{ width, height: 32, borderRadius: 999, background: 'var(--border-light)', display: 'inline-block' }} />;
}

export function TemplateStrip({
  template, setTemplate, families, slideCount, generatedAt, onRegenerateAll,
}: {
  template: CarouselTemplate;
  setTemplate: (t: CarouselTemplate) => void;
  families: NowFamilySpec[];
  slideCount: number;
  generatedAt: string | null;
  onRegenerateAll: () => void;
}) {
  const archivedInUse = !isNowTemplate(template);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 20px', borderBottom: '1px solid var(--border-light)', background: 'var(--sidebar)', flexWrap: 'wrap' }}>
      <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--gray)' }}>Template</span>
      {families.map(f => (
        <TemplatePill key={f.templateId} label={f.label} active={template === f.templateId} onClick={() => setTemplate(f.templateId)} />
      ))}
      {/* De generieke templates zijn gearchiveerd: je kiest ze niet meer voor
          nieuw werk. Een carousel die er al op staat toont hem nog wel, zodat
          je ziet waarmee hij gemaakt is en hem opnieuw kunt genereren. */}
      {archivedInUse && (
        <>
          <span style={{ width: 1, height: 20, background: 'var(--border-light)' }} />
          <TemplatePill label={`${template} (gearchiveerd)`} active onClick={() => {}} />
        </>
      )}
      {/* Teller tegen de Instagram-limiet; boven de 10 kleurt hij rood en
          verschijnt eronder de amber-banner (in CarouselGenerator). */}
      <span style={{ marginLeft: 'auto', fontSize: 12, color: slideCount > MAX_IG_SLIDES ? 'var(--red-dark)' : 'var(--gray)', fontWeight: slideCount > MAX_IG_SLIDES ? 700 : 400 }}>
        {slideCount}/{MAX_IG_SLIDES} slides{generatedAt ? ` · gemaakt door Claude om ${fmtTime(generatedAt)}` : ''}
      </span>
      <button className="btn-small" onClick={onRegenerateAll}>↻ Genereer opnieuw</button>
    </div>
  );
}

export function BottomBar({
  status, tooManySlides, onReady, onPublish, onDelete,
}: {
  status: CarouselStatus;
  // Boven de Instagram-limiet (MAX_IG_SLIDES): klaarzetten/publiceren dicht.
  tooManySlides: boolean;
  onReady: () => void;
  onPublish: () => void;
  onDelete: () => void;
}) {
  if (status === 'published') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px', borderTop: '1px solid var(--border-light)', background: '#fff' }}>
        <span className="dot" style={{ background: 'var(--green)' }} />
        <span style={{ fontSize: 12.5, color: 'var(--gray)' }}>Gepubliceerd op Instagram — @amsterdamnow</span>
      </div>
    );
  }
  const limitTitle = tooManySlides
    ? `Instagram accepteert maximaal ${MAX_IG_SLIDES} slides — verwijder eerst slides.`
    : undefined;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px', borderTop: '1px solid var(--border-light)', background: '#fff' }}>
      <span className="dot" style={{ background: status === 'ready' ? 'var(--amber)' : 'var(--amber)' }} />
      <span style={{ fontSize: 12.5, color: 'var(--gray)' }}>
        {status === 'ready' ? 'Klaargezet — wacht op handmatige plaatsing' : 'Concept — nog niet klaargezet'}
      </span>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
        <button className="btn-small" style={{ color: 'var(--red-dark)' }} onClick={onDelete}>Verwijderen</button>
        {status !== 'ready' && (
          <button className="btn" disabled={tooManySlides} title={limitTitle} style={tooManySlides ? { opacity: 0.5, cursor: 'not-allowed' } : undefined} onClick={onReady}>
            Klaarzetten
          </button>
        )}
        <button className="btn-primary" disabled={tooManySlides} title={limitTitle} onClick={onPublish}>Publiceren op Instagram →</button>
      </div>
    </div>
  );
}

// Aantal slides hangt af van het gekozen template: een NOW-familie zegt zelf
// hoe lang hij mag worden (een gids 4-10, een hotspot vast 5). Zonder keuze —
// of bij een satori-template — houden we de oude tekst aan.
function slidesSentence(spec: NowFamilySpec | null): string {
  if (!spec) return 'Claude schrijft de slides uit dit artikel';
  if (spec.minSlides === spec.maxSlides) return `Claude schrijft ${spec.minSlides} slides uit dit artikel`;
  return `Claude schrijft ${spec.minSlides} tot ${spec.maxSlides} slides uit dit artikel`;
}

export function PreGeneratePanel({
  template, setTemplate, families, familiesLoading, familiesError, onGenerate,
}: {
  template: CarouselTemplate | null;
  setTemplate: (t: CarouselTemplate) => void;
  families: NowFamilySpec[];
  familiesLoading: boolean;
  familiesError: boolean;
  onGenerate: () => void;
}) {
  const chosenNow = families.find(f => f.templateId === template) || null;

  return (
    <div style={{ padding: '48px 32px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, textAlign: 'center' }}>
      <span style={{ fontSize: 16, fontWeight: 800 }}>Kies een template om te beginnen</span>
      <span style={{ fontSize: 13, color: 'var(--gray)', maxWidth: 420, lineHeight: 1.55 }}>
        {slidesSentence(chosenNow)} — titel, intro, beelden zijn al bekend. Kies eerst een template.
      </span>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        {familiesLoading ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <PillSkeleton width={96} />
            <PillSkeleton width={78} />
            <PillSkeleton width={110} />
          </div>
        ) : families.length > 0 ? (
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 620 }}>
            {families.map(f => (
              <span key={f.templateId} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, width: 150 }}>
                <TemplatePill label={f.label} active={template === f.templateId} onClick={() => setTemplate(f.templateId)} size="md" />
                <span style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.45 }}>{f.purpose}</span>
              </span>
            ))}
          </div>
        ) : (
          <span style={{ fontSize: 12, color: 'var(--muted)', maxWidth: 380, lineHeight: 1.5 }}>
            {familiesError
              ? 'De templates konden niet worden opgehaald bij de socials-engine. Probeer het zo opnieuw, of controleer de koppeling via Instellingen → Instagram.'
              : 'Geen templates beschikbaar in de socials-engine.'}
          </span>
        )}
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
        socials-engine · {fmtTime(new Date().toISOString())}
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
  // Vangnet — normaal opent de modal niet eens boven de limiet (BottomBar
  // blokkeert), maar mocht het toch gebeuren dan kan er niet gepubliceerd worden.
  const tooMany = slideCount > MAX_IG_SLIDES;
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
          {tooMany ? (
            <div style={{ background: 'var(--red-bg)', border: '1px solid var(--red-border)', borderRadius: 8, padding: '10px 12px', fontSize: 12.5, lineHeight: 1.5, color: 'var(--red-dark)' }}>
              <span style={{ fontWeight: 800 }}>Te veel slides:</span> Instagram accepteert maximaal {MAX_IG_SLIDES} slides — verwijder er nog {slideCount - MAX_IG_SLIDES} voordat je publiceert.
            </div>
          ) : (
            <div style={{ background: 'var(--amber-bg)', border: '1px solid var(--amber-border)', borderRadius: 8, padding: '10px 12px', fontSize: 12.5, lineHeight: 1.5, color: 'var(--amber-dark)' }}>
              <span style={{ fontWeight: 800 }}>Controleer eerst:</span> na plaatsing zijn onderschrift en hashtags alleen nog in de Instagram-app te wijzigen.
            </div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 24px', borderTop: '1px solid var(--border-light)', background: 'var(--panel)' }}>
          <button className="btn" style={{ marginLeft: 'auto' }} disabled={publishing} onClick={onCancel}>Annuleren</button>
          <button
            className="btn-green"
            style={{ width: 'auto', padding: '9px 18px', ...(tooMany ? { opacity: 0.5, cursor: 'not-allowed' } : null) }}
            disabled={publishing || tooMany}
            title={tooMany ? `Instagram accepteert maximaal ${MAX_IG_SLIDES} slides.` : undefined}
            onClick={onConfirm}
          >
            {publishing ? 'Bezig…' : 'Ja, publiceren'}
          </button>
        </div>
      </div>
    </div>
  );
}
