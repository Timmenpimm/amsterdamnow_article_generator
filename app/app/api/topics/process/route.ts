import { NextResponse } from 'next/server';
import { writeNextTopic } from '@/lib/writer';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST() {
  try {
    const result = await writeNextTopic();
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Schrijven mislukt' }, { status: 500 });
  }
}
