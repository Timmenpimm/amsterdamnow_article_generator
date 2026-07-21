import { createHash } from 'node:crypto';
import { askClaudeJson, FAST_WRITE_MODEL } from './claude';
import { SCAN_SCHEMA } from './schemas';
import { extractPageText } from './tavily';
import {
  activeSources, addTopics, getFindingKeys, getSource,
  recordFindings, topicIdsByTitle, updateSourceScan,
} from './db';
import type { ScanResult, Source } from './types';

// Guard tegen het overspoelen van de wachtrij bij een grote/onverwachte pagina.
const MAX_NEW_PER_SCAN = 20;

const SCAN_SYSTEM = `Je bent redactie-assistent van Amsterdam NOW, een online stadsmagazine over Amsterdam (restaurants, cultuur, uitgaan, winkels, buurten, lifestyle).

Je krijgt de uitgelezen tekst van één agenda-, programma- of nieuwspagina. Haal daaruit de items die de moeite waard zijn als artikel voor Amsterdam NOW:
- concerten, voorstellingen, tentoonstellingen, festivals en events in Amsterdam
- nieuwe cafés, restaurants, winkels, openingen en noemenswaardige plekken

Negeer: navigatie, cookiemeldingen, reclame, algemene teksten, items buiten Amsterdam, en terugkerende/al voorbije programmering zonder nieuwswaarde.

Formuleer elk item als één bondige onderwerptitel zoals een redacteur die zou intypen — concreet en herkenbaar (naam + kern), bv. "Lucky Chops: brass party in de grote zaal van Paradiso". Geen datums-als-titel, geen opsommingstekens.

Geef per item ook "datum" mee: de concrete datum van het event in ISO-formaat (JJJJ-MM-DD), als de brontekst die noemt. Gaat het om iets zonder vaste enkele datum (een opening, een doorlopende expositie, nieuws zonder events-datum), geef dan datum: null. Een event waarvan de datum al voorbij is (zie "Vandaag is" hierboven) hoort niet in de output.

Geef UITSLUITEND geldige JSON terug in exact dit formaat, zonder omliggende tekst:
{"items": [{"titel": "...", "datum": "JJJJ-MM-DD" of null}]}

Maximaal 12 items, de meest relevante eerst. Vind je niets bruikbaars, geef dan {"items": []}.`;

// JJJJ-MM-DD in Europe/Amsterdam, zodat de prompt en de code-side filter
// hieronder dezelfde "vandaag" hanteren als de kalenderdag van de redactie.
function amsterdamToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(new Date());
}

// Deterministische check bovenop de prompt-instructie: Claude's eigen begrip
// van "vandaag" is niet betrouwbaar, dus filteren we hier nog eens hard op de
// "datum" die het schema teruggeeft. Alles wat niet als JJJJ-MM-DD parseert
// (null, "doorlopend", een bereik) laten we door — bij twijfel niet
// overslaan, dan maar een keer een oud item ter beoordeling op het bord.
function isPastEvent(item: any, todayISO: string): boolean {
  const datum = typeof item?.datum === 'string' ? item.datum.trim() : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(datum) && datum < todayISO;
}

function findingKey(title: string): string {
  return title.toLowerCase().trim().replace(/\s+/g, ' ');
}

// Scant één bron: pagina lezen → Claude haalt items eruit → ontdubbelen tegen de
// vondsten-historie → nieuwe items als topic in de wachtrij → vondsten vastleggen.
// Werkt de scanstatus van de bron altijd bij (ook bij een fout).
export async function scanSource(id: number): Promise<ScanResult> {
  const source = await getSource(id);
  if (!source) throw new Error('Bron niet gevonden.');
  try {
    const { contentHash, ...result } = await runScan(source);
    // Alleen bij een geslaagde scan de nieuwe hash wegschrijven; bij een fout
    // (catch hieronder) blijft de laatst bekende hash staan.
    await updateSourceScan(id, { status: 'ok', newCount: result.added, contentHash });
    return result;
  } catch (e: any) {
    const error = e?.message || 'Scan mislukt.';
    await updateSourceScan(id, { status: 'error', error });
    return { sourceId: id, ok: false, added: 0, skipped: 0, error };
  }
}

async function runScan(source: Source): Promise<ScanResult & { contentHash: string }> {
  const pageText = await extractPageText(source.url);

  // Dagelijkse cron scant elke actieve bron, ook als de pagina niet is
  // gewijzigd. Is de hash van de paginatekst gelijk aan de vorige scan, dan
  // is de Claude-call pure verspilling (~4k input-tokens voor niets) — sla
  // 'm dan over en meld een geslaagde scan zonder nieuwe items.
  const contentHash = createHash('sha256').update(pageText).digest('hex');
  if (contentHash === source.content_hash) {
    return { sourceId: source.id, ok: true, added: 0, skipped: 0, contentHash };
  }

  const today = amsterdamToday();
  const prompt = `Bron: ${source.name}\nURL: ${source.url}\nVandaag is ${today} (Europe/Amsterdam).\n\nUitgelezen pagina-inhoud:\n---\n${pageText}\n---`;
  const data = await askClaudeJson(SCAN_SYSTEM, prompt, false, FAST_WRITE_MODEL, 6000, SCAN_SCHEMA);

  const rawItems = Array.isArray((data as any).items) ? (data as any).items : [];
  const titles: string[] = rawItems
    .filter((it: any) => !isPastEvent(it, today))
    .map((it: any) => (typeof it === 'string' ? it : String(it?.titel || it?.title || '')))
    .map((t: string) => t.trim())
    .filter(Boolean);

  // Ontdubbel binnen deze scan.
  const seen = new Set<string>();
  const unique = titles.filter(t => {
    const k = findingKey(t);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Ontdubbel tegen wat deze bron eerder al vond (ook verwijderde items blijven
  // onderdrukt — dat is de dedup-historie).
  const known = await getFindingKeys(source.id);
  const fresh = unique.filter(t => !known.has(findingKey(t))).slice(0, MAX_NEW_PER_SCAN);
  if (!fresh.length) return { sourceId: source.id, ok: true, added: 0, skipped: 0, contentHash };

  // addTopics ontdubbelt nog eens tegen de globale wachtrij (handmatige invoer of
  // een andere bron die hetzelfde al aandroeg).
  const { added, skipped } = await addTopics(fresh);
  const idMap = await topicIdsByTitle(fresh);
  const entries = fresh.map(t => ({ title: t, topicId: idMap.get(t.toLowerCase().trim()) ?? null }));
  await recordFindings(source.id, entries);

  return { sourceId: source.id, ok: true, added: added.length, skipped: skipped.length, contentHash };
}

// Voor de cron/"alle bronnen"-run: elke actieve bron sequentieel, best-effort.
export async function scanAllActiveSources(): Promise<ScanResult[]> {
  const sources = await activeSources();
  const results: ScanResult[] = [];
  for (const s of sources) results.push(await scanSource(s.id));
  return results;
}
