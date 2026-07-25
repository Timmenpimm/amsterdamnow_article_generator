import { NextRequest, NextResponse } from 'next/server';
import { getWpConnection, isValidWpUrl, normalizeWpUrl } from '@/lib/wpConfig';

export const dynamic = 'force-dynamic';

// Test de WordPress-verbinding met een GET op /wp/v2/users/me (Basic auth).
// Body-velden zijn optioneel: ontbrekende velden vallen terug op de
// opgeslagen/env-verbinding, zodat "Test verbinding" ook zonder her-invoer van
// het wachtwoord werkt. Redactie-route zonder auth, zoals /api/model; het
// antwoord bevat nooit credentials.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const saved = await getWpConnection();

  const url = typeof body.url === 'string' && body.url.trim() ? normalizeWpUrl(body.url) : saved.url;
  const user = typeof body.user === 'string' && body.user.trim() ? body.user.trim() : saved.user;
  const appPassword = typeof body.appPassword === 'string' && body.appPassword.trim()
    ? body.appPassword.trim()
    : saved.appPassword;

  if (!isValidWpUrl(url)) {
    return NextResponse.json({ ok: false, error: 'Site-URL moet met http:// of https:// beginnen.' });
  }
  if (!user || !appPassword) {
    return NextResponse.json({ ok: false, error: 'Gebruikersnaam en application password zijn nog niet ingesteld.' });
  }

  try {
    const res = await fetch(`${url}/wp-json/wp/v2/users/me`, {
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${user}:${appPassword}`).toString('base64'),
        Accept: 'application/json',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const msg = res.status === 401 || res.status === 403
        ? 'WordPress wijst de inloggegevens af (controleer gebruikersnaam en application password).'
        : `WordPress antwoordde met status ${res.status}.`;
      return NextResponse.json({ ok: false, error: msg });
    }
    const me = await res.json().catch(() => null);
    return NextResponse.json({ ok: true, name: typeof me?.name === 'string' ? me.name : user });
  } catch {
    return NextResponse.json({ ok: false, error: `Kon ${url} niet bereiken.` });
  }
}
