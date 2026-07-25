import { NextRequest, NextResponse } from 'next/server';
import { latestAuditByPost, latestAuditForPost } from '@/lib/db';

export const dynamic = 'force-dynamic';

// Auditbevindingen per artikel, voor het bord en het artikeldetail.
//
// Zonder parameters: het oordeel van élk geauditeerd artikel, zonder de
// bevindingsteksten — het bord haalt dit in één verzoek op naast /api/board.
// Met ?postId=…: de bevindingen van dat ene artikel, voor het detailscherm.
//
// Let op de volgorde in vercel.json: deze route moet vóór
// `^/api/audit/([^/]+)/?$` staan, anders vangt de run-detailroute hem op met
// id "by-post". Geen auth (leesactie, net als /api/audit) en alleen lezen — de
// auditor zelf schrijft, deze route nooit.
export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('postId');

  try {
    if (raw !== null) {
      const postId = Number(raw);
      if (!Number.isInteger(postId) || postId <= 0) {
        return NextResponse.json({ error: 'Ongeldig post-id.' }, { status: 400 });
      }
      const oordeel = await latestAuditForPost(postId);
      // 404, niet een leeg oordeel: "nooit gecontroleerd" is iets anders dan
      // "gecontroleerd en niets gevonden" (dat laatste is verdict 'ok').
      if (!oordeel) {
        return NextResponse.json(
          { error: `Artikel ${postId} is niet geauditeerd in de recente runs.` },
          { status: 404 }
        );
      }
      return NextResponse.json(oordeel);
    }

    return NextResponse.json({ verdicts: await latestAuditByPost() });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Auditbevindingen ophalen mislukt.' }, { status: 500 });
  }
}
