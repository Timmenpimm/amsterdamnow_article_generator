import { NextRequest, NextResponse } from 'next/server';
import { cleanTaxonomyFootersFromDrafts } from '@/lib/wp';

export const dynamic = 'force-dynamic';

// Eenmalige opschoning van drafts die het ongewenste categorie/tag-linkblok
// (zie PR #35) al in hun opgeslagen WordPress-content hadden staan. Dekt alle
// drafts, dus zowel de "beelden nodig" als "klaar voor publicatie" kolom.
export async function POST(req: NextRequest) {
  const secret = process.env.ADMIN_CLEANUP_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    const cleaned = await cleanTaxonomyFootersFromDrafts();
    return NextResponse.json({ cleaned });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
