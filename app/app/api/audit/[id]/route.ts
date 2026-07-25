import { NextRequest, NextResponse } from 'next/server';
import { getAuditRun, listAuditFindings } from '@/lib/db';
import { listArticles } from '@/lib/wp';
import { worstVerdict } from '@/lib/types';
import type { AuditFinding, AuditVerdict } from '@/lib/types';

export const dynamic = 'force-dynamic';

// Zelfde terugkijk als de auto-publisher: ruim genoeg om ook net-gepubliceerde
// artikelen nog van een titel te voorzien. Alleen lezen — de auditor schrijft
// nooit naar WordPress.
const PUBLISHED_FOR_TITLES = 50;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const runId = Number(id);
  if (!Number.isInteger(runId) || runId <= 0) {
    return NextResponse.json({ error: 'Ongeldig run-id.' }, { status: 400 });
  }

  try {
    const run = await getAuditRun(runId);
    if (!run) return NextResponse.json({ error: `Auditrun ${runId} niet gevonden.` }, { status: 404 });

    const findings = await listAuditFindings(runId);

    // Titels zijn cosmetisch: valt WordPress weg, dan tonen we het post-id.
    const titels = new Map<number, string>();
    try {
      for (const a of await listArticles(PUBLISHED_FOR_TITLES)) titels.set(a.id, a.title);
    } catch (e: any) {
      console.error('[audit] titels ophalen uit WordPress mislukt', e);
    }

    const perPost = new Map<number, AuditFinding[]>();
    for (const f of findings) {
      const bucket = perPost.get(f.postId);
      if (bucket) bucket.push(f);
      else perPost.set(f.postId, [f]);
    }

    // Volgorde van de steekproef aanhouden; bevindingen op een post-id dat niet
    // (meer) in postIds staat gaan er achteraan, zodat niets onzichtbaar wordt.
    const postIds = [...run.postIds];
    for (const postId of perPost.keys()) if (!postIds.includes(postId)) postIds.push(postId);

    const gedaan = new Set(run.donePostIds || []);
    const posts = postIds.map(postId => {
      const eigen = perPost.get(postId) || [];
      return {
        postId,
        titel: titels.get(postId) || `Artikel ${postId}`,
        done: gedaan.has(postId),
        // null = nog niet geauditeerd; een gedaan artikel zonder bevindingen is 'ok'.
        verdict: eigen.length || gedaan.has(postId) ? worstVerdict(eigen) : (null as AuditVerdict | null),
        findings: eigen,
      };
    });

    return NextResponse.json({ run, posts, aantalBevindingen: findings.length });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Auditrun ophalen mislukt.' }, { status: 500 });
  }
}
