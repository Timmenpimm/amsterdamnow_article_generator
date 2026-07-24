import { NextRequest, NextResponse } from 'next/server';
import {
  getAutoPublishSettings, saveAutoPublishSettings, nextRunAt, isWithinActiveWindow,
  type AutoPublishSettings,
} from '@/lib/publisher';

export const dynamic = 'force-dynamic';

// "HH:MM" 24u, gebruikt om schedule.start/end te valideren.
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// Geen CRON-auth: dit is een redactie-instelling, client-driven zoals
// POST /api/prompts.
export async function GET() {
  const settings = await getAutoPublishSettings();
  return NextResponse.json({ ...settings, nextAt: nextRunAt(settings), windowOpen: isWithinActiveWindow(settings) });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const partial: Partial<AutoPublishSettings> = {};

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

  if (body.schedule !== undefined) {
    const s = body.schedule;
    if (
      typeof s !== 'object' || s === null ||
      typeof s.enabled !== 'boolean' ||
      typeof s.start !== 'string' || !HHMM.test(s.start) ||
      typeof s.end !== 'string' || !HHMM.test(s.end)
    ) {
      return NextResponse.json(
        { error: 'schedule moet { enabled: boolean, start: "HH:MM", end: "HH:MM" } zijn (24-uurs tijd).' },
        { status: 400 }
      );
    }
    partial.schedule = { enabled: s.enabled, start: s.start, end: s.end };
  }

  const settings = await saveAutoPublishSettings(partial);
  return NextResponse.json({ ...settings, nextAt: nextRunAt(settings), windowOpen: isWithinActiveWindow(settings) });
}
