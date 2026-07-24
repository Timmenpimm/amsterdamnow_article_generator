import { NextRequest, NextResponse } from 'next/server';
import { getModelSettings } from '@/lib/modelConfig';

export const dynamic = 'force-dynamic';

// Proxy voor de live modellenlijst van een Omniroute-endpoint (GET /v1/models).
// Server-side omdat de browser localhost:20128 niet betrouwbaar/CORS-vrij kan
// bereiken. Query ?baseUrl= overschrijft de opgeslagen endpoint (voor de
// "test verbinding"-knop terwijl je nog aan het typen bent).
export async function GET(req: NextRequest) {
  const override = req.nextUrl.searchParams.get('baseUrl')?.trim();
  const settings = await getModelSettings();
  const base = (override && /^https?:\/\//i.test(override) ? override : settings.omniroute.baseUrl).replace(/\/+$/, '');
  const url = `${base}/v1/models`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, {
      headers: settings.omniroute.apiKey ? { authorization: `Bearer ${settings.omniroute.apiKey}` } : {},
      cache: 'no-store',
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) {
      return NextResponse.json({ error: `Endpoint gaf ${res.status}.`, models: [] }, { status: 502 });
    }
    const data = await res.json().catch(() => ({}));
    const models: string[] = Array.isArray(data?.data)
      ? data.data.map((m: { id?: string }) => m?.id).filter((id: unknown): id is string => typeof id === 'string')
      : [];
    return NextResponse.json({ models });
  } catch (e) {
    return NextResponse.json(
      { error: `Endpoint onbereikbaar op ${url} (${(e as Error).message}). Draait Omniroute?`, models: [] },
      { status: 502 }
    );
  }
}
