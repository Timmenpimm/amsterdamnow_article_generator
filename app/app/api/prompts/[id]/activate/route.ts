import { NextRequest, NextResponse } from 'next/server';
import { activatePromptVersion } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const version = await activatePromptVersion(Number(id));
  if (!version) return NextResponse.json({ error: 'niet gevonden' }, { status: 404 });
  return NextResponse.json({ version });
}
