import { NextRequest, NextResponse } from 'next/server';
import { getTavilyApiKey } from '@/lib/tavilyConfig';

export const dynamic = 'force-dynamic';

// Test de Tavily-key met een GET op /usage — dat endpoint valideert de key
// (401 bij een ongeldige) en geeft verbruik/limiet terug zonder credits te
// kosten, dus goedkoper dan een echte search. Body-veld `apiKey` is
// optioneel: zonder valt de test terug op de opgeslagen/env-key, zodat "Test
// verbinding" ook zonder her-invoer werkt. Redactie-route zonder auth, zoals
// /api/koppelingen/wordpress/test; het antwoord bevat nooit de key zelf.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const apiKey = typeof body.apiKey === 'string' && body.apiKey.trim()
    ? body.apiKey.trim()
    : await getTavilyApiKey();

  if (!apiKey) {
    return NextResponse.json({ ok: false, error: 'Er is nog geen Tavily-API-key ingesteld.' });
  }

  try {
    const res = await fetch('https://api.tavily.com/usage', {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const msg = res.status === 401 || res.status === 403
        ? 'Tavily wijst deze API-key af (controleer de key).'
        : res.status === 429 || res.status === 432 || res.status === 433
          ? 'Deze key werkt, maar het quotum is op / de limiet is bereikt. Wissel naar een andere key of wacht tot het quotum ververst.'
          : `Tavily antwoordde met status ${res.status}.`;
      return NextResponse.json({ ok: false, error: msg });
    }
    const data = await res.json().catch(() => null) as {
      key?: { usage?: number; limit?: number | null };
      account?: { current_plan?: string; plan_usage?: number; plan_limit?: number | null };
    } | null;
    const usage = data?.account?.plan_usage ?? data?.key?.usage ?? null;
    const limit = data?.account?.plan_limit ?? data?.key?.limit ?? null;
    const exhausted = typeof usage === 'number' && typeof limit === 'number' && limit > 0 && usage >= limit;
    return NextResponse.json({
      ok: true,
      plan: data?.account?.current_plan ?? null,
      usage,
      limit,
      exhausted,
    });
  } catch {
    return NextResponse.json({ ok: false, error: 'Kon api.tavily.com niet bereiken.' });
  }
}
