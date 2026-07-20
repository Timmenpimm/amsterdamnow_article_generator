import { NextRequest, NextResponse } from 'next/server';
import { deleteSource, renameSource, setSourceActive } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  if (typeof body.active === 'boolean') await setSourceActive(Number(id), body.active);
  if (typeof body.name === 'string' && body.name.trim()) await renameSource(Number(id), body.name);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await deleteSource(Number(id));
  return NextResponse.json({ ok: true });
}
