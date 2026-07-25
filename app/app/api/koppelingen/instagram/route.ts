import { NextRequest, NextResponse } from 'next/server';
import {
  EngineError,
  engineFetch,
  getEngineSettings,
  isValidEngineUrl,
  saveEngineSettings,
} from '@/lib/socialsEngine';

export const dynamic = 'force-dynamic';

// Koppeling met de socials-engine (die Instagram bezit). De artikel-tool
// proxyt server-side met een Bearer-key; redactie-route zonder auth zoals
// /api/model, en de GET-respons bevat nooit de key of het access token —
// alleen booleans en de door de engine al gemaskeerde verbinding.

interface EngineConnection {
  igUsername: string;
  businessAccountId: string;
  hasToken: boolean;
}

// Leest de Instagram-verbinding bij de engine op. `null` = niets ingesteld of
// (nog) niet opvraagbaar; de fout gaat als aparte string terug zodat de UI
// een nette Nederlandse melding kan tonen.
async function fetchEngineConnection(): Promise<{ connection: EngineConnection | null; error?: string }> {
  try {
    const res = await engineFetch('/api/settings/instagram');
    const data = await res.json().catch(() => null);
    if (!data || typeof data !== 'object') return { connection: null };
    const igUsername = typeof data.igUsername === 'string' ? data.igUsername : '';
    const businessAccountId = typeof data.businessAccountId === 'string' ? data.businessAccountId : '';
    const hasToken = Boolean(data.hasAccessToken ?? data.hasToken ?? data.accessToken);
    if (!igUsername && !businessAccountId && !hasToken) return { connection: null };
    return { connection: { igUsername, businessAccountId, hasToken } };
  } catch (err) {
    if (err instanceof EngineError) {
      if (err.status === 401) return { connection: null, error: 'De engine wijst de API-key af (401).' };
      if (err.status === 404) return { connection: null }; // niets opgeslagen aan engine-kant
      if (err.status === null) return { connection: null, error: 'Socials-engine niet bereikbaar.' };
      return { connection: null, error: `Socials-engine gaf status ${err.status}.` };
    }
    return { connection: null, error: 'Socials-engine niet bereikbaar.' };
  }
}

async function status() {
  const s = await getEngineSettings();
  const hasEngineKey = Boolean(s.apiKey);
  // Zonder key niet bij de engine aankloppen: dat wordt gegarandeerd een 401.
  const { connection, error } = hasEngineKey
    ? await fetchEngineConnection()
    : { connection: null, error: undefined };
  return {
    engineConfigured: hasEngineKey,
    hasEngineKey,
    engineUrl: s.baseUrl,
    connection,
    ...(error ? { error } : {}),
  };
}

export async function GET() {
  return NextResponse.json(await status());
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));

  // 1. Engine-instellingen lokaal opslaan (key `socials_engine`).
  const partial: Parameters<typeof saveEngineSettings>[0] = {};
  if (body.engineUrl !== undefined) {
    if (typeof body.engineUrl !== 'string') {
      return NextResponse.json({ error: 'engineUrl moet een string zijn.' }, { status: 400 });
    }
    const url = body.engineUrl.trim();
    if (url && !isValidEngineUrl(url)) {
      return NextResponse.json({ error: 'Engine-URL moet met http:// of https:// beginnen.' }, { status: 400 });
    }
    partial.baseUrl = url; // leeg = terugvallen op env/default
  }
  // Lege string = bestaande key behouden (zelfde conventie als /api/model).
  if (typeof body.engineApiKey === 'string' && body.engineApiKey.trim()) {
    partial.apiKey = body.engineApiKey.trim();
  }
  if (Object.keys(partial).length) await saveEngineSettings(partial);

  // 2. Instagram-credentials (optioneel) doorsturen naar de engine.
  const accessToken = typeof body.accessToken === 'string' ? body.accessToken.trim() : '';
  const businessAccountId = typeof body.businessAccountId === 'string' ? body.businessAccountId.trim() : '';
  const igUsername = typeof body.igUsername === 'string' ? body.igUsername.trim() : '';
  if (accessToken || businessAccountId) {
    try {
      await engineFetch('/api/settings/instagram', {
        method: 'POST',
        body: JSON.stringify({
          ...(accessToken ? { accessToken } : {}),
          ...(businessAccountId ? { businessAccountId } : {}),
          ...(igUsername ? { igUsername } : {}),
        }),
      });
    } catch (err) {
      const msg = err instanceof EngineError && err.status === 401
        ? 'De engine wijst de API-key af (401) — Instagram-gegevens niet opgeslagen.'
        : 'Kon de Instagram-gegevens niet naar de socials-engine sturen.';
      return NextResponse.json({ ...(await status()), error: msg }, { status: 502 });
    }
  }

  return NextResponse.json(await status());
}
