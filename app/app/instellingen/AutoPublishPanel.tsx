'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from '@/components/toast';
import PanelHeader from './PanelHeader';

type AutoPublishSettings = {
  enabled: boolean;
  intervalMinutes: number;
  lastPublishedAt: string | null;
  maxPerDay: number;
  clusterCooldown: number;
};
type SettingsResponse = AutoPublishSettings & { nextAt: string | null };

const PRESETS: { minutes: number; label: string }[] = [
  { minutes: 5, label: '5 min' },
  { minutes: 10, label: '10 min' },
  { minutes: 30, label: '30 min' },
  { minutes: 60, label: '1 uur' },
  { minutes: 120, label: '2 uur' },
  { minutes: 240, label: '4 uur' },
  { minutes: 480, label: '8 uur' },
  { minutes: 1440, label: '24 uur' },
];

const MAX_PER_DAY_PRESETS = [0, 6, 8, 12, 16, 24];
const CLUSTER_COOLDOWN_PRESETS = [0, 2, 3, 4, 5];

// Zelfde toggle-patroon als bronnen/page.tsx (geen gedeelde util-class voor
// dit element — zie docs/DESIGN-MAP.md §3).
function Toggle({ on, onClick, disabled }: { on: boolean; onClick?: () => void; disabled?: boolean }) {
  return (
    <span
      onClick={disabled ? undefined : onClick}
      title={on ? 'Actief — klik om te pauzeren' : 'Gepauzeerd — klik om te hervatten'}
      style={{
        width: 34, height: 20, borderRadius: 999, flexShrink: 0, position: 'relative',
        background: on ? 'var(--ink)' : 'var(--border)', cursor: disabled ? 'default' : 'pointer',
        transition: 'background 0.15s',
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: on ? 16 : 2, width: 16, height: 16, borderRadius: '50%',
        background: '#fff', transition: 'left 0.15s',
      }}
      />
    </span>
  );
}

function fmt(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const time = d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `vandaag ${time}`;
  const yesterday = new Date(now.getTime() - 86400000).toDateString() === d.toDateString();
  if (yesterday) return `gisteren ${time}`;
  return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' }) + ` ${time}`;
}

export default function AutoPublishPanel({
  eyebrow,
  title,
  description,
  onChanged,
}: {
  eyebrow: string;
  title: string;
  description: string;
  onChanged: () => void;
}) {
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/publish/settings');
    if (res.ok) setSettings(await res.json());
  }, []);

  useEffect(() => { load(); }, [load]);

  async function save(partial: Partial<AutoPublishSettings>) {
    setBusy(true);
    try {
      const res = await fetch('/api/publish/settings', {
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

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--card)' }}>
      <PanelHeader eyebrow={eyebrow} title={title} description={description} />
      {!settings ? (
        <div style={{ flex: 1 }} />
      ) : (
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '20px 28px 24px' }}>
      <div className="card" style={{ maxWidth: 560, padding: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <Toggle on={settings.enabled} disabled={busy} onClick={() => save({ enabled: !settings.enabled })} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Automatisch publiceren</div>
            <div style={{ fontSize: 12, color: 'var(--gray)', marginTop: 2, lineHeight: 1.5 }}>
              Publiceert zelf artikelen uit de kolom "Klaar voor publicatie" op het ingestelde interval — één artikel per keer.
            </div>
          </div>
        </div>

        <div>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 8 }}>
            Interval
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <select
              value={settings.intervalMinutes}
              disabled={busy}
              onChange={e => save({ intervalMinutes: Number(e.target.value) })}
              style={{
                fontSize: 13, fontWeight: 600, padding: '8px 12px', borderRadius: 8,
                border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--ink)',
              }}
            >
              {PRESETS.map(p => (
                <option key={p.minutes} value={p.minutes}>{p.label}</option>
              ))}
            </select>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>({settings.intervalMinutes} minuten)</span>
          </div>
        </div>

        <div>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 8 }}>
            Max. per dag
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <select
              value={settings.maxPerDay}
              disabled={busy}
              onChange={e => save({ maxPerDay: Number(e.target.value) })}
              style={{
                fontSize: 13, fontWeight: 600, padding: '8px 12px', borderRadius: 8,
                border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--ink)',
              }}
            >
              {MAX_PER_DAY_PRESETS.map(n => (
                <option key={n} value={n}>{n === 0 ? 'Onbeperkt' : `${n} per dag`}</option>
              ))}
            </select>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              {settings.maxPerDay === 0 ? 'geen dagcap' : 'harde cap in het laatste etmaal'}
            </span>
          </div>
        </div>

        <div>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 8 }}>
            Cluster-cooldown
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <select
              value={settings.clusterCooldown}
              disabled={busy}
              onChange={e => save({ clusterCooldown: Number(e.target.value) })}
              style={{
                fontSize: 13, fontWeight: 600, padding: '8px 12px', borderRadius: 8,
                border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--ink)',
              }}
            >
              {CLUSTER_COOLDOWN_PRESETS.map(n => (
                <option key={n} value={n}>{n === 0 ? 'Uit' : `${n} artikelen`}</option>
              ))}
            </select>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              {settings.clusterCooldown === 0 ? 'geen spreiding op soort' : 'geen soortgelijk artikel binnen de laatste ' + settings.clusterCooldown}
            </span>
          </div>
        </div>

        <div style={{ borderTop: '1px solid var(--border-light)', paddingTop: 14, fontSize: 12.5, color: 'var(--gray)', lineHeight: 1.7 }}>
          <div>Laatst gepubliceerd: <strong style={{ color: 'var(--ink)' }}>{fmt(settings.lastPublishedAt)}</strong></div>
          <div>Volgende publicatie: <strong style={{ color: 'var(--ink)' }}>{settings.enabled ? fmt(settings.nextAt) : 'gepauzeerd'}</strong></div>
          <div style={{ marginTop: 10, color: 'var(--muted)' }}>
            Volgorde: niet-evergreen artikelen met een naderend evenement eerst (dichtstbijzijnde datum voorop), dan
            overige niet-evergreen artikelen, dan evergreen content. Om te voorkomen dat er meerdere gelijksoortige
            artikelen kort na elkaar live gaan, wordt een kandidaat overgeslagen als hetzelfde soort zaak of gebeurtenis
            (cluster, bv. "muziekfestival" of "padelclub") al bij één van de laatste {settings.clusterCooldown || 3}{' '}
            publicaties zat — tenzij er geen alternatief klaarstaat. De dagcap begrenst bovendien het totaal aantal
            automatische publicaties per etmaal{settings.maxPerDay > 0 ? ` op ${settings.maxPerDay}` : ''}.
          </div>
        </div>
      </div>
      </div>
      )}
    </div>
  );
}
