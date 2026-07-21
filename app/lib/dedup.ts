// WP-dedup-index (fase 2, zie docs/superpowers/specs/2026-07-21-wp-dedup-index-design.md):
// voorkomt dat de artikel-tool onderwerpen genereert die al op amsterdamnow.com
// staan (incl. drafts/pending/future). Methode: lexicale shortlist (Dice-score
// op genormaliseerde titeltokens) + één Haiku-call die beoordeelt of het echt
// hetzelfde specifieke onderwerp/venue/event is — geen embeddings, geen nieuwe
// dependencies.
import { decodeHtmlEntities } from './htmlEntities';
import { askClaudeJson } from './claude';
import { DEDUP_JUDGE_SCHEMA } from './schemas';
import { getAllWpPosts, getWpSyncState, type WpDedupCandidate } from './db';
import { syncWpPosts, type WpSyncResult } from './wpSync';

// Klein en bewust NL+EN: alleen woorden die vrijwel elke titel kunnen bevatten
// zonder onderscheidend te zijn. Een langere lijst risicoert dat inhoudelijke
// woorden (bv. buurtnamen, "nieuwe" in een merknaam) verdwijnen.
const STOPWORDS = new Set([
  'de', 'het', 'een', 'van', 'in', 'op', 'voor', 'met', 'en', 'te', 'aan', 'bij', 'naar',
  'the', 'a', 'an', 'of', 'to', 'for', 'with', 'and', 'on', 'at',
  'best', 'beste', 'top', 'nieuwe', 'new',
]);

// Diacritics strippen via NFD-decompositie (é → e + combining acute accent,
// dat laatste teken valt in de U+0300–U+036F-range en wordt weggehaald).
function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// lowercase → entities decoderen (WP-titels komen met &#038; e.d. binnen,
// zie htmlEntities.ts) → diacritics weg → interpunctie weg → stopwoorden eruit
// → tokenizen. Retourneert de tokens, niet een samengevoegde string: zowel de
// Dice-score als de exacte-match-check (join(' ')) hebben aan de tokens genoeg.
export function normalizeTitle(raw: string): string[] {
  const decoded = decodeHtmlEntities(String(raw || ''));
  const lower = decoded.toLowerCase();
  const plain = stripDiacritics(lower).replace(/[^a-z0-9\s]+/g, ' ');
  return plain.split(/\s+/).filter(Boolean).filter(t => !STOPWORDS.has(t));
}

// Sørensen-Dice op de tokenverzamelingen (niet multiset): 2×|A∩B| / (|A|+|B|).
export function diceCoefficient(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let overlap = 0;
  for (const t of setA) if (setB.has(t)) overlap++;
  return (2 * overlap) / (setA.size + setB.size);
}

export interface LexicalCandidate {
  wp_id: number;
  title: string;
  excerpt: string;
  link: string;
  status: string;
  score: number;
}

// Kandidaten scoren zonder woorden: alles onder deze score telt als "geen
// serieuze overlap" en wordt niet aan Haiku voorgelegd (bespaart calls en
// context, en voorkomt dat een willekeurige titel toch als kandidaat langskomt).
const SCORE_FLOOR = 0.12;
// Boost wanneer de ene genormaliseerde titel de andere als substring bevat
// (bv. "AMAZE Houthavens" in "AMAZE by ID&T: … in de Houthavens") — sterkere
// indicatie dan alleen tokenoverlap.
const SUBSTRING_BOOST = 0.3;
// Kleine boost per gedeeld token tussen de nieuwe titel en de excerpt van de
// kandidaat, gecapt zodat dit de titel-score nooit domineert.
const EXCERPT_HIT_BOOST = 0.02;
const EXCERPT_HIT_BOOST_CAP = 0.1;

