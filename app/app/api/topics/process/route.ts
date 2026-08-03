import { NextResponse } from 'next/server';
import { processNextQueueJob } from '@/lib/queue';

export const dynamic = 'force-dynamic';
// Eén fase-stap kan lang duren: sinds Omniroute achter een lokaal model draait
// (~56 tok/s) kost een heel artikel makkelijk 100-200s aan generatie. 60s
// kapte die stap af (of dwong een kleinere, afgekapte output). Het plan staat
// maxDuration 300 toe (wordt ook door de carousel-publish gebruikt).
export const maxDuration = 300;

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
