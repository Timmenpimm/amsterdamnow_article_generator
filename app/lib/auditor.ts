import { askClaudeJson, askClaudeJsonWithImages, FAST_WRITE_MODEL, type ClaudeImage } from './claude';
import { activePrompt, listStructures, recentlyAuditedPostIds } from './db';
import { listArticles, WP_URL } from './wp';
import { articlePhase, type Article, type AuditFindingInput, type AuditFindingKind, type AuditScope, type AuditVerdict, type MediaRef } from './types';
import { decodeHtmlEntities } from './htmlEntities';
import { searchClaimSources, type AuditSource } from './auditSearch';
import { AUDIT_CLAIMS_EXTRACT_SCHEMA, AUDIT_CLAIMS_VERDICT_SCHEMA, AUDIT_IMAGE_SCHEMA } from './auditSchemas';

// De audit-engine: een tweede paar ogen met eigen bronnen. Zie
// docs/auditor-ontwerp.md.
//
// Wat dit bestand bewust NIET doet:
//   - niets importeren uit writer.ts, tavily.ts of validation.ts. Dat is geen
//     stijlvoorkeur: een auditor die de research of de checks van de generatie
//     hergebruikt, controleert zijn eigen aannames. De twee handmatige audits
//     van 25-07-2026 vonden in 5 van de 5 artikelen fouten die de pipeline zelf
//     niet zág, juist omdat de pipeline haar output tegen dezelfde research
//     toetste die de fout veroorzaakte.
//   - niets schrijven. Geen WordPress-mutatie, geen aanraking van de
//     auto-publisher. De auditor rapporteert; wat er met een bevinding gebeurt
//     is redactioneel werk.
//
// Wat wél gedeeld is met de generatie: het lezen van de artikelen
// (wp.ts listArticles) en de fase-indeling (articlePhase). Dat moet ook — het
// gaat om exact dezelfde artikelen. Onafhankelijk moeten de bronnen en het
// oordeel zijn, niet de vraag welk artikel je bekijkt.

// Artikelen die hier binnen zijn geauditeerd vallen buiten de trekking, zodat
// een tweede run nieuwe artikelen pakt in plaats van dezelfde drie.
const RECENT_AUDIT_DAYS = 14;

// Budget per artikel, afgestemd op de 60s-functielimiet die overal in deze
// codebase speelt. Eén artikel kost: 1 extractie-call + max 3 Serper-calls +
// 1 vision-call + 1 verdict-call. Niet meer.
const MAX_CLAIMS_EXTRACTED = 8;
const MAX_CLAIMS_CHECKED = 3;
// Drie beelden in plaats van vier: de vision-call stuurt de bytes mee en één
// tik moet binnen de 60s-functielimiet blijven, samen met de extractie-, de
// verdict- en de Serper-calls. Een vierde beeld voegt zelden iets toe.
const MAX_IMAGES_CHECKED = 3;
const CLAIM_TEXT_CHARS = 6000;
const EXTRACT_MAX_TOKENS = 1500;
const VERDICT_MAX_TOKENS = 2000;

// Beelden zelf ophalen en als base64 doorgeven, net als de beeldscoring doet:
// de Anthropic API weigert URL-sources waarvan robots.txt dat verbiedt, en dan
// klapt de héle vision-call op één beeld (zie lib/claude.ts).
const IMAGE_TIMEOUT_MS = 6000;
const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
// Alt-tekst zit niet op het Article-object; die staat in de WordPress
// media-API. Publiek leesbaar, dus geen auth nodig — de auditor heeft
// bewust geen schrijfrechten in handen.
const MEDIA_TIMEOUT_MS = 6000;

// Zinnen korter dan dit tellen niet mee in de tekstintegriteit-check: "Meer
// informatie op de website." of "De toegang is gratis." staan legitiem in
// tientallen artikelen en zouden de bevindingenlijst vol ruis zetten. Acht
// woorden is lang genoeg dat een letterlijke overeenkomst geen toeval meer is.
const MIN_SENTENCE_WORDS = 8;
// Bovengrens per soort bevinding: een artikel dat om wat voor reden dan ook
// grotendeels gedupliceerd is, moet één duidelijk signaal opleveren en niet
// veertig regels die het paneel onleesbaar maken.
const MAX_TEXT_FINDINGS_PER_KIND = 5;

