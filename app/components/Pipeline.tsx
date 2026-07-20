'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Article, BoardData, Topic } from '@/lib/types';
import { articlePhase, imageCount, parseListState, REQUIRED_IMAGES } from '@/lib/types';
import TopBar from './TopBar';
import BulkModal from './BulkModal';
import ListArticleModal from './ListArticleModal';
import ReviewModal from './ReviewModal';
import { toast } from './toast';

const AUTO_WRITE_STORAGE_KEY = 'artikel-tool:auto-write';

function ListBadge() {
  return (
    <span
      style={{
        fontSize: 10, fontWeight: 800, letterSpacing: '0.06em', color: 'var(--blue-dark)',
        background: '#e8eef7', padding: '2px 7px', borderRadius: 4, flexShrink: 0,
      }}
    >
      LIJST
    </span>
  );
}

function listProgress(t: Topic): string {
  const s = parseListState(t);
  if (!s) return '';
  if (t.phase === 'select' || (t.phase === 'verify' && !s.items.length)) return 'Kandidaat-items zoeken…';
  if (t.phase === 'verify') {
    const done = s.items.filter(i => i.status !== 'pending').length;
    return `Verificatie item ${Math.min(done + 1, s.items.length)}/${s.items.length}${s.rejected ? ` · ${s.rejected} afgevallen` : ''}`;
  }
  if (t.phase === 'compose') {
    const verifiedCount = s.items.filter(i => i.status === 'verified').length;
    const written = (s.composeChunks || []).reduce((n, c) => n + c.items.length, 0);
    const retry = s.composeAttempts ? ` · herkansing ${s.composeAttempts + 1}` : '';
    return written > 0 ? `Artikel wordt geschreven · ${written}/${verifiedCount} items${retry}` : `Claude schrijft het lijstartikel…${retry}`;
  }
  if (t.phase === 'finalize') return 'Valideren, interne links en SEO…';
  return '';
}

function timeLabel(iso: string): string {
  const d = new Date(iso.includes('T') || iso.includes(' ') ? iso.replace(' ', 'T') : iso);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const time = d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now.getTime() - 86400000).toDateString() === d.toDateString();
  if (sameDay) return `vandaag ${time}`;
  if (yesterday) return `gisteren ${time}`;
  return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' }) + ` ${time}`;
}

