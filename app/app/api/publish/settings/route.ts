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
  const partial: { enabled?: boolean; intervalMinutes?: number } = {};

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

  const settings = await saveAutoPublishSettings(partial);
  return NextResponse.json({ ...settings, nextAt: nextRunAt(settings) });
}
