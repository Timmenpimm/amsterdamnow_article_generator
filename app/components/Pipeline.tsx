'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Article, BoardData, Topic } from '@/lib/types';
import { articlePhase, imageCount, listImagesReady, parseListState, REQUIRED_IMAGES } from '@/lib/types';
import { classifyError, uitlegVoorKind, type ErrorKind } from '@/lib/errorKind';
import TopBar from './TopBar';
import TopicForm from './TopicForm';
import AuditPanel, { runTime, verdictStyle } from './AuditPanel';
import BulkModal from './BulkModal';
import ListArticleModal from './ListArticleModal';
import ReviewModal from './ReviewModal';
import { toast } from './toast';

const AUTO_WRITE_STORAGE_KEY = 'artikel-tool:auto-write';

// Het laatste auditoordeel per artikel, zoals /api/audit/by-post het teruggeeft.
// Alleen `verdict` is hard nodig; de rest mag ontbreken zonder dat de badge valt.
interface PostVerdict {
  verdict: 'ok' | 'twijfel' | 'fout';
  runId: number | null;
  aantal: number | null;
  geauditeerdOp: string | null;
}

// De route mag { verdicts: {...} } of de map zelf teruggeven; sleutels zonder
// geldig oordeel vallen af. Een artikel zonder oordeel krijgt dus géén badge —
// "niet geauditeerd" is nadrukkelijk iets anders dan "goedgekeurd".
function normalizeVerdicts(body: any): Record<string, PostVerdict> {
  const raw = body && typeof body === 'object' && !Array.isArray(body)
    ? (body.verdicts && typeof body.verdicts === 'object' ? body.verdicts : body)
    : null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, PostVerdict> = {};
  for (const [postId, value] of Object.entries(raw as Record<string, any>)) {
    const v = value?.verdict;
    if (v !== 'ok' && v !== 'twijfel' && v !== 'fout') continue;
    out[String(postId)] = {
      verdict: v,
      runId: typeof value.runId === 'number' ? value.runId : null,
      aantal: typeof value.aantal === 'number' ? value.aantal : null,
      geauditeerdOp: typeof value.geauditeerdOp === 'string' ? value.geauditeerdOp : null,
    };
  }
  return out;
}

// Compacte badge op de artikelkaart. Zelfde chipvorm als .chip-green/.chip-amber
// (er is geen .chip-red, dus rood gaat inline — net als in AuditPanel). Klikken
// opent het auditpaneel direct op dít artikel.
function AuditBadge({ v, onOpen }: { v: PostVerdict; onOpen: () => void }) {
  const s = verdictStyle(v.verdict);
  const n = v.aantal;
  const label = v.verdict === 'ok' ? '✓ ok' : `${s.label}${n != null ? ` · ${n}` : ''}`;
  const when = runTime(v.geauditeerdOp);
  return (
    <span
      role="button"
      tabIndex={0}
      title={
        `Auditor${when ? ` · ${when}` : ''}: oordeel ${s.label}`
        + `${n != null ? ` · ${n} bevinding${n === 1 ? '' : 'en'}` : ''} — klik voor de bevindingen`
      }
      onClick={onOpen}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      style={{
        fontSize: 10.5, fontWeight: 700, color: s.color, background: s.bg,
        padding: '3px 8px', borderRadius: 999, whiteSpace: 'nowrap', flexShrink: 0, cursor: 'pointer',
      }}
    >
      🔎 {label}
    </span>
  );
}

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

// Eén complete autofill-run voor één artikel. De server doet per aanroep één
// stap (zoeken → scoren → plaatsen, daarna per lijstitem één itemfoto), dus we
// blijven tikken tot done. Zonder opts.force gaat er géén body mee: dat is de
// bestaande automatische driver. Met force slaat de server de "artikel is al
// aangeraakt"-bewaking over en vult hij alleen nog lege slots; reset wist
// daarnaast op de eerste tik de "niets gevonden"-markeringen bij lijstitems.
async function runAutofillTicks(
  articleId: number,
  maxTicks: number,
  opts?: { force?: boolean; reset?: boolean },
): Promise<{ placed: number; itemsFilled: number; finished: boolean }> {
  let placed = 0;
  let itemsFilled = 0;
  for (let tick = 0; tick < maxTicks; tick++) {
    const init: RequestInit = opts?.force
      ? {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true, ...(tick === 0 && opts.reset ? { reset: true } : {}) }),
      }
      : { method: 'POST' };
    const res = await fetch(`/api/articles/${articleId}/candidates/autofill`, init);
    const body = await res.json();
    if (!res.ok || body.error) throw new Error(body.error || 'Beelden zoeken mislukt');
    if (body.placed > 0) placed += body.placed;
    if (body.filledItem) itemsFilled += 1;
    if (body.done) return { placed, itemsFilled, finished: true };
  }
  return { placed, itemsFilled, finished: false };
}

