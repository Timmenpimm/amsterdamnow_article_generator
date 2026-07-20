import { NextRequest, NextResponse } from 'next/server';
import { scanSource } from '@/lib/scanner';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return NextResponse.json(await scanSource(Number(id)));
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Scan mislukt.' }, { status: 500 });
  }
}