// Generieke tokens in bestandsnamen. Deze zeggen niets over het onderwerp, dus
// ze mogen nooit een "beeld hoort bij een ander onderwerp"-bevinding opleveren.
// De echte signaalwoorden zijn merk-, venue- en festivalnamen:
// `awakenings-in-spaarnwoude` bij een Dekmantel-artikel is een harde fout die
// je zonder model ziet — precies zo'n beeld zat in de audit van 25-07-2026.
const GENERIEKE_BEELDTOKENS = new Set([
  'amsterdam', 'nederland', 'holland', 'foto', 'fotos', 'image', 'images', 'photo', 'photos',
  'picture', 'screenshot', 'schermafbeelding', 'sfeer', 'sfeerbeeld', 'beeld', 'afbeelding',
  'cropped', 'scaled', 'resized', 'edited', 'final', 'definitief', 'versie', 'kopie',
  'header', 'banner', 'thumbnail', 'featured', 'slider', 'inline', 'uploads', 'unsplash',
  'pexels', 'stock', 'default', 'placeholder', 'klein', 'groot', 'medium', 'large', 'small',
  // De tool uploadt zelf als `<venue>-<type>-amsterdam_N.jpg` (zie
  // mediaName.ts). Dat type-token haalt de vijf-tekengrens en staat zelden in
  // de titel, dus zonder deze regel krijgt bijna élk artikel een onterechte
  // "beeld hoort bij een ander onderwerp"-fout — en dan is de hele
  // bevindingenlijst waardeloos.
  'restaurant', 'winkel', 'museum', 'theater', 'bioscoop', 'galerie', 'hotel', 'cafe',
  'terras', 'festival', 'evenement', 'expositie', 'tentoonstelling', 'concert', 'markt',
  'sauna', 'bakkerij', 'brouwerij', 'koffiebar', 'wijnbar', 'club', 'bar',
  // Gewone woorden en fotograaf-/stockleveranciers die geen onderwerp aanduiden.
  'grote', 'kleine', 'nieuwe', 'oude', 'mooie', 'shutterstock', 'gettyimages', 'adobe',
  // Artefacten van beeldexports en CMS-downloads. `caption-5-1024x1024.jpg`
  // meldde in de eerste echte auditrun drie keer "de term caption komt niet in
  // de titel voor" — waar, en volstrekt betekenisloos.
  'caption', 'captions', 'untitled', 'naamloos', 'download', 'downloads', 'export',
  'afbeelding1', 'website', 'webshop', 'facebook', 'instagram', 'origineel', 'original',
]);

// Bestandsnamen die verraden dat het beeld geen redactionele foto is maar een
// schermafbeelding. Dat is een echte bevinding — screenshots als artikelbeeld
// kwamen uit de handmatige audit van 25-07-2026 — maar een andere dan "dit
// beeld hoort bij een ander onderwerp".
const SCREENSHOT_PATROON = /(screen[\s_-]?shot|schermafbeelding|schermafdruk)/i;

// ---------------------------------------------------------------------------
// Kleine, lokale helpers. Bewust eigen kopieën: de generatie heeft
// vergelijkbare functies, maar de auditor mag niet met de generatie meebewegen.
// ---------------------------------------------------------------------------

