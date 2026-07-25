import { NextResponse } from 'next/server';
import { listAuditRuns, listAuditFindings, failStaleAuditRuns } from '@/lib/db';
import { worstVerdict } from '@/lib/types';
import type { AuditFinding, AuditRun, AuditVerdict } from '@/lib/types';

export const dynamic = 'force-dynamic';

// Aantal runs in het paneel op het bord. Meer historie is er wel, maar hoeft
// niet in één keer mee: per run wordt ook de bevindingenlijst gelezen.
const RUNS = 10;

// Collectie-route (/api/audit) — loopt via de catch-all in vercel.json, net als
// /api/board. Geen auth: leesactie voor het bord.
export async function GET() {
  try {
    // Zie /api/audit/run: vastgelopen runs afzetten voordat we ze tonen.
    await failStaleAuditRuns().catch(() => {});
    const runs = await listAuditRuns(RUNS);

    const withVerdicts = await Promise.all(runs.map(async (run: AuditRun) => {
      const findings = await listAuditFindings(run.id);

      // Per post-id het zwaarste verdict (fout > twijfel > ok), zodat het
      // paneel per artikel één chip kan tonen zonder de bevindingen te laden.
      const perPost = new Map<number, AuditFinding[]>();
      for (const f of findings) {
        const bucket = perPost.get(f.postId);
        if (bucket) bucket.push(f);
        else perPost.set(f.postId, [f]);
      }
      const verdictPerPost: Record<number, AuditVerdict> = {};
      for (const [postId, eigen] of perPost) verdictPerPost[postId] = worstVerdict(eigen);

      return { ...run, aantalBevindingen: findings.length, verdictPerPost };
    }));

    return NextResponse.json({ runs: withVerdicts });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Auditruns ophalen mislukt.' }, { status: 500 });
  }
}
