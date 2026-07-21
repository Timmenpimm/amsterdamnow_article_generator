'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Article, BoardData, ImageCandidate, ListArticleStructure, MediaRef } from '@/lib/types';
import { articlePhase, imageCount, listImagesReady, REQUIRED_IMAGES } from '@/lib/types';
import { toast } from './toast';

function allMedia(a: Article): MediaRef[] {
  return [...(a.featured ? [a.featured] : []), ...a.slider, ...(a.inline ? [a.inline] : [])];
}

type UploadTarget = 'featured' | 'slider' | 'inline' | number; // number = item-index van een lijstartikel

export default function ArticleDetail({ id }: { id: number }) {
  const router = useRouter();
  const [article, setArticle] = useState<Article | null>(null);
  const [list, setList] = useState<ListArticleStructure | null>(null);
  const [worklist, setWorklist] = useState<Article[]>([]);
  // Per artikel in de werkvoorraad: klaar-status + voortgangslabel. Lijst-
  // artikelen volgen de itemfoto-regel, standaardartikelen de x/3-telling.
  const [worklistMeta, setWorklistMeta] = useState<Record<number, { ready: boolean; label: string }>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState<UploadTarget | null>(null);
  const [fotograaf, setFotograaf] = useState('');
  const [candidates, setCandidates] = useState<ImageCandidate[]>([]);
  const [suggestPhase, setSuggestPhase] = useState('');   // '' = niet bezig
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadRole = useRef<UploadTarget>('slider');

  const load = useCallback(async () => {
    try {
      const [aRes, bRes] = await Promise.all([fetch(`/api/articles/${id}`), fetch('/api/board')]);
      if (!aRes.ok) throw new Error((await aRes.json()).error || 'Artikel niet gevonden');
      const payload = await aRes.json();
      const a = payload.article as Article;
      setArticle(a);
      setList((payload.list as ListArticleStructure) || null);
      setFotograaf(a.fotograaf);
      const board = (await bRes.json()) as BoardData;
      const meta: Record<number, { ready: boolean; label: string }> = {};
      const drafts = board.articles.filter(x => x.status === 'draft');
      for (const d of drafts) {
        const lc = board.lists?.[d.id];
        meta[d.id] = lc
          ? { ready: listImagesReady(d, lc), label: `${lc.withMedia}/${lc.items} itemfoto's` }
          : { ready: imageCount(d) >= REQUIRED_IMAGES, label: `${imageCount(d)}/${REQUIRED_IMAGES} beelden` };
      }
      setWorklistMeta(meta);
      setWorklist([
        ...drafts.filter(x => !meta[x.id].ready),
        ...drafts.filter(x => meta[x.id].ready),
      ]);
      setError('');
    } catch (e: any) {
      setError(e.message);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Eerder gevonden kandidaat-beelden meteen tonen bij openen van het scherm.
  useEffect(() => {
    let stop = false;
    fetch(`/api/articles/${id}/candidates`)
      .then(r => r.json())
      .then(d => { if (!stop && Array.isArray(d.candidates)) setCandidates(d.candidates); })
      .catch(() => { /* paneel blijft gewoon leeg */ });
    return () => { stop = true; };
  }, [id]);

  // Vers artikel zonder beelden? Dan vult Claude alvast de beste 3 in
  // (zelfde autofill als het bord op de achtergrond draait; de server
  // bewaakt dat al-aangeraakt werk wordt overgeslagen). Bij lijstartikelen
  // gaat de loop daarna door met de itemfoto's: per aanroep vult de server
  // maximaal één item (60s-limiet), dus we blijven aanroepen tot done.
  const autofillTried = useRef(false);
  useEffect(() => {
    if (!article || autofillTried.current) return;
    if (article.status !== 'draft') return;
    const itemsMissing = Boolean(list && list.items.some(i => !i.media));
    if (imageCount(article, list) > 0 && !itemsMissing) return;
    autofillTried.current = true;
    (async () => {
      try {
        // Zoeken + scorebatches + plaatsen (±6 tikken) plus bij een lijst
        // één tik per itemfoto.
        const maxTicks = 10 + (list ? list.items.length + 2 : 0);
        let placedTotal = 0;
        let itemsFilled = 0;
        let label = 'Claude vult alvast beelden in… (zoeken)';
        for (let tick = 0; tick < maxTicks; tick++) {
          setSuggestPhase(label);
          const res = await fetch(`/api/articles/${article.id}/candidates/autofill`, { method: 'POST' });
          const body = await res.json();
          if (!res.ok) throw new Error(body.error);
          if (body.placed > 0) placedTotal += body.placed;
          if (body.filledItem) itemsFilled += 1;
          if (body.filledItem || body.skippedItem || body.step === 'place') await load();
          label = body.step === 'place' || body.step === 'item'
            ? `Claude zoekt itemfoto's… nog ${body.remainingItems ?? '?'} item${body.remainingItems === 1 ? '' : 's'}`
            : 'Claude vult alvast beelden in… (beoordelen)';
          if (body.done) {
            if (body.eligible === false) return; // redactie was hier al — niets doen
            if (placedTotal > 0) {
              toast(itemsFilled > 0
                ? `Beelden ingevuld — waarvan ${itemsFilled} itemfoto${itemsFilled > 1 ? "'s" : ''}. Vervang of vul aan waar nodig`
                : `${placedTotal} beelden alvast ingevuld — vervang of vul aan waar nodig`);
              await load();
            }
            const cRes = await fetch(`/api/articles/${article.id}/candidates`);
            const cData = await cRes.json();
            if (Array.isArray(cData.candidates)) setCandidates(cData.candidates);
            return;
          }
        }
      } catch (e: any) {
        toast(e.message, { kind: 'error' });
      } finally {
        setSuggestPhase('');
      }
    })();
  }, [article, list, load]);

  // Zoeken + scoren. Scoren gaat in tikken van max 12 beelden (één
  // Claude-call per request i.v.m. de serverless-limiet).
  async function suggestImages() {
    if (suggestPhase) return;
    try {
      setSuggestPhase('Zoeken bij Openverse, Wikimedia Commons, Pexels en Google…');
      const sRes = await fetch(`/api/articles/${id}/candidates/search`, { method: 'POST' });
      const sData = await sRes.json();
      if (!sRes.ok) throw new Error(sData.error);
      setCandidates(sData.candidates);
      if (sData.errors?.length) toast(`Niet alle bronnen deden mee: ${sData.errors.join(' · ')}`, { kind: 'error' });

      let remaining = (sData.candidates as ImageCandidate[]).filter(c => c.status === 'new').length;
      let safety = 6;
      while (remaining > 0 && safety-- > 0) {
        setSuggestPhase(`Claude beoordeelt de beelden… nog ${remaining} te gaan`);
        const res = await fetch(`/api/articles/${id}/candidates/score`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        setCandidates(data.candidates);
        remaining = data.remaining;
      }
    } catch (e: any) {
      toast(e.message, { kind: 'error' });
    } finally {
      setSuggestPhase('');
    }
  }

  // Kandidaat in een slot zetten via de bestaande media-endpoints; daarna de
  // kandidaat op 'used' en — als het veld leeg is — de fotograaf invullen
  // (naamsvermelding hoort bij CC BY).
  async function useCandidate(c: ImageCandidate, target: UploadTarget) {
    if (!article) return;
    setBusy(true);
    try {
      const endpoint = typeof target === 'number'
        ? `/api/articles/${article.id}/item-media?item=${target}`
        : `/api/articles/${article.id}/media?role=${target}`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: c.url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setArticle(data.article);
      if (data.list) setList(data.list);
      const credit = [c.author, c.source, c.license].filter(Boolean).join(' · ');
      if (!fotograaf.trim() && credit) {
        setFotograaf(credit);
        await fetch(`/api/articles/${article.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fotograaf: credit, knownMedia: allMedia(data.article) }),
        }).catch(() => { /* credit staat in elk geval in het veld */ });
      }
      await patchCandidate(c.id, 'used');
      const slotLabel = target === 'featured' ? 'featured' : target === 'inline' ? 'inline in tekst' : 'slider';
      toast(typeof target === 'number' ? 'Kandidaat als itemfoto gezet' : `Kandidaat naar ${slotLabel}`);
    } catch (e: any) {
      toast(e.message, { kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function patchCandidate(candidateId: number, status: 'used' | 'dismissed') {
    const res = await fetch(`/api/articles/${id}/candidates`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidateId, status }),
    });
    const data = await res.json();
    if (res.ok) setCandidates(data.candidates);
  }

  async function patch(body: Record<string, unknown>) {
    if (!article) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/articles/${article.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, knownMedia: allMedia(article) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setArticle(data.article);
    } catch (e: any) {
      toast(e.message, { kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  // Verklein grote foto's client-side (max 2400px, JPEG) — houdt uploads klein
  // genoeg voor de serverless request-limiet en scheelt bandbreedte.
  async function shrinkImage(file: File): Promise<File> {
    if (!file.type.startsWith('image/') || file.size < 1.5 * 1024 * 1024) return file;
    try {
      const bitmap = await createImageBitmap(file);
      const MAX = 2400;
      const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob: Blob | null = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.85));
      if (!blob || blob.size >= file.size) return file;
      return new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' });
    } catch {
      return file;
    }
  }

  async function uploadFiles(files: FileList | File[], role: UploadTarget) {
    if (!article || !files.length) return;
    setBusy(true);
    try {
      if (typeof role === 'number') {
        // Itemfoto van een lijstartikel: één foto per item; de content wordt
        // server-side opnieuw geassembleerd met de foto op de juiste plek.
        const form = new FormData();
        form.append('files', await shrinkImage(Array.from(files)[0]));
        const res = await fetch(`/api/articles/${article.id}/item-media?item=${role}`, { method: 'POST', body: form });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        setArticle(data.article);
        setList(data.list);
        toast(`Foto gezet bij "${data.list?.items?.[role]?.naam || 'item'}"`);
        return;
      }
      const form = new FormData();
      for (const f of Array.from(files)) form.append('files', await shrinkImage(f));
      const res = await fetch(`/api/articles/${article.id}/media?role=${role}`, { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setArticle(data.article);
      toast(`${Array.from(files).length > 1 ? `${files.length} beelden` : 'Beeld'} geüpload naar de mediabibliotheek`);
    } catch (e: any) {
      toast(e.message, { kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function uploadUrl(role: UploadTarget) {
    if (!article) return;
    const url = prompt('Plak de URL van de afbeelding:');
    if (!url?.trim()) return;
    setBusy(true);
    try {
      const endpoint = typeof role === 'number'
        ? `/api/articles/${article.id}/item-media?item=${role}`
        : `/api/articles/${article.id}/media?role=${role}`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setArticle(data.article);
      if (data.list) setList(data.list);
      toast('Beeld toegevoegd vanaf URL');
    } catch (e: any) {
      toast(e.message, { kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function removeItemMedia(index: number) {
    if (!article) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/articles/${article.id}/item-media?item=${index}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remove: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setArticle(data.article);
      setList(data.list);
    } catch (e: any) {
      toast(e.message, { kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  function pickFiles(role: UploadTarget) {
    uploadRole.current = role;
    fileInput.current?.click();
  }

  async function publish() {
    if (!article) return;
    if (!confirm(`"${article.title}" publiceren op amsterdamnow.com?`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/articles/${article.id}/publish`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast('Gepubliceerd — live op de site');
      router.push('/');
    } catch (e: any) {
      toast(e.message, { kind: 'error' });
      setBusy(false);
    }
  }

  if (error) {
    return (
      <div style={{ padding: 40 }}>
        <div className="card" style={{ maxWidth: 480, padding: 16, borderColor: 'var(--red-border)' }}>
          <div style={{ fontWeight: 800, color: 'var(--red-dark)' }}>Kan artikel niet laden</div>
          <div style={{ fontSize: 12.5, color: 'var(--gray)', marginTop: 6 }}>{error}</div>
          <Link href="/"><button className="btn" style={{ marginTop: 12 }}>← Terug naar Pipeline</button></Link>
        </div>
      </div>
    );
  }
  if (!article) {
    return <div style={{ padding: 40, color: 'var(--gray)', fontSize: 13 }}>Laden…</div>;
  }

  const count = imageCount(article, list);
  // Klaar-regel: standaard = 3 beelden; lijst = featured + ≥1 slider + élk
  // item een foto (zelfde regel als articlePhase/listImagesReady).
  const listCounts = list
    ? { items: list.items.length, withMedia: list.items.filter(i => i.media).length }
    : null;
  const complete = listCounts
    ? listImagesReady(article, listCounts)
    : count >= REQUIRED_IMAGES;
  // Voortgang voor de teller/balk: bij een lijst tellen de "slots" featured,
  // slider (minimaal 1) en elk item; standaard blijft x/3.
  const totalSlots = listCounts ? 2 + listCounts.items : REQUIRED_IMAGES;
  const filledSlots = listCounts
    ? (article.featured ? 1 : 0) + (article.slider.length >= 1 ? 1 : 0) + listCounts.withMedia
    : count;
  const listMissing = listCounts
    ? [
        ...(!article.featured ? ['featured'] : []),
        ...(article.slider.length < 1 ? ['slider'] : []),
        ...(listCounts.withMedia < listCounts.items
          ? [`${listCounts.items - listCounts.withMedia} itemfoto${listCounts.items - listCounts.withMedia > 1 ? "'s" : ''}`]
          : []),
      ]
    : [];
  const idx = worklist.findIndex(a => a.id === article.id);
  const prev = idx > 0 ? worklist[idx - 1] : null;
  const next = idx >= 0 && idx < worklist.length - 1 ? worklist[idx + 1] : null;
  const needList = worklist.filter(a => !worklistMeta[a.id]?.ready);
  const readyList = worklist.filter(a => worklistMeta[a.id]?.ready);
  const sliderMissing = Math.max(0, 1 - article.slider.length);
  // Gebruikte en afgewezen kandidaten verdwijnen uit de grid; gescoorde staan
  // op volgorde van score (de db-query sorteert al).
  const visibleCandidates = candidates.filter(c => c.status === 'new' || c.status === 'scored');

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--panel)' }}>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={e => {
          if (e.target.files?.length) uploadFiles(e.target.files, uploadRole.current);
          e.target.value = '';
        }}
      />

      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '12px 20px', borderBottom: '1px solid var(--border-light)', background: 'var(--card)', flexShrink: 0 }}>
        <Link href="/" style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--gray)' }}>← Pipeline</Link>
        <span style={{ width: 1, height: 18, background: 'var(--border-light)' }} />
        <span style={{ fontSize: 13.5, fontWeight: 700 }}>Beeldwerk</span>
        <span style={{ fontSize: 12.5, color: 'var(--gray)' }}>
          {idx >= 0 ? `artikel ${idx + 1} van ${worklist.length} in de werkvoorraad` : ''}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {(article.status === 'publish' || articlePhase(article, list) === 'ready') && (
            <Link href={`/carousel/${article.id}`} className="btn-small">
              Maak Instagram-carousel
            </Link>
          )}
          <button className="btn-small" disabled={!prev} style={{ opacity: prev ? 1 : 0.45 }} onClick={() => prev && router.push(`/artikel/${prev.id}`)}>
            ↑ vorige
          </button>
          <button className="btn-small" disabled={!next} style={{ opacity: next ? 1 : 0.45 }} onClick={() => next && router.push(`/artikel/${next.id}`)}>
            volgende ↓
          </button>
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* linkerlijst */}
        <div className="desktop-only">
          <div style={{ width: 296, flexShrink: 0, borderRight: '1px solid var(--border-light)', background: 'var(--sidebar)', display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
            <div style={{ padding: '14px 16px 8px', fontSize: 11.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--amber-dark)' }}>
              Beelden nodig · {needList.length}
            </div>
            {needList.map(a => <WorklistRow key={a.id} a={a} current={a.id === article.id} ready={false} label={worklistMeta[a.id]?.label || ''} />)}
            <div style={{ padding: '16px 16px 8px', fontSize: 11.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--green-dark)' }}>
              Klaar voor publicatie · {readyList.length}
            </div>
            {readyList.map(a => <WorklistRow key={a.id} a={a} current={a.id === article.id} ready label={worklistMeta[a.id]?.label || ''} />)}
          </div>
        </div>

        {/* artikel-preview */}
        <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', background: 'var(--card)', padding: '24px 44px', borderRight: '1px solid var(--border-light)' }}>
          <div style={{ maxWidth: 620, display: 'flex', flexDirection: 'column', gap: 13 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--red)' }}>
                {article.category || 'Geen categorie'}
              </span>
              {article.district && (
                <>
                  <span style={{ color: 'var(--faint)' }}>·</span>
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--gray)' }}>{article.district}</span>
                </>
              )}
              {article.rubriek && (
                <>
                  <span style={{ color: 'var(--faint)' }}>·</span>
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--gray)' }}>Rubriek: {article.rubriek}</span>
                </>
              )}
              <a
                href={`https://www.amsterdamnow.com/wp-admin/post.php?post=${article.id}&action=edit`}
                target="_blank"
                rel="noreferrer"
                style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600, color: 'var(--gray)', textDecoration: 'underline' }}
              >
                Tekst bewerken in WordPress ↗
              </a>
            </div>
            <h1 style={{ fontSize: 30, fontWeight: 800, lineHeight: 1.12, letterSpacing: '-0.015em', margin: 0 }}>{article.title}</h1>
            {article.subregel && (
              <div style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--text-soft)' }}>{article.subregel}</div>
            )}
            {article.intro && <div style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.55 }}>{article.intro}</div>}
            <div
              className="article-body"
              style={{ fontSize: 14.5, lineHeight: 1.65, color: 'var(--text)' }}
              dangerouslySetInnerHTML={{ __html: article.contentHtml }}
            />
            <style>{`
              .article-body h2 { font-size: 15px; font-weight: 700; line-height: 1.55; color: var(--ink); margin: 0 0 4px; }
              .article-body p { margin: 0 0 13px; }
              .article-body img { max-width: 100%; height: auto; border-radius: 8px; }
              .article-body blockquote {
                border-left: 3px solid var(--ink); margin: 4px 0 13px; padding: 4px 0 4px 18px;
                font-size: 17px; font-weight: 700; line-height: 1.45; font-style: italic;
              }
              .article-body blockquote p { margin: 0; }
            `}</style>

            {/* artikelgegevens */}
            <div style={{ marginTop: 8, border: '1px solid var(--border-light)', borderRadius: 10, padding: '16px 18px', background: 'var(--panel)' }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--gray)', marginBottom: 12 }}>
                Artikelgegevens — door de AI ingevuld · alleen-lezen, corrigeren in WordPress
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 24px', fontSize: 13 }}>
                <Meta k="Locatie" v={article.naam_locatie} />
                <Meta k="Adres" v={article.adres} />
                <Meta k="Website" v={article.website.replace(/^https?:\/\//, '')} />
                <Meta k="Kaart" v={article.cordA && article.cordB ? `${article.cordB}, ${article.cordA} ✓` : ''} />
                <Meta k="Tags" v={article.tags.join(', ')} />
                <Meta k="Stad" v={article.stad} />
                <Meta k="Focus keyword" v={article.focusKeyword} />
                <Meta k="Slug" v={article.slug ? `/${article.slug}/` : ''} />
                <Meta k="SEO-titel" v={article.seoTitle} wide />
                <Meta k="Meta description" v={article.metaDescription} wide ellipsis />
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap', alignItems: 'center' }}>
                <Flag on={article.flags.new_in_town} label="New in town" />
                <Flag on={article.flags.featured_item} label="Featured item" />
                <Flag on={article.flags.beste_van_amsterdam} label="Beste van Amsterdam" />
                <Flag on={article.flags.homepage_carousel} label="Homepage-carrousel" />
              </div>
            </div>
          </div>
        </div>

        {/* beeldwerk-paneel */}
        <div style={{ width: 'min(560px, 42vw)', flexShrink: 0, background: 'var(--sidebar)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ flex: 1, overflowY: 'auto', padding: '24px 24px 12px', display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 15, fontWeight: 800 }}>Beelden</span>
              <span className={complete ? 'chip-green' : 'chip-amber'} style={{ fontSize: 12 }}>
                {complete
                  ? `✓ ${count} beelden`
                  : listCounts
                    ? `${listCounts.withMedia}/${listCounts.items} itemfoto's`
                    : `${count} van ${REQUIRED_IMAGES} verplicht`}
              </span>
              <div style={{ flex: 1, height: 4, background: 'var(--border-light)', borderRadius: 2, overflow: 'hidden' }}>
                <div
                  style={{
                    width: `${Math.min(100, (filledSlots / totalSlots) * 100)}%`, height: '100%',
                    background: complete ? 'var(--green)' : 'var(--amber)',
                  }}
                />
              </div>
            </div>

            {/* featured */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase' }}>1 · Featured image</span>
                <span style={{ fontSize: 11, color: 'var(--gray)' }}>de hoofdfoto op de site</span>
                <span style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 700, color: article.featured ? 'var(--green-dark)' : 'var(--amber-dark)' }}>
                  {article.featured ? '✓ gevuld' : 'nog leeg'}
                </span>
              </div>
              {article.featured ? (
                <div style={{ position: 'relative', borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border)' }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={article.featured.url} alt="Featured image" style={{ width: '100%', height: 280, objectFit: 'cover', display: 'block' }} />
                  <div style={{ position: 'absolute', right: 10, top: 10, display: 'flex', gap: 6 }}>
                    <OverlayBtn onClick={() => pickFiles('featured')}>Vervangen</OverlayBtn>
                    <OverlayBtn
                      onClick={() =>
                        patch({
                          featuredId: null,
                          sliderIds: [...article.slider.map(m => m.id), article.featured!.id],
                        })
                      }
                    >
                      ↓ naar slider
                    </OverlayBtn>
                  </div>
                  <div style={{ position: 'absolute', left: 10, bottom: 10, fontSize: 10.5, fontWeight: 800, letterSpacing: '0.08em', background: '#fff', padding: '4px 8px', borderRadius: 5 }}>
                    FEATURED
                  </div>
                </div>
              ) : (
                <DropSlot
                  height={220}
                  active={dragOver === 'featured'}
                  onDragState={s => setDragOver(s ? 'featured' : null)}
                  onFiles={files => uploadFiles(files, 'featured')}
                  onClick={() => pickFiles('featured')}
                  onUrl={() => uploadUrl('featured')}
                  label="Sleep de hoofdfoto hierheen"
                />
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                <span style={{ color: 'var(--gray)', flexShrink: 0 }}>Fotograaf</span>
                <input
                  value={fotograaf}
                  onChange={e => setFotograaf(e.target.value)}
                  onBlur={() => fotograaf !== article.fotograaf && patch({ fotograaf })}
                  placeholder="naam of bron…"
                  style={{
                    flex: 1, border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px',
                    background: 'var(--card)', fontWeight: 600, fontSize: 12.5, outline: 'none',
                  }}
                />
                <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>ACF · fotograaf</span>
              </div>
            </div>

            {/* slider */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase' }}>2 · Slider</span>
                <span style={{ fontSize: 11, color: 'var(--gray)' }}>1 foto · meer mag, volgorde = slider-volgorde</span>
                <span style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 700, color: sliderMissing ? 'var(--amber-dark)' : 'var(--green-dark)' }}>
                  {sliderMissing ? `nog ${sliderMissing} nodig` : `✓ ${article.slider.length} foto's`}
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {article.slider.map((m, i) => (
                  <div key={m.id} style={{ position: 'relative', borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border)' }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={m.url} alt={`slider ${i + 1}`} style={{ width: '100%', height: 190, objectFit: 'cover', display: 'block' }} />
                    <div style={{ position: 'absolute', right: 8, top: 8, display: 'flex', gap: 5 }}>
                      {i > 0 && (
                        <OverlayBtn
                          title="Naar voren"
                          onClick={() => {
                            const ids = article.slider.map(x => x.id);
                            [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
                            patch({ sliderIds: ids });
                          }}
                        >
                          ←
                        </OverlayBtn>
                      )}
                      <OverlayBtn
                        title="Maak featured"
                        onClick={() => {
                          const rest = article.slider.filter(x => x.id !== m.id).map(x => x.id);
                          if (article.featured) rest.push(article.featured.id);
                          patch({ featuredId: m.id, sliderIds: rest });
                        }}
                      >
                        ★
                      </OverlayBtn>
                      {!list && (
                        <OverlayBtn
                          title="Naar inline in tekst"
                          onClick={() => patch({ sliderIds: article.slider.filter(x => x.id !== m.id).map(x => x.id), inlineId: m.id })}
                        >
                          ▸ inline
                        </OverlayBtn>
                      )}
                      <OverlayBtn
                        title="Verwijderen uit slider"
                        onClick={() => patch({ sliderIds: article.slider.filter(x => x.id !== m.id).map(x => x.id) })}
                      >
                        ✕
                      </OverlayBtn>
                    </div>
                    <div style={{ position: 'absolute', left: 8, bottom: 8, fontSize: 10.5, fontWeight: 800, background: 'rgba(255,255,255,0.92)', padding: '3px 7px', borderRadius: 5 }}>
                      {i + 1}
                    </div>
                  </div>
                ))}
                <DropSlot
                  height={190}
                  active={dragOver === 'slider'}
                  onDragState={s => setDragOver(s ? 'slider' : null)}
                  onFiles={files => uploadFiles(files, 'slider')}
                  onClick={() => pickFiles('slider')}
                  onUrl={() => uploadUrl('slider')}
                  label="Sleep de sliderfoto hierheen"
                />
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--gray)' }}>Uploads gaan direct naar de WordPress-mediabibliotheek.</div>
            </div>

            {/* inline in tekst (alleen standaardartikelen) */}
            {!list && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase' }}>3 · Inline in tekst</span>
                  <span style={{ fontSize: 11, color: 'var(--gray)' }}>verschijnt tussen alinea 2 en 3</span>
                  <span style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 700, color: article.inline ? 'var(--green-dark)' : 'var(--amber-dark)' }}>
                    {article.inline ? '✓ gevuld' : 'nog leeg'}
                  </span>
                </div>
                {article.inline ? (
                  <div style={{ position: 'relative', borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border)' }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={article.inline.url} alt="Inline-beeld" style={{ width: '100%', height: 220, objectFit: 'cover', display: 'block' }} />
                    <div style={{ position: 'absolute', right: 10, top: 10, display: 'flex', gap: 6 }}>
                      <OverlayBtn onClick={() => pickFiles('inline')}>Vervangen</OverlayBtn>
                      <OverlayBtn
                        onClick={() => patch({ inlineId: null, sliderIds: [...article.slider.map(m => m.id), article.inline!.id] })}
                      >
                        ↓ naar slider
                      </OverlayBtn>
                      <OverlayBtn title="Verwijderen" onClick={() => patch({ inlineId: null })}>✕</OverlayBtn>
                    </div>
                    <div style={{ position: 'absolute', left: 10, bottom: 10, fontSize: 10.5, fontWeight: 800, letterSpacing: '0.08em', background: '#fff', padding: '4px 8px', borderRadius: 5 }}>
                      INLINE
                    </div>
                  </div>
                ) : (
                  <DropSlot
                    height={200}
                    active={dragOver === 'inline'}
                    onDragState={s => setDragOver(s ? 'inline' : null)}
                    onFiles={files => uploadFiles(files, 'inline')}
                    onClick={() => pickFiles('inline')}
                    onUrl={() => uploadUrl('inline')}
                    label="Sleep het inline-beeld hierheen"
                  />
                )}
                <div style={{ fontSize: 11.5, color: 'var(--gray)' }}>Komt als losse afbeelding tussen de 2e en 3e alinea van het artikel.</div>
              </div>
            )}

            {/* itemfoto's (lijstartikelen) */}
            {list && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase' }}>3 · Itemfoto&apos;s</span>
                  <span style={{ fontSize: 11, color: 'var(--gray)' }}>per item één foto, komt in de tekst onder het item</span>
                  <span style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 700, color: list.items.every(i => i.media) ? 'var(--green-dark)' : 'var(--amber-dark)' }}>
                    {list.items.filter(i => i.media).length}/{list.items.length} gevuld
                  </span>
                </div>
                {list.meldingen?.length > 0 && (
                  <div style={{ background: 'var(--amber-bg)', border: '1px solid var(--amber-border)', borderRadius: 8, padding: '9px 12px', fontSize: 12, color: 'var(--amber-dark)', lineHeight: 1.45 }}>
                    {list.meldingen.map((m, i) => <div key={i}>⚠ {m}</div>)}
                  </div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {list.items.map((item, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid var(--border-light)', borderRadius: 8, background: 'var(--card)', padding: 8 }}>
                      {item.media ? (
                        <div style={{ position: 'relative', flexShrink: 0 }}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={item.media.url} alt={item.naam} style={{ width: 96, height: 64, objectFit: 'cover', borderRadius: 6, display: 'block' }} />
                        </div>
                      ) : (
                        <div
                          className={dragOver === i ? 'dropzone-active' : ''}
                          style={{
                            width: 96, height: 64, border: '1.5px dashed #b7b5ae', borderRadius: 6, flexShrink: 0,
                            display: 'grid', placeItems: 'center', fontSize: 18, color: 'var(--muted)', cursor: 'pointer', background: 'var(--panel)',
                          }}
                          onClick={() => pickFiles(i)}
                          onDragOver={e => { e.preventDefault(); setDragOver(i); }}
                          onDragLeave={() => setDragOver(v => (v === i ? null : v))}
                          onDrop={e => {
                            e.preventDefault();
                            setDragOver(null);
                            if (e.dataTransfer.files?.length) uploadFiles(e.dataTransfer.files, i);
                          }}
                        >
                          ＋
                        </div>
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 700, lineHeight: 1.3 }}>{i + 1} · {item.naam}</div>
                        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {[item.adres, item.buurt].filter(Boolean).join(', ')}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                        {item.media ? (
                          <>
                            <button className="btn-small" style={{ fontSize: 11.5, padding: '5px 9px' }} onClick={() => pickFiles(i)}>Vervangen</button>
                            <button className="btn-small" style={{ fontSize: 11.5, padding: '5px 9px' }} title="Foto weghalen" onClick={() => removeItemMedia(i)}>✕</button>
                          </>
                        ) : (
                          <button
                            className="btn-small"
                            style={{ fontSize: 11.5, padding: '5px 9px' }}
                            onClick={() => uploadUrl(i)}
                          >
                            URL
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* beeldselectie: voorgestelde rechtenvrije kandidaten */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  4 · Voorgestelde beelden
                </span>
                <span style={{ fontSize: 11, color: 'var(--gray)' }}>rechtenvrij · minimaal 1000×1000</span>
                <button
                  className="btn-small"
                  style={{ marginLeft: 'auto', fontSize: 11.5, padding: '5px 10px', opacity: suggestPhase ? 0.6 : 1 }}
                  disabled={!!suggestPhase}
                  onClick={suggestImages}
                >
                  {suggestPhase ? 'Bezig…' : visibleCandidates.length ? '↻ Meer alternatieven' : 'Zoek kandidaten'}
                </button>
              </div>

              {suggestPhase && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--blue-dark)' }}>
                  <span style={{ width: 60, height: 3, background: 'var(--border-light)', borderRadius: 2, overflow: 'hidden', flexShrink: 0 }}>
                    <span style={{ display: 'block', width: '45%', height: '100%', background: 'var(--blue)' }} />
                  </span>
                  {suggestPhase}
                </div>
              )}

              {!suggestPhase && !visibleCandidates.length && (
                <div style={{ border: '1px dashed var(--border)', borderRadius: 10, padding: '12px 14px', fontSize: 12, color: 'var(--gray)', lineHeight: 1.45, background: 'rgba(255,255,255,0.5)' }}>
                  Bij een vers artikel vult Claude de beste 3 beelden automatisch in. &quot;Zoek kandidaten&quot;
                  doorzoekt Openverse, Wikimedia Commons, Pexels en Google (met rechtenfilter) op{' '}
                  {article.naam_locatie ? `"${article.naam_locatie}"` : 'het onderwerp'} als je zelf
                  (meer) alternatieven wilt bekijken.
                </div>
              )}

              {visibleCandidates.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  {visibleCandidates.map(c => (
                    <CandidateCard
                      key={c.id}
                      c={c}
                      busy={busy}
                      items={list?.items.map(it => it.naam) || null}
                      onUse={target => useCandidate(c, target)}
                      onDismiss={() => patchCandidate(c.id, 'dismissed')}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* publicatiebalk */}
          <div style={{ borderTop: '1px solid var(--border-light)', background: 'var(--card)', padding: '14px 24px', display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0 }}>
            <div style={{ fontSize: 12.5, lineHeight: 1.4 }}>
              {complete ? (
                <>
                  <span style={{ fontWeight: 800, color: 'var(--green-dark)' }}>✓ Beelden compleet</span>
                  <br />
                  <span style={{ color: 'var(--gray)' }}>klaar om te publiceren op amsterdamnow.com</span>
                </>
              ) : listCounts ? (
                <>
                  <span style={{ fontWeight: 800, color: 'var(--amber-dark)' }}>
                    Nog nodig: {listMissing.join(', ')}
                  </span>
                  <br />
                  <span style={{ color: 'var(--gray)' }}>publiceren kan zodra featured, slider én alle itemfoto&apos;s gevuld zijn</span>
                </>
              ) : (
                <>
                  <span style={{ fontWeight: 800, color: 'var(--amber-dark)' }}>
                    Nog {REQUIRED_IMAGES - count} beeld{REQUIRED_IMAGES - count > 1 ? 'en' : ''} nodig
                  </span>
                  <br />
                  <span style={{ color: 'var(--gray)' }}>publiceren kan zodra {REQUIRED_IMAGES}/{REQUIRED_IMAGES} gevuld is</span>
                </>
              )}
            </div>
            <button
              className="btn-primary"
              style={{
                marginLeft: 'auto', fontSize: 13.5, padding: '11px 22px',
                background: complete ? 'var(--green-dark)' : undefined,
              }}
              disabled={!complete || busy}
              onClick={publish}
            >
              Publiceren
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function WorklistRow({ a, current, ready, label }: { a: Article; current: boolean; ready: boolean; label: string }) {
  return (
    <Link href={`/artikel/${a.id}`} style={{ display: 'block' }}>
      <div
        style={{
          display: 'flex', gap: 10, padding: '10px 16px',
          background: current ? 'var(--card)' : undefined,
          borderTop: current ? '1px solid var(--border-light)' : undefined,
          borderBottom: current ? '1px solid var(--border-light)' : undefined,
          boxShadow: current ? 'inset 3px 0 0 var(--ink)' : undefined,
        }}
      >
        {a.featured ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={a.featured.url} alt="" style={{ width: 52, height: 40, objectFit: 'cover', borderRadius: 5, flexShrink: 0 }} />
        ) : (
          <span className="hatch" style={{ width: 52, height: 40, borderRadius: 5, flexShrink: 0 }} />
        )}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: current ? 700 : 600, lineHeight: 1.3, color: current ? 'var(--ink)' : 'var(--text-soft)' }}>
            {a.title}
          </div>
          <div style={{ fontSize: 11, fontWeight: 700, marginTop: 3, color: ready ? 'var(--green-dark)' : 'var(--amber-dark)' }}>
            {ready ? '✓ compleet' : label}
          </div>
        </div>
      </div>
    </Link>
  );
}

function Meta({ k, v, wide, ellipsis }: { k: string; v: string; wide?: boolean; ellipsis?: boolean }) {
  return (
    <div
      style={{
        gridColumn: wide ? '1 / -1' : undefined, display: 'flex', justifyContent: 'space-between', gap: 12,
        borderBottom: '1px solid #eceae5', paddingBottom: 8,
      }}
    >
      <span style={{ color: 'var(--gray)', flexShrink: 0 }}>{k}</span>
      <span
        style={{
          fontWeight: 600, textAlign: 'right',
          overflow: ellipsis ? 'hidden' : undefined, textOverflow: ellipsis ? 'ellipsis' : undefined,
          whiteSpace: ellipsis ? 'nowrap' : undefined, color: v ? undefined : 'var(--muted)',
        }}
      >
        {v || '—'}
      </span>
    </div>
  );
}

function Flag({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: on ? 700 : 600,
        padding: '5px 11px', borderRadius: 999,
        background: on ? 'var(--ink)' : undefined, color: on ? '#fff' : 'var(--muted)',
        border: on ? '1px solid var(--ink)' : '1px solid var(--border-light)',
      }}
    >
      {on ? '✓ ' : ''}{label}
    </span>
  );
}

function CandidateCard({
  c, busy, items, onUse, onDismiss,
}: {
  c: ImageCandidate; busy: boolean; items: string[] | null;
  onUse: (target: UploadTarget) => void; onDismiss: () => void;
}) {
  const [showItems, setShowItems] = useState(false);
  const scored = c.score != null;
  const scoreColor = !scored ? 'var(--muted)'
    : c.score! >= 75 ? 'var(--green-dark)'
    : c.score! >= 50 ? 'var(--amber-dark)'
    : 'var(--gray)';
  return (
    <div style={{ border: '1px solid var(--border-light)', borderRadius: 10, background: 'var(--card)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <a href={c.source_page || c.url} target="_blank" rel="noreferrer" title="Bekijk bij de bron">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={c.thumb_url}
          alt={c.title || 'kandidaat'}
          style={{ width: '100%', height: 128, objectFit: 'cover', display: 'block', background: 'var(--soft)' }}
          loading="lazy"
          onError={e => {
            // Sommige bronnen (m.n. Openverse-thumbs) weigeren hotlinks;
            // val dan terug op het volledige beeld.
            const img = e.currentTarget;
            if (img.src !== c.url) img.src = c.url;
          }}
        />
      </a>
      <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 5, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11.5, fontWeight: 800, color: scoreColor }}>
            {scored ? `${c.score}` : '…'}
          </span>
          {c.role === 'featured' && <span className="chip-green" style={{ fontSize: 10 }}>tip: featured</span>}
          <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--muted)' }}>{c.width}×{c.height}</span>
        </div>
        {c.reason && (
          <div style={{ fontSize: 11, color: 'var(--gray)', lineHeight: 1.35 }}>{c.reason}</div>
        )}
        <div style={{ fontSize: 10.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {[c.source, c.author, c.license].filter(Boolean).join(' · ')}
        </div>
        <div style={{ display: 'flex', gap: 5, marginTop: 'auto', flexWrap: 'wrap' }}>
          <button className="btn-small" disabled={busy} style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => onUse('featured')}>★ Featured</button>
          <button className="btn-small" disabled={busy} style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => onUse('slider')}>+ Slider</button>
          {!items && (
            <button className="btn-small" disabled={busy} style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => onUse('inline')}>+ Inline</button>
          )}
          {items && (
            <button className="btn-small" disabled={busy} style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => setShowItems(v => !v)}>item ▾</button>
          )}
          <button className="btn-small" disabled={busy} title="Afwijzen" style={{ fontSize: 11, padding: '4px 8px', marginLeft: 'auto' }} onClick={onDismiss}>✕</button>
        </div>
        {showItems && items && (
          <div style={{ borderTop: '1px solid var(--border-light)', marginTop: 4, paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 2 }}>Koppel aan item</div>
            {items.map((naam, i) => (
              <button
                key={i}
                className="btn-small"
                disabled={busy}
                style={{ fontSize: 11, padding: '4px 8px', textAlign: 'left' }}
                onClick={() => { setShowItems(false); onUse(i); }}
              >
                {i + 1} · {naam}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function OverlayBtn({ children, onClick, title }: { children: React.ReactNode; onClick: () => void; title?: string }) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        fontSize: 11.5, fontWeight: 700, background: 'rgba(23,23,21,0.82)', color: '#fff',
        padding: '5px 10px', borderRadius: 6, border: 'none',
      }}
    >
      {children}
    </button>
  );
}

function DropSlot({
  height, active, label, onFiles, onClick, onUrl, onDragState,
}: {
  height: number; active: boolean; label: string;
  onFiles: (files: FileList) => void; onClick: () => void; onUrl: () => void;
  onDragState: (over: boolean) => void;
}) {
  return (
    <div
      className={active ? 'dropzone-active' : ''}
      style={{
        height, border: '1.5px dashed #b7b5ae', borderRadius: 10, background: 'var(--card)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 8, textAlign: 'center', padding: 14, cursor: 'pointer',
      }}
      onClick={onClick}
      onDragOver={e => { e.preventDefault(); onDragState(true); }}
      onDragLeave={() => onDragState(false)}
      onDrop={e => {
        e.preventDefault();
        onDragState(false);
        if (e.dataTransfer.files?.length) onFiles(e.dataTransfer.files);
      }}
    >
      <span style={{ fontSize: 22, color: 'var(--muted)' }}>＋</span>
      <span style={{ fontSize: 12.5, fontWeight: 700 }}>{label}</span>
      <span style={{ fontSize: 11.5, color: 'var(--gray)', lineHeight: 1.4 }}>
        meerdere tegelijk kan — of{' '}
        <span
          style={{ textDecoration: 'underline', fontWeight: 600 }}
          onClick={e => { e.stopPropagation(); onUrl(); }}
        >
          plak een afbeeldings-URL
        </span>
      </span>
    </div>
  );
}
