import { NextRequest, NextResponse } from 'next/server';
import { engineFetch } from '@/lib/socialsEngine';
import { getArticle } from '@/lib/wp';
import {
  engineConfigured, engineErrorJson, notConfiguredJson, toContent, toMeta,
  type EngineCarousel,
} from '@/lib/carouselEngine';
import { isNowTemplate } from '@/lib/carousel';
import type { CarouselSlide } from '@/lib/carousel';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// POST /api/carousel/[articleId]/generate — laadt het artikel server-side uit
// WordPress en laat de engine er een carousel van maken (POST /api/generate).
export async function POST(req: NextRequest, { params }: { params: Promise<{ articleId: string }> }) {
  const { articleId } = await params;
  const id = Number(articleId);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: 'Ongeldig artikel-id.' }, { status: 400 });
  }
  if (!(await engineConfigured())) return notConfiguredJson();

  // Template gaat ongewijzigd door naar de engine: zowel de satori-ids
  // ('modern-news'/…) als de Amsterdam NOW-ids ('now:<family>'). De engine is
  // de enige die weet welke ids bestaan; hier niet valideren.
  const body = await req.json().catch(() => null);
  const template = typeof body?.template === 'string' ? body.template : undefined;

  const article = await getArticle(id);
  if (!article) {
    return NextResponse.json({ error: 'Artikel niet gevonden.' }, { status: 404 });
  }

  const payload = {
    article: {
      wordpressId: article.id,
      title: article.title,
      contentHtml: article.contentHtml,
      excerpt: article.intro || article.subregel || undefined,
      imageUrl: article.featured?.url || undefined,
      categories: [article.category].filter(Boolean),
      tags: article.tags,
    },
    template,
  };

  try {
    const res = await engineFetch('/api/generate', {
      method: 'POST',
      body: JSON.stringify(payload),
      // Genereren kan lang duren (Claude-call + renderen aan engine-kant).
      signal: AbortSignal.timeout(55000),
    });
    const eng = await res.json().catch(() => null);
    const c: EngineCarousel | undefined = eng?.carousel;
    if (!c?.id) {
      return NextResponse.json({ error: 'Onverwacht antwoord van de socials-engine bij het genereren.' }, { status: 502 });
    }

    // De engine kent alleen imagePrompts; de artikelbeelden zelf leven hier.
    // Zelfde toewijzing als de oude mock: hero/cta krijgen het uitgelichte
    // beeld, image-slides doorlopen de sliderbeelden. Daarna terugschrijven
    // zodat de engine dezelfde beelden gebruikt bij render/publicatie.
    //
    // Alléén voor satori-carousels: NOW-slides hebben geen layout/imageUrl maar
    // slideType + values, en hun beeld-tokens zitten in het manifest. Die laten
    // we ongemoeid — nooit in de satori-vorm dwingen.
    const isNow = isNowTemplate(template) || isNowTemplate(c.template);
    const pool = [article.featured, ...(article.slider || [])]
      .map(m => m?.url)
      .filter((u, i, arr): u is string => Boolean(u) && arr.indexOf(u) === i);
    if (!isNow && pool.length && Array.isArray(c.slides)) {
      let next = 1;
      c.slides = (c.slides as CarouselSlide[]).map(s => {
        if (s.imageUrl) return s;
        if (s.layout === 'hero' || s.layout === 'cta') return { ...s, imageUrl: pool[0] };
        if (s.layout === 'image') {
          const url = pool[next % pool.length] ?? pool[0];
          next += 1;
          return { ...s, imageUrl: url };
        }
        return s;
      });
      try {
        await engineFetch(`/api/carousels/${c.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ slides: c.slides }),
        });
      } catch {
        // Verrijking is best-effort: de content met beelden gaat sowieso terug
        // naar de client; de eerstvolgende autosave schrijft ze alsnog weg.
      }
    }

    return NextResponse.json(
      { carouselId: c.id, meta: toMeta(id, c), content: toContent(c, article.title) },
      { status: 201 }
    );
  } catch (err) {
    return engineErrorJson(err);
  }
}
