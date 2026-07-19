import { NextRequest, NextResponse } from 'next/server';
import { completeTopic } from '@/lib/db';
import { checkToken } from '@/lib/n8n-auth';

export const dynamic = 'force-dynamic';

// n8n roept dit aan na de succesvolle POST naar WordPress (vervangt "Delete rows"):
// POST { topicId, postId }
export async function POST(req: NextRequest) {
  if (!checkToken(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { topicId, postId } = await req.json();
  await completeTopic(Number(topicId), Number(postId));
  return NextResponse.json({ ok: true });
}
