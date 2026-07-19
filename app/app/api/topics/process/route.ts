import { NextResponse } from 'next/server';
import { activeListTopic, peekNextQueued } from '@/lib/db';
import { writeNextTopic } from '@/lib/writer';
import { processListStep } from '@/lib/listWriter';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Eén verwerkingsstap per aanroep. Een lopende lijstrun heeft voorrang;
// daarna bepaalt de wachtrijvolgorde of de standaard- of lijstpipeline start.
// Lijstruns geven done=false terug zolang er fasen resteren: de frontend
// blijft dan aanroepen tot de run klaar is of op itemcontrole wacht.
export async function POST() {
  try {
    const running = await activeListTopic();
    if (running) {
      const step = await processListStep(running.id);
      return NextResponse.json({ list: step, topic: step?.topic ?? null, article: step?.article ?? null });
    }
    const next = await peekNextQueued();
    if (next?.type === 'lijst') {
      const step = await processListStep();
      return NextResponse.json({ list: step, topic: step?.topic ?? null, article: step?.article ?? null });
    }
    const result = await writeNextTopic();
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Schrijven mislukt' }, { status: 500 });
  }
}
