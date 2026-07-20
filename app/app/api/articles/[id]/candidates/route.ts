import { NextRequest, NextResponse } from 'next/server';
import { listImageCandidates, setImageCandidateStatus, getImageCandidate } from '@/lib/db';
import type { CandidateStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return NextResponse.json({ candidates: await listImageCandidates(Number(id)) });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// Status van een kandidaat bijwerken: 'used' (in een slot gezet) of
// 'dismissed' (afgewezen; komt bij vernieuwen niet terug).
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { candidateId, status } = await req.json() as { candidateId: number; status: CandidateStatus };
    if (!candidateId || !['used', 'dismissed', 'scored'].includes(status)) {
      return NextResponse.json({ error: 'Ongeldige status.' }, { status: 400 });
    }
    const existing = await getImageCandidate(Number(id), Number(candidateId));
    if (!existing) return NextResponse.json({ error: 'Kandidaat niet gevonden.' }, { status: 404 });
    await setImageCandidateStatus(Number(id), Number(candidateId), status);
    return NextResponse.json({ candidates: await listImageCandidates(Number(id)) });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
