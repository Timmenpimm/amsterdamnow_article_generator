import { NextRequest, NextResponse } from 'next/server';
import { PUBLISHED_SEARCH_DEFAULT_PER_PAGE, searchPublished } from '@/lib/wp';

export const dynamic = 'force-dynamic';

// GET /api/wp/published?search=…&page=1&per_page=20
//
// Zoeken in het volledige WordPress-archief (~1100 gepubliceerde posts) voor
// het carousel-overzicht. Bewust náást /api/board en niet erin: het bord draait
// op listArticles() (alle drafts + 15 recente publicaties, met media-fanout en
// een 15s process-cache) en wordt door de hele app gebruikt — daar een
// archiefzoekopdracht doorheen duwen zou elke pagina vertragen. Deze route doet
// één lichte, gepagineerde WP-call en houdt de zoekfunctie geïsoleerd.
//
// Let op: nieuwe api-routes moeten ook in vercel.json staan (legacy builder
// routet per pad), anders is dit op productie een 404.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const search = sp.get('search') || '';
  const page = Number(sp.get('page') || '1');
  const perPage = Number(sp.get('per_page') || String(PUBLISHED_SEARCH_DEFAULT_PER_PAGE));

  try {
    const { live, ...result } = await searchPublished({ search, page, perPage });
    return NextResponse.json({ mode: live ? 'live' : 'demo', ...result });
  } catch (e: any) {
    // Trage of onbereikbare WordPress: 502 met de leesbare melding uit wp.ts,
    // zodat de UI iets kan tonen waar de gebruiker wat aan heeft.
    return NextResponse.json({ error: e?.message || 'WordPress is niet bereikbaar.' }, { status: 502 });
  }
}
