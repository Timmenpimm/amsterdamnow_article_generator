'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Article } from '@/lib/types';
import {
  getCarouselContent, generateCarousel, regenerateSlide,
  saveCarouselContent, flushCarouselSave, markReady, publishCarousel,
  EngineNotConfiguredError,
  type CarouselContent, type CarouselSlide, type CarouselStatus, type CarouselTemplate, type GenerateProgress,
} from '@/lib/carousel';
import { toast } from './toast';
import CarouselSlidePreview from './CarouselSlidePreview';
import CarouselSlideEditor from './CarouselSlideEditor';
import {
  SubContext, TemplateStrip, BottomBar, PreGeneratePanel, LoadingPanel,
  GenerateErrorPanel, LoadErrorPanel, PublishModal,
} from './CarouselPanels';

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
  const cancelled = useRef(false);

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
    try {
      await markReady(articleId);
      setStatus('ready');
      toast('Klaargezet — wacht op handmatige plaatsing');
    } catch (e: any) {
      toast(e.message, { kind: 'error' });
    }
  }

  async function doPublish() {
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

  if (loadError) return <LoadErrorPanel message={loadError} />;
  if (!article) return <div style={{ padding: 40, fontSize: 13, color: 'var(--gray)' }}>Laden…</div>;

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
        <PreGeneratePanel template={template} setTemplate={setTemplate} onGenerate={runGenerate} />
      ) : (
        <>
          <TemplateStrip
            template={template || 'modern-news'}
            setTemplate={setTemplate}
            slideCount={content.slides.length}
            generatedAt={savedAt}
            onRegenerateAll={runGenerate}
          />
          <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
            <CarouselSlidePreview
              slides={content.slides}
              currentIndex={slideIndex}
              onSelect={setSlideIndex}
              kicker={[article.category, article.district].filter(Boolean).join(' · ').toUpperCase() || 'AMSTERDAM'}
            />
            <CarouselSlideEditor
              content={content}
              slideIndex={slideIndex}
              onChangeSlide={patchSlide}
              onRegenerateSlide={doRegenerateSlide}
              regenerating={regenBusy}
              onChangeCaption={patchCaption}
              onChangeHashtags={patchHashtags}
            />
          </div>
          <BottomBar status={status} onReady={doMarkReady} onPublish={() => setPublishOpen(true)} />
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
