import { NextRequest, NextResponse } from 'next/server';
import { getModelSettings, saveModelSettings, type ProviderId } from '@/lib/modelConfig';

export const dynamic = 'force-dynamic';

// Redactie-instelling, client-driven zoals /api/publish/settings — geen
// CRON-auth. Slaat op onder app_settings-key `model_provider`.
//
// LET OP: de apiKey wordt in de GET-respons gemaskeerd teruggegeven (alleen of
// er één is ingesteld), zodat de sleutel niet naar de client lekt.
function redact(s: Awaited<ReturnType<typeof getModelSettings>>) {
  return {
    provider: s.provider,
    omniroute: {
      baseUrl: s.omniroute.baseUrl,
      model: s.omniroute.model,
      visionModel: s.omniroute.visionModel,
      hasApiKey: Boolean(s.omniroute.apiKey),
    },
    failover: s.failover,
  };
}

export async function GET() {
  return NextResponse.json(redact(await getModelSettings()));
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const partial: Parameters<typeof saveModelSettings>[0] = {};

  if (body.provider !== undefined) {
    if (body.provider !== 'anthropic' && body.provider !== 'omniroute') {
      return NextResponse.json({ error: "provider moet 'anthropic' of 'omniroute' zijn." }, { status: 400 });
    }
    partial.provider = body.provider as ProviderId;
  }

  if (body.failover !== undefined) {
    if (typeof body.failover !== 'boolean') {
      return NextResponse.json({ error: 'failover moet een boolean zijn.' }, { status: 400 });
    }
    partial.failover = body.failover;
  }

  const o = body.omniroute;
  if (o !== undefined && o !== null && typeof o === 'object') {
    const om: Partial<{ baseUrl: string; apiKey: string; model: string; visionModel: string }> = {};
    if (typeof o.baseUrl === 'string') {
      const url = o.baseUrl.trim();
      if (url && !/^https?:\/\//i.test(url)) {
        return NextResponse.json({ error: 'baseUrl moet met http:// of https:// beginnen.' }, { status: 400 });
      }
      om.baseUrl = url;
    }
    // Lege string = ongewijzigd laten (de client stuurt nooit een lege sleutel
    // om de bestaande te overschrijven); een niet-lege string vervangt 'm.
    if (typeof o.apiKey === 'string' && o.apiKey.trim()) om.apiKey = o.apiKey.trim();
    if (typeof o.model === 'string') om.model = o.model.trim();
    if (typeof o.visionModel === 'string') om.visionModel = o.visionModel.trim();
    partial.omniroute = om as { baseUrl: string; apiKey: string; model: string; visionModel: string };
  }

  const saved = await saveModelSettings(partial);
  return NextResponse.json(redact(saved));
}
