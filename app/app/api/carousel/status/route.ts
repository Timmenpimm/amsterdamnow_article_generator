import { NextRequest, NextResponse } from 'next/server';
import { engineFetch } from '@/lib/socialsEngine';
import {
  engineConfigured, engineErrorJson, newestPerWordpressId, notConfiguredJson, toMeta,
  type EngineCarousel,
} from '@/lib/carouselEngine';

export const dynamic = 'force-dynamic';

// GET /api/carousel/status?ids=1,2,3 — batch-status voor het overzicht.
// Eén engine-call (GET /api/carousels), gemapt naar CarouselMeta per artikel;
// artikelen zonder carousel ontbreken in `metas` (client vult status 'none').
export async function GET(req: NextRequest) {
  const ids = (req.nextUrl.searchParams.get('ids') || '')
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isFinite(n) && n > 0);
  if (ids.length === 0) return NextResponse.json({ metas: {} });
  if (!(await engineConfigured())) return notConfiguredJson();

  try {
    const res = await engineFetch('/api/carousels');
    const body = await res.json().catch(() => null);
    const carousels: EngineCarousel[] = Array.isArray(body?.carousels) ? body.carousels : [];
    const byWpId = newestPerWordpressId(carousels);
    const metas: Record<number, ReturnType<typeof toMeta>> = {};
    for (const id of ids) {
      const c = byWpId.get(id);
      if (c) metas[id] = toMeta(id, c);
    }
    return NextResponse.json({ metas });
  } catch (err) {
    return engineErrorJson(err);
  }
}
