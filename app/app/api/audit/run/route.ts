import { NextRequest, NextResponse } from 'next/server';
import { createAuditRun, failStaleAuditRuns } from '@/lib/db';
import { sampleForAudit } from '@/lib/auditor';
import { auditSearchConfigured } from '@/lib/auditSearch';
import type { AuditScope } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Default-steekproef en harde klem. Groter dan 10 heeft geen zin: elke tik doet
// één artikel (zie ../tick/route.ts), dus de UI zou minutenlang pollen.
const DEFAULT_SAMPLE = 3;
const MIN_SAMPLE = 1;
const MAX_SAMPLE = 10;

// Geen auth: dit is een redactie-actie vanaf het bord, zoals /api/publish/tick
// en /api/prompts. Deze route doet nog géén auditwerk — alleen de trekking en
// het aanmaken van de run, zodat hij ver binnen de 60s-limiet blijft.
export async function POST(req: NextRequest) {
  // Opruimen vóór een nieuwe run: een gesloten tabblad laat een run anders
  // eeuwig op 'running' staan en het paneel toont dan voortgang die er niet is.
  await failStaleAuditRuns().catch(() => {});
  const body = await req.json().catch(() => ({} as any));

  const scope: AuditScope = body?.scope === 'ready' ? 'ready' : 'drafts';

  let sampleSize = DEFAULT_SAMPLE;
  if (body?.sampleSize !== undefined) {
    const n = Number(body.sampleSize);
    if (!Number.isFinite(n)) {
      return NextResponse.json(
        { error: `sampleSize moet een getal tussen ${MIN_SAMPLE} en ${MAX_SAMPLE} zijn.` },
        { status: 400 }
      );
    }
    sampleSize = Math.min(MAX_SAMPLE, Math.max(MIN_SAMPLE, Math.trunc(n)));
  }

  // Instelfout, meteen zichtbaar: zonder eigen zoekindex is de auditor niet
  // onafhankelijk en heeft een run geen zin. Beter hier dan een run aanmaken
  // die de eerste tik direct op 'failed' zet.
  if (!auditSearchConfigured()) {
    return NextResponse.json(
      { error: 'SERPER_API_KEY ontbreekt — de auditor kan zonder eigen zoekindex geen claims natrekken.' },
      { status: 500 }
    );
  }

  try {
    const postIds = await sampleForAudit(scope, sampleSize);

    // Lege steekproef is geen fout: alles is al geauditeerd (14-daagse
    // cooldown) of de kolom is leeg. 200 met een melding, zodat de UI het
    // gewoon kan tonen in plaats van een foutbalk.
    if (!postIds.length) {
      const melding = scope === 'ready'
        ? 'Geen publicatieklare artikelen om te auditen — ze zijn de afgelopen 14 dagen al gecontroleerd, of de kolom is leeg.'
        : 'Geen te publiceren artikelen om te auditen — ze zijn de afgelopen 14 dagen al gecontroleerd, of er staan geen concepten klaar.';
      return NextResponse.json({ runId: null, postIds: [], melding, scope, sampleSize });
    }

    const runId = await createAuditRun(scope, sampleSize, postIds);
    return NextResponse.json({ runId, postIds, scope, sampleSize });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Auditrun starten mislukt.' }, { status: 500 });
  }
}
