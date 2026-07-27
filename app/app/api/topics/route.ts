import { NextRequest, NextResponse } from 'next/server';
import { addTopics, listTopics } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET() {
  return NextResponse.json({ topics: await listTopics() });
}

// Handmatige invoer hoort direct responsief te zijn. De kostbare WordPress- en
// Haiku-dedup-check gebeurt pas vlak voor het schrijven. Bronnenscans zijn de
// uitzondering: daar controleren we al bij import, zodat een grote externe
// agenda de wachtrij niet met bestaande onderwerpen vult.
export async function POST(req: NextRequest) {
  const body = await req.json();
  const rawTitles: string[] = Array.isArray(body.titles) ? body.titles : [String(body.title || '')];
  const titles = rawTitles.map(t => t.trim()).filter(Boolean);
  return NextResponse.json(await addTopics(titles));
}
