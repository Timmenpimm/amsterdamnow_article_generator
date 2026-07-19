import { NextResponse } from 'next/server';
import { listTopics, STORAGE } from '@/lib/db';
import { listArticles, LIVE } from '@/lib/wp';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [topics, articles] = await Promise.all([listTopics(), listArticles()]);
    return NextResponse.json({
      mode: LIVE ? 'live' : 'demo',
      storage: STORAGE,
      persistent: STORAGE === 'postgres' || !process.env.VERCEL,
      topics,
      articles,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
