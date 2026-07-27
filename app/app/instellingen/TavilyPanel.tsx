'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from '@/components/toast';
import PanelHeader from './PanelHeader';
import { Chip } from './WordPressPanel';

type TavilyStatus = {
  configured: boolean;
  source: 'settings' | 'env' | 'none';
  maskedKey: string;
  hasEnvFallback: boolean;
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

export default function TavilyPanel({
  eyebrow, title, description, onChanged,
}: {
  eyebrow: string;
  title: string;
  description: string;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState<TavilyStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [apiKey, setApiKey] = useState('');

  // Testresultaat van "Test verbinding".
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/koppelingen/tavily');
    if (res.ok) setStatus(await res.json());
  }, []);

  useEffect(() => { load(); }, [load]);

  async function save() {
    const key = apiKey.trim();
    if (!key) return;
    setBusy(true);
    try {
      const res = await fetch('/api/koppelingen/tavily', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: key }),
      });
      const body = await res.json();
      if (!res.ok) { toast(body.error || 'Opslaan mislukt', { kind: 'error' }); return; }
      setStatus(body);
      setApiKey('');
      setTestResult(null);
      toast('Tavily-API-key opgeslagen.');
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function removeOverride() {
    setBusy(true);
    try {
      const res = await fetch('/api/koppelingen/tavily', { method: 'DELETE' });
      const body = await res.json();
      if (!res.ok) { toast(body.error || 'Verwijderen mislukt', { kind: 'error' }); return; }
      setStatus(body);
      setTestResult(null);
      toast(body.hasEnvFallback
        ? 'Override verwijderd — de tool gebruikt weer de omgevingsvariabele.'
        : 'Override verwijderd — er is nu geen Tavily-key meer ingesteld.');
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      // Nog niet opgeslagen invoer meesturen; leeg veld = de route valt terug
      // op de opgeslagen/env-key.
      const res = await fetch('/api/koppelingen/tavily/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      const body = await res.json();
      if (!body.ok) {
        setTestResult({ ok: false, text: body.error || 'Verbinding mislukt.' });
      } else {
        const usageText = typeof body.usage === 'number'
          ? ` Verbruik: ${body.usage}${typeof body.limit === 'number' ? ` van ${body.limit}` : ''} credits${body.plan ? ` (${body.plan})` : ''}.`
          : '';
        setTestResult(body.exhausted
          ? { ok: false, text: `Key is geldig, maar het quotum is op.${usageText} Wissel naar een andere key.` }
          : { ok: true, text: `Key werkt.${usageText}` });
      }
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
            <Chip label={status.configured ? 'actief' : 'niet geconfigureerd'} tone={status.configured ? 'green' : 'muted'} />
            <Chip
              label={status.source === 'settings' ? 'bron: instellingen' : status.source === 'env' ? 'bron: omgevingsvariabelen' : 'geen key'}
              tone="muted"
            />
            {status.maskedKey ? <Chip label={`key ${status.maskedKey}`} tone="muted" /> : null}
          </div>

          {/* API-KEY */}
          <div>
            <div style={labelStyle}>Tavily-API-key</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="password"
                value={apiKey}
                disabled={busy}
                onChange={e => setApiKey(e.target.value)}
                placeholder={status.configured ? `•••••••• (ingesteld — ${status.maskedKey})` : 'tvly-…'}
                style={inputStyle}
              />
              <button
                className="btn btn-primary btn-small"
                disabled={busy || !apiKey.trim()}
                onClick={save}
                style={{ whiteSpace: 'nowrap' }}
              >
                {busy ? 'Opslaan…' : 'Opslaan'}
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
            <div style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.5, color: testResult ? (testResult.ok ? 'var(--green-dark)' : 'var(--red, #c0392b)') : 'var(--muted)' }}>
              {testResult
                ? testResult.text
                : 'Een key maak je aan op app.tavily.com → API Keys. De test kost geen credits.'}
            </div>
          </div>

          {/* OVERRIDE VERWIJDEREN */}
          {status.source === 'settings' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button className="btn btn-small" disabled={busy} onClick={removeOverride}>
                Verwijder override
              </button>
              <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                {status.hasEnvFallback
                  ? 'De tool valt dan terug op de omgevingsvariabele TAVILY_API_KEY.'
                  : 'Let op: er is geen omgevingsvariabele om op terug te vallen.'}
              </span>
            </div>
          )}

          {/* CAVEATS */}
          <div style={{ borderTop: '1px solid var(--border-light)', paddingTop: 14, fontSize: 12, color: 'var(--gray)', lineHeight: 1.7 }}>
            <div style={{ fontWeight: 700, color: 'var(--ink)', marginBottom: 4 }}>Goed om te weten</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li>Een key hier ingesteld wint van de omgevingsvariabele (<code>TAVILY_API_KEY</code>); de wissel werkt binnen ~10 seconden door in de research-pipeline.</li>
              <li>Is het quotum van een key op (HTTP 432), plak hier een andere key en klik op Opslaan — geen Vercel-deploy nodig.</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
