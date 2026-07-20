import { NextRequest, NextResponse } from 'next/server';
import { addSource, listSources } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ sources: await listSources() });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const url = String(body.url || '').trim();
  if (!url) return NextResponse.json({ error: 'Geef een URL op.' }, { status: 400 });
  try {
    const { source, duplicate } = await addSource(url, body.name, body.label);
    return NextResponse.json({ source, duplicate });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Toevoegen mislukt.' }, { status: 400 });
  }
}
