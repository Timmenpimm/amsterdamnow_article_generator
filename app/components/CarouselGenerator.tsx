'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Article } from '@/lib/types';
import {
  getCarouselContent, getNowFamilies, generateCarousel, regenerateSlide,
  saveCarouselContent, flushCarouselSave, markReady, publishCarousel, deleteCarousel,
  EngineNotConfiguredError, findNowStep, isNowSlide, MAX_IG_SLIDES,
  type AnyCarouselSlide, type CarouselContent, type CarouselSlide, type CarouselStatus,
  type CarouselTemplate, type GenerateProgress, type NowCarouselSlide, type NowFamilySpec,
} from '@/lib/carousel';
import { toast } from './toast';
import CarouselSlidePreview from './CarouselSlidePreview';
import CarouselSlideEditor from './CarouselSlideEditor';
import {
  SubContext, TemplateStrip, BottomBar, PreGeneratePanel, LoadingPanel,
  GenerateErrorPanel, LoadErrorPanel, PublishModal,
} from './CarouselPanels';

// ---------------------------------------------------------------------------
// Slide verwijderen — helpers
// ---------------------------------------------------------------------------

// Reden waarom de actieve slide níet verwijderd mag worden; null = mag wel.
// Dezelfde functie stuurt de disabled-state + title van de verwijder-knop aan
// én is het vangnet in doDeleteSlide zelf.
function slideDeleteBlockReason(
  slides: AnyCarouselSlide[],
  slideIndex: number,
  nowSpec: NowFamilySpec | null
): string | null {
  const slide = slides[slideIndex];
  if (!slide) return 'Geen slide geselecteerd.';

  if (nowSpec && isNowSlide(slide)) {
    // NOW: de step-minima uit het engine-manifest zijn leidend. Een step met
    // min === max (cover, cta) is een vast onderdeel en nooit verwijderbaar.
    const step = findNowStep(nowSpec, slide.slideType);
    if (step) {
      const ofType = slides.filter(s => isNowSlide(s) && s.slideType === slide.slideType).length;
      if (ofType - 1 < step.min) {
        return step.min === step.max
          ? 'Deze slide is een vast onderdeel van dit template en kan niet verwijderd worden.'
          : `Dit template heeft minimaal ${step.min} slides van dit type — verwijderen kan niet meer.`;
      }
    }
    const floor = Math.max(3, nowSpec.minSlides);
    if (slides.length - 1 < floor) {
      return `Dit template heeft minimaal ${floor} slides — verwijderen kan niet meer.`;
    }
    return null;
  }

  // Satori: alleen het Instagram-minimum van 2 slides bewaken.
  if (slides.length - 1 < 2) return 'Een carousel heeft minimaal 2 slides — verwijderen kan niet meer.';
  return null;
}

// Hernummert NOW-slides na een verwijdering. Binnen elke hérhaalde step
// (max > min in het manifest) krijgen tokens met `zeroPadTo` het nieuwe
// 1-based volgnummer binnen die step (de engine vult ze óók zonder padding:
// String(positie + 1)) en tokens met `enumValues` de waarde per positie
// (enumValues[positie % lengte]). Tokens met `autoCount` — op wélke slide dan
// ook — krijgen het nieuwe totale aantal slides van de herhaalde step.
function renumberNowSlides(slides: NowCarouselSlide[], spec: NowFamilySpec): NowCarouselSlide[] {
  const counts = new Map<string, number>();
  for (const s of slides) counts.set(s.slideType, (counts.get(s.slideType) || 0) + 1);
  const repeatedStep = spec.steps.find(st => st.max > st.min);
  const repeatedCount = repeatedStep ? counts.get(repeatedStep.slideType) || 0 : 0;

  const seen = new Map<string, number>();
  return slides.map((slide, i) => {
    const pos = seen.get(slide.slideType) || 0; // 0-based positie binnen de step
    seen.set(slide.slideType, pos + 1);

    let values = slide.values || {};
    const step = findNowStep(spec, slide.slideType);
    if (step) {
      const inRepeatedStep = step.max > step.min;
      let next: Record<string, string> | null = null;
      for (const p of step.placeholders) {
        let v: string | undefined;
        if (inRepeatedStep && p.zeroPadTo != null) v = String(pos + 1);
        else if (inRepeatedStep && p.enumValues && p.enumValues.length > 0) v = p.enumValues[pos % p.enumValues.length];
        else if (p.autoCount && repeatedStep) v = String(repeatedCount);
        if (v !== undefined && values[p.name] !== v) {
          if (!next) next = { ...values };
          next[p.name] = v;
        }
      }
      if (next) values = next;
    }
    return { ...slide, index: i, values };
  });
}

