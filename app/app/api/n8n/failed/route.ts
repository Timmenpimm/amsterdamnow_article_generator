import { NextRequest, NextResponse } from 'next/server';
import { failTopic } from '@/lib/db';
import { checkToken } from '@/lib/n8n-auth';

export const dynamic = 'force-dynamic';

// n8n meldt hiermee een mislukte run (error-branch van de workflow):
// POST { topicId, error, step }
export async function POST(req: NextRequest) {
  if (!checkToken(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { topicId, error, step } = await req.json();
  await failTopic(Number(topicId), String(error || 'Onbekende fout'), String(step || ''));
  return NextResponse.json({ ok: true });
}