// Pure scoringsfunctie (geen DB/netwerk) — apart van lexicalCandidates zodat
// dit met vaste fixtures te unit-testen is.
export function scoreCandidates(title: string, posts: WpDedupCandidate[], limit = 10): LexicalCandidate[] {
  const queryTokens = normalizeTitle(title);
  const queryKey = queryTokens.join(' ');

  const scored = posts.map(p => {
    const postTokens = normalizeTitle(p.title);
    const postKey = postTokens.join(' ');
    let score = diceCoefficient(queryTokens, postTokens);

    if (queryKey && postKey && (queryKey.includes(postKey) || postKey.includes(queryKey))) {
      score += SUBSTRING_BOOST;
    }

    if (p.excerpt) {
      const excerptTokens = new Set(normalizeTitle(p.excerpt));
      const hits = queryTokens.filter(t => excerptTokens.has(t)).length;
      if (hits > 0) score += Math.min(EXCERPT_HIT_BOOST_CAP, hits * EXCERPT_HIT_BOOST);
    }

    return { wp_id: p.id, title: p.title, excerpt: p.excerpt, link: p.link, status: p.status, score };
  });

  return scored
    .filter(c => c.score >= SCORE_FLOOR)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function lexicalCandidates(title: string, limit = 10): Promise<LexicalCandidate[]> {
  const posts = await getAllWpPosts();
  return scoreCandidates(title, posts, limit);
}

const DEDUP_MODEL = 'claude-haiku-4-5-20251001';
// Ruim genoeg voor {duplicate, wp_id, reason} met een korte Nederlandse
// redengeving; de call heeft geen research/lang antwoord nodig.
const DEDUP_MAX_TOKENS = 500;

const DEDUP_SYSTEM = `Je beoordeelt voor de redactie van amsterdamnow.com of een NIEUW artikel-onderwerp een duplicaat is van een AL BESTAAND WordPress-artikel (gepubliceerd, concept, wachtend op review of gepland).

Cruciaal: "duplicaat" betekent hetzelfde SPECIFIEKE onderwerp — dezelfde zaak, locatie, venue of gebeurtenis. Niet slechts hetzelfde THEMA of dezelfde categorie.

Voorbeelden:
- Een nieuw lijstartikel "de beste restaurants" is GEEN duplicaat van een ander lijstartikel over restaurants, ook al staan er dezelfde soort tenten in.
- Een artikel over een specifieke zaak, locatie of gebeurtenis IS een duplicaat als er al een artikel over precies diezelfde zaak/locatie/gebeurtenis bestaat — ook als de titel anders geformuleerd is (bv. andere woordvolgorde, afkorting, of net iets andere naam).
- Twee artikelen over hetzelfde evenement in verschillende jaren zijn GEEN duplicaten van elkaar, tenzij de nieuwe titel evident over dezelfde editie/periode gaat als de bestaande.

Beoordeel uitsluitend op basis van de aangeleverde titels/excerpts, verzin geen extra kennis. Twijfel je serieus, kies dan "duplicate": false.

Antwoord uitsluitend met geldig JSON: {"duplicate": boolean, "wp_id": getal of null, "reason": "korte Nederlandse reden"}.
Is er geen duidelijk duplicaat, geef dan "duplicate": false en "wp_id": null.`;

export interface JudgeResult {
  duplicate: boolean;
  wp_id: number | null;
  reason: string;
}

// Eén Haiku-call die de shortlist beoordeelt. Faalt (netwerk/API-fout) de
// aanroeper mag dit laten gooien — checkTopicAgainstWp vangt het fail-open af.
export async function judgeDuplicate(newTitle: string, candidates: LexicalCandidate[]): Promise<JudgeResult> {
  const list = candidates
    .map(c => `- wp_id ${c.wp_id} (status: ${c.status}): "${c.title}"${c.excerpt ? `\n  Excerpt: ${c.excerpt.slice(0, 220)}` : ''}`)
    .join('\n');
  const prompt = `Nieuw onderwerp: "${newTitle}"\n\nMogelijk gerelateerde, al bestaande artikelen op amsterdamnow.com:\n${list}\n\nIs het nieuwe onderwerp een duplicaat van één van deze bestaande artikelen?`;

  const result = await askClaudeJson(DEDUP_SYSTEM, prompt, false, DEDUP_MODEL, DEDUP_MAX_TOKENS, DEDUP_JUDGE_SCHEMA);

  // Defensief parsen: het schema garandeert de vorm, maar niet dat wp_id ook
  // echt bij een van de meegegeven kandidaten hoort — dat toetst de aanroeper.
  const duplicate = result.duplicate === true;
  const wpIdRaw = result.wp_id;
  const wp_id = duplicate && typeof wpIdRaw === 'number' && Number.isFinite(wpIdRaw) ? wpIdRaw : null;
  const reason = typeof result.reason === 'string' && result.reason.trim() ? result.reason.trim() : '';
  return { duplicate: duplicate && wp_id != null, wp_id, reason };
}

export interface DedupExisting {
  wp_id: number;
  title: string;
  link: string;
  status: string;
}

export interface DedupResult {
  verdict: 'duplicate' | 'ok' | 'unknown';
  existing?: DedupExisting;
  reason?: string;
}

// Sync wordt als verouderd beschouwd na 6 uur — zie spec §2 (staleness-guard).
const STALE_MS = 6 * 60 * 60 * 1000;

// In-flight-memoization voor de staleness-getriggerde sync: zonder dit
// triggert elke gelijktijdige checkTopicAgainstWp-aanroep (bv. een bulk-
// submit met meerdere titels, zie POST /api/topics) zijn eigen syncWpPosts()
// zodra de index verouderd blijkt — dezelfde WP-fetch en dezelfde upserts,
// meerdere keren parallel. Een module-scope variabele volstaat hier: binnen
// één serverless-invocation/runtime delen alle gelijktijdige requests hem.
let staleSyncInFlight: Promise<WpSyncResult> | null = null;

function triggerStalenessSync(): Promise<WpSyncResult> {
  if (!staleSyncInFlight) {
    staleSyncInFlight = syncWpPosts({}).finally(() => { staleSyncInFlight = null; });
  }
  return staleSyncInFlight;
}

function toExisting(c: LexicalCandidate): DedupExisting {
  return { wp_id: c.wp_id, title: c.title, link: c.link, status: c.status };
}

// Hoofdfunctie voor de hooks (POST /api/topics en vlak vóór createDraft).
// Fail-open: WP onbereikbaar of de Haiku-call faalt → 'unknown' (topic mag
// door), maar een exacte genormaliseerde-titelmatch blokkeert altijd, ook dan.
export async function checkTopicAgainstWp(title: string): Promise<DedupResult> {
  try {
    const state = await getWpSyncState();
    const stale = state.count === 0 || !state.lastSyncedAt || (Date.now() - new Date(state.lastSyncedAt).getTime()) > STALE_MS;
    if (stale) {
      try {
        await triggerStalenessSync();
      } catch (err) {
        console.warn('[dedup] staleness-sync mislukt, ga door met beschikbare data', err);
      }
    }
  } catch (err) {
    console.warn('[dedup] kon syncstatus niet ophalen, ga door zonder sync', err);
  }

  const candidates = await lexicalCandidates(title, 10);

  const queryKey = normalizeTitle(title).join(' ');
  if (queryKey) {
    const exact = candidates.find(c => normalizeTitle(c.title).join(' ') === queryKey);
    if (exact) {
      return { verdict: 'duplicate', existing: toExisting(exact), reason: 'Exacte titelmatch (genormaliseerd).' };
    }
  }

  if (!candidates.length) {
    // Geen kandidaten: ofwel de index is (nog) leeg — dan weten we het niet
    // zeker (fail-open) — ofwel er is gewoon niets vergelijkbaars, dan is dit
    // gerust een nieuw onderwerp.
    const state = await getWpSyncState().catch(() => null);
    if (!state || state.count === 0) {
      console.warn('[dedup] wp_posts index leeg, kan niet checken');
      return { verdict: 'unknown' };
    }
    return { verdict: 'ok' };
  }

  try {
    const judged = await judgeDuplicate(title, candidates);
    if (judged.duplicate && judged.wp_id != null) {
      const match = candidates.find(c => c.wp_id === judged.wp_id);
      if (match) {
        return { verdict: 'duplicate', existing: toExisting(match), reason: judged.reason };
      }
    }
    return { verdict: 'ok' };
  } catch (err) {
    console.warn('[dedup] Haiku-beoordeling mislukt, topic mag door (fail-open)', err);
    return { verdict: 'unknown' };
  }
}
