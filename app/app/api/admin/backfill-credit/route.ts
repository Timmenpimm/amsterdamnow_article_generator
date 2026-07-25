import { NextRequest, NextResponse } from 'next/server';
import { listArticles, updateImages } from '@/lib/wp';
import { cleanCredit, needsCleaning } from '@/lib/credit';

export const dynamic = 'force-dynamic';

// Eenmalige, idempotente schoonmaak van het ACF-veld `fotograaf`: haalt de
// onbevestigde Google-licentieclaim eruit en laat auteur + bron staan. Zie
// lib/credit.ts voor het waarom. Raakt drafts én gepubliceerde artikelen —
// een audit op 25-07-2026 vond de string in 30 van de 31 publicatieklare
// artikelen en in 15 al gepubliceerde.
//
// Beveiligd met Bearer CRON_SECRET; per tik max MAX_PER_TICK i.v.m. de 60s
// serverless-limiet. De aanroeper blijft POST'en tot done: true.
// Body: { dryRun?: boolean, publishedPerPage?: number }
const MAX_PER_TICK = 12;

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    const body = await req.json().catch(() => ({})) as { dryRun?: boolean; publishedPerPage?: number };
    // Standaard ruimer dan het bord (15) — gepubliceerde artikelen dragen de
    // string ook en vallen anders buiten de scope.
    const articles = await listArticles(body.publishedPerPage ?? 100);
    const todo = articles.filter(a => needsCleaning(a.fotograaf));

    // Droogloop schrijft niets en mag dus de hele lijst in één keer tonen.
    const batch = body.dryRun ? todo : todo.slice(0, MAX_PER_TICK);
    const changed: { id: number; status: string; van: string; naar: string }[] = [];
    for (const a of batch) {
      const naar = cleanCredit(a.fotograaf);
      // Alleen het fotograaf-veld meegeven: updateImages laat featured/slider/
      // inline ongemoeid zolang die keys ontbreken.
      if (!body.dryRun) await updateImages(a.id, { fotograaf: naar });
      changed.push({ id: a.id, status: a.status, van: a.fotograaf, naar });
    }

    return NextResponse.json({
      done: body.dryRun ? true : todo.length <= MAX_PER_TICK,
      dryRun: Boolean(body.dryRun),
      scanned: articles.length,
      matches: todo.length,
      changed,
      remaining: body.dryRun ? 0 : Math.max(0, todo.length - batch.length),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
