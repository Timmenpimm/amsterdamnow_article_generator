import { NextRequest, NextResponse } from 'next/server';
import { deleteTopic, pushTopicToTop, retryTopic, updateTopicTitle } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  if (body.action === 'retry') await retryTopic(Number(id));
  if (body.action === 'top') {
    const moved = await pushTopicToTop(Number(id));
    // Al opgepakt door de writer of net verwijderd — geen fout, maar de client
    // moet weten dat er niets verschoven is (en dus zijn optimistische
    // volgorde moet terugdraaien via een verse board-load).
    if (!moved) {
      return NextResponse.json(
        { ok: false, error: 'Dit onderwerp staat niet meer in de wachtrij.' },
        { status: 409 }
      );
    }
  }
  if (typeof body.title === 'string' && body.title.trim()) await updateTopicTitle(Number(id), body.title);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await deleteTopic(Number(id));
  return NextResponse.json({ ok: true });
}
