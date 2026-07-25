'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from '@/components/toast';
import PanelHeader from './PanelHeader';

type WpStatus = {
  url: string;
  user: string;
  hasPassword: boolean;
  source: 'settings' | 'env' | 'none';
  live: boolean;
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

// Status-chip: groen via de bestaande .chip-green-class, muted als inline
// variant in dezelfde vorm (er is geen .chip-muted in globals.css).
export function Chip({ label, tone }: { label: string; tone: 'green' | 'muted' }) {
  if (tone === 'green') return <span className="chip-green">{label}</span>;
  return (
    <span
      style={{
        fontSize: 11.5, fontWeight: 700, padding: '3px 8px', borderRadius: 999, whiteSpace: 'nowrap',
        background: 'var(--soft)', color: 'var(--muted)',
      }}
    >
      {label}
    </span>
  );
}

export default function WordPressPanel({
  eyebrow, title, description, onChanged,
}: {
  eyebrow: string;
  title: string;
  description: string;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState<WpStatus | null>(null);
  const [busy, setBusy] = useState(false);

  // Lokale bewerkvelden (tekstvelden slaan pas op bij blur).
  const [url, setUrl] = useState('');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');

  // Testresultaat van "Test verbinding".
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/koppelingen/wordpress');
    if (res.ok) {
      const s: WpStatus = await res.json();
      setStatus(s);
      setUrl(s.url);
      setUser(s.user);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function save(partial: Partial<{ url: string; user: string; appPassword: string }>) {
    setBusy(true);
    try {
      const res = await fetch('/api/koppelingen/wordpress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partial),
      });
      const body = await res.json();
      if (!res.ok) { toast(body.error || 'Opslaan mislukt', { kind: 'error' }); return; }
      setStatus(body);
      setUrl(body.url);
      setUser(body.user);
      setTestResult(null);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      // Nog niet opgeslagen invoer meesturen; leeg wachtwoordveld = de route
      // valt terug op het opgeslagen/env-wachtwoord.
      const res = await fetch('/api/koppelingen/wordpress/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: url.trim(),
          user: user.trim(),
          ...(password.trim() ? { appPassword: password.trim() } : {}),
        }),
      });
      const body = await res.json();
      setTestResult(body.ok
        ? { ok: true, text: `Verbonden met ${url.trim() || status?.url} als ${body.name}.` }
        : { ok: false, text: body.error || 'Verbinding mislukt.' });
    } catch {
      setTestResult({ ok: false, text: 'Verbinding mislukt.' });
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

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--card)' }}>
      <PanelHeader eyebrow={eyebrow} title={title} description={description} />
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '20px 28px 24px' }}>
        <div className="card" style={{ maxWidth: 620, padding: 18, display: 'flex', flexDirection: 'column', gap: 18 }}>

          {/* STATUS */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Chip label={status.live ? 'live' : 'demo'} tone={status.live ? 'green' : 'muted'} />
            <Chip
              label={status.source === 'settings' ? 'bron: instellingen' : status.source === 'env' ? 'bron: omgevingsvariabelen' : 'niet ingesteld'}
              tone="muted"
            />
          </div>

          {/* SITE-URL */}
          <div>
            <div style={labelStyle}>Site-URL</div>
            <input
              value={url}
              disabled={busy}
              onChange={e => setUrl(e.target.value)}
              onBlur={() => url.trim() !== status.url && save({ url: url.trim() })}
              placeholder="https://www.amsterdamnow.com"
              style={inputStyle}
            />
          </div>

          {/* GEBRUIKERSNAAM */}
          <div>
            <div style={labelStyle}>Gebruikersnaam</div>
            <input
              value={user}
              disabled={busy}
              onChange={e => setUser(e.target.value)}
              onBlur={() => user.trim() !== status.user && save({ user: user.trim() })}
              placeholder="WordPress-gebruikersnaam"
              style={inputStyle}
            />
          </div>

          {/* APPLICATION PASSWORD */}
          <div>
            <div style={labelStyle}>Application password</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="password"
                value={password}
                disabled={busy}
                onChange={e => setPassword(e.target.value)}
                onBlur={() => password.trim() && save({ appPassword: password.trim() }).then(() => setPassword(''))}
                placeholder={status.hasPassword ? '•••••••• (ingesteld — leeg laten = behouden)' : 'Nog niet ingesteld'}
                style={inputStyle}
              />
              <button
                className="btn btn-small"
                disabled={testing}
                onClick={testConnection}
                style={{ whiteSpace: 'nowrap' }}
              >
                {testing ? 'Testen…' : 'Test verbinding'}
              </button>
            </div>
            <div style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.5, color: testResult ? (testResult.ok ? 'var(--green-dark)' : 'var(--red, #c0392b)') : 'var(--muted)' }}>
              {testResult
                ? testResult.text
                : 'WordPress-admin → Gebruikers → Profiel → Application Passwords.'}
            </div>
          </div>

          {/* CAVEATS */}
          <div style={{ borderTop: '1px solid var(--border-light)', paddingTop: 14, fontSize: 12, color: 'var(--gray)', lineHeight: 1.7 }}>
            <div style={{ fontWeight: 700, color: 'var(--ink)', marginBottom: 4 }}>Goed om te weten</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li>Instellingen hier winnen van de omgevingsvariabelen (<code>WP_URL</code>, <code>WP_USER</code>, <code>WP_APP_PASSWORD</code>); een leeggelaten veld valt daarop terug.</li>
              <li>Zonder volledige verbinding draait de tool in demo-modus; mét verbinding landen nieuwe artikelen als draft op deze WordPress-site.</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
