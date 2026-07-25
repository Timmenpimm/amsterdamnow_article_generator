import { NextRequest, NextResponse } from 'next/server';
import { getWpConnection, saveWpConnection, isValidWpUrl } from '@/lib/wpConfig';

export const dynamic = 'force-dynamic';

// Redactie-instelling, client-driven zoals /api/model — geen CRON-auth.
// Slaat op onder app_settings-key `wordpress_connection`.
//
// LET OP: het application password wordt in de GET-respons gemaskeerd
// teruggegeven (alleen óf er één is ingesteld), zodat het nooit naar de
// client lekt.
async function redacted() {
  const conn = await getWpConnection();
  return {
    url: conn.url,
    user: conn.user,
    hasPassword: Boolean(conn.appPassword),
    source: conn.source,
    live: conn.live,
  };
}

export async function GET() {
  return NextResponse.json(await redacted());
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const partial: Parameters<typeof saveWpConnection>[0] = {};

  if (body.url !== undefined) {
    if (typeof body.url !== 'string') {
      return NextResponse.json({ error: 'url moet een string zijn.' }, { status: 400 });
    }
    const url = body.url.trim();
    if (url && !isValidWpUrl(url)) {
      return NextResponse.json({ error: 'Site-URL moet met http:// of https:// beginnen.' }, { status: 400 });
    }
    partial.url = url; // leeg = terugvallen op env
  }

  if (body.user !== undefined) {
    if (typeof body.user !== 'string') {
      return NextResponse.json({ error: 'user moet een string zijn.' }, { status: 400 });
    }
    partial.user = body.user.trim();
  }

  // Lege string = bestaand wachtwoord behouden (de client stuurt nooit een
  // lege waarde om het bestaande te overschrijven) — zelfde conventie als de
  // API-key in /api/model.
  if (typeof body.appPassword === 'string' && body.appPassword.trim()) {
    partial.appPassword = body.appPassword.trim();
  }

  await saveWpConnection(partial);
  return NextResponse.json(await redacted());
}
