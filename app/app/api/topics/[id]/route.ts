import { NextRequest, NextResponse } from 'next/server';
import { deleteTopic, retryTopic, updateTopicTitle } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  if (body.action === 'retry') await retryTopic(Number(id));
  if (typeof body.title === 'string' && body.title.trim()) await updateTopicTitle(Number(id), body.title);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await deleteTopic(Number(id));
  return NextResponse.json({ ok: true });
}
