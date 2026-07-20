import { NextRequest, NextResponse } from 'next/server';
import { processNextQueueJob } from '@/lib/queue';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

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
