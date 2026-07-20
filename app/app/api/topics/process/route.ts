import { NextResponse } from 'next/server';
import { processNextQueueJob } from '@/lib/queue';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Eén verwerkingsstap per aanroep. Een lopende lijstrun heeft voorrang;
// daarna bepaalt de wachtrijvolgorde of de standaard- of lijstpipeline start.
// Lijstruns geven done=false terug zolang er fasen resteren: de frontend
// blijft dan aanroepen tot de run klaar is of op itemcontrole wacht.
export async function POST() {
  try {
    return NextResponse.json(await processNextQueueJob());
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Schrijven mislukt' }, { status: 500 });
  }
}
