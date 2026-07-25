import { NextRequest, NextResponse } from 'next/server';
import { engineFetch } from '@/lib/socialsEngine';
import { getArticle } from '@/lib/wp';
import {
  engineConfigured, engineErrorJson, notConfiguredJson, toContent, toMeta,
  type EngineCarousel,
} from '@/lib/carouselEngine';

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
    return NextResponse.json(
      { carouselId: c.id, meta: toMeta(id, c), content: toContent(c, article.title) },
      { status: 201 }
    );
  } catch (err) {
    return engineErrorJson(err);
  }
}
