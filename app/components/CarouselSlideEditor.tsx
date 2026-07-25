'use client';

import { isNowSlide, type CarouselContent, type CarouselSlide, type NowFamilySpec } from '@/lib/carousel';
import CarouselNowFields from './CarouselNowFields';

const LAYOUT_NAME: Record<CarouselSlide['layout'], string> = {
  hero: 'Hero', info: 'Info', image: 'Beeld', quote: 'Quote', cta: 'CTA',
};

export default function CarouselSlideEditor({
  content, slideIndex, onChangeSlide, onRegenerateSlide, regenerating,
  onChangeCaption, onChangeHashtags, nowSpec,
}: {
  content: CarouselContent;
  slideIndex: number;
  onChangeSlide: (patch: Partial<CarouselSlide>) => void;
  onRegenerateSlide: () => void;
  regenerating: boolean;
  onChangeCaption: (v: string) => void;
  onChangeHashtags: (tags: string[]) => void;
  // Gezet bij een Amsterdam NOW-carousel: dan tonen we per slidetype de tokens
  // uit het manifest in plaats van kop/body.
  nowSpec?: NowFamilySpec | null;
}) {
  const slide = content.slides[slideIndex];
  if (!slide) return null;

  // NOW-slide zonder spec = manifest is nog aan het laden; dan géén satori-velden
  // tonen (die zouden leeg zijn), maar een korte wachtmelding.
  const nowSlide = isNowSlide(slide) ? slide : null;
  const satoriSlide = nowSlide ? null : (slide as CarouselSlide);

  // NOW-slides schrijven `values` terug, satori-slides `headline`/`body` — beide
  // via dezelfde onChangeSlide-callback, die de parent met `{...s, ...patch}`
  // toepast en met de bestaande PATCH-autosave bewaart. De cast houdt het
  // prop-contract van de satori-editor onveranderd.
  const changeValues = (values: Record<string, string>) =>
    onChangeSlide({ values } as unknown as Partial<CarouselSlide>);

  return (
    <div style={{ width: 380, flexShrink: 0, borderLeft: '1px solid var(--border-light)', background: '#fff', overflowY: 'auto' }}>
      <div style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 800 }}>
            Slide {slideIndex + 1} · {nowSlide
              ? nowSlide.slideType.replace(/[-_]/g, ' ').replace(/^\w/, c => c.toUpperCase())
              : LAYOUT_NAME[satoriSlide!.layout]}
          </span>
          <button className="btn-small" style={{ marginLeft: 'auto' }} disabled={regenerating} onClick={onRegenerateSlide}>
            {regenerating ? <span className="spin" style={{ display: 'inline-block' }}>↻</span> : '↻'} Regenereer deze slide
          </button>
        </div>

        {nowSlide ? (
          nowSpec
            ? <CarouselNowFields slide={nowSlide} spec={nowSpec} onChangeValues={changeValues} />
            : <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>Sjabloon laden…</span>
        ) : (
        <>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--gray)' }}>Kop</span>
          <textarea
            value={satoriSlide!.headline}
            onChange={e => onChangeSlide({ headline: e.target.value })}
            rows={2}
            style={{
              border: '1.5px solid var(--ink)', borderRadius: 8, padding: '10px 12px', background: '#fff',
              fontSize: 15, fontWeight: 800, lineHeight: 1.25, resize: 'vertical', fontFamily: 'inherit',
            }}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--gray)' }}>Body-tekst</span>
          <textarea
            value={satoriSlide!.body}
            onChange={e => onChangeSlide({ body: e.target.value })}
            rows={3}
            style={{
              border: '1px solid var(--border)', borderRadius: 8, padding: '9px 12px', background: '#fff',
              fontSize: 13, lineHeight: 1.45, resize: 'vertical', fontFamily: 'inherit',
            }}
          />
        </div>

        {satoriSlide!.imageUrl && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--gray)' }}>Beeld</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid var(--border)', borderRadius: 8, padding: 8, background: 'var(--panel)' }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={satoriSlide!.imageUrl} alt="" style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 6 }} />
              <span style={{ fontSize: 12, color: 'var(--gray)', lineHeight: 1.4 }}>Beeld van het artikel</span>
              <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted)' }}>via ArticleDetail</span>
            </div>
          </div>
        )}
        </>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px solid var(--border-light)', paddingTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--gray)' }}>Onderschrift</span>
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted)' }}>{content.caption.length} tekens</span>
          </div>
          <textarea
            value={content.caption}
            onChange={e => onChangeCaption(e.target.value)}
            rows={4}
            style={{
              border: '1px solid var(--border)', borderRadius: 8, padding: '11px 12px', background: '#fff',
              fontSize: 13, lineHeight: 1.55, color: 'var(--text)', resize: 'vertical', fontFamily: 'inherit',
            }}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--gray)' }}>Hashtags</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--gray)' }}>{content.hashtags.length}</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            {content.hashtags.map((tag, i) => (
              <span key={tag} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, background: 'var(--soft)', borderRadius: 5, padding: '4px 8px' }}>
                #{tag}
                <span
                  style={{ color: 'var(--muted)', cursor: 'pointer', fontSize: 12 }}
                  onClick={() => onChangeHashtags(content.hashtags.filter((_, j) => j !== i))}
                >
                  ✕
                </span>
              </span>
            ))}
            <input
              placeholder="+ hashtag & Enter"
              onKeyDown={e => {
                if (e.key !== 'Enter') return;
                const el = e.currentTarget;
                const next = el.value.trim().replace(/^#/, '').replace(/\s+/g, '');
                if (next) onChangeHashtags([...content.hashtags, next]);
                el.value = '';
              }}
              style={{
                fontSize: 12.5, color: 'var(--gray)', border: '1px dashed var(--faint)', borderRadius: 5,
                padding: '4px 10px', background: 'transparent', minWidth: 140,
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
