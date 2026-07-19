import { NextRequest, NextResponse } from 'next/server';
import { listPrompts, savePromptVersion } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const kind = req.nextUrl.searchParams.get('kind') === 'seo' ? 'seo' : 'schrijf';
  return NextResponse.json({ versions: await listPrompts(kind) });
}

export async function POST(req: NextRequest) {
  const { kind, content, note } = await req.json();
  if (!content || !['schrijf', 'seo'].includes(kind)) {
    return NextResponse.json({ error: 'kind en content verplicht' }, { status: 400 });
  }
  const version = await savePromptVersion(kind, String(content), String(note || ''));
  return NextResponse.json({ version });
}
