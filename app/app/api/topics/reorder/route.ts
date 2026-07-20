import { NextRequest, NextResponse } from 'next/server';
import { reorderTopics } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const { ids } = await req.json();
    if (!Array.isArray(ids)) throw new Error('Geen wachtrijvolgorde ontvangen.');
    await reorderTopics(ids.map(Number));
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Volgorde opslaan mislukt' }, { status: 400 });
  }
}
