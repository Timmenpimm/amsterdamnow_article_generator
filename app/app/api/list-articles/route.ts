import { NextResponse } from 'next/server';
import { createListArticleDraft } from '@/lib/listArticle';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const { exportText } = await request.json();
    if (typeof exportText !== 'string' || !exportText.trim()) {
      return NextResponse.json({ error: 'Geen exporttekst ontvangen' }, { status: 400 });
    }
    const result = await createListArticleDraft(exportText);
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Lijstartikel maken mislukt' }, { status: 500 });
  }
}
