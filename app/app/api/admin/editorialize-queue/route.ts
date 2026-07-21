import { NextRequest, NextResponse } from 'next/server';
import { listTopics, queuedScannerTopics, updateTopicTitle } from '@/lib/db';
import { editorializeTitles } from '@/lib/scanner';

export const dynamic = 'force-dynamic';

// Eenmalige, idempotente herformulering van bestaande wachtrij-items die door
// de scanner letterlijk uit een bronkop zijn overgenomen: de titel wordt via
// editorializeTitles() omgezet naar een eigen input-topic. Idempotent doordat
// herschreven titels de dedup_key van hun vondst niet meer matchen en dus uit
// de selectie van queuedScannerTopics() vallen. Nieuwe scans herformuleren al
// bij binnenkomst; dit is alleen de inhaalslag voor de bestaande wachtrij.
//
// Beveiligd met Bearer CRON_SECRET; per tik max MAX_PER_TICK i.v.m. de 60s
// serverless-limiet. De aanroeper blijft POST'en tot done: true.
const MAX_PER_TICK = 25;

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    const todo = await queuedScannerTopics();
    const batch = todo.slice(0, MAX_PER_TICK);

    // Eén LLM-call voor de hele batch; fail-open (bij een fout komen de
    // originele titels terug en slaan we ze hieronder als "ongewijzigd" over).
    const rewritten = batch.length ? await editorializeTitles(batch.map(t => t.title)) : [];

    // Huidige wachtrijtitels (lower+trim, zoals addTopics dedupt) om te
    // voorkomen dat een herschreven titel een duplicaat in de wachtrij wordt.
    const queue = await listTopics();
    const existing = new Set(queue.map(t => t.title.toLowerCase().trim()));

    const changed: { id: number; van: string; naar: string }[] = [];
    const skipped: { id: number; titel: string; reden: string }[] = [];
    for (let i = 0; i < batch.length; i++) {
      const { id, title } = batch[i];
      const nieuw = (rewritten[i] || '').trim();
      if (!nieuw || nieuw === title) {
        skipped.push({ id, titel: title, reden: 'ongewijzigd' });
        continue;
      }
      const key = nieuw.toLowerCase();
      if (existing.has(key)) {
        skipped.push({ id, titel: title, reden: 'bestaat al in wachtrij' });
        continue;
      }
      await updateTopicTitle(id, nieuw);
      existing.delete(title.toLowerCase().trim());
      existing.add(key);
      changed.push({ id, van: title, naar: nieuw });
    }

    return NextResponse.json({
      done: todo.length <= MAX_PER_TICK,
      changed,
      skipped,
      remaining: Math.max(0, todo.length - batch.length),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
