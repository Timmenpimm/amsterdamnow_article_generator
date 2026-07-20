'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import Link from 'next/link';
import TopBar from '@/components/TopBar';
import { toast } from '@/components/toast';
import type { SourceSummary, FindingState, ScanResult } from '@/lib/types';

// ---------- helpers ----------

function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

function fmtWhen(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  const isYest = d.toDateString() === yest.toDateString();
  const time = d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `vandaag ${time}`;
  if (isYest) return 'gisteren';
  return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
}

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
}

function nextMorningRun(): string {
  const now = new Date();
  const next = new Date(now);
  next.setHours(7, 0, 0, 0);
  if (now.getHours() >= 7) next.setDate(now.getDate() + 1);
  const today = next.toDateString() === now.toDateString();
  return today ? 'vandaag 07:00' : 'morgen 07:00';
}

const FINDING_PILL: Record<FindingState, { label: string; style: CSSProperties }> = {
  queued: { label: 'in wachtrij', style: { color: 'var(--gray)', background: 'var(--soft)' } },
  written: { label: 'al geschreven', style: { color: 'var(--green-dark)', background: 'var(--green-bg)' } },
  deleted: { label: 'verwijderd door redactie', style: { color: 'var(--muted)', border: '1px solid var(--border-light)' } },
};

// ---------- toggle ----------

function Toggle({ on, onClick, disabled }: { on: boolean; onClick?: () => void; disabled?: boolean }) {
  return (
    <span
      onClick={disabled ? undefined : onClick}
      title={on ? 'Actief — klik om te pauzeren' : 'Gepauzeerd — klik om te hervatten'}
      style={{
        width: 34, height: 20, borderRadius: 999, flexShrink: 0, position: 'relative',
        background: on ? 'var(--ink)' : 'var(--border)', cursor: disabled ? 'default' : 'pointer',
        transition: 'background 0.15s', marginTop: 2,
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: on ? 16 : 2, width: 16, height: 16, borderRadius: '50%',
        background: '#fff', transition: 'left 0.15s',
      }} />
    </span>
  );
}

// ---------- page ----------

