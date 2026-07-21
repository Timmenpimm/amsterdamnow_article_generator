import { NextRequest, NextResponse } from 'next/server';
import { backfillSeo } from '@/lib/seoBackfill';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Bewust een losse, expliciete POST: dit is een eenmalige redactionele
// migratie, geen actie die bij gewoon paginabezoek mag gebeuren. `dryRun`
// geeft eerst de exacte kandidaatlijst terug zonder WordPress te wijzigen.
// Roep herhaald aan (zelfde als /api/admin/backfill-editorial-format) totdat
// de response `done: true` teruggeeft.
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const result = await backfillSeo(Boolean(body.dryRun));
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Backfill mislukt' }, { status: 500 });
  }
}
