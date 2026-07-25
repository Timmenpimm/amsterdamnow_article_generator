'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// De auditor-API is bewust losgekoppeld van de rest van de tool (eigen tabellen,
// eigen routes). Deze types beschrijven alléén wat dit paneel van de respons
// gebruikt; alles is optioneel omdat een run halverwege kan zijn, kan zijn
// mislukt, of velden kan missen. Nooit crashen op ontbrekende data.
type Verdict = 'ok' | 'twijfel' | 'fout';

interface AuditRunRow {
  id: number;
  startedAt?: string | null;
  finishedAt?: string | null;
  status?: string | null;
  scope?: string | null;
  sampleSize?: number | null;
  postIds?: number[] | null;
  donePostIds?: number[] | null;
  error?: string | null;
  aantalBevindingen?: number | null;
  verdictPerPost?: Record<string, string | null> | { postId?: number; verdict?: string | null }[] | null;
}

export interface AuditFinding {
  kind?: string | null;
  verdict?: string | null;
  onderwerp?: string | null;
  bevinding?: string | null;
  bron?: string | null;
}

interface AuditPost {
  postId?: number | null;
  titel?: string | null;
  verdict?: string | null;
  findings?: AuditFinding[] | null;
}

interface DetailState {
  status: 'loading' | 'ok' | 'error';
  posts: AuditPost[];
  error?: string;
}

const VERDICT_ORDER: Record<string, number> = { fout: 0, twijfel: 1, ok: 2 };

function isVerdict(v: unknown): v is Verdict {
  return v === 'ok' || v === 'twijfel' || v === 'fout';
}

// Geëxporteerd zodat het bord en het artikeldetail exact dezelfde kleuren en
// woorden gebruiken als dit paneel — één plek waar het oordeel vorm krijgt.
export function verdictStyle(v: string | null | undefined): { label: string; color: string; bg: string } {
  if (v === 'fout') return { label: 'fout', color: 'var(--red-dark)', bg: 'var(--red-bg)' };
  if (v === 'twijfel') return { label: 'twijfel', color: 'var(--amber-dark)', bg: 'var(--amber-bg)' };
  if (v === 'ok') return { label: 'ok', color: 'var(--green-dark)', bg: 'var(--green-bg)' };
  return { label: 'onbekend', color: 'var(--gray)', bg: 'var(--soft)' };
}

// Zelfde chipvorm als .chip-amber/.chip-green in globals.css, maar met een
// verdict-afhankelijke kleur (er is geen .chip-red).
export function VerdictBadge({ verdict, small }: { verdict: string | null | undefined; small?: boolean }) {
  const s = verdictStyle(verdict);
  return (
    <span
      style={{
        fontSize: small ? 10.5 : 11.5, fontWeight: 700, color: s.color, background: s.bg,
        padding: '3px 8px', borderRadius: 999, whiteSpace: 'nowrap', flexShrink: 0,
      }}
    >
      {s.label}
    </span>
  );
}

function scopeLabel(scope: string | null | undefined): string {
  if (scope === 'ready') return 'publicatieklaar';
  if (scope === 'drafts') return 'nog te publiceren';
  return scope || 'steekproef';
}

export function runTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso.includes('T') || iso.includes(' ') ? iso.replace(' ', 'T') : iso);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const time = d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `vandaag ${time}`;
  if (new Date(now.getTime() - 86400000).toDateString() === d.toDateString()) return `gisteren ${time}`;
  return `${d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })} ${time}`;
}

export function hostOf(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0] || url;
}

// De API mag zowel { runs: [...] } als een losse array teruggeven.
function normalizeRuns(body: any): AuditRunRow[] {
  const raw = Array.isArray(body) ? body : Array.isArray(body?.runs) ? body.runs : [];
  return raw.filter((r: any) => r && typeof r.id === 'number');
}

// Bevindingen per post: { posts: [...] } is het contract, maar we accepteren
// ook een losse array of een byPost-sleutel zodat een kleine afwijking in de
// route geen leeg paneel oplevert.
function normalizePosts(body: any): AuditPost[] {
  const raw = Array.isArray(body) ? body
    : Array.isArray(body?.posts) ? body.posts
      : Array.isArray(body?.byPost) ? body.byPost
        : Array.isArray(body?.bevindingen) ? body.bevindingen
          : [];
  return raw.filter((p: any) => p && typeof p === 'object');
}

