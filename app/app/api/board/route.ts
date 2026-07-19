import { NextResponse } from 'next/server';
import { listStructures, listTopics, STORAGE } from '@/lib/db';
import { listArticles, LIVE } from '@/lib/wp';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [topics, articles, structures] = await Promise.all([listTopics(), listArticles(), listStructures()]);
    // Compact per lijstartikel: aantal items en aantal met foto, voor de
    // beeldenteller op het bord.
    const lists: Record<number, { items: number; withMedia: number }> = {};
    for (const [postId, s] of Object.entries(structures)) {
      lists[Number(postId)] = { items: s.items.length, withMedia: s.items.filter(i => i.media).length };
    }
    return NextResponse.json({
      mode: LIVE ? 'live' : 'demo',
      storage: STORAGE,
      persistent: STORAGE === 'postgres' || !process.env.VERCEL,
      topics,
      articles,
      lists,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
