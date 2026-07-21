import { NextRequest, NextResponse } from 'next/server';
import { syncWpPosts } from '@/lib/wpSync';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Cron/handmatig: Bearer CRON_SECRET, zelfde beveiligingspatroon als
// /api/queue/worker & /api/sources/scan. `?full=1` draait een volledige
// sync (incl. verwijderpas voor posts die niet meer terugkwamen); zonder
// die param is het de incrementele sync (default, licht genoeg voor een
// veelvuldige cron).
async function handle(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Niet geautoriseerd.' }, { status: 401 });
  }
  try {
    const full = req.nextUrl.searchParams.get('full') === '1';
    return NextResponse.json(await syncWpPosts({ full }));
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'WP-sync mislukt.' }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
