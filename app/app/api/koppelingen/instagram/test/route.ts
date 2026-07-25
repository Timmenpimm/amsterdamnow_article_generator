import { NextResponse } from 'next/server';
import { EngineError, engineFetch, getEngineSettings } from '@/lib/socialsEngine';

export const dynamic = 'force-dynamic';

// Proxyt de verbindingstest van de socials-engine: POST met lege body test de
// dáár opgeslagen Instagram-verbinding. Redactie-route zonder auth (zoals
// /api/model); antwoord bevat nooit keys of tokens.
export async function POST() {
  const s = await getEngineSettings();
  if (!s.apiKey) {
    return NextResponse.json({ ok: false, error: 'Er is nog geen API-key voor de socials-engine ingesteld.' });
  }
  try {
    const res = await engineFetch('/api/settings/instagram/test', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const data = await res.json().catch(() => null);
    if (data && typeof data === 'object' && 'ok' in data) {
      return NextResponse.json({
        ok: Boolean(data.ok),
        ...(typeof data.username === 'string' && data.username ? { username: data.username } : {}),
        ...(!data.ok && typeof data.error === 'string' ? { error: String(data.error).slice(0, 300) } : {}),
      });
    }
    return NextResponse.json({ ok: false, error: 'Onverwacht antwoord van de socials-engine.' });
  } catch (err) {
    if (err instanceof EngineError) {
      if (err.status === 401) return NextResponse.json({ ok: false, error: 'De engine wijst de API-key af (401).' });
      if (err.status === null) return NextResponse.json({ ok: false, error: 'Socials-engine niet bereikbaar.' });
      return NextResponse.json({ ok: false, error: `Test mislukt — engine gaf status ${err.status}.` });
    }
    return NextResponse.json({ ok: false, error: 'Test mislukt.' });
  }
}
