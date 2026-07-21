'use client';

import type { CarouselSlide } from '@/lib/carousel-mock';

const LAYOUT_LABEL: Record<CarouselSlide['layout'], string> = {
  hero: 'HERO', info: 'INFO', image: 'BEELD', quote: 'QUOTE', cta: 'CTA',
};

function SlideFace({ slide, kicker, big }: { slide: CarouselSlide; kicker: string; big: boolean }) {
  const headlineSize = big ? 25 : 15;
  const bodySize = big ? 12.5 : 11;

  if (slide.layout === 'quote') {
    return (
      <div style={{ position: 'absolute', inset: 0, background: 'var(--ink)', display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: big ? '28px 26px' : '14px 14px', gap: 10 }}>
        <span style={{ fontSize: big ? 34 : 20, color: 'var(--red)', fontWeight: 800, lineHeight: 1 }}>&#8220;</span>
        <span style={{ fontSize: headlineSize, fontWeight: 700, lineHeight: 1.3, color: '#fff', fontStyle: 'italic' }}>{slide.headline}</span>
        <span style={{ fontSize: bodySize, color: 'rgba(255,255,255,0.6)' }}>{slide.body}</span>
      </div>
    );
  }
  if (slide.layout === 'cta') {
    return (
      <div style={{ position: 'absolute', inset: 0, background: 'var(--red)', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'flex-start', padding: big ? '28px 26px' : '14px 14px', gap: 8 }}>
        <span style={{ fontSize: headlineSize, fontWeight: 800, lineHeight: 1.15, color: '#fff' }}>{slide.headline}</span>
        <span style={{ fontSize: bodySize, color: 'rgba(255,255,255,0.85)', fontWeight: 600 }}>{slide.body}</span>
      </div>
    );
  }
  if (slide.layout === 'info') {
    return (
      <div style={{ position: 'absolute', inset: 0, background: '#fff', display: 'flex', flexDirection: 'column' }}>
        <div style={{ height: big ? 8 : 5, background: 'var(--red)', flexShrink: 0 }} />
        <div style={{ padding: big ? '18px 18px 0' : '10px 10px 0', display: 'flex', flexDirection: 'column', gap: big ? 8 : 5 }}>
          <span style={{ fontSize: big ? 10.5 : 8.5, fontWeight: 800, letterSpacing: '0.08em', color: 'var(--red)' }}>{kicker}</span>
          <span style={{ fontSize: headlineSize - 4, fontWeight: 800, lineHeight: 1.15, color: 'var(--ink)' }}>{slide.headline}</span>
          <span style={{ fontSize: bodySize, lineHeight: 1.4, color: 'var(--text-soft)' }}>{slide.body}</span>
        </div>
      </div>
    );
  }
  // hero / image: fotobeeld met gradient + tekst eronder
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#d8d6d0' }}>
      {slide.imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={slide.imageUrl} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
      )}
      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(20,20,18,0.35), rgba(20,20,18,0) 32%, rgba(20,20,18,0) 50%, rgba(20,20,18,0.88))' }} />
      <div style={{ position: 'absolute', left: big ? 20 : 10, right: big ? 20 : 10, bottom: big ? 22 : 10, display: 'flex', flexDirection: 'column', gap: big ? 10 : 4 }}>
        <span style={{ alignSelf: 'flex-start', fontSize: big ? 10.5 : 7.5, fontWeight: 800, letterSpacing: '0.06em', color: '#fff', background: 'var(--red)', padding: big ? '4px 10px' : '2px 6px', borderRadius: 5 }}>
          {kicker}
        </span>
        <span style={{ fontSize: headlineSize, fontWeight: 800, lineHeight: 1.1, color: '#fff', letterSpacing: '-0.01em' }}>{slide.headline}</span>
        {big && slide.body && <span style={{ fontSize: bodySize, fontWeight: 600, color: 'rgba(255,255,255,0.8)' }}>{slide.body}</span>}
      </div>
    </div>
  );
}

export default function CarouselSlidePreview({
  slides, currentIndex, onSelect, kicker,
}: {
  slides: CarouselSlide[];
  currentIndex: number;
  onSelect: (i: number) => void;
  kicker: string;
}) {
  const total = slides.length;
  const current = slides[currentIndex];
  const goto = (i: number) => onSelect((i + total) % total);

  return (
    <div style={{ flex: 1, minWidth: 0, background: 'var(--sidebar)', padding: '28px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
        <button
          onClick={() => goto(currentIndex - 1)}
          style={{ width: 38, height: 38, borderRadius: '50%', background: '#fff', border: '1px solid var(--border-light)', fontSize: 17, color: 'var(--gray)', flexShrink: 0 }}
        >
          ‹
        </button>

        <div style={{ position: 'relative', width: 260, height: 325, borderRadius: 14, overflow: 'hidden', boxShadow: '0 14px 36px rgba(20,20,18,0.24)', flexShrink: 0, outline: '3px solid var(--ink)', outlineOffset: 3 }}>
          {current && <SlideFace slide={current} kicker={kicker} big />}
          <div style={{ position: 'absolute', right: 12, top: 12, fontSize: 11, fontWeight: 700, color: '#fff', background: 'rgba(255,255,255,0.22)', padding: '4px 10px', borderRadius: 999 }}>
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

      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        {slides.map((s, i) => (
          <span
            key={s.index}
            onClick={() => onSelect(i)}
            style={{
              width: i === currentIndex ? 20 : 7, height: 7, borderRadius: 999, cursor: 'pointer',
              background: i === currentIndex ? 'var(--ink)' : 'var(--faint)',
            }}
          />
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#fff', border: '1px solid var(--border-light)', borderRadius: 12, padding: '10px 12px' }}>
        {slides.map((s, i) => (
          <div
            key={s.index}
            onClick={() => onSelect(i)}
            style={{
              position: 'relative', width: 46, height: 58, borderRadius: 6, overflow: 'hidden', flexShrink: 0, cursor: 'pointer', background: '#fff',
              outline: i === currentIndex ? '2px solid var(--ink)' : '1px solid var(--border)', outlineOffset: 1,
            }}
          >
            <SlideFace slide={s} kicker={kicker} big={false} />
            <span style={{ position: 'absolute', left: 3, bottom: 2, fontSize: 7, fontWeight: 800, color: '#fff', textShadow: '0 1px 2px rgba(0,0,0,0.7)' }}>
              {LAYOUT_LABEL[s.layout]}
            </span>
          </div>
        ))}
      </div>
      <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>Klik een slide om te bewerken</span>
    </div>
  );
}
