import { NextRequest, NextResponse } from 'next/server';
import { getAuditRun, saveAuditFindings, finishAuditRun, claimNextAuditPost, releaseAuditPost } from '@/lib/db';
import { auditOneArticle } from '@/lib/auditor';
import { auditSearchConfigured } from '@/lib/auditSearch';
import { worstVerdict } from '@/lib/types';
import type { AuditFindingInput, AuditVerdict } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Fouten die niet aan één artikel liggen maar aan de omgeving: dan heeft
// doorgaan met de volgende artikelen geen zin en gaat de hele run op 'failed'.
// Alles wat hier NIET op matcht is een artikelfout: dat artikel krijgt een
// 'twijfel'-bevinding met de melding en de run loopt door.
const INFRA_PATRONEN: RegExp[] = [
  /SERPER_API_KEY/i,
  /ANTHROPIC_API_KEY/i,
  /API[-_ ]?key\b/i,
  /DATABASE_URL/i,
  /\bdatabase\b/i,
  /ECONNREFUSED/i,
  /ENOTFOUND/i,
  /EAI_AGAIN/i,
  /ETIMEDOUT/i,
  /Connection terminated/i,
  /too many connections/i,
];

function isInfraFout(e: any): boolean {
  const melding = String(e?.message || e || '');
  const code = String(e?.code || '');
  return INFRA_PATRONEN.some(p => p.test(melding) || p.test(code));
}

// Fallback-bevinding als de audit van één artikel klapt: 'twijfel', want we
// weten niets over dit artikel — niet 'ok' (dat zou een geslaagde controle
// suggereren) en niet 'fout' (er is geen bron die iets tegenspreekt).
function foutBevinding(melding: string): AuditFindingInput {
  return {
    kind: 'tekst',
    verdict: 'twijfel',
    onderwerp: 'audit mislukt',
    bevinding: melding,
    bron: '',
  };
}

// Verwerkt precies ÉÉN artikel per aanroep: het eerste post-id uit postIds dat
// nog niet in donePostIds staat. Per artikel gaat er een claim-extractie, 1-3
// Serper-calls en een vision-call in — meer dan één artikel past niet binnen de
// 60s-functielimiet van Vercel (zie docs/DESIGN-MAP.md §4, valkuil 2).
// De UI pollt deze route tot `done` true is.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({} as any));
  const runId = Number(body?.runId);
  if (!Number.isInteger(runId) || runId <= 0) {
    return NextResponse.json({ error: 'runId is verplicht en moet een geheel getal zijn.' }, { status: 400 });
  }

  let run;
  try {
    run = await getAuditRun(runId);
  } catch (e: any) {
    return NextResponse.json(
      { error: `Auditrun ${runId} kon niet worden gelezen: ${e?.message || 'database onbereikbaar'}` },
      { status: 500 }
    );
  }
  if (!run) {
    return NextResponse.json({ error: `Auditrun ${runId} niet gevonden.` }, { status: 404 });
  }

  const gedaan = new Set<number>(run.donePostIds || []);
  const openIds = (run.postIds || []).filter((id: number) => !gedaan.has(id));

  // Alles al gedaan (of een lege run): afronden en klaar melden. Idempotent —
  // een dubbele poll van de UI mag hier gewoon nog eens langskomen.
  if (!openIds.length) {
    try {
      if (!run.finishedAt) await finishAuditRun(runId);
    } catch (e: any) {
      return NextResponse.json(
        { error: `Auditrun ${runId} afronden mislukt: ${e?.message || 'database onbereikbaar'}` },
        { status: 500 }
      );
    }
    return NextResponse.json({ done: true, remaining: 0, postId: null, findings: 0, verdict: null });
  }

  // Ontbrekende Serper-sleutel is per definitie een infrastructuurfout: dan
  // heeft de auditor geen onafhankelijke bron en is elk oordeel waardeloos.
  // Meteen de hele run op 'failed', niet artikel voor artikel dezelfde fout.
  if (!auditSearchConfigured()) {
    const melding = 'SERPER_API_KEY ontbreekt — de auditor kan geen onafhankelijke bronnen bevragen.';
    await finishAuditRun(runId, melding).catch(() => {});
    return NextResponse.json({ error: melding }, { status: 500 });
  }

  // Atomisch claimen in plaats van "pak het eerste open id": twee tabbladen of
  // een dubbelklik zouden anders hetzelfde artikel oppakken, met dubbele
  // bevindingen en dubbele modelkosten tot gevolg. Levert de claim niets op,
  // dan is een andere tik er al mee bezig; dan melden we voortgang zonder werk
  // te doen in plaats van hetzelfde artikel nog eens te auditen.
  const postId = await claimNextAuditPost(runId);
  if (postId === null) {
    return NextResponse.json({ done: false, remaining: openIds.length, postId: null, findings: 0, verdict: null });
  }

  let findings: AuditFindingInput[];
  try {
    findings = await auditOneArticle(postId);
  } catch (e: any) {
    const melding = e?.message || 'onbekende fout';
    if (isInfraFout(e)) {
      // Claim teruggeven: de run gaat op 'failed', maar wordt hij later opnieuw
      // opgepakt, dan moet dit artikel niet stil overgeslagen worden.
      await releaseAuditPost(runId, postId).catch(() => {});
      const runMelding = `Audit gestopt bij artikel ${postId}: ${melding}`;
      await finishAuditRun(runId, runMelding).catch(() => {});
      return NextResponse.json({ error: runMelding }, { status: 500 });
    }
    // Eén kapot artikel mag de run niet stoppen: markeer 'm als gedaan met een
    // 'twijfel'-bevinding die de foutmelding bevat, en ga door met de rest.
    console.error(`[audit] artikel ${postId} in run ${runId} mislukt`, e);
    findings = [foutBevinding(`Audit van dit artikel mislukte: ${melding}`)];
  }

  // saveAuditFindings markeert postId als done — ook bij nul bevindingen.
  try {
    await saveAuditFindings(runId, postId, findings);
  } catch (e: any) {
    await releaseAuditPost(runId, postId).catch(() => {});
    const runMelding = `Bevindingen van artikel ${postId} opslaan mislukt: ${e?.message || 'database onbereikbaar'}`;
    await finishAuditRun(runId, runMelding).catch(() => {});
    return NextResponse.json({ error: runMelding }, { status: 500 });
  }

  const remaining = openIds.length - 1;
  if (remaining === 0) {
    try {
      await finishAuditRun(runId);
    } catch (e: any) {
      return NextResponse.json(
        { error: `Auditrun ${runId} afronden mislukt: ${e?.message || 'database onbereikbaar'}` },
        { status: 500 }
      );
    }
  }

  // Geen bevindingen = 'ok' (zie worstVerdict in types.ts).
  const verdict: AuditVerdict = worstVerdict(findings);

  return NextResponse.json({
    done: remaining === 0,
    remaining,
    postId,
    findings: findings.length,
    verdict,
  });
}
