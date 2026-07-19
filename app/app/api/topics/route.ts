import { NextRequest, NextResponse } from 'next/server';
import { addTopics, listTopics } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ topics: await listTopics() });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const titles: string[] = Array.isArray(body.titles) ? body.titles : [String(body.title || '')];
  const result = await addTopics(titles);
  return NextResponse.json(result);
}
