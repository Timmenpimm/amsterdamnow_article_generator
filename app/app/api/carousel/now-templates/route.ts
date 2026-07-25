import { NextResponse } from 'next/server';
import { engineFetch } from '@/lib/socialsEngine';
import { engineConfigured, engineErrorJson, notConfiguredJson } from '@/lib/carouselEngine';
import type { NowFamilySpec } from '@/lib/carousel';

export const dynamic = 'force-dynamic';

// Het NOW-manifest verandert alleen bij een engine-deploy, dus één keer ophalen
// per serverproces is genoeg. Fouten en lege antwoorden bewaren we nóóit — dan
// zou een engine die net even plat lag de hele processlevensduur leeg blijven.
let cachedFamilies: NowFamilySpec[] | null = null;

// GET /api/carousel/now-templates — proxy naar engine `GET /api/templates/now`.
// Antwoord: { families: NowFamilySpec[] } (ongewijzigd doorgegeven), of de
// vaste notConfigured-respons als de engine-koppeling nog ontbreekt.
export async function GET() {
  if (cachedFamilies) return NextResponse.json({ families: cachedFamilies });
  if (!(await engineConfigured())) return notConfiguredJson();

  try {
    const res = await engineFetch('/api/templates/now');
    const body = await res.json().catch(() => null);
    const families: NowFamilySpec[] = Array.isArray(body?.families) ? body.families : [];
    if (families.length) cachedFamilies = families;
    return NextResponse.json({ families });
  } catch (err) {
    return engineErrorJson(err);
  }
}
