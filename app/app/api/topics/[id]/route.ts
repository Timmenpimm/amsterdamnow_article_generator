import { NextRequest, NextResponse } from 'next/server';
import { deleteTopic, pushTopicToTop, retryTopic, setTopicWebsite, updateTopicTitle } from '@/lib/db';
import { validateTopicBasic } from '@/lib/topicValidation';

export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  // Bord-herstelactie na "Entiteitscontrole faalt" (zie Pipeline.tsx): de
  // redactie geeft de juiste officiële website op. Zelfde basisvalidatie als
  // bij handmatige invoer (geen aggregators/concurrenten); de titel is hier
  // niet relevant voor die check, dus een placeholder van voldoende lengte
  // volstaat om alleen de website-regels te laten gelden.
  if (typeof body.website === 'string') {
    const website = body.website.trim();
    if (website) {
      const validation = validateTopicBasic('website-herstel', website);
      if (!validation.valid && validation.severity === 'error') {
        return NextResponse.json(
          { error: validation.reason, suggestion: validation.suggestion, validationFailed: true },
          { status: 400 }
        );
      }
    }
    await setTopicWebsite(Number(id), website);
  }
  if (body.action === 'retry') await retryTopic(Number(id));
  if (body.action === 'top') {
    const moved = await pushTopicToTop(Number(id));
    // Al opgepakt door de writer of net verwijderd — geen fout, maar de client
    // moet weten dat er niets verschoven is (en dus zijn optimistische
    // volgorde moet terugdraaien via een verse board-load).
    if (!moved) {
      return NextResponse.json(
        { ok: false, error: 'Dit onderwerp staat niet meer in de wachtrij.' },
        { status: 409 }
      );
    }
  }
  if (typeof body.title === 'string' && body.title.trim()) await updateTopicTitle(Number(id), body.title);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await deleteTopic(Number(id));
  return NextResponse.json({ ok: true });
}
