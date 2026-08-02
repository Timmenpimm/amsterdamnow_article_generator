import { NextRequest, NextResponse } from 'next/server';
import { addTopics, listTopics } from '@/lib/db';
import { validateTopicBasic } from '@/lib/topicValidation';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET() {
  return NextResponse.json({ topics: await listTopics() });
}

// Handmatige invoer hoort direct responsief te zijn. De kostbare WordPress- en
// Haiku-dedup-check gebeurt pas vlak voor het schrijven. Bronnenscans zijn de
// uitzondering: daar controleren we al bij import, zodat een grote externe
// agenda de wachtrij niet met bestaande onderwerpen vult.
//
// Basisvalidatie toegevoegd om evident ongeldige onderwerpen (concurrent-URLs,
// aggregators, lege velden) al bij invoer af te keuren. Dit bespaart API-kosten
// en wachttijd, en geeft directe feedback aan de redactie.
export async function POST(req: NextRequest) {
  const body = await req.json();
  const rawTitles: string[] = Array.isArray(body.titles) ? body.titles : [String(body.title || '')];
  const titles = rawTitles.map(t => t.trim()).filter(Boolean);
  
  // Voor bulk-import (bronnenscanner): geen validatie, oude gedrag behouden
  const skipValidation = body.skipValidation === true;
  
  // Voor handmatige invoer: valideer elk onderwerp, en neem de opgegeven
  // officiële website mee — die wordt hieronder per titel opgeslagen en is
  // straks in de pipeline (writer.ts stepResearch) de autoriteit voor de
  // entiteitscontrole. Bulk/scanner (skipValidation of meerdere titels) laat
  // dit veld bewust leeg, zoals voorheen.
  const website = titles.length === 1 ? (body.website?.trim() || '') : '';
  if (!skipValidation && titles.length === 1) {
    const title = titles[0];

    // Basisvalidatie zonder netwerk-calls (snel, binnen request)
    const validation = validateTopicBasic(title, website);
    if (!validation.valid && validation.severity === 'error') {
      return NextResponse.json(
        {
          error: validation.reason,
          suggestion: validation.suggestion,
          validationFailed: true
        },
        { status: 400 }
      );
    }
  }

  const websites = new Map<string, string>();
  if (website && titles.length === 1) websites.set(titles[0].toLowerCase(), website);

  return NextResponse.json(await addTopics(titles, undefined, undefined, websites));
}
