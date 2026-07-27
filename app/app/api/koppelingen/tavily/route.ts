import { NextRequest, NextResponse } from 'next/server';
import { getTavilyKeyStatus, saveTavilyApiKey, clearTavilyApiKey } from '@/lib/tavilyConfig';

export const dynamic = 'force-dynamic';

// Redactie-instelling, client-driven zoals /api/koppelingen/wordpress — geen
// CRON-auth. Slaat op onder app_settings-key `tavily_api_key`.
//
// LET OP: de key wordt in élke respons gemaskeerd teruggegeven (alleen de
// laatste 4 tekens), zodat hij nooit naar de client lekt.

export async function GET() {
  return NextResponse.json(await getTavilyKeyStatus());
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (typeof body.apiKey !== 'string' || !body.apiKey.trim()) {
    return NextResponse.json({ error: 'apiKey ontbreekt.' }, { status: 400 });
  }
  return NextResponse.json(await saveTavilyApiKey(body.apiKey.trim()));
}

// Verwijdert de override; de tool valt terug op de env-var TAVILY_API_KEY.
export async function DELETE() {
  return NextResponse.json(await clearTavilyApiKey());
}
