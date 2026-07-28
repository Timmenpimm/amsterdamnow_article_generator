'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  findNowStep, flushCarouselSave,
  type NowCarouselSlide, type NowFamilySpec,
} from '@/lib/carousel';

// ---------------------------------------------------------------------------
// Preview voor Amsterdam NOW-carousels.
//
// De satori-templates worden in CarouselSlidePreview met DOM nagebouwd. Voor de
// NOW-ontwerpen kan dat niet: het zijn pixel-exacte HTML-ontwerpen die de engine
// met een headless browser rendert. Een DOM-benadering zou dus een verkeerd
// beeld geven. Daarom haalt dit component de échte PNG's op via de proxy
// `POST /api/carousel/[articleId]/render` en toont die.
//
// Cache & verversen: `renders` bewaart per slide-`index` de dataUrl. Er gaat
// altijd één call per slide uit, achter elkaar — een hele carousel in één call
// loopt tegen de 60s-limiet van de engine aan. Daarna
// vergelijken we per slide een vingerafdruk van `slideType` + `values`; wat
// verandert wordt (gedebounced) opnieuw gerenderd. Vóór het renderen dwingen we
// met flushCarouselSave() de openstaande autosave af, want de engine rendert
// wat er op de server staat — niet wat er in de editor staat.
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 900;

// Grootste afmetingen van het grote voorbeeld en de thumbstrip; het echte
// formaat volgt uit `dimensions` van de slide (1080×1350 vs 1080×1920).
const BIG_MAX = { w: 260, h: 460 };
const THUMB_MAX = { w: 46, h: 58 };

interface RenderState {
  dataUrl?: string;
  error?: string;
  issues?: string[];
  loading?: boolean;
}

function fingerprint(slide: NowCarouselSlide): string {
  return `${slide.slideType}|${JSON.stringify(slide.values || {})}`;
}

function fit(dim: { width: number; height: number }, max: { w: number; h: number }) {
  const scale = Math.min(max.w / dim.width, max.h / dim.height);
  return { width: Math.round(dim.width * scale), height: Math.round(dim.height * scale) };
}

function typeLabel(slideType: string): string {
  return slideType.replace(/[-_]/g, ' ').toUpperCase();
}

// Verwijder-knop bij de actieve slide — gedeeld door het NOW- en het
// satori-pad (CarouselSlidePreview importeert hem hiervandaan). De guard
// (waaróm verwijderen niet mag) rekent CarouselGenerator uit; hier alleen
// disabled + uitleg in de title.
export function SlideDeleteButton({
  currentIndex, blockedReason, onDelete,
}: {
  currentIndex: number;
  blockedReason: string | null;
  onDelete: () => void;
}) {
  const blocked = !!blockedReason;
  return (
    <button
      className="btn-small"
      disabled={blocked}
      title={blockedReason || `Slide ${currentIndex + 1} uit de carousel verwijderen`}
      onClick={onDelete}
      style={blocked
        ? { color: 'var(--muted)', opacity: 0.6, cursor: 'not-allowed' }
        : { color: 'var(--red-dark)' }}
    >
      ✕ Verwijder slide {currentIndex + 1}
    </button>
  );
}

function Face({ state, label, big }: { state: RenderState | undefined; label: string; big: boolean }) {
  if (state?.dataUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={state.dataUrl}
        alt={label}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
      />
    );
  }
  return (
    <div
      className="hatch"
      style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}
    >
      {state?.error ? (
        <span
          style={{
            width: big ? 30 : 16, height: big ? 30 : 16, borderRadius: '50%',
            background: 'var(--red-bg)', color: 'var(--red-dark)',
            display: 'grid', placeItems: 'center', fontSize: big ? 16 : 10, fontWeight: 800,
          }}
        >
          !
        </span>
      ) : (
        <span
          className="spin"
          style={{
            width: big ? 34 : 14, height: big ? 34 : 14, borderRadius: '50%',
            border: `${big ? 4 : 2}px solid var(--border-light)`, borderTopColor: 'var(--ink)',
          }}
        />
      )}
    </div>
  );
}

