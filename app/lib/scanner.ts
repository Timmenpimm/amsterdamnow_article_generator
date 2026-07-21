import { createHash } from 'node:crypto';
import { askClaudeJson, FAST_WRITE_MODEL } from './claude';
import { SCAN_SCHEMA, SCAN_EDITORIALIZE_SCHEMA } from './schemas';
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

Geef per item ook de eventdatum mee in ISO-formaat (JJJJ-MM-DD), letterlijk uit de brontekst: "startdatum" en "einddatum". Bij een eendaags event is einddatum gelijk aan startdatum; bij een meerdaags event (festival, expositieperiode) de eerste en laatste dag. Gaat het om iets zonder concrete datum (een opening, een doorlopende expositie, nieuws zonder events-datum), geef dan startdatum: null en einddatum: null. Een event waarvan de einddatum al voorbij is (zie "Vandaag is" hierboven) hoort niet in de output.

Geef UITSLUITEND geldige JSON terug in exact dit formaat, zonder omliggende tekst:
{"items": [{"titel": "...", "startdatum": "JJJJ-MM-DD" of null, "einddatum": "JJJJ-MM-DD" of null}]}

Maximaal 12 items, de meest relevante eerst. Vind je niets bruikbaars, geef dan {"items": []}.`;

// JJJJ-MM-DD in Europe/Amsterdam, zodat de prompt en de code-side filter
// hieronder dezelfde "vandaag" hanteren als de kalenderdag van de redactie.
function amsterdamToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(new Date());
}

// Genormaliseerd scan-item: titel + (optionele) event-datums als JJJJ-MM-DD.
type ScanItem = { titel: string; start: string; eind: string };

// Strikt JJJJ-MM-DD of ''. Accepteert alleen het exacte ISO-formaat dat het
// schema/de prompt vraagt; al het andere (null, "doorlopend", een bereik) → ''.
function isoOrEmpty(value: unknown): string {
  const s = typeof value === 'string' ? value.trim() : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

// Deterministische check bovenop de prompt-instructie: Claude's eigen begrip
// van "vandaag" is niet betrouwbaar, dus filteren we hier nog eens hard. Een
// event is pas voorbij als de einddatum (of, bij ontbreken, de startdatum)
// vóór vandaag ligt. Zonder parsebare datum niet overslaan — bij twijfel
// liever een keer een oud item ter beoordeling op het bord.
function isPastEvent(item: ScanItem, todayISO: string): boolean {
  const ref = item.eind || item.start;
  return ref !== '' && ref < todayISO;
}

function findingKey(title: string): string {
  return title.toLowerCase().trim().replace(/\s+/g, ' ');
}

// Simpele, mechanische herschrijftaak → goedkoop model (zelfde patroon als
// DEDUP_MODEL in dedup.ts en CLASSIFY_MODEL in publisher.ts).
const EDITORIALIZE_MODEL = 'claude-haiku-4-5-20251001';
// ~20 korte titelparen per call; 3000 tokens is ruim.
const EDITORIALIZE_MAX_TOKENS = 3000;

const EDITORIALIZE_SYSTEM = `Je bent eindredacteur van Amsterdam NOW, een online stadsmagazine over Amsterdam.

Je krijgt onderwerp-titels die onze bronnenscanner letterlijk uit externe pagina's heeft gehaald (agenda's, nieuwspagina's, artikelen van andere media). Zet elke gescande titel om in een eigen input-topic voor onze redactie, zodat ons artikel nooit een kopie van het bronartikel wordt.

Regels:
1. Feiten blijven staan: namen van events, zaken, venues, buurten en jaartallen neem je over.
2. Bron-opmaak verdwijnt: aantallen uit lijstjes ("55 X", "top 10", "40+"), rubrieksnamen en huisstijl-formats van de bron laat je weg. Onze redactie bepaalt straks zelf de selectie en het aantal.
3. Thematische en lijst-onderwerpen krijgen een eigen invalshoek (bijvoorbeeld per buurt, per seizoen, voor een doelgroep, of een andere insteek), maar de zoekintentie blijft herkenbaar: uit "55 X beste terrassen van Amsterdam per wijk" moet nog altijd "beste terrassen Amsterdam" doorklinken.
4. Losse events, openingen en nieuwtjes blijven concreet (naam + kern), maar formuleer je kort in eigen woorden — niet de bronkop naschrijven.
5. Nederlands, één bondige onderwerptitel per item, geen aanhalingstekens, nummering of opsommingstekens.

