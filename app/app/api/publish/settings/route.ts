import { NextRequest, NextResponse } from 'next/server';
import { getAutoPublishSettings, saveAutoPublishSettings, nextRunAt } from '@/lib/publisher';

export const dynamic = 'force-dynamic';

// Geen CRON-auth: dit is een redactie-instelling, client-driven zoals
// POST /api/prompts.
export async function GET() {
  const settings = await getAutoPublishSettings();
  return NextResponse.json({ ...settings, nextAt: nextRunAt(settings) });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const partial: { enabled?: boolean; intervalMinutes?: number; maxPerDay?: number; clusterCooldown?: number } = {};

  if (typeof body.enabled === 'boolean') partial.enabled = body.enabled;

  if (body.intervalMinutes !== undefined) {
    const n = Number(body.intervalMinutes);
    if (!Number.isInteger(n) || n < 5 || n > 1440) {
      return NextResponse.json(
        { error: 'intervalMinutes moet een geheel getal tussen 5 en 1440 zijn.' },
        { status: 400 }
      );
    }
    partial.intervalMinutes = n;
  }

  if (body.maxPerDay !== undefined) {
    const n = Number(body.maxPerDay);
    if (!Number.isInteger(n) || n < 0 || n > 100) {
      return NextResponse.json(
        { error: 'maxPerDay moet een geheel getal tussen 0 en 100 zijn (0 = onbeperkt).' },
        { status: 400 }
      );
    }
    partial.maxPerDay = n;
  }

  if (body.clusterCooldown !== undefined) {
    const n = Number(body.clusterCooldown);
    if (!Number.isInteger(n) || n < 0 || n > 10) {
      return NextResponse.json(
        { error: 'clusterCooldown moet een geheel getal tussen 0 en 10 zijn (0 = uit).' },
        { status: 400 }
      );
    }
    partial.clusterCooldown = n;
  }

  const settings = await saveAutoPublishSettings(partial);
  return NextResponse.json({ ...settings, nextAt: nextRunAt(settings) });
}
