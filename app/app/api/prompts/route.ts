import { NextRequest, NextResponse } from 'next/server';
import { listPrompts, savePromptVersion } from '@/lib/db';
import { PROMPT_KINDS, type PromptKind } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const rawKind = req.nextUrl.searchParams.get('kind') as PromptKind | null;
  const kind = rawKind && PROMPT_KINDS.includes(rawKind) ? rawKind : 'schrijf';
  return NextResponse.json({ versions: await listPrompts(kind) });
}

export async function POST(req: NextRequest) {
  const { kind, content, note } = await req.json();
  if (!content || !PROMPT_KINDS.includes(kind)) {
    return NextResponse.json({ error: 'kind en content verplicht' }, { status: 400 });
  }
  const version = await savePromptVersion(kind, String(content), String(note || ''));
  return NextResponse.json({ version });
}
