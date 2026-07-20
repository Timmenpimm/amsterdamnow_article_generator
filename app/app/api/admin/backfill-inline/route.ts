import { NextRequest, NextResponse } from 'next/server';
import { listArticles, updateImages } from '@/lib/wp';
import { getListStructure } from '@/lib/db';

export const dynamic = 'force-dynamic';

// Eenmalige, idempotente omzetting van bestaande niet-gepubliceerde concepten
// van "featured + 2 slider" naar "featured + 1 slider + 1 inline": het laatste
// sliderbeeld verhuist naar een inline-beeld in de tekst. Alleen standaard-
// artikelen (lijstartikelen hebben hun eigen itemfoto-flow en her-assembleren
// hun content). Gepubliceerde artikelen blijven ongemoeid.
//
// Beveiligd met Bearer CRON_SECRET; per tik max MAX_PER_TICK i.v.m. de 60s
// serverless-limiet. De aanroeper blijft POST'en tot done: true.
const MAX_PER_TICK = 8;

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    const articles = await listArticles();
    const candidates = articles.filter(a => a.status !== 'publish' && a.slider.length >= 2 && !a.inline);

    // Sla lijstartikelen over (eigen itemfoto-flow).
    const todo: typeof candidates = [];
    for (const a of candidates) {
      const list = await getListStructure(a.id);
      if (!list) todo.push(a);
    }

    const batch = todo.slice(0, MAX_PER_TICK);
    const changed: { id: number; title: string }[] = [];
    for (const a of batch) {
      const last = a.slider[a.slider.length - 1];
      await updateImages(
        a.id,
        { sliderIds: a.slider.slice(0, -1).map(m => m.id), inlineId: last.id },
        [...a.slider, ...(a.featured ? [a.featured] : [])]
      );
      changed.push({ id: a.id, title: a.title });
    }

    return NextResponse.json({
      done: todo.length <= MAX_PER_TICK,
      changed,
      remaining: Math.max(0, todo.length - batch.length),
      skippedLists: candidates.length - todo.length,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