// Soort van de fout op een mislukt topic. Rijen van vóór de
// error_kind-kolom (of een board-payload zonder het veld) classificeren we
// hier alsnog op de melding — zelfde patronen als de server gebruikt.
function foutKind(t: Topic): ErrorKind {
  return t.error_kind || classifyError(t.error || '');
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
  // Eén herordening tegelijk: twee snelle tikken zouden allebei van dezelfde
  // render uitgaan, waarna de tweede de eerste stilletjes ongedaan maakt.
  const reorderBusy = useRef(false);
  const [reorderingId, setReorderingId] = useState<number | null>(null);
  const [publishState, setPublishState] = useState<{ enabled: boolean; nextAt: string | null } | null>(null);
  const [rerunId, setRerunId] = useState<number | null>(null);
  // Auditor (steekproefcontrole). auditRef is de harde guard tegen een tweede
  // run naast de lopende (zelfde patroon als writingRef bij het schrijven);
  // auditRefresh dwingt het paneel om de runlijst opnieuw op te halen.
  const [auditScope, setAuditScope] = useState<'drafts' | 'ready'>('drafts');
  const [auditSize, setAuditSize] = useState(3);
  const [auditBusy, setAuditBusy] = useState(false);
  const [auditProgress, setAuditProgress] = useState('');
  const auditRef = useRef(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditRefresh, setAuditRefresh] = useState(0);
  const [auditFocusRun, setAuditFocusRun] = useState<number | null>(null);
  const [auditFocusPost, setAuditFocusPost] = useState<number | null>(null);
  // Laatste oordeel per artikel, voor de badges op de kaarten. Eén keer laden
  // bij het openen van het bord, daarna alleen opnieuw ná een auditrun — er
  // wordt niet gepolld.
  const [verdicts, setVerdicts] = useState<Record<string, PostVerdict>>({});

  // Volgnummer per board-load. De poll (elke 12s) en de load() ná een actie
  // lopen door elkaar heen; zonder deze guard kan een trager antwoord van een
  // éérder gestarte poll een net doorgevoerde wijziging (bv. een nieuwe
  // wachtrijvolgorde) alsnog overschrijven. Alleen het laatst gestarte
  // verzoek mag setData doen.
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const res = await fetch('/api/board');
      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      const board = await res.json();
      if (seq !== loadSeq.current) return;
      setData(board);
      setError('');
    } catch (e: any) {
      if (seq !== loadSeq.current) return;
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 12000);
    return () => clearInterval(t);
  }, [load]);

  // Auditoordelen ophalen. Faalt dit (route bestaat niet, 500, rare body), dan
  // blijven de badges gewoon weg: het bord moet er niet van omvallen.
  const loadVerdicts = useCallback(async () => {
    try {
      const res = await fetch('/api/audit/by-post');
      if (!res.ok) return;
      const body = await res.json().catch(() => null);
      setVerdicts(normalizeVerdicts(body));
    } catch { /* geen badges, verder niets aan de hand */ }
  }, []);

  useEffect(() => { loadVerdicts(); }, [loadVerdicts]);

  // Vanaf een badge het paneel openen op dát artikel, in plaats van bovenaan de
  // runlijst.
  const openAuditFor = useCallback((postId: number, v: PostVerdict) => {
    setAuditFocusRun(v.runId);
    setAuditFocusPost(postId);
    setAuditOpen(true);
  }, []);

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
  // plaatsen, één stap per tik). Lijstartikelen krijgen daarna per tik één
  // itemfoto, tot elk item gevuld is (of gemarkeerd als "niets gevonden") —
  // ook als de redactie featured/slider al zelf zette. Artikelen waar de
  // redactie al beeldwerk aan deed slaat de server verder over (eligible:
  // false), dus dit raakt alleen lege slots. autofillBusy voorkomt dubbele
  // runs bij elke poll.
  const autofillBusy = useRef(false);
  const autofillDone = useRef(new Set<number>());
  useEffect(() => {
    const fresh = (data?.articles || []).find(a => {
      if (a.status !== 'draft' || autofillDone.current.has(a.id)) return false;
      const lc = data?.lists?.[a.id];
      if (lc && lc.withMedia < lc.items) return true; // lijst met lege item-slots
      return imageCount(a) + (lc?.withMedia || 0) === 0;
    });
    if (!fresh || autofillBusy.current) return;
    autofillBusy.current = true;
    (async () => {
      try {
        // Zoeken (1) + scorebatches (±4) + plaatsen (1) = ±6 tikken; bij een
        // lijst daarbovenop één tik per itemfoto.
        const maxTicks = 10 + (data?.lists?.[fresh.id]?.items ?? 0) + 2;
        const { placed, itemsFilled, finished } = await runAutofillTicks(fresh.id, maxTicks);
        // Klaar, of niet klaar binnen de limiet: in beide gevallen niet blijven hameren.
        autofillDone.current.add(fresh.id);
        if (finished && placed > 0) {
          toast(itemsFilled > 0
            ? `Claude heeft beelden ingevuld bij "${fresh.title}" — waarvan ${itemsFilled} itemfoto${itemsFilled > 1 ? "'s" : ''}`
            : `Claude heeft ${placed} beelden alvast ingevuld bij "${fresh.title}"`);
        }
        if (placed > 0) load();
      } catch {
        autofillDone.current.add(fresh.id); // stil falen; handmatig zoeken kan altijd nog
      } finally {
        autofillBusy.current = false;
      }
    })();
  }, [data, load]);

  // Auto-publisher: server beslist zelf of het interval verstreken is en of
  // er iets te publiceren valt (fire-and-forget poll, elke 60s zolang het
  // bord open staat). Bij een gepubliceerd artikel: bord verversen + toast.
  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const res = await fetch('/api/publish/tick');
        const body = await res.json();
        if (cancelled || !res.ok) return;
        setPublishState({ enabled: Boolean(body.enabled), nextAt: body.nextAt ?? null });
        if (body.published) {
          toast(`Automatisch gepubliceerd: ${body.published.title}`);
          load();
        } else if (body.error) {
          // De tick-route geeft bij een mislukte publicatie altijd HTTP 200
          // terug (zie /api/publish/tick), dus zonder deze check verdween
          // een mislukte auto-publish stilletjes: geen toast, geen signaal.
          toast(`Automatisch publiceren mislukt: ${body.error}`, { kind: 'error' });
        }
      } catch { /* volgende tik probeert het gewoon opnieuw */ }
    }
    tick();
    const id = setInterval(tick, 60000);
    return () => { cancelled = true; clearInterval(id); };
  }, [load]);

  const topics = data?.topics || [];
  const queued = topics.filter(t => t.status === 'queued');
  const writing = topics.filter(t => t.status === 'writing');
  const review = topics.filter(t => t.status === 'review');
  const failed = topics.filter(t => t.status === 'failed');
  const reviewTopic = review.find(t => t.id === reviewTopicId) || null;
  const articles = data?.articles || [];
  // Itemfoto's van lijstartikelen tellen mee in de beeldenteller.
  const countFor = (a: Article) => imageCount(a) + (data?.lists?.[a.id]?.withMedia || 0);
  // Klaar-regel: standaard = 3 beelden; lijst = featured + ≥1 slider + élk
  // item een foto (zelfde regel als articlePhase/listImagesReady server-side).
  const phaseFor = (a: Article): 'needImages' | 'ready' | 'published' => {
    if (a.status === 'publish') return 'published';
    const lc = data?.lists?.[a.id];
    if (lc) return listImagesReady(a, lc) ? 'ready' : 'needImages';
    return imageCount(a) >= REQUIRED_IMAGES ? 'ready' : 'needImages';
  };
  // Voortgangslabel voor de kaartjes: lijstartikelen tonen de itemfoto-teller
  // in plaats van x/3.
  const labelFor = (a: Article): string => {
    const lc = data?.lists?.[a.id];
    if (!lc) return `${imageCount(a)}/${REQUIRED_IMAGES} beelden`;
    const extra = [
      ...(!a.featured ? ['featured'] : []),
      ...(a.slider.length < 1 ? ['slider'] : []),
    ];
    return `${lc.withMedia}/${lc.items} itemfoto's${extra.length ? ` · ${extra.join(' + ')} nodig` : ''}`;
  };
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

  // Herordent de wachtrij ín de laatst bekende state (niet in de `queued` van
  // deze render): tussen renderen en klikken kan de writer het bovenste topic
  // geclaimd hebben, en dan zou een snapshot uit de closure dat topic in twee
  // kolommen tegelijk tonen. `order` krijgt de actuele queued-topics en geeft
  // de nieuwe volgorde terug.
  function reorderLocally(order: (queued: Topic[]) => Topic[]) {
    setData(d => {
      if (!d) return d;
      const q = d.topics.filter(t => t.status === 'queued');
      return { ...d, topics: [...order(q), ...d.topics.filter(t => t.status !== 'queued')] };
    });
  }

  async function onDrop(targetId: number) {
    const from = dragId.current;
    dragId.current = null;
    setDragOverId(null);
    if (from == null || from === targetId || reorderBusy.current) return;
    const ids = queued.map(t => t.id);
    const fromIdx = ids.indexOf(from);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    ids.splice(toIdx, 0, ...ids.splice(fromIdx, 1));
    reorderBusy.current = true;
    setReorderingId(from);
    reorderLocally(q => ids.map(id => q.find(t => t.id === id)).filter(Boolean) as Topic[]);
    try {
      const res = await fetch('/api/topics/reorder', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast(body.error || 'Volgorde opslaan mislukt', { kind: 'error' });
      }
    } finally {
      reorderBusy.current = false;
      setReorderingId(null);
      load();
    }
  }

  // Eén tik = vooraan in de wachtrij. Op mobiel de enige manier om te
  // herprioriteren (slepen werkt daar niet), op desktop de snelle route
  // zonder een kaart langs de hele kolom te hoeven slepen. Bewust één
  // rij-update (PATCH action 'top') in plaats van /reorder: die laatste eist
  // dat élk meegestuurd id nog 'queued' is, en faalt dus precies wanneer de
  // wachtrij druk is — het moment waarop je juist wilt herprioriteren.
  async function pushToTop(t: Topic) {
    if (reorderBusy.current) return;
    reorderBusy.current = true;
    setReorderingId(t.id);
    reorderLocally(q => [...q.filter(x => x.id === t.id), ...q.filter(x => x.id !== t.id)]);
    try {
      const res = await fetch(`/api/topics/${t.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'top' }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast(body.error || 'Bovenaan zetten mislukt', { kind: 'error' });
      } else {
        toast('Bovenaan de wachtrij gezet');
      }
    } catch {
      toast('Bovenaan zetten mislukt', { kind: 'error' });
    } finally {
      reorderBusy.current = false;
      setReorderingId(null);
      load();
    }
  }

  async function publish(a: Article) {
    if (!confirm(`"${a.title}" publiceren op amsterdamnow.com?`)) return;
    const res = await fetch(`/api/articles/${a.id}/publish`, { method: 'POST' });
    const body = await res.json();
    if (!res.ok) toast(body.error, { kind: 'error' });
    else toast('Gepubliceerd — live op de site');
    load();
  }

  // Beeldzoeker opnieuw laten draaien op een bestaand artikel — handig als de
  // automatische run halverwege omviel (tokens/timeout). Zelfde tikken als de
  // achtergrond-driver, maar met force: bestaande beelden blijven staan, alleen
  // lege slots worden gevuld, en de eerste tik reset de eerder overgeslagen
  // lijstitems. autofillBusy delen we met de driver, zodat de twee nooit
  // tegelijk aan hetzelfde artikel werken.
  async function rerunAutofill(a: Article) {
    if (autofillBusy.current) {
      toast('De beeldzoeker is al bezig — heel even geduld…');
      return;
    }
    autofillBusy.current = true;
    setRerunId(a.id);
    autofillDone.current.delete(a.id);
    try {
      const maxTicks = 10 + (data?.lists?.[a.id]?.items ?? 0) + 2;
      const { placed, itemsFilled } = await runAutofillTicks(a.id, maxTicks, { force: true, reset: true });
      await load();
      if (placed > 0) {
        toast(itemsFilled > 0
          ? `${placed} beeld(en) geplaatst bij "${a.title}" — waarvan ${itemsFilled} itemfoto${itemsFilled > 1 ? "'s" : ''}.`
          : `${placed} beeld(en) geplaatst bij "${a.title}".`);
      } else {
        toast('Geen bruikbare beelden gevonden — kies handmatig een foto.');
      }
    } catch (e: any) {
      toast(e.message || 'Beelden opnieuw zoeken mislukt', { kind: 'error' });
    } finally {
      // Ook na een fout: de driver hoeft dit artikel niet meteen over te nemen.
      autofillDone.current.add(a.id);
      autofillBusy.current = false;
      setRerunId(null);
    }
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
          // Wachtrij-brede quotum-pauze (Tavily-quotum, Claude-tegoed): niets
          // claimen tot het tijdstip verstreken is. De banner boven het bord
          // toont de reden; hier alleen stoppen met tikken.
          if (body.paused) {
            if (!opts?.silent) {
              toast(`Wachtrij gepauzeerd: ${body.paused.reden}`, { kind: 'error' });
            }
            load();
            return;
          }
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

  // Steekproefcontrole: één run trekken, daarna per tik één artikel auditen —
  // zelfde lus-vorm als startWriting hierboven (POST tot done, ref-guard tegen
  // dubbele runs, fouten via een error-toast, bord verversen in finally).
  // Er wordt níet gepolld als er geen run loopt.
  async function runAudit() {
    if (auditRef.current) return;
    auditRef.current = true;
    setAuditBusy(true);
    setAuditProgress('steekproef trekken…');
    try {
      const res = await fetch('/api/audit/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: auditScope, sampleSize: auditSize }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Audit starten mislukt');
      const postIds: number[] = Array.isArray(body.postIds) ? body.postIds : [];
      // De route mag legitiem niets te doen hebben (alles net geauditeerd, of
      // een leeg bord): dan is er geen run en geen lus.
      if (!body.runId || postIds.length === 0) {
        toast(body.melding || 'Geen artikelen om te auditen');
        return;
      }
      const runId: number = body.runId;
      setAuditFocusRun(runId);
      const total = postIds.length;
      let done = 0;
      let findings = 0;
      let fout = 0;
      let twijfel = 0;
      setAuditProgress(`artikel 0 van ${total} gecontroleerd`);
      // Ruimte voor een tik die niets afrondt; nooit oneindig doortikken.
      for (let tick = 0; tick < total + 5; tick++) {
        const tickRes = await fetch('/api/audit/tick', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId }),
        });
        const tb = await tickRes.json().catch(() => ({}));
        if (!tickRes.ok) throw new Error(tb.error || 'Audit mislukt');
        if (tb.postId != null) {
          done += 1;
          if (typeof tb.findings === 'number') findings += tb.findings;
          if (tb.verdict === 'fout') fout += 1;
          else if (tb.verdict === 'twijfel') twijfel += 1;
          setAuditProgress(`artikel ${Math.min(done, total)} van ${total} gecontroleerd`);
        }
        if (tb.done) break;
      }
      setAuditRefresh(n => n + 1);
      // Verse oordelen: de badges op de kaarten moeten de nieuwe run tonen.
      loadVerdicts();
      setAuditFocusPost(null);
      setAuditOpen(true);
      if (findings === 0) toast(`Audit klaar — ${done} artikel${done === 1 ? '' : 'en'} gecontroleerd, geen bevindingen`);
      else {
        toast(
          `Audit klaar — ${findings} bevinding${findings === 1 ? '' : 'en'} in ${done} artikel${done === 1 ? '' : 'en'}`
          + `${fout ? ` · ${fout}× fout` : ''}${twijfel ? ` · ${twijfel}× twijfel` : ''}`,
          { kind: fout > 0 ? 'error' : 'ok' },
        );
      }
    } catch (e: any) {
      toast(e.message || 'Audit mislukt', { kind: 'error' });
      setAuditRefresh(n => n + 1);
      // Een halverwege afgebroken run kan al oordelen hebben opgeleverd.
      loadVerdicts();
    } finally {
      auditRef.current = false;
      setAuditBusy(false);
      setAuditProgress('');
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

      {/* Wachtrij-brede quotum-pauze (zie getQueuePause in lib/db.ts): één
          accountbrede fout (Tavily-quotum, Claude-tegoed) pauzeert de hele
          wachtrij — dat hoort als één melding boven het bord, niet als losse
          rode kaarten per onderwerp. Buiten desktop-only, dus ook op mobiel. */}
      {data?.queuePause && (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '9px 20px',
            background: 'var(--amber-bg)', borderBottom: '1px solid var(--amber-border)',
            fontSize: 12.5, color: 'var(--amber-dark)',
          }}
        >
          <span style={{ fontWeight: 800 }}>⏸ Wachtrij gepauzeerd</span>
          <span>
            — {data.queuePause.reden}. Schrijven gaat automatisch verder rond{' '}
            {new Date(data.queuePause.until).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}.
          </span>
        </div>
      )}

      {/* ============ desktop kanban ============ */}
      <div className="desktop-only">
        <div style={{ display: 'flex', gap: 12, padding: '16px 20px 20px', alignItems: 'flex-start', overflowX: 'auto', flex: 1 }}>
          {/* In wachtrij */}
          <Column color="var(--muted)" title="In wachtrij" count={queued.length} hint="volgorde = prioriteit">
            {queued.map((t, i) => (
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
                        {i > 0 && (
                          // Bewust wél focusbaar (de buren ✎/✕ zijn dat niet):
                          // slepen werkt sowieso niet met een toetsenbord, dus
                          // dit is de enige toegankelijke manier om te
                          // herprioriteren.
                          <span
                            role="button"
                            tabIndex={0}
                            aria-label={`"${t.title}" bovenaan de wachtrij zetten`}
                            title="Bovenaan de wachtrij zetten"
                            style={{
                              cursor: reorderingId ? 'default' : 'pointer', fontWeight: 700,
                              opacity: reorderingId === t.id ? 0.4 : 1,
                            }}
                            onClick={() => pushToTop(t)}
                            onKeyDown={e => {
                              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pushToTop(t); }
                            }}
                          >
                            ⤒
                          </span>
                        )}
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
              return (
                <div key={a.id} className="card" style={{ overflow: 'hidden' }}>
                  {a.featured && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={a.featured.url} alt="" style={{ width: '100%', height: 96, objectFit: 'cover', display: 'block' }} />
                  )}
                  <div style={{ padding: '10px 12px 12px' }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35 }}>{a.title}</div>
                    {/* flexWrap + ellipsis: de badge mag de kaart niet breder maken. */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, rowGap: 6, marginTop: 9, flexWrap: 'wrap' }}>
                      <span className="chip-amber">{labelFor(a)}</span>
                      {verdicts[a.id] && <AuditBadge v={verdicts[a.id]} onOpen={() => openAuditFor(a.id, verdicts[a.id])} />}
                      <span style={{ fontSize: 11, color: 'var(--muted)', flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {[a.category, a.district.replace('Amsterdam ', '')].filter(Boolean).join(' · ')}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                      <Link href={`/artikel/${a.id}`} style={{ flex: 1 }}>
                        <button className="btn-primary" style={{ width: '100%', fontSize: 12.5, fontWeight: 700, padding: 8, borderRadius: 6 }}>
                          Beelden toevoegen →
                        </button>
                      </Link>
                      <button
                        className="btn-small"
                        title="Beelden opnieuw automatisch zoeken en plaatsen"
                        disabled={rerunId === a.id}
                        style={{ opacity: rerunId === a.id ? 0.6 : 1 }}
                        onClick={() => rerunAutofill(a)}
                      >
                        {rerunId === a.id ? '⟳' : '↻'}
                      </button>
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
          <Column
            color="var(--green)"
            title="Klaar voor publicatie"
            count={ready.length}
            hint={
              publishState
                ? (publishState.enabled
                  ? `auto: aan${publishState.nextAt ? ` · volgende ${new Date(publishState.nextAt).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}` : ''}`
                  : 'auto: uit')
                : undefined
            }
          >
            {/* Steekproefcontrole: knop bovenaan de kolomkop, met de scope- en
                aantal-keuze eronder (zelfde plek/vorm als de knop
                "Automatisch schrijven" in de kolom Wordt geschreven). */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 2 }}>
              <button
                className="btn-primary"
                disabled={auditBusy}
                title="Trek een steekproef en laat een onafhankelijke auditor claims, beelden en tekst controleren"
                onClick={runAudit}
                style={{ width: '100%', fontSize: 12.5, padding: '8px 10px' }}
              >
                {auditBusy ? 'Auditen…' : '🔎 Steekproef auditen'}
              </button>
              <div style={{ display: 'flex', gap: 6 }}>
                <select
                  value={auditScope}
                  disabled={auditBusy}
                  aria-label="Welke artikelen auditen"
                  onChange={e => setAuditScope(e.target.value === 'ready' ? 'ready' : 'drafts')}
                  style={{
                    flex: 1, minWidth: 0, fontSize: 11.5, fontWeight: 600, padding: '5px 6px', borderRadius: 6,
                    border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--ink)',
                  }}
                >
                  <option value="drafts">nog te publiceren</option>
                  <option value="ready">publicatieklaar</option>
                </select>
                <select
                  value={auditSize}
                  disabled={auditBusy}
                  aria-label="Aantal artikelen in de steekproef"
                  onChange={e => setAuditSize(Number(e.target.value) || 3)}
                  style={{
                    fontSize: 11.5, fontWeight: 600, padding: '5px 6px', borderRadius: 6,
                    border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--ink)',
                  }}
                >
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
                    <option key={n} value={n}>{n}×</option>
                  ))}
                </select>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--gray)' }}>
                {auditBusy && <span style={{ fontWeight: 700, color: 'var(--blue-dark)' }}>{auditProgress}</span>}
                <span
                  role="button"
                  tabIndex={0}
                  style={{ marginLeft: 'auto', textDecoration: 'underline', cursor: 'pointer' }}
                  onClick={() => { setAuditFocusPost(null); setAuditOpen(true); }}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setAuditFocusPost(null); setAuditOpen(true); } }}
                >
                  Bevindingen →
                </span>
              </div>
            </div>
            {ready.map(a => (
              <div key={a.id} className="card" style={{ overflow: 'hidden' }}>
                {a.featured && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={a.featured.url} alt="" style={{ width: '100%', height: 96, objectFit: 'cover', display: 'block' }} />
                )}
                <div style={{ padding: '10px 12px 12px' }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35 }}>{a.title}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, rowGap: 6, marginTop: 9, flexWrap: 'wrap' }}>
                    <span className="chip-green">✓ {countFor(a)} beelden</span>
                    {verdicts[a.id] && <AuditBadge v={verdicts[a.id]} onOpen={() => openAuditFor(a.id, verdicts[a.id])} />}
                    <span style={{ fontSize: 11, color: 'var(--muted)', flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, rowGap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                  <a href={a.link} target="_blank" rel="noreferrer" style={{ fontSize: 12, fontWeight: 600, textDecoration: 'underline' }}>
                    Bekijk live ↗
                  </a>
                  {verdicts[a.id] && <AuditBadge v={verdicts[a.id]} onOpen={() => openAuditFor(a.id, verdicts[a.id])} />}
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
            {failed.map(t => {
              const kind = foutKind(t);
              return (
                <div key={t.id} className="card" style={{ padding: 12, borderColor: 'var(--red-border)' }}>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35, flex: 1 }}>{t.title}</div>
                    {/* attempts telt fase-claims, geen mislukte pogingen — dus
                        "stap N", niet "poging N" (zie claimNext in lib/db.ts). */}
                    <span style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>stap {t.attempts || 1}</span>
                  </div>
                  <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, color: 'var(--red-dark)', lineHeight: 1.4 }}>
                    {uitlegVoorKind(kind, t.error || '')}
                  </div>
                  <div
                    style={{
                      marginTop: 6, fontSize: 12, color: 'var(--red-dark)', background: 'var(--red-bg)',
                      borderRadius: 6, padding: '7px 9px', lineHeight: 1.4, fontFamily: 'var(--mono)',
                    }}
                  >
                    {t.error_step ? `${t.error_step} · ` : ''}{t.error || 'Onbekende fout'}
                  </div>
                  {kind === 'definitief' ? (
                    <>
                      {/* Bewuste redactionele poort (event voorbij, duplicaat):
                          een retry levert gegarandeerd dezelfde uitkomst op,
                          dus die knop staat hier bewust niet. */}
                      <div style={{ fontSize: 12, color: 'var(--gray)', marginTop: 8, lineHeight: 1.45 }}>
                        Opnieuw proberen heeft geen zin — pas het onderwerp aan of verwijder het.
                      </div>
                      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                        <button
                          className="btn"
                          style={{ flex: 1, fontSize: 12.5, fontWeight: 700, padding: 8, borderRadius: 6 }}
                          onClick={() => removeTopic(t)}
                        >
                          Verwijderen
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
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
                    </>
                  )}
                </div>
              );
            })}
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
          phaseOf={phaseFor}
          labelOf={labelFor}
          onChanged={load}
          onPushToTop={pushToTop}
          reorderingId={reorderingId}
          onBulk={() => setBulkOpen(true)}
          onToggleAuto={() => setAutoOn(v => !v)}
          autoOn={autoOn}
          writingNow={writingNow}
          verdicts={verdicts}
          onOpenAudit={openAuditFor}
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
      <AuditPanel
        open={auditOpen}
        onClose={() => setAuditOpen(false)}
        refreshKey={auditRefresh}
        focusRunId={auditFocusRun}
        focusPostId={auditFocusPost}
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
  queued, writing, failed, needImages, ready, phaseOf, labelOf, onChanged, onPushToTop, reorderingId, onBulk, onToggleAuto, autoOn, writingNow,
  verdicts, onOpenAudit,
}: {
  queued: Topic[]; writing: Topic[]; failed: Topic[];
  needImages: Article[]; ready: Article[];
  phaseOf: (a: Article) => 'needImages' | 'ready' | 'published';
  labelOf: (a: Article) => string;
  onChanged: () => void; onPushToTop: (t: Topic) => void; reorderingId: number | null; onBulk: () => void;
  onToggleAuto: () => void; autoOn: boolean; writingNow: boolean;
  verdicts: Record<string, PostVerdict>; onOpenAudit: (postId: number, v: PostVerdict) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 'calc(100vh - 55px)' }}>
      <TopicForm onSubmitted={onChanged} onBulk={onBulk} />
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
        {failed.map(t => {
          const kind = foutKind(t);
          return (
            <div key={t.id} className="card" style={{ borderRadius: 10, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10, borderColor: 'var(--red-border)' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35 }}>{t.title}</div>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--red-dark)', marginTop: 3 }}>
                  Mislukt (stap {t.attempts || 1}) · {uitlegVoorKind(kind, t.error || '')}
                </div>
                {kind !== 'definitief' && (
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>Opnieuw proberen doe je op desktop.</div>
                )}
              </div>
              <span className="dot" style={{ background: 'var(--red)' }} />
            </div>
          );
        })}
        {queued.map((t, i) => (
          <div key={t.id} className="card" style={{ borderRadius: 10, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35 }}>{t.title}</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>
                {i === 0 ? `volgende aan de beurt · ${timeLabel(t.created_at)}` : timeLabel(t.created_at)}
              </div>
            </div>
            {i > 0 && (
              <button
                className="btn-small"
                title="Bovenaan de wachtrij zetten"
                aria-label={`"${t.title}" bovenaan de wachtrij zetten`}
                disabled={reorderingId != null}
                onClick={() => onPushToTop(t)}
                style={{ fontSize: 15, fontWeight: 700, lineHeight: 1, padding: '8px 11px', borderRadius: 8 }}
              >
                ⤒
              </button>
            )}
            <span className="dot" style={{ background: 'var(--muted)' }} />
          </div>
        ))}
        {[...needImages, ...ready].map(a => (
          <div key={a.id} className="card" style={{ borderRadius: 10, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35 }}>{a.title}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, rowGap: 5, marginTop: 3, flexWrap: 'wrap' }}>
                <span
                  style={{
                    fontSize: 11, fontWeight: 700,
                    color: phaseOf(a) === 'ready' ? 'var(--green-dark)' : 'var(--amber-dark)',
                  }}
                >
                  {phaseOf(a) === 'ready' ? '✓ klaar voor publicatie' : `Beelden nodig · ${labelOf(a)}`}
                </span>
                {verdicts[a.id] && <AuditBadge v={verdicts[a.id]} onOpen={() => onOpenAudit(a.id, verdicts[a.id])} />}
              </div>
            </div>
            <span className="dot" style={{ background: phaseOf(a) === 'ready' ? 'var(--green)' : 'var(--amber)' }} />
          </div>
        ))}
        <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', paddingTop: 2 }}>
          beeldwerk doe je op desktop — hier alleen invoeren en volgen
        </div>
      </div>
    </div>
  );
}
