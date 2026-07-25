import { NextResponse } from 'next/server';
import { listArticles } from '@/lib/wp';
import { listTopics } from '@/lib/db';
import { COMPETITORS, competitorInTekst } from '@/lib/competitors';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Inventarisatie: waar zit er nu nog een concurrent in de tool? Loopt over de
// wachtrij en over alle drafts en meldt per treffer welk veld het is. Bewust
// alleen-lezen en zonder CRON_SECRET — het rapporteert over data die de board-
// API toch al teruggeeft, en de redactie moet dit zelf kunnen openen zonder
// een secret dat niet uit Vercel te lezen is.
//
// De poorten in de pipeline (tavily.ts, writer.ts, validation.ts,
// imageSearch.ts, scanner.ts) houden nieuwe gevallen tegen; dit is de
// inhaalslag voor wat er vóór 25-07-2026 al doorheen kwam — zoals artikel
// 87365, dat volledig op de merknaam van Your Little Black Book liep.
type Treffer = { wat: 'topic' | 'artikel'; id: number; titel: string; concurrent: string; velden: string[] };

export async function GET() {
  try {
    const [topics, articles] = await Promise.all([listTopics(), listArticles()]);
    const treffers: Treffer[] = [];

    for (const t of topics) {
      const concurrent = competitorInTekst([t.title]);
      if (concurrent) treffers.push({ wat: 'topic', id: t.id, titel: t.title, concurrent, velden: ['titel'] });
    }

    for (const a of articles) {
      const velden: { naam: string; waarde: string }[] = [
        { naam: 'titel', waarde: a.title },
        { naam: 'subregel', waarde: a.subregel },
        { naam: 'intro', waarde: a.intro },
        { naam: 'tekst', waarde: a.contentHtml },
        { naam: 'naam_locatie', waarde: a.naam_locatie },
        { naam: 'website', waarde: a.website },
        { naam: 'slug', waarde: a.slug },
        { naam: 'focus-keyword', waarde: a.focusKeyword },
        { naam: 'seo-titel', waarde: a.seoTitle },
        { naam: 'meta-description', waarde: a.metaDescription },
        { naam: 'fotograaf', waarde: a.fotograaf },
        { naam: 'beeld', waarde: [a.featured?.url, a.inline?.url, ...(a.slider || []).map(s => s.url)].filter(Boolean).join(' ') },
      ];
      const geraakt = velden.filter(v => competitorInTekst([v.waarde]));
      if (!geraakt.length) continue;
      treffers.push({
        wat: 'artikel',
        id: a.id,
        titel: a.title,
        concurrent: competitorInTekst([geraakt[0].waarde]) || '',
        velden: geraakt.map(v => v.naam),
      });
    }

    return NextResponse.json({
      concurrenten: COMPETITORS.map(c => c.naam),
      onderzocht: { topics: topics.length, artikelen: articles.length },
      treffers,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Controle mislukt.' }, { status: 500 });
  }
}
