import { NextResponse } from 'next/server';
import { getQueuePause, listStructures, listTopics, STORAGE } from '@/lib/db';
import { listArticles, isLive } from '@/lib/wp';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [topics, articles, structures, queuePause] = await Promise.all([
      listTopics(), listArticles(), listStructures(), getQueuePause(),
    ]);
    // Compact per lijstartikel: aantal items en aantal met foto, voor de
    // beeldenteller op het bord.
    const lists: Record<number, { items: number; withMedia: number }> = {};
    for (const [postId, s] of Object.entries(structures)) {
      lists[Number(postId)] = { items: s.items.length, withMedia: s.items.filter(i => i.media).length };
    }
    return NextResponse.json({
      mode: (await isLive()) ? 'live' : 'demo',
      storage: STORAGE,
      persistent: STORAGE === 'postgres' || !process.env.VERCEL,
      topics,
      articles,
      lists,
      queuePause,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
