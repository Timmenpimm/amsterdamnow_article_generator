import { NextResponse } from 'next/server';
import { getQueuePause, listStructures, listTopics, STORAGE } from '@/lib/db';
import { listArticles, isLive } from '@/lib/wp';

export const dynamic = 'force-dynamic';

// Het bord wordt na acties en elke twaalf seconden opnieuw geladen. Topics en
// lijststructuren komen lokaal uit de database en blijven dus altijd vers;
// alleen de WordPress-spiegel is duur. Een korte process-cache voorkomt dat
// elke interface-actie opnieuw alle drafts, recente publicaties en media uit
// WordPress ophaalt, zonder het bord lang achter te laten lopen.
const ARTICLES_CACHE_MS = 15_000;
let articlesCache: { value: Awaited<ReturnType<typeof listArticles>>; expiresAt: number } | null = null;
let articlesInFlight: Promise<Awaited<ReturnType<typeof listArticles>>> | null = null;

async function boardArticles() {
  if (articlesCache && articlesCache.expiresAt > Date.now()) return articlesCache.value;
  if (!articlesInFlight) {
    articlesInFlight = listArticles()
      .then(value => {
        articlesCache = { value, expiresAt: Date.now() + ARTICLES_CACHE_MS };
        return value;
      })
      .finally(() => { articlesInFlight = null; });
  }
  return articlesInFlight;
}

export async function GET() {
  try {
    const [topics, articles, structures, queuePause] = await Promise.all([
      listTopics(), boardArticles(), listStructures(), getQueuePause(),
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
