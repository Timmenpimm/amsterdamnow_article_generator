import { NextRequest, NextResponse } from 'next/server';
import { listConstraints, saveConstraintVersion } from '@/lib/db';
import { CONSTRAINT_KINDS, type ConstraintKind } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const rawKind = req.nextUrl.searchParams.get('kind') as ConstraintKind | null;
  const kind = rawKind && CONSTRAINT_KINDS.includes(rawKind) ? rawKind : 'standaard';
  return NextResponse.json({ versions: await listConstraints(kind) });
}

export async function POST(req: NextRequest) {
  const { kind, content, note } = await req.json();
  if (!content || !CONSTRAINT_KINDS.includes(kind)) {
    return NextResponse.json({ error: 'kind en content verplicht' }, { status: 400 });
  }
  const version = await saveConstraintVersion(kind, content, String(note || ''));
  return NextResponse.json({ version });
}