function Column({
  color, title, count, hint, children, highlight,
}: {
  color: string; title: string; count: React.ReactNode; hint?: string;
  children: React.ReactNode; highlight?: boolean;
}) {
  return (
    <div
      style={{
        width: 264, flexShrink: 0, background: highlight ? 'var(--amber-col)' : 'var(--soft)',
        borderRadius: 10, padding: 10,
        outline: highlight ? '1.5px solid var(--amber-border)' : undefined, outlineOffset: -1.5,
      }}
    >
      <div className="colhead">
        <span className="dot" style={{ background: color }} />
        <span>{title}</span>
        <span style={{ fontWeight: 600, color: 'var(--gray)', textTransform: 'none', letterSpacing: 0 }}>{count}</span>
        {hint && (
          <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--gray)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
            {hint}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</div>
    </div>
  );
}

export default function Pipeline() {
  const [data, setData] = useState<BoardData | null>(null);
  const [error, setError] = useState('');
  const [bulkOpen, setBulkOpen] = useState(false);
  const [listModalOpen, setListModalOpen] = useState(false);
  const [reviewTopicId, setReviewTopicId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editValue, setEditValue] = useState('');
  const [writingNow, setWritingNow] = useState(false);
  const writingRef = useRef(false);
  const [autoOn, setAutoOn] = useState(false);
  const autoOnFirstWrite = useRef(true);
  const dragId = useRef<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/board');
      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      setData(await res.json());
      setError('');
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 12000);
    return () => clearInterval(t);
  }, [load]);

  // Automatisch-schrijven-status overleeft een refresh: laden bij opstarten,
  // bewaren bij elke wijziging (de allereerste render — de starttoestand
  // false — slaan we over, anders overschrijft die meteen een opgeslagen
  // 'aan' voordat het geladen kan worden).
  useEffect(() => {
    if (localStorage.getItem(AUTO_WRITE_STORAGE_KEY) === '1') setAutoOn(true);
  }, []);
  useEffect(() => {
    if (autoOnFirstWrite.current) { autoOnFirstWrite.current = false; return; }
    localStorage.setItem(AUTO_WRITE_STORAGE_KEY, autoOn ? '1' : '0');
  }, [autoOn]);

  // Beeldselectie-autofill op de achtergrond: voor het eerste verse artikel
  // zonder beelden vult Claude alvast de beste 3 in (zoeken → scoren →
  // plaatsen, één stap per tik). Artikelen waar de redactie al beeldwerk aan
  // deed slaat de server over (eligible: false), dus dit raakt alleen
  // onaangeraakt werk. autofillBusy voorkomt dubbele runs bij elke poll.
  const autofillBusy = useRef(false);
  const autofillDone = useRef(new Set<number>());
  useEffect(() => {
    const fresh = (data?.articles || []).find(a =>
      a.status === 'draft'
      && imageCount(a) + (data?.lists?.[a.id]?.withMedia || 0) === 0
      && !autofillDone.current.has(a.id)
    );
    if (!fresh || autofillBusy.current) return;
    autofillBusy.current = true;
    (async () => {
      try {
        for (let tick = 0; tick < 10; tick++) {
          const res = await fetch(`/api/articles/${fresh.id}/candidates/autofill`, { method: 'POST' });
          const body = await res.json();
          if (!res.ok) throw new Error(body.error);
          if (body.done) {
            autofillDone.current.add(fresh.id);
            if (body.placed > 0) {
              toast(`Claude heeft ${body.placed} beelden alvast ingevuld bij "${fresh.title}"`);
              load();
            }
            return;
          }
        }
        autofillDone.current.add(fresh.id); // na 10 tikken niet klaar: niet blijven hameren
      } catch {
        autofillDone.current.add(fresh.id); // stil falen; handmatig zoeken kan altijd nog
      } finally {
        autofillBusy.current = false;
      }
    })();
  }, [data, load]);

  const topics = data?.topics || [];
  const queued = topics.filter(t => t.status === 'queued');
  const writing = topics.filter(t => t.status === 'writing');
  const review = topics.filter(t => t.status === 'review');
  const failed = topics.filter(t => t.status === 'failed');
  const reviewTopic = review.find(t => t.id === reviewTopicId) || null;
  const articles = data?.articles || [];
  // Itemfoto's van lijstartikelen tellen mee in de beeldenteller.
  const countFor = (a: Article) => imageCount(a) + (data?.lists?.[a.id]?.withMedia || 0);
  const phaseFor = (a: Article): 'needImages' | 'ready' | 'published' =>
    a.status === 'publish' ? 'published' : countFor(a) >= REQUIRED_IMAGES ? 'ready' : 'needImages';
  const needImages = articles.filter(a => phaseFor(a) === 'needImages');
  const ready = articles.filter(a => phaseFor(a) === 'ready');
  const today = new Date().toDateString();
  const published = articles
    .filter(a => articlePhase(a) === 'published')
    .sort((a, b) => +new Date(b.date) - +new Date(a.date));
  const publishedToday = published.filter(a => new Date(a.date).toDateString() === today);
  const publishedShown = publishedToday.length ? publishedToday : published.slice(0, 2);

  async function removeTopic(t: Topic) {
    await fetch(`/api/topics/${t.id}`, { method: 'DELETE' });
    toast('Onderwerp verwijderd', {
      undo: async () => {
        await fetch('/api/topics', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ titles: [t.title] }),
        });
        load();
      },
    });
    load();
  }

  async function cancelWriting(t: Topic) {
    if (!confirm(`"${t.title}" annuleren? Dit stopt de lopende Claude-generatie.`)) return;
    const res = await fetch(`/api/topics/${t.id}`, { method: 'DELETE' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) toast(body.error || 'Annuleren mislukt', { kind: 'error' });
    else toast('Onderwerp geannuleerd');
    load();
  }

  async function retryTopic(t: Topic) {
    await fetch(`/api/topics/${t.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'retry' }),
    });
    toast('Opnieuw in wachtrij gezet — bovenaan');
    load();
  }

  async function saveEdit(t: Topic) {
    const title = editValue.trim();
    setEditingId(null);
    if (!title || title === t.title) return;
    await fetch(`/api/topics/${t.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    load();
  }

  async function onDrop(targetId: number) {
    const from = dragId.current;
    dragId.current = null;
    setDragOverId(null);
    if (from == null || from === targetId) return;
    const ids = queued.map(t => t.id);
    const fromIdx = ids.indexOf(from);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    ids.splice(toIdx, 0, ...ids.splice(fromIdx, 1));
    setData(d => d && {
      ...d,
      topics: [
        ...ids.map(id => queued.find(t => t.id === id)!),
        ...d.topics.filter(t => t.status !== 'queued'),
      ],
    });
    const res = await fetch('/api/topics/reorder', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast(body.error || 'Volgorde opslaan mislukt', { kind: 'error' });
    }
    load();
  }

  async function publish(a: Article) {
    if (!confirm(`"${a.title}" publiceren op amsterdamnow.com?`)) return;
    const res = await fetch(`/api/articles/${a.id}/publish`, { method: 'POST' });
    const body = await res.json();
    if (!res.ok) toast(body.error, { kind: 'error' });
    else toast('Gepubliceerd — live op de site');
    load();
  }

  async function deleteArticle(a: Article) {
    if (!confirm(`"${a.title}" verwijderen? De draft gaat naar de prullenbak in WordPress.`)) return;
    const res = await fetch(`/api/articles/${a.id}`, { method: 'DELETE' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) toast(body.error || 'Verwijderen mislukt', { kind: 'error' });
    else toast('Artikel verwijderd');
    load();
  }

  async function startWriting(opts?: { silent?: boolean }) {
    if (writingRef.current) return;
    writingRef.current = true;
    setWritingNow(true);
    try {
      // Beide pipelines bestaan uit meerdere fase-stappen: blijf aanroepen tot
      // de run klaar is, op itemcontrole wacht, of de wachtrij leeg is.
      let toldBlocked = false;
      for (let tick = 0; tick < 40; tick++) {
        const res = await fetch('/api/topics/process', { method: 'POST' });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || 'Schrijven mislukt');
        if (!body.topic) {
          // blocked = er ligt werk, maar er is al een taak actief (bv. een
          // ander tabblad, of een net weggevallen tik die nog moet herstellen)
          // — geen lege wachtrij, dus even opnieuw proberen in plaats van
          // meteen opgeven.
          if (body.blocked) {
            if (!toldBlocked) { toast('Er wordt al aan een ander artikel gewerkt — heel even geduld…'); toldBlocked = true; }
            await new Promise(r => setTimeout(r, 3000));
            continue;
          }
          // Bij de auto-write-loop (opts.silent) een lege wachtrij stil overslaan.
          if (!opts?.silent) toast('De wachtrij is leeg');
          return;
        }
        const step = body.list || body.standaard;
        if (step) {
          load();
          if (!step.done) continue;
          if (step.phase === 'review') toast('Items geverifieerd — controleer de selectie op het bord');
          else if (body.article) toast(`Draft gemaakt: ${body.article.title}`);
          return;
        }
        toast(`Draft gemaakt: ${body.article.title}`);
        return;
      }
    } catch (e: any) {
      toast(e.message, { kind: 'error' });
    } finally {
      writingRef.current = false;
      setWritingNow(false);
      load();
    }
  }

  // Automatisch schrijven: zolang autoOn aan staat, elke 5 minuten een ronde
  // starten (ook met lege wachtrij — dan gebeurt er stil niets die ronde).
  // Uitzetten stopt alleen de vólgende ronde; een lopende ronde maakt af.
  useEffect(() => {
    if (!autoOn) return;
    startWriting();
    const id = setInterval(() => startWriting({ silent: true }), 5 * 60 * 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOn]);

  if (error) {
    return (
      <div>
        <TopBar mode={data?.mode} onAdded={load} onBulk={() => setBulkOpen(true)} onList={() => setListModalOpen(true)} />
        <div style={{ padding: 40, maxWidth: 560 }}>
          <div className="card" style={{ borderColor: 'var(--red-border)', padding: 16 }}>
            <div style={{ fontWeight: 800, color: 'var(--red-dark)' }}>Kan het bord niet laden</div>
            <div style={{ fontSize: 12.5, color: 'var(--gray)', marginTop: 6, fontFamily: 'var(--mono)' }}>{error}</div>
            <button className="btn" style={{ marginTop: 12 }} onClick={load}>Opnieuw proberen</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <TopBar mode={data?.mode} onAdded={load} onBulk={() => setBulkOpen(true)} onList={() => setListModalOpen(true)} />

      {data && data.persistent === false && (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '9px 20px',
            background: 'var(--amber-bg)', borderBottom: '1px solid var(--amber-border)',
            fontSize: 12.5, color: 'var(--amber-dark)',
          }}
        >
          <span style={{ fontWeight: 800 }}>Geen database gekoppeld</span>
          <span>
            — wijzigingen gaan verloren bij een nieuwe serverstart. Zet <code style={{ fontFamily: 'var(--mono)' }}>DATABASE_URL</code>{' '}
            (Supabase-connectiestring) in de Vercel-omgevingsvariabelen.
          </span>
        </div>
      )}

      {/* ============ desktop kanban ============ */}
      <div className="desktop-only">
        <div style={{ display: 'flex', gap: 12, padding: '16px 20px 20px', alignItems: 'flex-start', overflowX: 'auto', flex: 1 }}>
          {/* In wachtrij */}
          <Column color="var(--muted)" title="In wachtrij" count={queued.length} hint="volgorde = prioriteit">
            {queued.map(t => (
              <div
                key={t.id}
                className={`card queue-card${dragId.current === t.id ? ' dragging' : ''}${dragOverId === t.id ? ' dragover' : ''}`}
                style={{ padding: '10px 12px', boxShadow: '0 1px 2px rgba(20,20,18,0.04)' }}
                draggable={editingId !== t.id}
                onDragStart={() => { dragId.current = t.id; }}
                onDragOver={e => { e.preventDefault(); setDragOverId(t.id); }}
                onDragLeave={() => setDragOverId(v => (v === t.id ? null : v))}
                onDrop={() => onDrop(t.id)}
              >
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <span style={{ color: 'var(--faint)', fontSize: 13, letterSpacing: -1, cursor: 'grab', lineHeight: 1.3 }}>⠿</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {editingId === t.id ? (
                      <input
                        autoFocus
                        value={editValue}
                        onChange={e => setEditValue(e.target.value)}
                        onBlur={() => saveEdit(t)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') saveEdit(t);
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                        style={{
                          width: '100%', fontSize: 13.5, fontWeight: 600, border: '1px solid var(--ink)',
                          borderRadius: 4, padding: '2px 6px', outline: 'none',
                        }}
                      />
                    ) : (
                      <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35 }}>
                        {t.type === 'lijst' && <><ListBadge />{' '}</>}
                        {t.title}
                      </div>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 7 }}>
                      <span style={{ fontSize: 11, color: 'var(--muted)' }}>{timeLabel(t.created_at)}</span>
                      <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, fontSize: 12, color: 'var(--gray)' }}>
                        <span
                          style={{ cursor: 'pointer' }}
                          title="Bewerken"
                          onClick={() => { setEditingId(t.id); setEditValue(t.title); }}
                        >
                          ✎
                        </span>
                        <span style={{ cursor: 'pointer' }} title="Verwijderen" onClick={() => removeTopic(t)}>✕</span>
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
            {data && queued.length === 0 && (
              <div
                style={{
                  border: '1.5px dashed var(--faint)', borderRadius: 8, padding: '26px 18px', textAlign: 'center',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
                }}
              >
                <span
                  style={{
                    width: 40, height: 40, borderRadius: '50%', background: 'var(--card)',
                    border: '1px solid var(--border-light)', display: 'grid', placeItems: 'center',
                    fontSize: 18, color: 'var(--muted)',
                  }}
                >
                  ＋
                </span>
                <div style={{ fontSize: 13, fontWeight: 700 }}>De wachtrij is leeg</div>
                <div style={{ fontSize: 12, color: 'var(--gray)', lineHeight: 1.5 }}>
                  De AI heeft niets te doen. Typ een onderwerp bovenaan of plak een lijst.
                </div>
                <button
                  className="btn-primary"
                  style={{ fontSize: 12.5, padding: '8px 14px' }}
                  onClick={() => setBulkOpen(true)}
                >
                  Onderwerp toevoegen
                </button>
              </div>
            )}
          </Column>

          {/* Wordt geschreven */}
          <Column color="var(--blue)" title="Wordt geschreven" count={writing.length + review.length}>
            <button
              className="btn-primary"
              onClick={() => setAutoOn(v => !v)}
              style={{
                width: '100%', fontSize: 12.5, padding: '8px 10px',
                background: autoOn ? 'var(--blue)' : undefined,
              }}
            >
              {writingNow ? 'Claude schrijft… ⏸' : autoOn ? '⏸ Automatisch schrijven (aan)' : '▶ Automatisch schrijven'}
            </button>
            {review.map(t => {
              const s = parseListState(t);
              return (
                <div key={t.id} className="card" style={{ padding: 12, borderColor: 'var(--amber-border)', background: 'var(--amber-bg)' }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35 }}>
                    <ListBadge /> {t.title}
                  </div>
                  <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--amber-dark)', marginTop: 7 }}>
                    ✓ {s?.verified ?? 0} items geverifieerd{s?.rejected ? ` · ${s.rejected} afgevallen` : ''}
                  </div>
                  <button
                    className="btn-primary"
                    style={{ marginTop: 10, width: '100%', fontSize: 12.5, fontWeight: 700, padding: 8, borderRadius: 6 }}
                    onClick={() => setReviewTopicId(t.id)}
                  >
                    Items controleren →
                  </button>
                </div>
              );
            })}
            {writing.map(t => (
              <div key={t.id} className="card" style={{ padding: 12 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600, lineHeight: 1.35 }}>
                    {t.type === 'lijst' && <><ListBadge />{' '}</>}
                    {t.title}
                  </div>
                  <span
                    style={{ cursor: 'pointer', fontSize: 12, color: 'var(--gray)', flexShrink: 0 }}
                    title="Annuleren"
                    onClick={() => cancelWriting(t)}
                  >
                    ✕
                  </span>
                </div>
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ height: 4, background: '#eceae5', borderRadius: 2, overflow: 'hidden' }}>
                    <div className="progress-pulse" style={{ width: '62%', height: '100%', background: 'var(--blue)', borderRadius: 2 }} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: 'var(--gray)' }}>
                    <span style={{ fontWeight: 600, color: 'var(--blue-dark)' }}>
                      {t.type === 'lijst' ? listProgress(t) : 'Research → schrijven → SEO…'}
                    </span>
                    <span>{t.started_at ? `gestart ${timeLabel(t.started_at)}` : ''}</span>
                  </div>
                </div>
              </div>
            ))}
            {writing.length === 0 && (
              <div style={{ fontSize: 11.5, color: 'var(--muted)', textAlign: 'center', padding: '14px 6px' }}>
                nu geen artikel in de maak
              </div>
            )}
            <div style={{ fontSize: 11.5, color: 'var(--muted)', textAlign: 'center', padding: 6 }}>
              Claude onderzoekt, schrijft en vult SEO in. Daarna staat de draft klaar voor beeldwerk.
            </div>
          </Column>

          {/* Beelden nodig */}
          <Column color="var(--amber)" title="Klaar — beelden nodig" count={needImages.length} highlight>
            {needImages.map(a => {
              const count = countFor(a);
              return (
                <div key={a.id} className="card" style={{ overflow: 'hidden' }}>
                  {a.featured && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={a.featured.url} alt="" style={{ width: '100%', height: 96, objectFit: 'cover', display: 'block' }} />
                  )}
                  <div style={{ padding: '10px 12px 12px' }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35 }}>{a.title}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 9 }}>
                      <span className="chip-amber">{count}/{REQUIRED_IMAGES} beelden</span>
                      <span style={{ fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {[a.category, a.district.replace('Amsterdam ', '')].filter(Boolean).join(' · ')}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                      <Link href={`/artikel/${a.id}`} style={{ flex: 1 }}>
                        <button className="btn-primary" style={{ width: '100%', fontSize: 12.5, fontWeight: 700, padding: 8, borderRadius: 6 }}>
                          Beelden toevoegen →
                        </button>
                      </Link>
                      <button className="btn-small" title="Verwijderen" onClick={() => deleteArticle(a)}>✕</button>
                    </div>
                  </div>
                </div>
              );
            })}
            {data && needImages.length === 0 && (
              <div style={{ fontSize: 11.5, color: 'var(--muted)', textAlign: 'center', padding: '14px 6px' }}>
                geen artikelen die op beelden wachten
              </div>
            )}
          </Column>

          {/* Klaar voor publicatie */}
          <Column color="var(--green)" title="Klaar voor publicatie" count={ready.length}>
            {ready.map(a => (
              <div key={a.id} className="card" style={{ overflow: 'hidden' }}>
                {a.featured && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={a.featured.url} alt="" style={{ width: '100%', height: 96, objectFit: 'cover', display: 'block' }} />
                )}
                <div style={{ padding: '10px 12px 12px' }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35 }}>{a.title}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 9 }}>
                    <span className="chip-green">✓ {countFor(a)} beelden</span>
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                      {[a.category, a.district.replace('Amsterdam ', '')].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                    <button className="btn-green" onClick={() => publish(a)}>Publiceren</button>
                    <Link href={`/artikel/${a.id}`}>
                      <button className="btn-small" title="Beeldwerk bekijken">✎</button>
                    </Link>
                    <button className="btn-small" title="Verwijderen" onClick={() => deleteArticle(a)}>✕</button>
                  </div>
                </div>
              </div>
            ))}
            {data && ready.length === 0 && (
              <div style={{ fontSize: 11.5, color: 'var(--muted)', textAlign: 'center', padding: '14px 6px' }}>
                niets wacht op publicatie
              </div>
            )}
          </Column>

          {/* Gepubliceerd */}
          <Column color="var(--ink)" title="Gepubliceerd" count={publishedToday.length ? `vandaag ${publishedToday.length}` : 'recent'}>
            {publishedShown.map(a => (
              <div key={a.id} className="card" style={{ padding: '10px 12px' }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35 }}>{a.title}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                  <a href={a.link} target="_blank" rel="noreferrer" style={{ fontSize: 12, fontWeight: 600, textDecoration: 'underline' }}>
                    Bekijk live ↗
                  </a>
                  <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 'auto' }}>
                    {new Date(a.date).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              </div>
            ))}
            <div style={{ fontSize: 11.5, color: 'var(--muted)', textAlign: 'center', padding: 4 }}>
              oudere artikelen in het <Link href="/archief" style={{ textDecoration: 'underline' }}>Archief</Link>
            </div>
          </Column>

          {/* Mislukt */}
          <Column color="var(--red)" title="Mislukt" count={failed.length}>
            {failed.map(t => (
              <div key={t.id} className="card" style={{ padding: 12, borderColor: 'var(--red-border)' }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35, flex: 1 }}>{t.title}</div>
                  <span style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>poging {t.attempts || 1}</span>
                </div>
                <div
                  style={{
                    marginTop: 8, fontSize: 12, color: 'var(--red-dark)', background: 'var(--red-bg)',
                    borderRadius: 6, padding: '7px 9px', lineHeight: 1.4, fontFamily: 'var(--mono)',
                  }}
                >
                  {t.error_step ? `${t.error_step} · ` : ''}{t.error || 'Onbekende fout'}
                </div>
                <div style={{ fontSize: 12, color: 'var(--gray)', marginTop: 8, lineHeight: 1.45 }}>
                  Het onderwerp blijft bewaard. Opnieuw proberen zet het bovenaan de wachtrij.
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button
                    className="btn-primary"
                    style={{ flex: 1, fontSize: 12.5, fontWeight: 700, padding: 8, borderRadius: 6 }}
                    onClick={() => retryTopic(t)}
                  >
                    Opnieuw proberen
                  </button>
                  <button className="btn-small" onClick={() => removeTopic(t)}>✕</button>
                </div>
              </div>
            ))}
            {data && failed.length === 0 && (
              <div style={{ fontSize: 11.5, color: 'var(--muted)', textAlign: 'center', padding: '14px 6px' }}>
                geen fouten 🎉
              </div>
            )}
          </Column>
        </div>
      </div>

      {/* ============ mobiel: invoer + volgen ============ */}
      <div className="mobile-only" style={{ flex: 1 }}>
        <MobileHome
          queued={queued}
          writing={[...review, ...writing]}
          failed={failed}
          needImages={needImages}
          ready={ready}
          onChanged={load}
          onBulk={() => setBulkOpen(true)}
          onToggleAuto={() => setAutoOn(v => !v)}
          autoOn={autoOn}
          writingNow={writingNow}
        />
      </div>

      {bulkOpen && (
        <BulkModal
          existing={topics.map(t => t.title)}
          onClose={() => setBulkOpen(false)}
          onAdded={load}
        />
      )}
      <ListArticleModal
        open={listModalOpen}
        onClose={() => setListModalOpen(false)}
        onCreated={load}
      />
      {reviewTopic && (
        <ReviewModal
          topic={reviewTopic}
          onClose={() => setReviewTopicId(null)}
          onApproved={() => { setReviewTopicId(null); startWriting(); }}
        />
      )}
    </div>
  );
}

