'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from '@/components/toast';
import PanelHeader from './PanelHeader';
import { Chip } from './WordPressPanel';

type IgStatus = {
  engineConfigured: boolean;
  hasEngineKey: boolean;
  engineUrl: string;
  connection: { igUsername: string; businessAccountId: string; hasToken: boolean } | null;
  error?: string;
};

const inputStyle: React.CSSProperties = {
  fontSize: 13, padding: '8px 12px', borderRadius: 8,
  border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--ink)',
  width: '100%', outline: 'none',
};

const labelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
  color: 'var(--muted)', marginBottom: 8,
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 14, fontWeight: 700,
};

export default function InstagramPanel({
  eyebrow, title, description, onChanged,
}: {
  eyebrow: string;
  title: string;
  description: string;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState<IgStatus | null>(null);
  const [busy, setBusy] = useState(false);

  // Sectie 1: engine-instellingen
  const [engineUrl, setEngineUrl] = useState('');
  const [engineApiKey, setEngineApiKey] = useState('');
  const [hasEngineChanges, setHasEngineChanges] = useState(false);

  // Sectie 2: Instagram-credentials (doorgestuurd naar de engine).
  const [accessToken, setAccessToken] = useState('');
  const [businessAccountId, setBusinessAccountId] = useState('');

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/koppelingen/instagram');
    if (res.ok) {
      const s: IgStatus = await res.json();
      setStatus(s);
      setEngineUrl(s.engineUrl);
      setBusinessAccountId(s.connection?.businessAccountId || '');
      setHasEngineChanges(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Check voor engine wijzigingen
  useEffect(() => {
    if (!status) return;
    const changed = engineUrl.trim() !== status.engineUrl || engineApiKey.trim() !== '';
    setHasEngineChanges(changed);
  }, [engineUrl, engineApiKey, status]);

  async function save(partial: Record<string, string>) {
    setBusy(true);
    try {
      const res = await fetch('/api/koppelingen/instagram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partial),
      });
      const body = await res.json();
      if (!res.ok) {
        toast(body.error || 'Opslaan mislukt', { kind: 'error' });
        if (body.engineUrl) { setStatus(body); }
        return;
      }
      setStatus(body);
      setEngineUrl(body.engineUrl);
      setTestResult(null);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function saveEngine() {
    if (!hasEngineChanges) return;
    setBusy(true);
    try {
      const updates: Record<string, string> = {};
      if (engineUrl.trim() !== status?.engineUrl) updates.engineUrl = engineUrl.trim();
      if (engineApiKey.trim()) updates.engineApiKey = engineApiKey.trim();

      const res = await fetch('/api/koppelingen/instagram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const body = await res.json();
      if (!res.ok) {
        toast(body.error || 'Opslaan mislukt', { kind: 'error' });
        if (body.engineUrl) { setStatus(body); }
        return;
      }
      setStatus(body);
      setEngineUrl(body.engineUrl);
      setEngineApiKey('');
      setHasEngineChanges(false);
      setTestResult(null);
      toast('Engine instellingen opgeslagen', { kind: 'ok' });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function saveInstagram() {
    // Engine eist token + business-ID samen; knop staat pas aan als beide gevuld zijn.
    if (!accessToken.trim() || !businessAccountId.trim()) return;
    await save({
      accessToken: accessToken.trim(),
      businessAccountId: businessAccountId.trim(),
    });
    setAccessToken('');
  }

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/koppelingen/instagram/test', { method: 'POST' });
      const body = await res.json();
      setTestResult(body.ok
        ? { ok: true, text: `Verbonden${body.username ? ` als @${body.username}` : ''}.` }
        : { ok: false, text: body.error || 'Test mislukt.' });
    } catch {
      setTestResult({ ok: false, text: 'Test mislukt.' });
    } finally {
      setTesting(false);
    }
  }

  if (!status) {
    return (
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--card)' }}>
        <PanelHeader eyebrow={eyebrow} title={title} description={description} />
        <div style={{ flex: 1 }} />
      </div>
    );
  }

  const conn = status.connection;

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--card)' }}>
      <PanelHeader eyebrow={eyebrow} title={title} description={description} />
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '20px 28px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* SECTIE 1: SOCIALS-ENGINE */}
        <div className="card" style={{ maxWidth: 620, padding: 18, display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={sectionTitleStyle}>Socials-engine</div>
            <Chip
              label={status.hasEngineKey ? 'gekoppeld' : 'niet ingesteld'}
              tone={status.hasEngineKey ? 'green' : 'muted'}
            />
          </div>

          <div>
            <div style={labelStyle}>Engine-URL</div>
            <input
              value={engineUrl}
              disabled={busy}
              onChange={e => setEngineUrl(e.target.value)}
              placeholder="https://amsterdamnow-socials.vercel.app"
              style={inputStyle}
            />
          </div>

          <div>
            <div style={labelStyle}>API-key</div>
            <input
              type="password"
              value={engineApiKey}
              disabled={busy}
              onChange={e => setEngineApiKey(e.target.value)}
              placeholder={status.hasEngineKey ? '•••••••• (ingesteld — leeg laten = behouden)' : 'ENGINE_API_KEY van de socials-engine'}
              style={inputStyle}
            />
          </div>

          {/* ENGINE OPSLAAN KNOP */}
          <div>
            <button
              className="btn"
              disabled={!hasEngineChanges || busy}
              onClick={saveEngine}
              style={{ 
                opacity: hasEngineChanges ? 1 : 0.5,
                cursor: hasEngineChanges ? 'pointer' : 'not-allowed'
              }}
            >
              {busy ? 'Opslaan…' : hasEngineChanges ? 'Wijzigingen opslaan' : 'Opgeslagen'}
            </button>
          </div>
        </div>

        {/* SECTIE 2: INSTAGRAM-ACCOUNT */}
        <div className="card" style={{ maxWidth: 620, padding: 18, display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={sectionTitleStyle}>Instagram-account</div>
            <Chip
              label={conn?.igUsername ? `@${conn.igUsername}` : 'niet gekoppeld'}
              tone={conn?.igUsername ? 'green' : 'muted'}
            />
          </div>

          {!status.hasEngineKey ? (
            <div style={{ fontSize: 12.5, color: 'var(--gray)', lineHeight: 1.6 }}>
              Vul eerst de API-key van de socials-engine in (hierboven). Daarna kan de tool de Instagram-koppeling van de engine uitlezen en instellen.
            </div>
          ) : (
            <>
              {status.error && (
                <div style={{ fontSize: 12.5, color: 'var(--red-dark)', background: 'var(--red-bg)', border: '1px solid var(--red-border)', borderRadius: 8, padding: '8px 12px', lineHeight: 1.5 }}>
                  {status.error}
                </div>
              )}

              <div style={{ fontSize: 12.5, color: 'var(--gray)', lineHeight: 1.6 }}>
                {conn
                  ? <>Gekoppeld account: <strong style={{ color: 'var(--ink)' }}>{conn.igUsername ? `@${conn.igUsername}` : 'onbekend'}</strong>{conn.businessAccountId ? <> · business-ID <code>{conn.businessAccountId}</code></> : null}{conn.hasToken ? '' : ' · nog geen access token'}</>
                  : 'De engine heeft nog geen Instagram-verbinding opgeslagen.'}
              </div>

              <div>
                <div style={labelStyle}>Access token</div>
                <input
                  type="password"
                  value={accessToken}
                  disabled={busy}
                  onChange={e => setAccessToken(e.target.value)}
                  placeholder={conn?.hasToken ? '•••••••• (ingesteld — leeg laten = behouden)' : 'Meta access token (plakken)'}
                  style={inputStyle}
                />
              </div>

              <div>
                <div style={labelStyle}>Business-account-ID</div>
                <input
                  value={businessAccountId}
                  disabled={busy}
                  onChange={e => setBusinessAccountId(e.target.value)}
                  placeholder="Instagram business account ID"
                  style={inputStyle}
                />
              </div>

              {/* INSTAGRAM ACTIE KNOPPEN */}
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn"
                  disabled={busy || !accessToken.trim() || !businessAccountId.trim()}
                  onClick={saveInstagram}
                  style={{ whiteSpace: 'nowrap' }}
                >
                  Opslaan
                </button>
                <button
                  className="btn btn-small"
                  disabled={testing}
                  onClick={testConnection}
                  style={{ whiteSpace: 'nowrap' }}
                >
                  {testing ? 'Testen…' : 'Test verbinding'}
                </button>
              </div>
              <div style={{ fontSize: 11.5, marginTop: -8, lineHeight: 1.5, color: testResult ? (testResult.ok ? 'var(--green-dark)' : 'var(--red, #c0392b)') : 'var(--muted)' }}>
                {testResult
                  ? testResult.text
                  : 'Opslaan stuurt de gegevens door naar de engine; de test controleert de dáár opgeslagen verbinding.'}
              </div>
            </>
          )}

          {/* CAVEATS */}
          <div style={{ borderTop: '1px solid var(--border-light)', paddingTop: 14, fontSize: 12, color: 'var(--gray)', lineHeight: 1.7 }}>
            <div style={{ fontWeight: 700, color: 'var(--ink)', marginBottom: 4 }}>Goed om te weten</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li>De socials-engine bezit het Instagram-account; deze tool praat er uitsluitend server-side mee (de key blijft op de server).</li>
              <li>Makkelijker dan tokens plakken: log in via de <a href="https://amsterdamnow-socials.vercel.app/dashboard/settings" target="_blank" rel="noreferrer">engine-dashboard</a> met &ldquo;Login met Instagram&rdquo; (OAuth) — de koppeling verschijnt daarna hier vanzelf.</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
