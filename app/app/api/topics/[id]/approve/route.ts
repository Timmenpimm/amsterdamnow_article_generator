import { NextRequest, NextResponse } from 'next/server';
import { approveItems } from '@/lib/listWriter';

export const dynamic = 'force-dynamic';

// Itemcontrole: de redacteur keurt de geverifieerde items goed (met eventuele
// uitsluitingen); daarna gaat de lijstrun door naar de compositiefase.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { include } = await req.json();
    if (!Array.isArray(include)) return NextResponse.json({ error: 'include-lijst ontbreekt' }, { status: 400 });
    const topic = await approveItems(Number(id), include.map(String));
    return NextResponse.json({ topic });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Goedkeuren mislukt' }, { status: 500 });
  }
}