function plainText(html: string): string {
  return decodeHtmlEntities(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Hoofdletter- en interpunctie-ongevoelige normalisatie voor "komt letterlijk
// voor"-vergelijkingen. Diakritieken worden afgevlakt zodat `café` en `cafe`
// hetzelfde zijn — in bestandsnamen bestaat de e-aigu niet.
function normalize(value: string): string {
  return String(value || '')
    .toLocaleLowerCase('nl-NL')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.slice(0, 300) || 'onbekende fout';
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// Onbekende of ontbrekende verdicts worden 'twijfel', nooit 'ok': een oordeel
// dat we niet kunnen lezen is geen goedkeuring.
function asVerdict(value: unknown): AuditVerdict {
  const v = asString(value).toLowerCase();
  return v === 'ok' || v === 'fout' ? v : 'twijfel';
}

// URL-vergelijking voor de bron-controle: protocol, www en trailing slash
// mogen verschillen, de rest niet.
function urlKey(url: string): string {
  return asString(url).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Steekproef
// ---------------------------------------------------------------------------

/**
 * Trekt de steekproef voor een run.
 *
 * scope `drafts` = alles wat nog gepubliceerd moet worden; `ready` = daarvan
 * alleen wat publicatieklaar is. Voor lijstartikelen heeft articlePhase de
 * list-structuren nodig (elk item moet een eigen foto hebben), dus die worden
 * er net als in /api/board bijgehaald.
 *
 * Gooit nooit bij een lege set: dan is er simpelweg niets te auditen.
 */
export async function sampleForAudit(scope: AuditScope, sampleSize: number): Promise<number[]> {
  const size = Math.max(0, Math.trunc(Number(sampleSize) || 0));
  if (!size) return [];

  const [articles, structures, recent] = await Promise.all([
    listArticles(),
    listStructures(),
    // De uitsluiting is een verfijning, geen voorwaarde: kan de audit-historie
    // niet gelezen worden (lege database, tabel nog niet aangelegd), dan is
    // een steekproef zonder uitsluiting beter dan geen steekproef.
    recentlyAuditedPostIds(RECENT_AUDIT_DAYS).catch(() => [] as number[]),
  ]);

  // Alleen drafts: een gepubliceerd artikel is geen te publiceren artikel meer,
  // en de auditor is bedoeld als controle vóór publicatie.
  const pool = articles.filter(a => {
    if (a.status !== 'draft') return false;
    if (scope === 'drafts') return true;
    return articlePhase(a, structures[a.id] || null) === 'ready';
  });
  if (!pool.length) return [];

  const recentSet = new Set(recent);
  const fresh = pool.filter(a => !recentSet.has(a.id)).map(a => a.id);
  const picked = shuffle(fresh).slice(0, size);
  if (picked.length >= size) return picked;

  // Te weinig verse artikelen: aanvullen met de artikelen die het langst niet
  // gecontroleerd zijn. We nemen aan dat recentlyAuditedPostIds op auditdatum
  // geordend is (nieuwste eerst) en lopen die lijst daarom van achteren af.
  // Klopt die aanname niet, dan is de aanvulling alleen minder gericht — nooit
  // fout: het blijven artikelen uit dezelfde scope.
  const poolIds = new Set(pool.map(a => a.id));
  const alreadyPicked = new Set(picked);
  for (const id of [...recent].reverse()) {
    if (picked.length >= size) break;
    if (!poolIds.has(id) || alreadyPicked.has(id)) continue;
    picked.push(id);
    alreadyPicked.add(id);
  }
  return picked;
}

// ---------------------------------------------------------------------------
// 1. Claimcheck — model + eigen zoekindex
// ---------------------------------------------------------------------------

type ExtractedClaim = { tekst: string; soort: string; zoekterm: string };

// Superlatieven en getallen/jaartallen eerst: daar vonden de handmatige audits
// de fouten. De rest volgt in de volgorde waarin het model ze aandroeg (het
// zet de belangrijkste vooraan), zodat de drie zoekopdrachten naar de zwaarste
// beweringen gaan.
function claimWeight(soort: string): number {
  const s = soort.toLowerCase();
  if (s === 'superlatief') return 0;
  if (s === 'getal' || s === 'jaartal' || s === 'capaciteit' || s === 'prijs') return 1;
  return 2;
}

function articleFactText(a: Article): string {
  const parts = [
    `Titel: ${a.title}`,
    `Subregel: ${a.subregel}`,
    `Intro: ${plainText(a.intro)}`,
    a.naam_locatie ? `Locatie volgens het artikel: ${a.naam_locatie}${a.adres ? `, ${a.adres}` : ''}` : '',
    '',
    'Artikeltekst:',
    plainText(a.contentHtml).slice(0, CLAIM_TEXT_CHARS),
  ];
  return parts.filter(Boolean).join('\n');
}

async function claimCheck(article: Article): Promise<AuditFindingInput[]> {
  const prompt = (await activePrompt('audit-claims')).content;

  // Stap 1 — extractie. FAST_WRITE_MODEL: dit is aanwijzen wat controleerbaar
  // is, geen creatief werk, en het moet snel binnen de functielimiet passen.
  const extracted = await askClaudeJson(
    prompt,
    [
      'Haal de harde, controleerbare beweringen uit dit artikel. Geef per bewering ook de zoekopdracht waarmee je haar zou natrekken.',
      '',
      articleFactText(article),
    ].join('\n'),
    FAST_WRITE_MODEL,
    EXTRACT_MAX_TOKENS,
    AUDIT_CLAIMS_EXTRACT_SCHEMA,
    false,
    `audit-claims-extract#${article.id}`,
  );

  const geëxtraheerd = rowsOf(extracted, 'claims');
  const claims: ExtractedClaim[] = geëxtraheerd.rows
    .map((c: any) => ({ tekst: asString(c?.tekst), soort: asString(c?.soort), zoekterm: asString(c?.zoekterm) }))
    .filter((c: ExtractedClaim) => c.tekst)
    .slice(0, MAX_CLAIMS_EXTRACTED);
  // Onherkenbaar antwoord is géén schone audit. Niet elke provider ondersteunt
  // structured outputs (Omniroute niet, zie modelConfig.ts), en dan volgt het
  // model de prompt in plaats van het schema. Wie dat stil als "nul claims"
  // afdoet, krijgt een auditor die alles groen verklaart — erger dan geen
  // auditor. Een lege lijst mag wel: dat is een echt antwoord.
  if (!geëxtraheerd.herkend) {
    return [{
      kind: 'claim', verdict: 'twijfel', onderwerp: 'claimcheck',
      bevinding: 'Het model gaf geen bruikbare claim-lijst terug (mogelijk een provider zonder structured outputs). De claims van dit artikel zijn NIET gecontroleerd.',
      bron: '',
    }];
  }
  // Geen controleerbare bewering in het artikel is geen bevinding: dan valt er
  // op dit onderdeel niets te melden.
  if (!claims.length) return [];

  // Stap 2 — zwaarste drie claims natrekken in de eigen index. Stabiele sort
  // op gewicht, zodat de modelvolgorde binnen hetzelfde gewicht behouden blijft.
  const zwaarste = claims
    .map((c, i) => ({ c, i }))
    .sort((x, y) => claimWeight(x.c.soort) - claimWeight(y.c.soort) || x.i - y.i)
    .slice(0, MAX_CLAIMS_CHECKED)
    .map(x => x.c);

  const searched = await Promise.all(
    zwaarste.map(async c => ({ claim: c, sources: await searchClaimSources(c.zoekterm || c.tekst) })),
  );

  // Stap 3 — één verdict-call met claims én zoekresultaten. De set toegestane
  // bronnen wordt hier vastgelegd: alleen URL's die het model daadwerkelijk
  // heeft gezien mogen straks in een bevinding staan.
  const allowedUrls = new Map<string, string>();
  for (const s of searched) for (const src of s.sources) allowedUrls.set(urlKey(src.url), src.url);

  const verdictPrompt = [
    'Beoordeel per claim of de meegegeven zoekresultaten haar bevestigen, ontkrachten of onbeslist laten.',
    'Deze zoekresultaten komen uit een andere zoekindex dan waarmee het artikel is geschreven. Ga uitsluitend uit van wat hier staat.',
    '',
    `Artikel: ${article.title}`,
    article.naam_locatie ? `Locatie volgens het artikel: ${article.naam_locatie}` : '',
    '',
    ...searched.map((s, i) => [
      `Claim ${i + 1} (${s.claim.soort || 'overig'}): ${s.claim.tekst}`,
      `Zoekopdracht: ${s.claim.zoekterm || s.claim.tekst}`,
      s.sources.length
        ? s.sources.map((src: AuditSource) => `- ${src.title || 'zonder titel'} — ${src.url}\n  ${src.snippet || '(geen snippet)'}`).join('\n')
        : '- Geen zoekresultaten gevonden.',
      '',
    ].join('\n')),
  ].filter(Boolean).join('\n');

  const judged = await askClaudeJson(prompt, verdictPrompt, FAST_WRITE_MODEL, VERDICT_MAX_TOKENS, AUDIT_CLAIMS_VERDICT_SCHEMA, false, `audit-claims-oordeel#${article.id}`);
  const geoordeeld = rowsOf(judged, 'bevindingen');
  if (!geoordeeld.herkend) {
    return [{
      kind: 'claim', verdict: 'twijfel', onderwerp: 'claimcheck',
      bevinding: `Het model gaf geen leesbaar oordeel over de ${zwaarste.length} nagetrokken claims. Die zijn dus NIET gecontroleerd.`,
      bron: '',
    }];
  }
  const rows = geoordeeld.rows;

  return rows.slice(0, MAX_CLAIMS_CHECKED).map((r: any, i: number): AuditFindingInput => {
    const onderwerp = asString(r?.onderwerp) || searched[i]?.claim.tekst.slice(0, 120) || 'claim';
    let bevinding = asString(r?.bevinding) || 'Geen toelichting gegeven.';
    let verdict = asVerdict(r?.verdict);

    // Bron-controle in code, niet alleen in de prompt. Een verzonnen of niet
    // meegegeven URL is precies het soort schijnzekerheid dat deze feature moet
    // uitbannen, dus die gooien we weg. En zonder bron kan een claim nooit
    // 'ok' zijn: "bevestigd" zonder bewijs is geen bevestiging.
    const claimed = asString(r?.bron);
    let bron = claimed && allowedUrls.has(urlKey(claimed)) ? allowedUrls.get(urlKey(claimed))! : '';
    if (claimed && !bron) bevinding += ' (De opgegeven bron stond niet in de zoekresultaten en is daarom weggelaten.)';
    if (!bron && verdict === 'ok') {
      verdict = 'twijfel';
      bevinding += ' (Geen bruikbare bron uit de eigen zoekopdracht, dus niet bevestigd.)';
    }
    return { kind: 'claim', verdict, onderwerp: onderwerp.slice(0, 200), bevinding, bron };
  });
}

// ---------------------------------------------------------------------------
// 2. Beeldcheck — twee deterministische signalen plus één vision-beoordeling
// ---------------------------------------------------------------------------

type AuditImage = { rol: string; ref: MediaRef; bestandsnaam: string };

// Alle beelden van het artikel met hun rol, in de volgorde waarin de lezer ze
// ziet. De URL's staan al op het Article-object; alleen de alt-tekst moet uit
// de media-API komen.
function collectImages(a: Article): AuditImage[] {
  const out: AuditImage[] = [];
  const add = (rol: string, ref: MediaRef | null | undefined) => {
    if (!ref?.url) return;
    if (out.some(o => o.ref.id === ref.id)) return; // featured staat vaak óók in de slider
    out.push({ rol, ref, bestandsnaam: fileNameFromUrl(ref.url) });
  };
  add('featured', a.featured);
  a.slider.forEach((m, i) => add(`slider ${i + 1}`, m));
  add('inline', a.inline);
  return out.slice(0, MAX_IMAGES_CHECKED);
}

function fileNameFromUrl(url: string): string {
  try {
    const path = new URL(url, WP_URL).pathname;
    return decodeURIComponent(path.split('/').pop() || '');
  } catch {
    return (url.split('?')[0].split('/').pop() || '');
  }
}

// Tokens uit een bestandsnaam die iets over het onderwerp kunnen zeggen:
// minstens 5 tekens, geen generiek woord, geen puur getal en geen
// formaatsuffix (1024x682). Wat overblijft is het soort woord dat een merk-,
// venue- of festivalnaam is.
// Haalt de rijenlijst uit een modelantwoord en zegt erbij of het antwoord
// überhaupt herkenbaar was. Dat onderscheid is het verschil tussen "het model
// vond niets" (geldig) en "we hebben het antwoord niet kunnen lezen" (dan mag
// er nooit een groen oordeel uit rollen). Naast de schemasleutel accepteren we
// de sleutels die een provider zónder structured outputs oplevert, en een
// antwoord dat zelf al een array is.
function rowsOf(payload: Record<string, unknown>, sleutel: string): { rows: any[]; herkend: boolean } {
  if (Array.isArray(payload)) return { rows: payload, herkend: true };
  for (const k of [sleutel, 'bevindingen', 'items', 'resultaten']) {
    if (Array.isArray((payload as any)?.[k])) return { rows: (payload as any)[k], herkend: true };
  }
  return { rows: [], herkend: false };
}

export function fileNameTokens(bestandsnaam: string): string[] {
  const base = bestandsnaam.replace(/\.[a-z0-9]{2,5}$/i, '');
  const tokens = normalize(base).split(' ');
  const out: string[] = [];
  for (const t of tokens) {
    if (t.length < 5) continue;
    // Alleen letterreeksen tellen als aanwijzing voor een ánder onderwerp.
    // Alles met een cijfer erin is een tijdstempel, een formaat of een
    // cameravolgnummer: `screenshot2025`, `23at16`, `852x1024`, `e1612345678`,
    // `img20240101`. Die leverden meldingen op als "de bestandsnaam bevat de
    // term 23at16, dat wijst op een ander onderwerp" — pure ruis, en ruis maakt
    // een auditrapport waardeloos. Een venuenaam mét cijfer (Studio80) raken we
    // hiermee kwijt als signaal; dat is de goede kant om fout te zitten.
    if (!/^\p{L}+$/u.test(t)) continue;
    if (GENERIEKE_BEELDTOKENS.has(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

// Komt het token terug in de tekst van het artikel? Substring in beide
// richtingen (met een minimum van 5 tekens) vangt verbuigingen en
// samenstellingen op: `dekmantel` in "Dekmantel Festival", `restaurant` in
// "restaurants". Ruimer fout-negatief zijn is hier de bedoeling — een
// `fout`-bevinding moet kloppen.
function tokenAppearsIn(token: string, haystack: string, haystackWords: string[]): boolean {
  if (haystack.includes(token)) return true;
  return haystackWords.some(w => w.length >= 5 && (w.startsWith(token) || token.startsWith(w)));
}

// De alt-tekst zit niet in listArticles; hem hier ophalen kost per beeld één
// publieke GET. Mislukt dat, dan levert deze functie null en slaat de
// alt-check dat beeld over — een onbereikbare media-API mag geen `twijfel`
// opleveren die er niet is.
async function fetchAltText(id: number): Promise<string | null> {
  try {
    const res = await fetch(`${WP_URL}/wp-json/wp/v2/media/${id}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json() as { alt_text?: string };
    return typeof data.alt_text === 'string' ? data.alt_text : '';
  } catch {
    return null;
  }
}

async function fetchImageBytes(url: string): Promise<ClaudeImage | null> {
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AmsterdamNOW-auditor)' },
    });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_TYPES.has(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > IMAGE_MAX_BYTES) return null;
    return { media_type: type, data: buf.toString('base64') };
  } catch {
    return null;
  }
}

// Namen van de ándere artikelen op het bord, als losse letterreeksen. Komt zo'n
// naam voor in een bestandsnaam hier, dan is het beeld aantoonbaar van een
// ander onderwerp — dat is het verschil tussen een harde bevinding en een
// vermoeden.
function onderwerpenVanAndereArtikelen(article: Article, board: Article[]): Set<string> {
  const uit = new Set<string>();
  for (const other of board) {
    if (other.id === article.id) continue;
    const naam = normalize([other.naam_locatie, other.title].filter(Boolean).join(' '));
    for (const woord of naam.split(' ')) {
      if (woord.length < 5) continue;
      if (!/^\p{L}+$/u.test(woord)) continue;
      if (GENERIEKE_BEELDTOKENS.has(woord)) continue;
      uit.add(woord);
    }
  }
  return uit;
}

async function imageCheck(article: Article, board: Article[]): Promise<AuditFindingInput[]> {
  const images = collectImages(article);
  if (!images.length) {
    return [{
      kind: 'beeld', verdict: 'twijfel', onderwerp: 'geen beeld',
      bevinding: 'Het artikel heeft nog geen beelden, dus er is niets te beoordelen.', bron: '',
    }];
  }

  const findings: AuditFindingInput[] = [];
  const andereOnderwerpen = onderwerpenVanAndereArtikelen(article, board);

  // --- Deterministisch signaal 1: de bestandsnaam noemt een ander onderwerp.
  // Vóór de vision-call, want dit heeft geen model nodig.
  //
  // Twee lessen uit de praktijk zitten hierin verwerkt. (a) Alleen een
  // letterreeks telt als aanwijzing; tijdstempels en formaten als
  // `screenshot2025`, `23at16` of `852x1024` leverden meldingen op die niets
  // betekenden. (b) "Ik kan deze term niet terugvinden in de titel" is zwakker
  // bewijs dan het klinkt: fotograafnamen en buurtnamen halen dezelfde toets.
  // Daarom is het pas een `fout` als de term de naam van een ánder artikel op
  // het bord is (dan is het beeld aantoonbaar hergebruikt, zoals het
  // Awakenings-beeld bij het Dekmantel-artikel); anders `twijfel`.
  const haystack = normalize([article.title, article.naam_locatie, ...(article.tags || [])].filter(Boolean).join(' '));
  const haystackWords = haystack.split(' ').filter(Boolean);
  for (const img of images) {
    const vreemd = fileNameTokens(img.bestandsnaam).filter(t => !tokenAppearsIn(t, haystack, haystackWords));
    if (!vreemd.length) continue;
    const anderOnderwerp = vreemd.filter(t => andereOnderwerpen.has(t));
    if (anderOnderwerp.length) {
      findings.push({
        kind: 'beeld', verdict: 'fout', onderwerp: `${img.rol}: bestandsnaam`,
        bevinding: `De bestandsnaam "${img.bestandsnaam}" noemt ${anderOnderwerp.map(t => `"${t}"`).join(', ')}, en dat is het onderwerp van een ander artikel op het bord. Dit beeld lijkt hergebruikt.`,
        bron: img.ref.url,
      });
      continue;
    }
    findings.push({
      kind: 'beeld', verdict: 'twijfel', onderwerp: `${img.rol}: bestandsnaam`,
      bevinding: `De bestandsnaam "${img.bestandsnaam}" bevat ${vreemd.length === 1 ? 'de term' : 'de termen'} ${vreemd.map(t => `"${t}"`).join(', ')}, ${vreemd.length === 1 ? 'die' : 'die'} niet terugkomt in de titel, de locatienaam of de tags. Meestal onschuldig (fotograaf, buurt, pandnaam), maar controleer of het beeld echt bij dit artikel hoort.`,
      bron: img.ref.url,
    });
  }

  // --- Deterministisch signaal 1b: het beeld is een schermafbeelding. Geen
  // verkeerd onderwerp, wél een beeldkwaliteitsprobleem: in de handmatige
  // audit van 25-07-2026 stonden er twee als artikelbeeld op het bord.
  for (const img of images) {
    if (!SCREENSHOT_PATROON.test(img.bestandsnaam)) continue;
    findings.push({
      kind: 'beeld', verdict: 'twijfel', onderwerp: `${img.rol}: schermafbeelding`,
      bevinding: `De bestandsnaam "${img.bestandsnaam}" wijst op een schermafbeelding in plaats van een redactionele foto. Controleer of dit beeld goed genoeg is om te publiceren.`,
      bron: img.ref.url,
    });
  }

  // --- Deterministisch signaal 2: alt-tekst leeg of gelijk aan de
  // bestandsnaam. Alle 12 beelden uit de eerste handmatige audit hadden dit;
  // het is geen inhoudelijke fout maar wel verloren beeld-SEO, dus `twijfel`.
  const alts = await Promise.all(images.map(img => fetchAltText(img.ref.id)));
  images.forEach((img, i) => {
    const alt = alts[i];
    if (alt === null) return; // media-API onbereikbaar: niets vaststelbaar
    const naamZonderExt = img.bestandsnaam.replace(/\.[a-z0-9]{2,5}$/i, '');
    if (!alt.trim()) {
      findings.push({
        kind: 'beeld', verdict: 'twijfel', onderwerp: `${img.rol}: alt-tekst`,
        bevinding: 'Dit beeld heeft geen alt-tekst.', bron: img.ref.url,
      });
      return;
    }
    if (normalize(alt) === normalize(naamZonderExt)) {
      findings.push({
        kind: 'beeld', verdict: 'twijfel', onderwerp: `${img.rol}: alt-tekst`,
        bevinding: `De alt-tekst is gelijk aan de bestandsnaam ("${alt.trim()}") en beschrijft dus niet wat er te zien is.`,
        bron: img.ref.url,
      });
    }
  });

  // --- Vision-beoordeling op de echte bytes. Eén call voor alle (maximaal
  // vier) beelden: dat houdt het artikel binnen de 60s-limiet. Beelden die we
  // niet kunnen ophalen gaan niet mee — dat is geen bevinding over de inhoud.
  const bytes = await Promise.all(images.map(img => fetchImageBytes(img.ref.url)));
  const loadable = images.filter((_, i) => bytes[i]);
  const payload = bytes.filter(Boolean) as ClaudeImage[];
  if (!payload.length) return findings;

  const prompt = (await activePrompt('audit-beeld')).content;
  const vraag = [
    'Beoordeel per beeld of het aantoonbaar bij dit artikel hoort.',
    '',
    `Titel: ${article.title}`,
    article.subregel ? `Subregel: ${article.subregel}` : '',
    article.naam_locatie ? `Locatie: ${article.naam_locatie}${article.adres ? `, ${article.adres}` : ''}` : '',
    article.district ? `Stadsdeel: ${article.district}` : '',
    article.tags?.length ? `Tags: ${article.tags.join(', ')}` : '',
    '',
    'Rol en bestandsnaam per beeld:',
    // Rol én bestandsnaam expliciet meegeven: de rol bepaalt wat een passend
    // beeld is (featured = het onderwerp zelf) en de bestandsnaam is voor het
    // model een extra aanwijzing over de herkomst.
    ...loadable.map((img, i) => `Beeld ${i + 1} — rol: ${img.rol}, bestandsnaam: ${img.bestandsnaam}`),
  ].filter(Boolean).join('\n');

  const judged = await askClaudeJsonWithImages(prompt, vraag, payload, FAST_WRITE_MODEL, AUDIT_IMAGE_SCHEMA, `audit-beeld#${article.id}`);
  const beoordeeld = rowsOf(judged, 'beelden');
  const rows = beoordeeld.rows;
  // Zie de claimcheck: een onleesbaar antwoord mag nooit als "beelden zijn in
  // orde" eindigen. Ook een antwoord met te weinig rijen telt hier: elk beeld
  // dat geen oordeel kreeg wordt hieronder expliciet als ongecontroleerd
  // gemeld, zodat het paneel niet suggereert dat er naar gekeken is.
  if (!beoordeeld.herkend) {
    findings.push({
      kind: 'beeld', verdict: 'twijfel', onderwerp: 'beeldcheck',
      bevinding: `Het model gaf geen leesbaar oordeel over de ${loadable.length} meegestuurde beelden (mogelijk een provider zonder structured outputs). De beeldinhoud is NIET gecontroleerd.`,
      bron: '',
    });
  } else if (rows.length < loadable.length) {
    loadable.slice(rows.length).forEach(img => findings.push({
      kind: 'beeld', verdict: 'twijfel', onderwerp: `${img.rol}: inhoud`,
      bevinding: 'Dit beeld kreeg geen oordeel van het model en is dus niet op inhoud gecontroleerd.',
      bron: img.ref.url,
    }));
  }
  rows.slice(0, loadable.length).forEach((r: any, i: number) => {
    const img = loadable[i];
    findings.push({
      kind: 'beeld',
      verdict: asVerdict(r?.verdict),
      onderwerp: `${asString(r?.rol) || img.rol}: inhoud`,
      bevinding: asString(r?.bevinding) || 'Geen toelichting gegeven.',
      bron: img.ref.url,
    });
  });

  return findings;
}

// ---------------------------------------------------------------------------
// 3. Tekstintegriteit — puur code, geen model, geen bron
// ---------------------------------------------------------------------------

// Zinnen van minstens MIN_SENTENCE_WORDS woorden, genormaliseerd. De split is
// simpel (leesteken + witruimte); een afkorting die per ongeluk splitst maakt
// de zin alleen korter en valt dan buiten de ondergrens — dat is de veilige
// kant.
// De pull-quote staat per ontwerp twee keer in de HTML: één keer als
// <blockquote> boven de tekst en één keer op zijn oorspronkelijke plek in de
// lopende tekst (zie articleHtml.ts — een pull-quote is nadruk, geen
// vervanging). Zonder deze uitzondering meldt de duplicaatcheck dus élk
// standaardartikel als "fout", en dat is precies wat de eerste echte auditrun
// liet zien: 3 van de 3 artikelen. We tellen daarom alleen de lopende tekst.
function stripPullQuotes(html: string): string {
  return String(html || '').replace(/<blockquote\b[\s\S]*?<\/blockquote>/gi, ' ');
}

export function longSentences(html: string): { raw: string; key: string }[] {
  const out: { raw: string; key: string }[] = [];
  for (const part of plainText(stripPullQuotes(html)).split(/(?<=[.!?])\s+/)) {
    const raw = part.trim();
    if (!raw) continue;
    const key = normalize(raw);
    if (key.split(' ').filter(Boolean).length < MIN_SENTENCE_WORDS) continue;
    out.push({ raw, key });
  }
  return out;
}

// Bewust breder dan de voorbeeldzin-check van de generatie, en er volledig van
// losgekoppeld: die kent alleen de zinnen uit de promptlijst. Deze check vangt
// óók toekomstige contaminatie die niet uit de prompt komt — zoals de
// wijnkaart-zin die twee keer in hetzelfde artikel stond.
function textIntegrityCheck(article: Article, board: Article[]): AuditFindingInput[] {
  const findings: AuditFindingInput[] = [];
  const sentences = longSentences(article.contentHtml);
  if (!sentences.length) return findings;

  // (1) Dezelfde zin twee keer in dít artikel.
  const counts = new Map<string, { raw: string; n: number }>();
  for (const s of sentences) {
    const seen = counts.get(s.key);
    if (seen) seen.n += 1;
    else counts.set(s.key, { raw: s.raw, n: 1 });
  }
  for (const { raw, n } of counts.values()) {
    if (n < 2) continue;
    if (findings.length >= MAX_TEXT_FINDINGS_PER_KIND) break;
    findings.push({
      kind: 'tekst', verdict: 'fout', onderwerp: 'dubbele zin in het artikel',
      bevinding: `Deze zin staat ${n} keer in het artikel: "${raw.slice(0, 240)}"`,
      bron: article.link || '',
    });
  }

  // (2) Dezelfde zin in een ánder artikel op het bord. Eén index over alle
  // andere artikelen; bij meerdere treffers noemen we het eerste post-id — dat
  // is genoeg om de contaminatie te vinden.
  const elders = new Map<string, number>();
  for (const other of board) {
    if (other.id === article.id) continue;
    for (const s of longSentences(other.contentHtml)) {
      if (!elders.has(s.key)) elders.set(s.key, other.id);
    }
  }
  let crossFindings = 0;
  for (const s of sentences) {
    const otherId = elders.get(s.key);
    if (!otherId) continue;
    if (crossFindings >= MAX_TEXT_FINDINGS_PER_KIND) break;
    crossFindings += 1;
    // Bewust 'twijfel' en niet 'fout': een gedeelde zin is meestal
    // contaminatie, maar een neutrale servicezin ("Meer informatie en tickets
    // vind je op de website van het festival") haalt de acht-woordengrens ook
    // en is legitiem herbruikbaar. Een dubbele zin binnen één artikel is wél
    // altijd fout — daar bestaat geen onschuldige verklaring voor.
    findings.push({
      kind: 'tekst', verdict: 'twijfel', onderwerp: `zin komt ook voor in artikel ${otherId}`,
      bevinding: `Deze zin staat letterlijk ook in artikel ${otherId}: "${s.raw.slice(0, 240)}"`,
      bron: article.link || '',
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// De audit van één artikel
// ---------------------------------------------------------------------------

// Elke controle is fail-open: klapt er één, dan leveren de andere twee nog
// steeds bevindingen op en komt de fout zélf als `twijfel`-bevinding in het
// rapport. Een mislukte controle mag nooit de hele audit laten falen — dan
// verdwijnt ook het werk dat wél gelukt is.
async function runCheck(
  kind: AuditFindingKind, label: string, fn: () => Promise<AuditFindingInput[]> | AuditFindingInput[],
): Promise<AuditFindingInput[]> {
  try {
    return await fn();
  } catch (e) {
    return [{
      kind, verdict: 'twijfel', onderwerp: `${label} mislukt`,
      bevinding: `Deze controle kon niet worden uitgevoerd: ${errorText(e)}`, bron: '',
    }];
  }
}

/**
 * Draait de drie controles op één artikel en geeft alle bevindingen samen
 * terug. De aanroeper (de route) bepaalt het eindoordeel met worstVerdict en
 * slaat het op; deze functie schrijft niets.
 *
 * Externe calls per artikel: 1 extractie-call, maximaal 3 Serper-calls,
 * 1 vision-call, 1 verdict-call — plus het lezen van de artikelen en de
 * beelden uit WordPress. Dat past binnen de 60s-functielimiet.
 */
export async function auditOneArticle(postId: number): Promise<AuditFindingInput[]> {
  // Eén keer het hele bord lezen: dat levert zowel het te auditen artikel als
  // de andere artikelen die de zin-vergelijking nodig heeft. De feitenbasis is
  // hiermee bewust de artikeltekst uit WordPress — wat de lezer ziet — en niet
  // de research-JSON waarmee het artikel is geschreven.
  const board = await listArticles();
  const article = board.find(a => a.id === postId);
  if (!article) throw new Error(`Artikel ${postId} staat niet op het bord (verwijderd of buiten de meegeladen set).`);

  // Claim- en beeldcheck parallel: samen zijn dat de trage stappen (zoeken en
  // beelden ophalen), en ze raken elkaar niet.
  const [claims, beelden, tekst] = await Promise.all([
    runCheck('claim', 'Claimcheck', () => claimCheck(article)),
    runCheck('beeld', 'Beeldcheck', () => imageCheck(article, board)),
    runCheck('tekst', 'Tekstcontrole', () => textIntegrityCheck(article, board)),
  ]);
  return [...claims, ...beelden, ...tekst];
}