export default function BronnenPage() {
  const [sources, setSources] = useState<SourceSummary[] | null>(null);
  const [mode, setMode] = useState<'live' | 'demo' | undefined>(undefined);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const [scanning, setScanning] = useState<Set<number>>(new Set());
  const [expanded, setExpanded] = useState<number | null>(null);
  const [scanAllBusy, setScanAllBusy] = useState(false);
  const [lastRun, setLastRun] = useState<{ added: number; sourcesScanned: number; skipped: number; failed: number } | null>(null);

  const load = useCallback(async () => {
    const r = await fetch('/api/sources').then(x => x.json()).catch(() => null);
    if (r?.sources) setSources(r.sources);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { fetch('/api/board').then(r => r.json()).then(d => setMode(d.mode)).catch(() => {}); }, []);

  const setScan = (id: number, on: boolean) =>
    setScanning(prev => { const n = new Set(prev); on ? n.add(id) : n.delete(id); return n; });

  async function addSource() {
    const u = url.trim();
    if (!u || adding) return;
    setAdding(true);
    try {
      const res = await fetch('/api/sources', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: u, name: name.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { toast(data.error || 'Toevoegen mislukt', { kind: 'error' }); return; }
      if (data.duplicate) { toast('Deze bron staat er al', { kind: 'error' }); return; }
      toast('Bron toegevoegd');
      setUrl(''); setName('');
      await load();
    } finally { setAdding(false); }
  }

  async function scanOne(id: number): Promise<ScanResult | null> {
    setScan(id, true);
    try {
      const res = await fetch(`/api/sources/${id}/scan`, { method: 'POST' });
      const data: ScanResult = await res.json();
      return data;
    } catch {
      return { sourceId: id, ok: false, added: 0, skipped: 0, error: 'Scan mislukt.' };
    } finally {
      setScan(id, false);
    }
  }

  async function handleScanOne(id: number) {
    const r = await scanOne(id);
    await load();
    if (!r) return;
    if (!r.ok) toast(r.error || 'Bron niet bereikbaar', { kind: 'error' });
    else if (r.added > 0) toast(`${r.added} ${r.added === 1 ? 'nieuw onderwerp' : 'nieuwe onderwerpen'} toegevoegd`);
    else toast('Niets nieuws — alles al bekend');
  }

  async function scanAll() {
    if (scanAllBusy || !sources) return;
    const active = sources.filter(s => s.active);
    if (!active.length) { toast('Geen actieve bronnen om te scannen', { kind: 'error' }); return; }
    setScanAllBusy(true);
    let added = 0, skipped = 0, failed = 0;
    try {
      for (const s of active) {
        const r = await scanOne(s.id);
        if (!r || !r.ok) failed += 1;
        else { added += r.added; skipped += r.skipped; }
        await load();
      }
      setLastRun({ added, sourcesScanned: active.length, skipped, failed });
      toast(`${added} ${added === 1 ? 'nieuw onderwerp' : 'nieuwe onderwerpen'} toegevoegd`);
    } finally { setScanAllBusy(false); }
  }

  async function toggle(s: SourceSummary) {
    await fetch(`/api/sources/${s.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: !s.active }),
    });
    await load();
  }

  async function remove(s: SourceSummary) {
    if (!window.confirm(`Bron "${s.name}" verwijderen? De vondsten-historie verdwijnt ook.`)) return;
    await fetch(`/api/sources/${s.id}`, { method: 'DELETE' });
    toast('Bron verwijderd');
    await load();
  }

  const list = sources || [];
  const activeCount = list.filter(s => s.active).length;
  const pausedCount = list.length - activeCount;
  const lastRunAt = list
    .map(s => s.last_scan_at).filter(Boolean)
    .sort().slice(-1)[0] as string | undefined;

  return (
    <div style={{ minHeight: '100vh' }}>
      <TopBar mode={mode} />
      <div style={{ display: 'flex', gap: 0, maxWidth: 1440, margin: '0 auto', alignItems: 'stretch' }}>
        {/* ===== hoofdkolom: zone A + B ===== */}
        <div style={{ flex: 1, minWidth: 0, padding: '22px 24px 40px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* ZONE A — bron toevoegen (desktop) */}
          <div className="desktop-only">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                flex: 1, display: 'flex', alignItems: 'center', gap: 10,
                border: '1.5px solid var(--ink)', borderRadius: 8, padding: '8px 14px', background: 'var(--card)',
              }}>
                <span style={{ fontSize: 15, fontWeight: 700 }}>＋</span>
                <input
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addSource()}
                  placeholder="Plak een agenda- of programmapagina — https://…"
                  style={{ flex: 1, border: 'none', outline: 'none', fontSize: 13.5, background: 'transparent', minWidth: 200 }}
                />
              </div>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addSource()}
                placeholder="naam (optioneel)"
                style={{
                  width: 150, border: '1px solid var(--border)', borderRadius: 8, padding: '9px 12px',
                  fontSize: 13, background: 'var(--card)', outline: 'none',
                }}
              />
              <button className="btn-primary" style={{ whiteSpace: 'nowrap' }} onClick={addSource} disabled={adding}>
                Bron toevoegen
              </button>
            </div>
          </div>
          {/* mobiel: alleen URL + knop */}
          <div className="mobile-only">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <input
                value={url}
                onChange={e => setUrl(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addSource()}
                placeholder="Plak een agendapagina — https://…"
                style={{ border: '1.5px solid var(--ink)', borderRadius: 8, padding: '10px 14px', fontSize: 13.5, outline: 'none', width: '100%' }}
              />
              <button className="btn-primary" onClick={addSource} disabled={adding}>Bron toevoegen</button>
            </div>
          </div>

          {/* ZONE B — bronnenlijst */}
          {list.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--gray)' }}>Bronnen</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--gray)' }}>{list.length}</span>
              <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted)' }}>
                {activeCount} actief{pausedCount ? ` · ${pausedCount} gepauzeerd` : ''}
              </span>
            </div>
          )}

          {/* lege state (3b) */}
          {sources && list.length === 0 && (
            <div style={{
              border: '1.5px dashed var(--faint)', borderRadius: 10, padding: '40px 24px', textAlign: 'center',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
            }}>
              <span style={{
                width: 44, height: 44, borderRadius: '50%', background: 'var(--card)', border: '1px solid var(--border-light)',
                display: 'grid', placeItems: 'center', fontSize: 20, color: 'var(--muted)',
              }}>＋</span>
              <div style={{ fontSize: 14, fontWeight: 700 }}>Nog geen bronnen</div>
              <div style={{ fontSize: 12.5, color: 'var(--gray)', lineHeight: 1.55, maxWidth: 420 }}>
                Geef agendapagina&apos;s op van poppodia, theaters, musea of horecasites. De scanner leest ze dagelijks uit en
                zet relevante events, nieuwe cafés en openingen direct als onderwerp in de wachtrij.
              </div>
            </div>
          )}

          {/* bron-kaarten */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {list.map(s => (
              <SourceCard
                key={s.id}
                s={s}
                scanning={scanning.has(s.id)}
                expanded={expanded === s.id}
                onToggleExpand={() => setExpanded(expanded === s.id ? null : s.id)}
                onScan={() => handleScanOne(s.id)}
                onToggleActive={() => toggle(s)}
                onRemove={() => remove(s)}
              />
            ))}
          </div>
        </div>

        {/* ===== ZONE C — scan-overzicht ===== */}
        <div className="desktop-only">
          <aside style={{
            width: 340, flexShrink: 0, borderLeft: '1px solid var(--border-light)', background: 'var(--sidebar)',
            padding: 20, display: 'flex', flexDirection: 'column', gap: 16, minHeight: '100%',
          }}>
            <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--gray)' }}>Automatische scan</div>
            <div className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 9 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="dot" style={{ background: 'var(--green)' }} />
                <span style={{ fontSize: 13, fontWeight: 700 }}>Elke ochtend om 07:00</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
                <span style={{ color: 'var(--gray)' }}>Volgende run</span><span style={{ fontWeight: 600 }}>{nextMorningRun()}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
                <span style={{ color: 'var(--gray)' }}>Laatste run</span>
                <span style={{ fontWeight: 600 }}>{lastRunAt ? fmtWhen(lastRunAt) : '—'}</span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.45, borderTop: '1px solid var(--border-light)', paddingTop: 8 }}>
                Eén keer per dag — het Vercel-plan staat vaker draaien niet toe.
              </div>
            </div>

            <button className="btn-primary" style={{ width: '100%', padding: '11px 18px' }} onClick={scanAll} disabled={scanAllBusy}>
              {scanAllBusy ? 'Bezig met scannen…' : 'Alle bronnen nu scannen'}
            </button>

            {lastRun && (
              <>
                <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--gray)', marginTop: 2 }}>Laatste run</div>
                <div className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, lineHeight: 1.4 }}>
                    {lastRun.added} {lastRun.added === 1 ? 'nieuw onderwerp' : 'nieuwe onderwerpen'} toegevoegd
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--gray)', lineHeight: 1.5 }}>
                    uit {lastRun.sourcesScanned} {lastRun.sourcesScanned === 1 ? 'bron' : 'bronnen'}
                    {lastRun.skipped ? ` · ${lastRun.skipped} al bekend, overgeslagen` : ''}
                    {lastRun.failed ? ` · ${lastRun.failed} onbereikbaar` : ''}.
                  </div>
                  <Link href="/" style={{ fontSize: 12.5, fontWeight: 700, textDecoration: 'underline', marginTop: 2 }}>Bekijk op het bord →</Link>
                </div>
              </>
            )}

            <div style={{ background: 'var(--amber-bg)', border: '1px solid var(--amber-border)', borderRadius: 8, padding: '12px 14px', fontSize: 12.5, lineHeight: 1.5, color: 'var(--amber-dark)' }}>
              <span style={{ fontWeight: 800 }}>Geen controlestap:</span> vondsten staan direct als onderwerp tussen de rest op het bord — daar te bewerken of te verwijderen als elk ander topic.
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

// ---------- bron-kaart ----------

function SourceCard({
  s, scanning, expanded, onToggleExpand, onScan, onToggleActive, onRemove,
}: {
  s: SourceSummary;
  scanning: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onScan: () => void;
  onToggleActive: () => void;
  onRemove: () => void;
}) {
  const error = !scanning && s.last_scan_status === 'error';
  const paused = !s.active;
  const foundLine = `${s.foundCount} gevonden sinds ${fmtDate(s.created_at)}`;

  const borderColor = scanning ? '#cdd9ea' : error ? 'var(--red-border)' : 'var(--border-light)';
  const cardBg = paused && !scanning ? 'var(--panel)' : 'var(--card)';

  return (
    <div className="card" style={{ border: `1px solid ${borderColor}`, background: cardBg, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {/* kop-rij */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: paused ? 'var(--gray)' : 'var(--ink)' }}>{s.name}</span>
              {s.label && (
                <span style={{ fontSize: 11, color: paused ? 'var(--muted)' : 'var(--gray)', background: 'var(--soft)', padding: '2px 7px', borderRadius: 5 }}>{s.label}</span>
              )}
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: paused ? 'var(--muted)' : 'var(--gray)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {displayUrl(s.url)}
            </div>
          </div>
          <Toggle on={!!s.active} onClick={onToggleActive} disabled={scanning} />
          {scanning ? (
            <button className="btn-small" disabled style={{ background: 'var(--soft)', color: 'var(--muted)', cursor: 'default', whiteSpace: 'nowrap' }}>Bezig…</button>
          ) : error ? (
            <button className="btn-primary" style={{ padding: '6px 11px', fontSize: 12 }} onClick={onScan}>Opnieuw proberen</button>
          ) : (
            <button className="btn-small" style={{ whiteSpace: 'nowrap' }} onClick={onScan} disabled={paused} title={paused ? 'Bron is gepauzeerd' : undefined}>Nu scannen</button>
          )}
          <button className="btn-small" style={{ color: 'var(--gray)', padding: '6px 9px' }} onClick={onRemove} title="Bron verwijderen">✕</button>
        </div>

        {/* status-regel */}
        {scanning ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ height: 4, background: '#eceae5', borderRadius: 2, overflow: 'hidden' }}>
              <div className="progress-pulse" style={{ width: '48%', height: '100%', background: 'var(--blue)', borderRadius: 2 }} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--blue-dark)' }}>Bezig met scannen…</span>
              <span style={{ fontSize: 12.5, color: 'var(--gray)' }}>pagina lezen · items vergelijken met historie</span>
            </div>
          </div>
        ) : error ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, color: 'var(--red-dark)', background: 'var(--red-bg)', borderRadius: 7, padding: '8px 11px', lineHeight: 1.4 }}>
            <span className="dot" style={{ background: 'var(--red)' }} />
            <span><strong style={{ fontWeight: 700 }}>{s.last_scan_error || 'Bron niet bereikbaar'}</strong>{s.last_scan_at ? ` — ${fmtWhen(s.last_scan_at)}` : ''}</span>
            <span style={{ marginLeft: 'auto', color: 'var(--gray)', whiteSpace: 'nowrap' }}>{s.foundCount} gevonden</span>
          </div>
        ) : paused ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="dot" style={{ background: 'var(--muted)' }} />
            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--gray)' }}>Gepauzeerd</span>
            <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>zet de schakelaar aan om te hervatten</span>
            <span style={{ color: 'var(--border-light)' }}>·</span>
            <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{foundLine}</span>
            {s.foundCount > 0 && (
              <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600, color: 'var(--gray)', cursor: 'pointer' }} onClick={onToggleExpand}>
                {expanded ? 'Inklappen ▲' : 'Vondsten tonen ▾'}
              </span>
            )}
          </div>
        ) : s.last_scan_status === 'ok' ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="dot" style={{ background: 'var(--green)' }} />
            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--green-dark)' }}>Laatste scan geslaagd</span>
            <span style={{ fontSize: 12.5, color: 'var(--gray)' }}>
              {fmtWhen(s.last_scan_at)} ·{' '}
              {s.last_new_count && s.last_new_count > 0
                ? <strong style={{ fontWeight: 700, color: 'var(--ink)' }}>{s.last_new_count} {s.last_new_count === 1 ? 'nieuw onderwerp' : 'nieuwe onderwerpen'}</strong>
                : <><strong style={{ fontWeight: 700, color: 'var(--ink)' }}>niets nieuws</strong> — alles al bekend</>}
            </span>
            <span style={{ color: 'var(--border)' }}>·</span>
            <span style={{ fontSize: 12.5, color: 'var(--gray)' }}>{foundLine}</span>
            {s.foundCount > 0 && (
              <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600, color: 'var(--gray)', cursor: 'pointer' }} onClick={onToggleExpand}>
                {expanded ? 'Inklappen ▲' : 'Vondsten tonen ▾'}
              </span>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="dot" style={{ background: 'var(--muted)' }} />
            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--gray)' }}>Nog niet gescand</span>
            <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>gebruik “Nu scannen” of wacht op de ochtendrun</span>
          </div>
        )}
      </div>

      {/* uitgeklapt: vondsten-historie */}
      {expanded && s.recent.length > 0 && (
        <div style={{ borderTop: '1px solid var(--soft)', background: 'var(--panel)', padding: '12px 16px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--gray)' }}>Recent gevonden</span>
            <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>dedup-historie — waarom een event niet opnieuw omhoogkomt</span>
          </div>
          {s.recent.map((f, i) => {
            const pill = FINDING_PILL[f.state];
            const del = f.state === 'deleted';
            return (
              <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: i < s.recent.length - 1 ? '1px solid var(--soft)' : 'none' }}>
                <span style={{ fontSize: 11.5, color: 'var(--muted)', width: 78, flexShrink: 0 }}>{fmtWhen(f.found_at)}</span>
                <span style={{ fontSize: 12.5, fontWeight: 500, flex: 1, minWidth: 0, color: del ? 'var(--muted)' : 'var(--text)', textDecoration: del ? 'line-through' : 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.title}</span>
                <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 999, whiteSpace: 'nowrap', ...pill.style }}>{pill.label}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
