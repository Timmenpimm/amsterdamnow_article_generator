import { NextRequest, NextResponse } from 'next/server';
import { reorderTopics } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const { ids } = await req.json();
  if (Array.isArray(ids)) await reorderTopics(ids.map(Number));
  return NextResponse.json({ ok: true });
}
