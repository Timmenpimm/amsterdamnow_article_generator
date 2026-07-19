import { NextRequest, NextResponse } from 'next/server';
import { claimNextTopic } from '@/lib/db';
import { checkToken } from '@/lib/n8n-auth';

export const dynamic = 'force-dynamic';

// n8n vervangt hiermee de Google Sheets "Get row(s)"-node:
// POST /api/n8n/claim met header x-api-key: $N8N_TOKEN
// → { topic: { id, title } } of { topic: null } als de wachtrij leeg is.
export async function POST(req: NextRequest) {
  if (!checkToken(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return NextResponse.json({ topic: await claimNextTopic() });
}