export default function CarouselGenerator({ articleId }: { articleId: number }) {
  const [article, setArticle] = useState<Article | null>(null);
  const [loadError, setLoadError] = useState('');
  const [template, setTemplate] = useState<CarouselTemplate | null>(null);
  const [content, setContent] = useState<CarouselContent | null>(null);
  const [status, setStatus] = useState<CarouselStatus>('none');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [slideIndex, setSlideIndex] = useState(0);
  const [progress, setProgress] = useState<GenerateProgress | null>(null);
  const [genError, setGenError] = useState('');
  const [regenBusy, setRegenBusy] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [engineMissing, setEngineMissing] = useState(false);
  const [engineError, setEngineError] = useState('');
  // NOW-families uit het engine-manifest: één keer ophalen bij mount, daarna
  // read-only. Mislukt het, dan blijven de generieke templates gewoon werken.
  const [families, setFamilies] = useState<NowFamilySpec[]>([]);
  const [familiesLoading, setFamiliesLoading] = useState(true);
  const [familiesError, setFamiliesError] = useState(false);
  const cancelled = useRef(false);

  // Manifest-spec van het gekozen template — null bij een satori-carousel.
  // Preview, editor en de verwijder-guard lezen hieruit welke slidetypes/tokens
  // er bestaan.
  const nowSpec = families.find(f => f.templateId === template) || null;
  // Instagram-limiet: bij meer slides zijn klaarzetten/publiceren geblokkeerd.
  const tooManySlides = (content?.slides.length ?? 0) > MAX_IG_SLIDES;

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/articles/${articleId}`);
      if (!res.ok) throw new Error((await res.json()).error || 'Artikel niet gevonden');
      const { article: a } = await res.json();
      setArticle(a);
      setLoadError('');
    } catch (e: any) {
      setLoadError(e.message);
      return;
    }
    try {
      const { meta, content: existing } = await getCarouselContent(articleId);
      if (existing) setContent(existing);
      if (meta.template) setTemplate(meta.template);
      setStatus(meta.status);
      setSavedAt(meta.savedAt);
      setEngineMissing(false);
      setEngineError('');
    } catch (e: any) {
      if (e instanceof EngineNotConfiguredError) setEngineMissing(true);
      else setEngineError(e.message || 'Carousel-status kon niet geladen worden.');
    }
  }, [articleId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    let alive = true;
    getNowFamilies()
      .then(fs => { if (alive) setFamilies(fs); })
      .catch(() => { if (alive) setFamiliesError(true); })
      .finally(() => { if (alive) setFamiliesLoading(false); });
    return () => { alive = false; };
  }, []);

  // Openstaande (gedebouncede) autosave wegschrijven bij het verlaten van de
  // pagina, zodat de laatste toetsaanslagen niet verloren gaan.
  useEffect(() => () => { void flushCarouselSave(); }, []);

  async function runGenerate() {
    if (!article || !template) return;
    cancelled.current = false;
    setGenError('');
    setProgress({ headline: 'Starten…', detail: '', steps: [], pct: 0 });
    try {
      const c = await generateCarousel(article, template, p => { if (!cancelled.current) setProgress(p); });
      if (cancelled.current) return;
      setContent(c);
      setStatus('concept');
      setSavedAt(new Date().toISOString());
      setSlideIndex(0);
    } catch (e: any) {
      if (cancelled.current) return;
      if (e instanceof EngineNotConfiguredError) {
        setEngineMissing(true);
      } else {
        setGenError(e.message);
        toast('Genereren mislukt — probeer het opnieuw', { kind: 'error' });
      }
    } finally {
      if (!cancelled.current) setProgress(null);
    }
  }

  function cancelGenerate() {
    cancelled.current = true;
    setProgress(null);
  }

  function patchSlide(patch: Partial<CarouselSlide>) {
    if (!content) return;
    const next = { ...content, slides: content.slides.map((s, i) => (i === slideIndex ? { ...s, ...patch } : s)) };
    setContent(next);
    saveCarouselContent(articleId, next);
    setSavedAt(new Date().toISOString());
  }

  function patchCaption(v: string) {
    if (!content) return;
    const next = { ...content, caption: v };
    setContent(next);
    saveCarouselContent(articleId, next);
    setSavedAt(new Date().toISOString());
  }

  function patchHashtags(tags: string[]) {
    if (!content) return;
    const next = { ...content, hashtags: tags };
    setContent(next);
    saveCarouselContent(articleId, next);
    setSavedAt(new Date().toISOString());
  }

  function doDeleteSlide() {
    if (!content) return;
    const reason = slideDeleteBlockReason(content.slides, slideIndex, nowSpec);
    if (reason) { toast(reason, { kind: 'error' }); return; }
    if (!confirm(`Slide ${slideIndex + 1} verwijderen? Dit kan niet ongedaan gemaakt worden.`)) return;

    const remaining = content.slides.filter((_, i) => i !== slideIndex);
    // NOW-carousel: hernummeren + tellers bijwerken; satori: alleen herindexeren.
    const slides: AnyCarouselSlide[] =
      nowSpec && remaining.every(isNowSlide)
        ? renumberNowSlides(remaining as NowCarouselSlide[], nowSpec)
        : remaining.map((s, i) => ({ ...s, index: i }));

    const next = { ...content, slides };
    setContent(next);
    setSlideIndex(i => Math.min(i, slides.length - 1));
    saveCarouselContent(articleId, next);
    setSavedAt(new Date().toISOString());
    toast('Slide verwijderd');
  }

  async function doRegenerateSlide() {
    if (!article || !template || regenBusy) return;
    setRegenBusy(true);
    try {
      const slide = await regenerateSlide(article, template, slideIndex);
      setContent(c => (c ? { ...c, slides: c.slides.map((s, i) => (i === slideIndex ? slide : s)) } : c));
      setSavedAt(new Date().toISOString());
      toast('Slide opnieuw geschreven');
    } catch (e: any) {
      toast(e.message, { kind: 'error' });
    } finally {
      setRegenBusy(false);
    }
  }

  async function doMarkReady() {
    if (tooManySlides) {
      toast(`Instagram accepteert maximaal ${MAX_IG_SLIDES} slides — verwijder eerst slides.`, { kind: 'error' });
      return;
    }
    try {
      await markReady(articleId);
      setStatus('ready');
      toast('Klaargezet — wacht op handmatige plaatsing');
    } catch (e: any) {
      toast(e.message, { kind: 'error' });
    }
  }

  async function doPublish() {
    if (tooManySlides) {
      toast(`Instagram accepteert maximaal ${MAX_IG_SLIDES} slides — verwijder eerst slides.`, { kind: 'error' });
      return;
    }
    setPublishing(true);
    try {
      await publishCarousel(articleId);
      setStatus('published');
      setPublishOpen(false);
      toast('Carousel geplaatst op Instagram');
    } catch (e: any) {
      toast(e.message, { kind: 'error' });
    } finally {
      setPublishing(false);
    }
  }

  async function doDeleteCarousel() {
    if (!confirm('Deze carousel definitief verwijderen? Dit kan niet ongedaan gemaakt worden.')) return;
    try {
      await deleteCarousel(articleId);
      setContent(null);
      setStatus('none');
      setSavedAt(null);
      toast('Carousel verwijderd');
    } catch (e: any) {
      toast(e.message, { kind: 'error' });
    }
  }

  if (loadError) return <LoadErrorPanel message={loadError} />;
  if (!article) return <div style={{ padding: 40, fontSize: 13, color: 'var(--gray)' }}>Laden…</div>;

  // Waarom de actieve slide (niet) verwijderd mag worden — voor de knop-state.
  const deleteSlideBlocked = content ? slideDeleteBlockReason(content.slides, slideIndex, nowSpec) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 'calc(100vh - 53px)' }}>
      <SubContext article={article} status={status} savedAt={savedAt} />

      {engineMissing && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px', background: 'var(--amber-bg)', borderBottom: '1px solid var(--amber-border)' }}>
          <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--amber-dark)' }}>Socials-engine niet gekoppeld</span>
          <span style={{ fontSize: 12.5, color: 'var(--amber-dark)' }}>Genereren en publiceren werken pas na het instellen van de koppeling.</span>
          <Link href="/instellingen" className="btn-small" style={{ marginLeft: 'auto', flexShrink: 0 }}>Naar Instellingen → Instagram</Link>
        </div>
      )}
      {engineError && !engineMissing && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px', background: 'var(--red-bg)', borderBottom: '1px solid var(--red-border)' }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--red-dark)' }}>{engineError}</span>
          <button className="btn-small" style={{ marginLeft: 'auto', flexShrink: 0 }} onClick={load}>Opnieuw proberen</button>
        </div>
      )}

      {progress ? (
        <LoadingPanel progress={progress} onCancel={cancelGenerate} />
      ) : genError ? (
        <GenerateErrorPanel message={genError} onRetry={runGenerate} />
      ) : !content ? (
        <PreGeneratePanel
          template={template}
          setTemplate={setTemplate}
          families={families}
          familiesLoading={familiesLoading}
          familiesError={familiesError}
          onGenerate={runGenerate}
        />
      ) : (
        <>
          <TemplateStrip
            template={template || 'modern-news'}
            setTemplate={setTemplate}
            families={families}
            slideCount={content.slides.length}
            generatedAt={savedAt}
            onRegenerateAll={runGenerate}
          />
          {tooManySlides && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px', background: 'var(--amber-bg)', borderBottom: '1px solid var(--amber-border)' }}>
              <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--amber-dark)' }}>Te veel slides voor Instagram</span>
              <span style={{ fontSize: 12.5, color: 'var(--amber-dark)' }}>
                Instagram accepteert maximaal {MAX_IG_SLIDES} slides — verwijder er nog {content.slides.length - MAX_IG_SLIDES}.
              </span>
            </div>
          )}
          <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
            <CarouselSlidePreview
              slides={content.slides}
              currentIndex={slideIndex}
              onSelect={setSlideIndex}
              kicker={[article.category, article.district].filter(Boolean).join(' · ').toUpperCase() || 'AMSTERDAM'}
              nowSpec={nowSpec}
              articleId={article.id}
              onDeleteSlide={doDeleteSlide}
              deleteBlockedReason={deleteSlideBlocked}
            />
            <CarouselSlideEditor
              content={content}
              slideIndex={slideIndex}
              nowSpec={nowSpec}
              onChangeSlide={patchSlide}
              onRegenerateSlide={doRegenerateSlide}
              regenerating={regenBusy}
              onChangeCaption={patchCaption}
              onChangeHashtags={patchHashtags}
            />
          </div>
          <BottomBar status={status} tooManySlides={tooManySlides} onReady={doMarkReady} onPublish={() => setPublishOpen(true)} onDelete={doDeleteCarousel} />
        </>
      )}

      {publishOpen && content && (
        <PublishModal
          slideCount={content.slides.length}
          publishing={publishing}
          onCancel={() => !publishing && setPublishOpen(false)}
          onConfirm={doPublish}
        />
      )}
    </div>
  );
}
