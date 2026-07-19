import { NextResponse } from 'next/server';
import { addListTopic } from '@/lib/db';
import type { ListState } from '@/lib/types';

export const dynamic = 'force-dynamic';

// Maakt een lijstartikel-run aan: thema verplicht, items optioneel.
// Met aangeleverde items slaat de pipeline de selectiefase over.
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const title = String(body.title || '').trim();
    if (!title) return NextResponse.json({ error: 'Geef een thema op voor het lijstartikel' }, { status: 400 });
    const rawItems: string[] = Array.isArray(body.items) ? body.items.map(String) : [];
    const items = [...new Set(rawItems.map(s => s.trim()).filter(Boolean))];
    const state: ListState = {
      items: items.map(naam => ({ naam, status: 'pending' as const })),
      aangeleverd: items.length > 0,
      weekendgids: Boolean(body.weekendgids),
      verified: 0,
      rejected: 0,
      meldingen: [],
    };
    if (state.aangeleverd && items.length < 3) {
      return NextResponse.json({ error: 'Geef minimaal 3 items op, of laat het veld leeg zodat de AI kandidaten voorstelt' }, { status: 400 });
    }
    const topic = await addListTopic(title, state);
    return NextResponse.json({ topic });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Lijstartikel aanmaken mislukt' }, { status: 500 });
  }
}
