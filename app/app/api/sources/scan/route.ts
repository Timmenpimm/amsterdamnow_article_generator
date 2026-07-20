import { NextRequest, NextResponse } from 'next/server';
import { scanAllActiveSources } from '@/lib/scanner';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Dagelijkse cron (Vercel stuurt Authorization: Bearer <CRON_SECRET> mee zodra
// CRON_SECRET is gezet), zelfde beveiligingspatroon als /api/queue/worker.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Niet geautoriseerd.' }, { status: 401 });
  }
  try {
    return NextResponse.json({ results: await scanAllActiveSources() });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Scan mislukt.' }, { status: 500 });
  }
}

// Server-side "alle bronnen scannen" (de UI-knop loopt normaal per bron voor
// live voortgang; deze variant is er voor volledigheid en als fallback).
export async function POST() {
  try {
    return NextResponse.json({ results: await scanAllActiveSources() });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Scan mislukt.' }, { status: 500 });
  }
}
