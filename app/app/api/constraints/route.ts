import { NextRequest, NextResponse } from 'next/server';
import { listConstraints, saveConstraintVersion } from '@/lib/db';
import {
  CONSTRAINT_KINDS, type ConstraintKind,
  DEFAULT_STANDAARD_CONSTRAINTS, DEFAULT_LIST_CONSTRAINTS,
} from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const rawKind = req.nextUrl.searchParams.get('kind') as ConstraintKind | null;
  const kind = rawKind && CONSTRAINT_KINDS.includes(rawKind) ? rawKind : 'standaard';
  const versions = await listConstraints(kind);
  // Alleen de actieve versie backfillen met codedefaults voor velden die
  // pas later zijn toegevoegd — de editor bewerkt en toont die. Oudere,
  // niet-actieve versies blijven ongewijzigd: dat is de audit trail van wat
  // er destijds daadwerkelijk is opgeslagen.
  const defaults = kind === 'standaard' ? DEFAULT_STANDAARD_CONSTRAINTS : DEFAULT_LIST_CONSTRAINTS;
  const withDefaults = versions.map(v => v.active === 1
    ? { ...v, content: JSON.stringify({ ...defaults, ...JSON.parse(v.content) }) }
    : v);
  return NextResponse.json({ versions: withDefaults });
}

export async function POST(req: NextRequest) {
  const { kind, content, note } = await req.json();
  if (!content || !CONSTRAINT_KINDS.includes(kind)) {
    return NextResponse.json({ error: 'kind en content verplicht' }, { status: 400 });
  }
  const version = await saveConstraintVersion(kind, content, String(note || ''));
  return NextResponse.json({ version });
}