// Tel de verdicts van een run, ongeacht of verdictPerPost een map of een lijst is.
function verdictCounts(run: AuditRunRow): { fout: number; twijfel: number; ok: number } {
  const counts = { fout: 0, twijfel: 0, ok: 0 };
  const v = run.verdictPerPost;
  const values: unknown[] = !v ? []
    : Array.isArray(v) ? v.map(x => x?.verdict)
      : Object.values(v);
  for (const value of values) if (isVerdict(value)) counts[value] += 1;
  return counts;
}

export function sortFindings(findings: AuditFinding[]): AuditFinding[] {
  // fout eerst, dan twijfel, dan ok/onbekend — stabiel binnen dezelfde groep.
  return [...findings].sort((a, b) => {
    const av = VERDICT_ORDER[String(a?.verdict)] ?? 3;
    const bv = VERDICT_ORDER[String(b?.verdict)] ?? 3;
    return av - bv;
  });
}

export default function AuditPanel({
  open, onClose, refreshKey = 0, focusRunId = null, focusPostId = null,
}: {
  open: boolean;
  onClose: () => void;
  /** Verhoog dit om de runlijst opnieuw te laten ophalen (bv. na een run). */
  refreshKey?: number;
  /** Run die direct uitgeklapt moet staan (de net afgeronde run). */
  focusRunId?: number | null;
  /**
   * Artikel waarop het paneel moet openen: dat artikel wordt gemarkeerd en in
   * beeld gescrold binnen de uitgeklapte run. Zonder deze prop gedraagt het
   * paneel zich precies zoals voorheen (lijst bovenaan, niets gemarkeerd).
   */
  focusPostId?: number | null;
}) {
  const [runs, setRuns] = useState<AuditRunRow[] | null>(null);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [details, setDetails] = useState<Record<number, DetailState>>({});
  const focusedPostEl = useRef<HTMLDivElement | null>(null);

  const loadRuns = useCallback(async () => {
    try {
      const res = await fetch('/api/audit');
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || 'Audits laden mislukt');
      setRuns(normalizeRuns(body));
      setError('');
    } catch (e: any) {
      setRuns([]);
      setError(e?.message || 'Audits laden mislukt');
    }
  }, []);

  // Alleen ophalen als het paneel open staat of de runlijst vers is; géén
  // interval — er wordt niet gepolld als er geen run loopt.
  useEffect(() => {
    if (!open) return;
    loadRuns();
  }, [open, refreshKey, loadRuns]);

  // Details opnieuw ophalen bij een nieuwe run: een uitgeklapte run kan net
  // bevindingen hebben gekregen.
  useEffect(() => {
    if (!refreshKey) return;
    setDetails({});
  }, [refreshKey]);

  useEffect(() => {
    if (open && focusRunId) setExpandedId(focusRunId);
  }, [open, focusRunId, refreshKey]);

  const loadDetail = useCallback(async (id: number) => {
    setDetails(d => (d[id]?.status === 'ok' ? d : { ...d, [id]: { status: 'loading', posts: [] } }));
    try {
      const res = await fetch(`/api/audit/${id}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || 'Bevindingen laden mislukt');
      setDetails(d => ({ ...d, [id]: { status: 'ok', posts: normalizePosts(body) } }));
    } catch (e: any) {
      setDetails(d => ({ ...d, [id]: { status: 'error', posts: [], error: e?.message || 'Bevindingen laden mislukt' } }));
    }
  }, []);

  useEffect(() => {
    if (!open || expandedId == null) return;
    if (details[expandedId]?.status === 'ok') return;
    loadDetail(expandedId);
    // details bewust niet in de deps: dat zou na elke setDetails opnieuw vuren.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, expandedId, loadDetail]);

  // Kom je binnen via een badge op een artikelkaart, dan is de kop van de lijst
  // niet interessant: scroll naar dát artikel zodra de bevindingen geladen zijn.
  // `details` staat in de deps omdat het element pas bestaat ná het laden.
  useEffect(() => {
    if (!open || focusPostId == null) return;
    const el = focusedPostEl.current;
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [open, focusPostId, expandedId, details]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        style={{
          width: 'min(720px, 96vw)', background: 'var(--card)', borderRadius: 12,
          boxShadow: '0 24px 60px rgba(20,20,18,0.35)', overflow: 'hidden',
          maxHeight: '92vh', display: 'flex', flexDirection: 'column',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', padding: '16px 22px', borderBottom: '1px solid var(--border-light)' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800 }}>Steekproefcontrole</div>
            <div style={{ fontSize: 12.5, color: 'var(--gray)', marginTop: 3, lineHeight: 1.5 }}>
              Een tweede paar ogen met eigen bronnen: claims, beelden en tekstintegriteit. De auditor wijzigt niets — wat
              er met een bevinding gebeurt blijft redactioneel werk.
            </div>
          </div>
          <span
            role="button"
            aria-label="Sluiten"
            style={{ marginLeft: 'auto', fontSize: 16, color: 'var(--gray)', cursor: 'pointer', padding: 8 }}
            onClick={onClose}
          >
            ✕
          </span>
        </div>

        <div style={{ padding: '14px 22px 18px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {error && (
            <div className="card" style={{ borderColor: 'var(--red-border)', background: 'var(--red-bg)', padding: '10px 14px' }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--red-dark)' }}>{error}</div>
              <button className="btn-small" style={{ marginTop: 8 }} onClick={loadRuns}>Opnieuw proberen</button>
            </div>
          )}

          {runs === null && !error && (
            <div style={{ fontSize: 11.5, color: 'var(--muted)', textAlign: 'center', padding: '18px 6px' }}>
              audits laden…
            </div>
          )}

          {runs !== null && runs.length === 0 && !error && (
            <div style={{ fontSize: 12, color: 'var(--gray)', textAlign: 'center', padding: '22px 6px', lineHeight: 1.5 }}>
              Nog geen audits uitgevoerd. Start er een via <strong>Steekproef auditen</strong> in de kolom
              &ldquo;Klaar voor publicatie&rdquo;.
            </div>
          )}

          {(runs || []).map(run => {
            const counts = verdictCounts(run);
            const total = Array.isArray(run.postIds) ? run.postIds.length : (run.sampleSize || 0);
            const done = Array.isArray(run.donePostIds) ? run.donePostIds.length : 0;
            const running = run.status === 'running' || (run.status !== 'failed' && !run.finishedAt && done < total);
            const expanded = expandedId === run.id;
            const detail = details[run.id];
            return (
              <div key={run.id} className="card" style={{ overflow: 'hidden' }}>
                <div
                  role="button"
                  tabIndex={0}
                  aria-expanded={expanded}
                  onClick={() => setExpandedId(expanded ? null : run.id)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpandedId(expanded ? null : run.id); }
                  }}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', cursor: 'pointer', flexWrap: 'wrap' }}
                >
                  <span style={{ fontSize: 12, color: 'var(--faint)', width: 12, flexShrink: 0 }}>{expanded ? '▾' : '▸'}</span>
                  <span style={{ fontSize: 13, fontWeight: 700 }}>{runTime(run.startedAt) || `run ${run.id}`}</span>
                  <span style={{ fontSize: 11.5, color: 'var(--gray)' }}>
                    {scopeLabel(run.scope)} · {total || 0} artikel{total === 1 ? '' : 'en'}
                  </span>
                  <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
                    {run.status === 'failed' && (
                      <span
                        style={{
                          fontSize: 10.5, fontWeight: 700, color: 'var(--red-dark)', background: 'var(--red-bg)',
                          padding: '3px 8px', borderRadius: 999, whiteSpace: 'nowrap',
                        }}
                      >
                        mislukt
                      </span>
                    )}
                    {running && (
                      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--blue-dark)' }}>
                        bezig · {done}/{total || '?'}
                      </span>
                    )}
                    {counts.fout > 0 && (
                      <span
                        style={{
                          fontSize: 10.5, fontWeight: 700, color: 'var(--red-dark)', background: 'var(--red-bg)',
                          padding: '3px 8px', borderRadius: 999, whiteSpace: 'nowrap',
                        }}
                      >
                        {counts.fout} fout
                      </span>
                    )}
                    {counts.twijfel > 0 && <span className="chip-amber" style={{ fontSize: 10.5 }}>{counts.twijfel} twijfel</span>}
                    {counts.ok > 0 && <span className="chip-green" style={{ fontSize: 10.5 }}>{counts.ok} ok</span>}
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                      {(run.aantalBevindingen ?? 0)} bevinding{(run.aantalBevindingen ?? 0) === 1 ? '' : 'en'}
                    </span>
                  </span>
                </div>

                {run.error && (
                  <div
                    style={{
                      margin: '0 14px 12px', fontSize: 12, color: 'var(--red-dark)', background: 'var(--red-bg)',
                      borderRadius: 6, padding: '7px 9px', lineHeight: 1.4, fontFamily: 'var(--mono)',
                    }}
                  >
                    {run.error}
                  </div>
                )}

                {expanded && (
                  <div style={{ borderTop: '1px solid var(--border-light)', background: 'var(--panel)', padding: '10px 14px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {(!detail || detail.status === 'loading') && (
                      <div style={{ fontSize: 11.5, color: 'var(--muted)', padding: '8px 2px' }}>bevindingen laden…</div>
                    )}
                    {detail?.status === 'error' && (
                      <div style={{ fontSize: 12, color: 'var(--red-dark)' }}>
                        {detail.error}{' '}
                        <span style={{ textDecoration: 'underline', cursor: 'pointer' }} onClick={() => loadDetail(run.id)}>opnieuw</span>
                      </div>
                    )}
                    {detail?.status === 'ok' && detail.posts.length === 0 && (
                      <div style={{ fontSize: 12, color: 'var(--gray)', padding: '6px 2px' }}>
                        {running ? 'Nog geen artikel afgerond in deze run.' : 'Geen artikelen in deze run.'}
                      </div>
                    )}
                    {detail?.status === 'ok' && detail.posts.map((post, pi) => {
                      const findings = sortFindings(Array.isArray(post.findings) ? post.findings.filter(Boolean) : []);
                      const focused = focusPostId != null && post.postId === focusPostId;
                      return (
                        <div
                          key={post.postId ?? pi}
                          ref={focused ? focusedPostEl : undefined}
                          style={{
                            border: '1px solid var(--border-light)', borderRadius: 8, background: 'var(--card)', padding: '10px 12px',
                            outline: focused ? '1.5px solid var(--ink)' : undefined, outlineOffset: focused ? -1.5 : undefined,
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.35, flex: 1, minWidth: 0 }}>
                              {post.titel || `Artikel ${post.postId ?? '?'}`}
                            </span>
                            <VerdictBadge verdict={post.verdict} />
                          </div>
                          {findings.length === 0 ? (
                            <div style={{ fontSize: 12, color: 'var(--gray)', marginTop: 7 }}>geen bevindingen</div>
                          ) : (
                            <ul style={{ margin: '8px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 7 }}>
                              {findings.map((f, i) => (
                                <li
                                  key={i}
                                  style={{
                                    borderLeft: `2px solid ${verdictStyle(f.verdict).color}`,
                                    paddingLeft: 9, lineHeight: 1.45,
                                  }}
                                >
                                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
                                    <VerdictBadge verdict={f.verdict} small />
                                    <span style={{ fontSize: 12.5, fontWeight: 700 }}>{f.onderwerp || 'Bevinding'}</span>
                                    {f.kind && (
                                      <span style={{ fontSize: 10.5, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{f.kind}</span>
                                    )}
                                  </div>
                                  {f.bevinding && (
                                    <div style={{ fontSize: 12, color: 'var(--text-soft)', marginTop: 2 }}>{f.bevinding}</div>
                                  )}
                                  {f.bron && /^https?:\/\//.test(f.bron) && (
                                    <a
                                      href={f.bron}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      style={{ fontSize: 11.5, color: 'var(--gray)', textDecoration: 'underline', wordBreak: 'break-all' }}
                                    >
                                      bron: {hostOf(f.bron)} ↗
                                    </a>
                                  )}
                                  {f.bron && !/^https?:\/\//.test(f.bron) && (
                                    <div style={{ fontSize: 11.5, color: 'var(--gray)' }}>bron: {f.bron}</div>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 22px', borderTop: '1px solid var(--border-light)', background: 'var(--panel)' }}>
          <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>laatste 10 runs</span>
          <button className="btn-small" style={{ marginLeft: 'auto' }} onClick={loadRuns}>Verversen</button>
          <button className="btn" onClick={onClose}>Sluiten</button>
        </div>
      </div>
    </div>
  );
}