Geef UITSLUITEND geldige JSON in exact dit formaat, zonder omliggende tekst:
{"topics": [{"bron": "<de gescande titel, letterlijk geëchood>", "topic": "<het eigen input-topic>"}]}
Eén object per invoertitel, in dezelfde volgorde als de invoer.`;

// Zet gescande bronkoppen om naar eigen input-topics. Fail-open: valt de call
// of een individueel item uit, dan gaat de originele titel de wachtrij in —
// liever één keer een letterlijk topic dan een verloren vondst. De uitvoer
// heeft gegarandeerd dezelfde lengte en volgorde als de invoer.
export async function editorializeTitles(titles: string[]): Promise<string[]> {
  if (!titles.length) return [];
  try {
    const prompt = `Gescande titels:\n${titles.map((t, i) => `${i + 1}. ${t}`).join('\n')}`;
    const data = await askClaudeJson(
      EDITORIALIZE_SYSTEM, prompt, false, EDITORIALIZE_MODEL, EDITORIALIZE_MAX_TOKENS, SCAN_EDITORIALIZE_SCHEMA,
    );
    const out = Array.isArray((data as any).topics) ? (data as any).topics : [];
    return titles.map((original, i) => {
      const topic = typeof out[i]?.topic === 'string' ? out[i].topic.trim() : '';
      return topic || original;
    });
  } catch (e) {
    console.warn('[scanner] redactionaliseren mislukt, gebruik gescande titels', e);
    return titles;
  }
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
  const items: ScanItem[] = rawItems
    .map((it: any) => {
      const start = isoOrEmpty(it?.startdatum);
      const eind = isoOrEmpty(it?.einddatum) || start; // eendaags: eind = start
      return { titel: (typeof it === 'string' ? it : String(it?.titel || it?.title || '')).trim(), start, eind };
    })
    .filter((it: ScanItem) => it.titel && !isPastEvent(it, today));

  // Ontdubbel binnen deze scan (op titel; de datum reist mee).
  const seen = new Set<string>();
  const unique = items.filter(it => {
    const k = findingKey(it.titel);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Ontdubbel tegen wat deze bron eerder al vond (ook verwijderde items blijven
  // onderdrukt — dat is de dedup-historie).
  const known = await getFindingKeys(source.id);
  const fresh = unique.filter(it => !known.has(findingKey(it.titel))).slice(0, MAX_NEW_PER_SCAN);
  if (!fresh.length) return { sourceId: source.id, ok: true, added: 0, skipped: 0, contentHash };

  // Redactionaliseer vóór de wachtrij: de gescande kop is de kop van de bron;
  // wij zetten er een eigen input-topic van in de wachtrij zodat het artikel
  // geen kopie van het bronartikel wordt. De vondsten-historie (en dus de
  // dedup tegen eerdere scans) blijft op de originele bronkop draaien —
  // anders zou elke scan hetzelfde item met een nieuwe herformulering opnieuw
  // aandragen.
  const topics = await editorializeTitles(fresh.map(f => f.titel));

  // Seed de event-datum op het topic: de datum hoort bij de originele bronkop
  // (fresh[i]); we koppelen 'm aan het editorialized topic dat de wachtrij
  // ingaat, zodat stepResearch (writer.ts) 'm als gezaghebbende event-datum
  // gebruikt — de bronpagina is betrouwbaarder dan een research-gok. Alleen
  // items met een concrete startdatum krijgen een seed.
  const seeds = new Map<string, { start: string; eind: string }>();
  fresh.forEach((f, i) => {
    if (f.start) seeds.set(topics[i].toLowerCase().trim(), { start: f.start, eind: f.eind });
  });

  // addTopics ontdubbelt nog eens tegen de globale wachtrij (handmatige invoer of
  // een andere bron die hetzelfde al aandroeg) en zet de seed in list_state.
  const { added, skipped } = await addTopics(topics, new Set(), seeds);
  const idMap = await topicIdsByTitle(topics);
  const entries = fresh.map((f, i) => ({
    title: f.titel,
    topicId: idMap.get(topics[i].toLowerCase().trim()) ?? null,
  }));
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
