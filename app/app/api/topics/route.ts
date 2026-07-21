import { NextRequest, NextResponse } from 'next/server';
import { addTopics, listTopics } from '@/lib/db';
import { checkTopicAgainstWp, type DedupExisting } from '@/lib/dedup';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ topics: await listTopics() });
}

// Cap op gelijktijdige Haiku-checks: elke titel zonder force triggert één
// judgeDuplicate-call (zie lib/dedup.ts) — bij een grote bulk-submit voorkomt
// dit dat tientallen Claude-calls tegelijk de lucht in gaan.
const CHECK_CONCURRENCY = 3;

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()));
  return results;
}

export interface TopicDuplicate {
  title: string;
  existing: DedupExisting;
  reason: string;
}

// Body: { titles: string[] } of { title: string }, optioneel met
// `force: true` (alle titels overslaan de dedup-check) of `forceTitles:
// string[]` (alleen die titels overslaan de check) — zie
// docs/superpowers/specs/2026-07-21-wp-dedup-index-design.md §4. Titels met
// verdict 'duplicate' worden NIET toegevoegd; ze komen terug in `duplicates`
// zodat de UI "Toch toevoegen" (herhaal met force) kan aanbieden.
export async function POST(req: NextRequest) {
  const body = await req.json();
  const rawTitles: string[] = Array.isArray(body.titles) ? body.titles : [String(body.title || '')];
  const titles = rawTitles.map(t => t.trim()).filter(Boolean);

  const forceAll = body.force === true;
  const forceTitleList: string[] = Array.isArray(body.forceTitles) ? body.forceTitles.map(String) : [];
  const forceKeys = new Set(forceTitleList.map(t => t.trim().toLowerCase()));

  const toCheck = forceAll ? [] : titles.filter(t => !forceKeys.has(t.toLowerCase()));
  const checked = await mapWithConcurrency(toCheck, CHECK_CONCURRENCY, async title => ({
    title,
    result: await checkTopicAgainstWp(title),
  }));

  const duplicates: TopicDuplicate[] = [];
  const blocked = new Set<string>();
  for (const { title, result } of checked) {
    if (result.verdict === 'duplicate' && result.existing) {
      duplicates.push({ title, existing: result.existing, reason: result.reason || '' });
      blocked.add(title.toLowerCase());
    }
  }

  const toAdd = titles.filter(t => !blocked.has(t.toLowerCase()));
  const effectiveForce = new Set(forceKeys);
  if (forceAll) for (const t of titles) effectiveForce.add(t.toLowerCase());

  const result = await addTopics(toAdd, effectiveForce);
  return NextResponse.json({ ...result, duplicates });
}