export default function CarouselNowPreview({
  slides, spec, currentIndex, onSelect, articleId, onDeleteSlide, deleteBlockedReason,
}: {
  slides: NowCarouselSlide[];
  spec: NowFamilySpec;
  currentIndex: number;
  onSelect: (i: number) => void;
  articleId?: number;
  // Verwijder-knop bij de actieve slide; zonder callback geen knop.
  onDeleteSlide?: () => void;
  deleteBlockedReason?: string | null;
}) {
  const [renders, setRenders] = useState<Record<number, RenderState>>({});
  const printsRef = useRef<string[]>([]);
  const runRef = useRef(0);
  // Slides die op een (her)render wachten. Blijft staan als de debounce-timer
  // opnieuw start, zodat een snel bewerkte slide niet overgeslagen wordt.
  const pendingRef = useRef<Set<number>>(new Set());

  const total = slides.length;
  const current = slides[currentIndex];
  const goto = (i: number) => onSelect((i + total) % total);

  const dimOf = useCallback(
    (slide: NowCarouselSlide | undefined) =>
      (slide && findNowStep(spec, slide.slideType)?.dimensions) || { width: 1080, height: 1350 },
    [spec]
  );

  // Eén render-call. `targets` = de slide-indexen waarvan we een beeld
  // verwachten; bij precies één index vragen we alleen die slide op.
  const runRender = useCallback(
    async (targets: number[]) => {
      if (!articleId || targets.length === 0) return;
      const gen = ++runRef.current;
      setRenders(prev => {
        const next = { ...prev };
        for (const i of targets) next[i] = { ...next[i], loading: true, error: undefined, issues: undefined };
        return next;
      });

      // De engine rendert wat er op de server staat; eerst de openstaande
      // (gedebouncede) autosave wegschrijven.
      try {
        await flushCarouselSave();
      } catch {
        // autosave is fire-and-forget; renderen mag toch geprobeerd worden
      }

      // Altijd één call per slide, netjes achter elkaar. Een carousel van 8
      // slides in één call zou tegen de 60s-limiet van de engine aanlopen; zo
      // verschijnt elke slide bovendien zodra hij klaar is in plaats van pas
      // aan het eind, en kost een mislukte slide niet de hele reeks.
      for (const index of targets) {
        try {
          const res = await fetch(`/api/carousel/${articleId}/render`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slideIndex: index }),
          });
          const body = await res.json().catch(() => null);
          if (gen !== runRef.current) return; // verouderd antwoord

          if (!res.ok) {
            const error: string = body?.error || `Renderen mislukt (HTTP ${res.status}).`;
            const issues: string[] | undefined = Array.isArray(body?.issues) ? body.issues.map(String) : undefined;
            setRenders(prev => ({ ...prev, [index]: { ...prev[index], loading: false, error, issues } }));
            continue;
          }

          const out: { index: number; dataUrl: string }[] = Array.isArray(body?.slides) ? body.slides : [];
          const hit = out.find(s => s?.index === index) || out[0];
          setRenders(prev => ({
            ...prev,
            [index]:
              typeof hit?.dataUrl === 'string'
                ? { dataUrl: hit.dataUrl, loading: false }
                : { ...prev[index], loading: false, error: 'Renderen leverde geen beeld op.' },
          }));
        } catch (e: any) {
          if (gen !== runRef.current) return;
          const error = e?.message || 'Renderen mislukt — probeer het opnieuw.';
          setRenders(prev => ({ ...prev, [index]: { ...prev[index], loading: false, error } }));
        }
      }
    },
    [articleId]
  );

  // Scheidingsteken \n is veilig: JSON.stringify escapet een echte newline, dus
  // die kan nooit ín een vingerafdruk voorkomen.
  const prints = slides.map(fingerprint);
  const printsKey = prints.join('\n');

  // Verversen na een bewerking: de parent schrijft de nieuwe waarden in
  // `slides` (via onChangeSlide → PATCH-autosave), waardoor de vingerafdruk van
  // die slide verandert en hier precies die slide opnieuw gerenderd wordt.
  useEffect(() => {
    const nextPrints = printsKey.length ? printsKey.split('\n') : [];
    const prev = printsRef.current;
    const first = prev.length === 0;
    const changed: number[] = [];
    slides.forEach((slide, i) => {
      if (first || prev[i] !== nextPrints[i]) changed.push(slide.index ?? i);
    });
    printsRef.current = nextPrints;
    for (const i of changed) pendingRef.current.add(i);
    if (pendingRef.current.size === 0) return;

    const t = setTimeout(() => {
      const targets = [...pendingRef.current];
      pendingRef.current.clear();
      void runRender(targets);
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
    // slides zit in printsKey verwerkt; bewust niet in de deps om dubbele runs
    // bij elke re-render van de parent te voorkomen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printsKey, runRender]);

  const currentKey = current?.index ?? currentIndex;
  const currentState = renders[currentKey];
  const bigBox = fit(dimOf(current), BIG_MAX);

  return (
    <div style={{ flex: 1, minWidth: 0, background: 'var(--sidebar)', padding: '28px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
        <button
          onClick={() => goto(currentIndex - 1)}
          style={{ width: 38, height: 38, borderRadius: '50%', background: '#fff', border: '1px solid var(--border-light)', fontSize: 17, color: 'var(--gray)', flexShrink: 0 }}
        >
          ‹
        </button>

        <div style={{ position: 'relative', width: bigBox.width, height: bigBox.height, borderRadius: 14, overflow: 'hidden', boxShadow: '0 14px 36px rgba(20,20,18,0.24)', flexShrink: 0, outline: '3px solid var(--ink)', outlineOffset: 3 }}>
          {current && <Face state={currentState} label={typeLabel(current.slideType)} big />}
          <div style={{ position: 'absolute', right: 12, top: 12, fontSize: 11, fontWeight: 700, color: '#fff', background: 'rgba(20,20,18,0.42)', padding: '4px 10px', borderRadius: 999 }}>
            {currentIndex + 1} / {total}
          </div>
        </div>

        <button
          onClick={() => goto(currentIndex + 1)}
          style={{ width: 38, height: 38, borderRadius: '50%', background: 'var(--ink)', color: '#fff', border: 'none', fontSize: 17, flexShrink: 0 }}
        >
          ›
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          {slides.map((s, i) => (
            <span
              key={s.index ?? i}
              onClick={() => onSelect(i)}
              style={{
                width: i === currentIndex ? 20 : 7, height: 7, borderRadius: 999, cursor: 'pointer',
                background: i === currentIndex ? 'var(--ink)' : 'var(--faint)',
              }}
            />
          ))}
        </div>
        {onDeleteSlide && (
          <>
            <span style={{ width: 1, height: 16, background: 'var(--border-light)' }} />
            <SlideDeleteButton currentIndex={currentIndex} blockedReason={deleteBlockedReason ?? null} onDelete={onDeleteSlide} />
          </>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#fff', border: '1px solid var(--border-light)', borderRadius: 12, padding: '10px 12px' }}>
        {slides.map((s, i) => {
          const box = fit(dimOf(s), THUMB_MAX);
          return (
            <div
              key={s.index ?? i}
              onClick={() => onSelect(i)}
              title={typeLabel(s.slideType)}
              style={{
                position: 'relative', width: box.width, height: box.height, borderRadius: 6, overflow: 'hidden',
                flexShrink: 0, cursor: 'pointer', background: '#fff',
                outline: i === currentIndex ? '2px solid var(--ink)' : '1px solid var(--border)', outlineOffset: 1,
              }}
            >
              <Face state={renders[s.index ?? i]} label={typeLabel(s.slideType)} big={false} />
            </div>
          );
        })}
      </div>

      {!articleId && (
        <span style={{ fontSize: 11.5, color: 'var(--red-dark)' }}>
          Voorbeeld niet beschikbaar — artikel-id ontbreekt.
        </span>
      )}

      {currentState?.error && (
        <div style={{ width: '100%', maxWidth: 420, background: 'var(--red-bg)', border: '1px solid var(--red-border)', borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--red-dark)' }}>Slide {currentIndex + 1} niet gerenderd</span>
            <button
              className="btn-small"
              style={{ marginLeft: 'auto', flexShrink: 0 }}
              onClick={() => void runRender([currentKey])}
            >
              Opnieuw proberen
            </button>
          </div>
          <span style={{ fontSize: 12.5, color: 'var(--red-dark)', lineHeight: 1.5 }}>{currentState.error}</span>
          {currentState.issues && currentState.issues.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 3 }}>
              {currentState.issues.map((issue, i) => (
                <li key={i} style={{ fontSize: 12, color: 'var(--red-dark)', lineHeight: 1.45 }}>{issue}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
        {currentState?.loading ? 'Beeld renderen…' : 'Klik een slide om te bewerken'}
      </span>
    </div>
  );
}