function MobileHome({
  queued, writing, failed, needImages, ready, onChanged, onBulk, onToggleAuto, autoOn, writingNow,
}: {
  queued: Topic[]; writing: Topic[]; failed: Topic[];
  needImages: Article[]; ready: Article[];
  onChanged: () => void; onBulk: () => void;
  onToggleAuto: () => void; autoOn: boolean; writingNow: boolean;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    const title = value.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      await fetch('/api/topics', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ titles: [title] }),
      });
      toast('Toegevoegd aan wachtrij');
      setValue('');
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 'calc(100vh - 55px)' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-light)', background: 'var(--panel)' }}>
        <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.01em' }}>Nieuw onderwerp</div>
        <textarea
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
          placeholder="Kikiboba in De Pijp: Taiwanese wheel cakes…"
          rows={2}
          style={{
            marginTop: 12, width: '100%', border: '1.5px solid var(--ink)', borderRadius: 12,
            background: 'var(--card)', padding: '14px 16px', fontSize: 15, fontWeight: 600,
            outline: 'none', resize: 'none',
          }}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button
            className="btn-primary"
            style={{ flex: 1, fontSize: 14, padding: 13, borderRadius: 10 }}
            disabled={!value.trim() || busy}
            onClick={submit}
          >
            Toevoegen aan wachtrij
          </button>
          <button className="btn" style={{ padding: '13px 14px', borderRadius: 10 }} onClick={onBulk}>
            Plak lijst
          </button>
        </div>
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)' }}>
          Claude onderzoekt het onderwerp, schrijft de draft en vult SEO in.
        </div>
      </div>
      <div style={{ flex: 1, padding: '14px 20px', display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--sidebar)' }}>
        <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--gray)' }}>
          Wachtrij · {queued.length + writing.length + failed.length}
        </div>
        <button
          className="btn-primary"
          onClick={onToggleAuto}
          style={{
            width: '100%', fontSize: 13, padding: 11, borderRadius: 8,
            background: autoOn ? 'var(--blue)' : undefined,
          }}
        >
          {writingNow ? 'Claude schrijft… ⏸' : autoOn ? '⏸ Automatisch schrijven (aan)' : '▶ Automatisch schrijven'}
        </button>
        {writing.map(t => (
          <div key={t.id} className="card" style={{ borderRadius: 10, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35 }}>{t.title}</div>
              <div style={{ fontSize: 11, fontWeight: 700, color: t.status === 'review' ? 'var(--amber-dark)' : 'var(--blue-dark)', marginTop: 3 }}>
                {t.status === 'review' ? 'Itemcontrole nodig — doe je op desktop' : 'Wordt geschreven…'}
              </div>
            </div>
            <span className="dot" style={{ background: t.status === 'review' ? 'var(--amber)' : 'var(--blue)' }} />
          </div>
        ))}
        {failed.map(t => (
          <div key={t.id} className="card" style={{ borderRadius: 10, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10, borderColor: 'var(--red-border)' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35 }}>{t.title}</div>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--red-dark)', marginTop: 3 }}>Mislukt — probeer opnieuw op desktop</div>
            </div>
            <span className="dot" style={{ background: 'var(--red)' }} />
          </div>
        ))}
        {queued.map(t => (
          <div key={t.id} className="card" style={{ borderRadius: 10, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35 }}>{t.title}</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>{timeLabel(t.created_at)}</div>
            </div>
            <span className="dot" style={{ background: 'var(--muted)' }} />
          </div>
        ))}
        {[...needImages, ...ready].map(a => (
          <div key={a.id} className="card" style={{ borderRadius: 10, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35 }}>{a.title}</div>
              <div
                style={{
                  fontSize: 11, fontWeight: 700, marginTop: 3,
                  color: articlePhase(a) === 'ready' ? 'var(--green-dark)' : 'var(--amber-dark)',
                }}
              >
                {articlePhase(a) === 'ready' ? '✓ klaar voor publicatie' : `Beelden nodig · ${imageCount(a)}/${REQUIRED_IMAGES}`}
              </div>
            </div>
            <span className="dot" style={{ background: articlePhase(a) === 'ready' ? 'var(--green)' : 'var(--amber)' }} />
          </div>
        ))}
        <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', paddingTop: 2 }}>
          beeldwerk doe je op desktop — hier alleen invoeren en volgen
        </div>
      </div>
    </div>
  );
}
