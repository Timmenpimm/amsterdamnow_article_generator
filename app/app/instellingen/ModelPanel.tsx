'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from '@/components/toast';
import PanelHeader from './PanelHeader';

type ModelSettings = {
  provider: 'anthropic' | 'omniroute';
  omniroute: {
    baseUrl: string;
    model: string;
    visionModel: string;
    hasApiKey: boolean;
  };
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

function ProviderCard({
  active, title, subtitle, onClick,
}: { active: boolean; title: string; subtitle: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, textAlign: 'left', cursor: 'pointer',
        border: `1.5px solid ${active ? 'var(--ink)' : 'var(--border)'}`,
        background: active ? 'var(--ink)' : 'var(--card)',
        color: active ? '#fff' : 'var(--ink)',
        borderRadius: 10, padding: '12px 14px', transition: 'all 0.12s',
      }}
    >
      <div style={{ fontSize: 13.5, fontWeight: 700 }}>{title}</div>
      <div style={{ fontSize: 11.5, marginTop: 3, lineHeight: 1.45, color: active ? 'rgba(255,255,255,0.72)' : 'var(--muted)' }}>
        {subtitle}
      </div>
    </button>
  );
}

export default function ModelPanel({
  eyebrow, title, description, onChanged,
}: {
  eyebrow: string;
  title: string;
  description: string;
  onChanged: () => void;
}) {
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<string[] | null>(null);
  const [modelsErr, setModelsErr] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);

  // Lokale bewerkvelden voor endpoint/sleutel (tekstvelden slaan pas op bij blur).
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');

  const load = useCallback(async () => {
    const res = await fetch('/api/model');
    if (res.ok) {
      const s: ModelSettings = await res.json();
      setSettings(s);
      setBaseUrl(s.omniroute.baseUrl);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const fetchModels = useCallback(async (url?: string) => {
    setLoadingModels(true);
    setModelsErr(null);
    try {
      const qs = url ? `?baseUrl=${encodeURIComponent(url)}` : '';
      const res = await fetch(`/api/model/models${qs}`);
      const body = await res.json();
      if (!res.ok) { setModelsErr(body.error || 'Kon modellen niet laden.'); setModels([]); return; }
      setModels(body.models || []);
    } catch {
      setModelsErr('Kon modellen niet laden.');
      setModels([]);
    } finally {
      setLoadingModels(false);
    }
  }, []);

  // Modellen ophalen zodra Omniroute actief is.
  useEffect(() => {
    if (settings?.provider === 'omniroute') fetchModels();
  }, [settings?.provider, fetchModels]);

  async function save(partial: Partial<{ provider: string; omniroute: Record<string, unknown> }>) {
    setBusy(true);
    try {
      const res = await fetch('/api/model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partial),
      });
      const body = await res.json();
      if (!res.ok) { toast(body.error || 'Opslaan mislukt', { kind: 'error' }); return; }
      setSettings(body);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  if (!settings) {
    return (
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--card)' }}>
        <PanelHeader eyebrow={eyebrow} title={title} description={description} />
        <div style={{ flex: 1 }} />
      </div>
    );
  }

  const isOmni = settings.provider === 'omniroute';
  const o = settings.omniroute;

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--card)' }}>
      <PanelHeader eyebrow={eyebrow} title={title} description={description} />
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '20px 28px 24px' }}>
        <div className="card" style={{ maxWidth: 620, padding: 18, display: 'flex', flexDirection: 'column', gap: 18 }}>

          {/* PROVIDER-KEUZE */}
          <div>
            <div style={labelStyle}>Waar draait de AI?</div>
            <div style={{ display: 'flex', gap: 10 }}>
              <ProviderCard
                active={!isOmni}
                title="Claude (Anthropic)"
                subtitle="Rechtstreeks naar api.anthropic.com. Volledige features (structured output)."
                onClick={() => !busy && save({ provider: 'anthropic' })}
              />
              <ProviderCard
                active={isOmni}
                title="Omniroute-gateway"
                subtitle="Via je eigen router — bespaart Anthropic-tokens (bv. Claude via GitHub of een goedkoper model)."
                onClick={() => !busy && save({ provider: 'omniroute' })}
              />
            </div>
          </div>

          {isOmni && (
            <>
              {/* ENDPOINT */}
              <div>
                <div style={labelStyle}>Endpoint (base-URL)</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    value={baseUrl}
                    disabled={busy}
                    onChange={e => setBaseUrl(e.target.value)}
                    onBlur={() => baseUrl.trim() !== o.baseUrl && save({ omniroute: { baseUrl: baseUrl.trim() } })}
                    placeholder="http://localhost:20128"
                    style={inputStyle}
                  />
                  <button
                    className="btn btn-small"
                    disabled={loadingModels}
                    onClick={() => fetchModels(baseUrl.trim())}
                    style={{ whiteSpace: 'nowrap' }}
                  >
                    {loadingModels ? 'Testen…' : 'Test verbinding'}
                  </button>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6, lineHeight: 1.5 }}>
                  {modelsErr
                    ? <span style={{ color: 'var(--red, #c0392b)' }}>{modelsErr}</span>
                    : models
                      ? <span style={{ color: 'var(--green-dark)' }}>Verbonden — {models.length} modellen beschikbaar.</span>
                      : 'Standaard: de lokale Omniroute op poort 20128.'}
                </div>
              </div>

              {/* API-KEY (optioneel) */}
              <div>
                <div style={labelStyle}>API-sleutel (optioneel)</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="password"
                    value={apiKey}
                    disabled={busy}
                    onChange={e => setApiKey(e.target.value)}
                    onBlur={() => apiKey.trim() && save({ omniroute: { apiKey: apiKey.trim() } }).then(() => setApiKey(''))}
                    placeholder={o.hasApiKey ? '•••••••• (ingesteld — leeg laten = behouden)' : 'Leeg = geen auth (localhost)'}
                    style={inputStyle}
                  />
                </div>
              </div>

              {/* MODEL */}
              <div>
                <div style={labelStyle}>Model (tekst)</div>
                {models && models.length > 0 ? (
                  <select
                    value={models.includes(o.model) ? o.model : '__custom'}
                    disabled={busy}
                    onChange={e => e.target.value !== '__custom' && save({ omniroute: { model: e.target.value } })}
                    style={{ ...inputStyle, fontWeight: 600, cursor: 'pointer' }}
                  >
                    {!models.includes(o.model) && <option value="__custom">{o.model} (niet in lijst)</option>}
                    {models.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                ) : (
                  <input
                    defaultValue={o.model}
                    disabled={busy}
                    onBlur={e => e.target.value.trim() !== o.model && save({ omniroute: { model: e.target.value.trim() } })}
                    placeholder="auto/best-coding"
                    style={{ ...inputStyle, fontWeight: 600 }}
                  />
                )}
              </div>

              {/* VISION-MODEL */}
              <div>
                <div style={labelStyle}>Model (beeldselectie)</div>
                {models && models.length > 0 ? (
                  <select
                    value={models.includes(o.visionModel) ? o.visionModel : '__custom'}
                    disabled={busy}
                    onChange={e => e.target.value !== '__custom' && save({ omniroute: { visionModel: e.target.value } })}
                    style={{ ...inputStyle, fontWeight: 600, cursor: 'pointer' }}
                  >
                    {!models.includes(o.visionModel) && <option value="__custom">{o.visionModel} (niet in lijst)</option>}
                    {models.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                ) : (
                  <input
                    defaultValue={o.visionModel}
                    disabled={busy}
                    onBlur={e => e.target.value.trim() !== o.visionModel && save({ omniroute: { visionModel: e.target.value.trim() } })}
                    placeholder="auto/best-vision"
                    style={{ ...inputStyle, fontWeight: 600 }}
                  />
                )}
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6, lineHeight: 1.5 }}>
                  Kies een model dat beelden kan lezen — de beeldselectie stuurt foto's mee.
                </div>
              </div>

              {/* CAVEATS */}
              <div style={{ borderTop: '1px solid var(--border-light)', paddingTop: 14, fontSize: 12, color: 'var(--gray)', lineHeight: 1.7 }}>
                <div style={{ fontWeight: 700, color: 'var(--ink)', marginBottom: 4 }}>Goed om te weten</div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  <li>Op de Vercel-productieomgeving is <code>localhost</code> onbereikbaar — gebruik Omniroute lokaal, of vul een publiek bereikbare URL in.</li>
                  <li>Structured output valt bij Omniroute automatisch terug op het vangnet (extractie + herkansing), dus de pipeline blijft werken.</li>
                </ul>
              </div>
            </>
          )}

          {!isOmni && (
            <div style={{ borderTop: '1px solid var(--border-light)', paddingTop: 14, fontSize: 12.5, color: 'var(--gray)', lineHeight: 1.7 }}>
              De pipeline praat rechtstreeks met Anthropic. Model en sleutel komen uit de omgevingsvariabelen
              (<code>ANTHROPIC_MODEL</code>, <code>ANTHROPIC_API_KEY</code>). Schakel over naar Omniroute om tokens te sparen.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
