import { NextRequest, NextResponse } from 'next/server';
import { scanAllActiveSources } from '@/lib/scanner';
import { syncWpPosts, type WpSyncResult } from '@/lib/wpSync';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Vercel Hobby staat maar één cron per dag toe, dus deze dagelijkse cron doet
// twee dingen op rij: (1) de wp_posts-dedup-index verversen zodat de tool nooit
// onderwerpen genereert die al op amsterdamnow.com staan, en pas dáárna (2) de
// bronnen scannen — de scan voegt nieuwe topics toe die meteen tegen de zojuist
// ververste index gededupliceerd worden. Zonder deze stap ververste de index
// alleen lui (>6u-staleness-trigger in lib/dedup.ts, en enkel wanneer iemand een
// topic toevoegt); een onbeheerde site kon zo dagen op een verouderde index
// draaien.
//
// Incrementeel op zes dagen (licht: alleen modified_after + self-heal), één keer
// per week een volledige resync mét verwijderpas zodat op de site verwijderde
// posts ook uit de index verdwijnen. Maandag = getUTCDay() 1; de cron draait om
// 05:00 UTC (07:00 CEST), dus de dag-check zit veilig binnen de juiste UTC-dag.
function shouldRunFullSync(): boolean {
  return new Date().getUTCDay() === 1;
}

async function refreshDedupIndex(): Promise<{ wpSync: WpSyncResult | { error: string } }> {
  const full = shouldRunFullSync();
  try {
    const wpSync = await syncWpPosts({ full });
    console.log(`[cron] wp_posts-index ververst (${full ? 'full' : 'incrementeel'}):`, JSON.stringify(wpSync));
    return { wpSync };
  } catch (e: any) {
    // Fail-soft: een mislukte sync mag de bronnen-scan niet blokkeren. De
    // staleness-guard in checkTopicAgainstWp vangt een verouderde index alsnog
    // af zodra er een topic gecheckt wordt.
    const error = e?.message || 'wp-sync mislukt';
    console.warn('[cron] wp_posts-sync mislukt, ga door met bronnen-scan', error);
    return { wpSync: { error } };
  }
}

// Dagelijkse cron (Vercel stuurt Authorization: Bearer <CRON_SECRET> mee zodra
// CRON_SECRET is gezet), zelfde beveiligingspatroon als /api/queue/worker.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Niet geautoriseerd.' }, { status: 401 });
  }
  try {
    // Eerst de index verversen (fail-soft), dan pas scannen zodat nieuwe
    // vondsten tegen de verse index gededupliceerd worden.
    const { wpSync } = await refreshDedupIndex();
    const results = await scanAllActiveSources();
    return NextResponse.json({ wpSync, results });
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
