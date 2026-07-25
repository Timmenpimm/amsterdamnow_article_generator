import { NextRequest, NextResponse } from 'next/server';
import { engineFetch } from '@/lib/socialsEngine';
import { engineConfigured, engineErrorJson, notConfiguredJson, type EngineCarousel } from '@/lib/carouselEngine';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// POST /api/carousel/[articleId]/publish — zet de carousel zo nodig eerst op
// APPROVED (de engine publiceert alleen goedgekeurde carousels) en roept dan
// de engine-publish aan. Kan tot ~60s duren (Instagram Graph API).
export async function POST(req: NextRequest, { params }: { params: Promise<{ articleId: string }> }) {
  await params; // articleId zit in het pad voor consistentie; engine werkt op carouselId
  const body = await req.json().catch(() => null);
  const carouselId = typeof body?.carouselId === 'string' ? body.carouselId : '';
  if (!carouselId) {
    return NextResponse.json({ error: 'carouselId ontbreekt in de aanvraag.' }, { status: 400 });
  }
  if (!(await engineConfigured())) return notConfiguredJson();

  try {
    // 1. Status ophalen; DRAFT/FAILED eerst naar APPROVED (toegestane overgang).
    const curRes = await engineFetch(`/api/carousels/${encodeURIComponent(carouselId)}`);
    const curBody = await curRes.json().catch(() => null);
    const current: EngineCarousel = curBody?.carousel || curBody || {};
    if (current.status === 'DRAFT' || current.status === 'FAILED') {
      await engineFetch(`/api/carousels/${encodeURIComponent(carouselId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'APPROVED' }),
      });
    }

    // 2. Publiceren (kan lang duren).
    const res = await engineFetch('/api/instagram/publish', {
      method: 'POST',
      body: JSON.stringify({ carouselId }),
      signal: AbortSignal.timeout(55000),
    });
    const out = await res.json().catch(() => null);
    const instagramId = out?.mediaId || out?.carousel?.instagramId || null;
    return NextResponse.json({ ok: true, instagramId, permalink: out?.permalink || undefined });
  } catch (err) {
    return engineErrorJson(err);
  }
}
