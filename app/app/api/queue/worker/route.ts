import { NextRequest, NextResponse } from 'next/server';
import { processNextQueueJob } from '@/lib/queue';

export const dynamic = 'force-dynamic';
// Zelfde reden als bij /api/topics/process: één fase-stap kan lang duren bij
// een lokaal Omniroute-model (~56 tok/s), dus dezelfde 300s-budgetten.
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Niet geautoriseerd.' }, { status: 401 });
  }
  try {
    return NextResponse.json(await processNextQueueJob());
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Wachtrijverwerking mislukt' }, { status: 500 });
  }
}
