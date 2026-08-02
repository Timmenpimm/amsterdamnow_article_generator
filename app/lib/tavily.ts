import { competitorInHost } from './competitors';
import { amsterdamToday } from './eventDate';
import { getTavilyApiKey } from './tavilyConfig';

type TavilyResult = { title?: string; url?: string; content?: string; raw_content?: string };
type TavilyResponse = { results?: TavilyResult[]; detail?: string | { error?: string }; message?: string };

export type ResearchSource = { title: string; url: string; content: string };

// Elke fase-stap moet binnen de 60s serverless-limiet blijven. Zonder timeout
// kan één hangende Tavily-call de hele tik over die grens duwen, waarna de
// fail-open-catch in writer.ts niet eens meer wordt bereikt en het topic een
// lease-cyclus verliest. 15s is ruim voor een advanced search.
const TAVILY_TIMEOUT_MS = 15_000;

// HTTP-fout van de Tavily-API. Draagt de status mee zodat de aanroeper
// infrastructuurfouten (rate limit, credits op, storing) kan onderscheiden van
// inhoudelijke fouten — patroon: ProviderHttpError in lib/claude.ts.
export class TavilyHttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'TavilyHttpError';
    this.status = status;
  }
}

// True als de fout een Tavily-infrastructuurprobleem is (geen inhoudelijk
// oordeel over het onderwerp): 429 (rate limit), 432/433 (plan-/creditlimiet)
// of 5xx (storing). De foutclassificatie in de queue gebruikt dit om zulke
// topics niet onterecht op "mislukt" te zetten.
export function isTavilyInfraError(err: unknown): boolean {
  const status = err instanceof TavilyHttpError ? err.status : 0;
  return status === 429 || status === 432 || status === 433 || status >= 500;
}

// Resultaat van researchWithTavily: de bronnen én de gedetecteerde officiële
// origin (site-root) van het onderwerp, of null als die niet te bepalen was.
// De caller (writer.ts) gebruikt officialUrl om research.website te
// overschrijven met de homepage — mits die origin aantoonbaar bij het
// onderwerp hoort (zie originHoortBijOnderwerp in writer.ts).
export type ResearchResult = { sources: ResearchSource[]; officialUrl: string | null };

// Hosts die vrijwel nooit de officiële site van het onderwerp zijn maar wél
// hoog scoren in een zoekopdracht: agenda's, ticketverkoop, social, reviews.
// Een match hierop diskwalificeert een URL als "officiële site".
const AGGREGATOR_HOSTS = [
  'iamsterdam', 'ticketmaster', 'eventbrite', 'songkick', 'facebook', 'instagram',
  'tripadvisor', 'google', 'youtube', 'wikipedia', 'timeout', 'reddit', 'tiktok',
  'spotify', 'bandsintown', 'residentadvisor', 'ra.co', 'paylogic', 'eventix',
  'ticketswap', 'linkedin', 'x.com', 'twitter', 'booking', 'yelp',
  // Festival-verzamelsites: tonen de line-up van de láátst bekende (vorige)
  // editie. Draft 87452 (NO ART) kreeg zo musicfestivalwizard.com als
  // "officiële site" en 25 verouderde acts als line-up.
  'musicfestivalwizard', 'partyflock', 'festivalinfo', 'festileaks',
];

// Is de wachtrijtitel zelf een URL? Redacteuren (en de scanner, vóór 21-07)
// plakken soms een kale link als onderwerp. Als tekst behandeld breekt zo'n
// titel twee dingen tegelijk: de Tavily-query wordt letterlijk
// "https://… Amsterdam", en topicTokens/looksOfficial matchen nooit op het
// aaneengeschreven domein — waarna een verzamelsite tot "officiële site" wordt
// verklaard (draft 87452). De geplakte URL ís de officiële site; gebruik hem zo.
export function topicAsUrl(topic: string): URL | null {
  const t = topic.trim();
  if (!/^https?:\/\/\S+$/i.test(t)) return null;
  try {
    return new URL(t);
  } catch {
    return null;
  }
}

// Domeinlabel als zoeknaam: "https://www.noartfestival.com/" -> "noartfestival".
export function hostLabel(url: URL): string {
  const parts = url.hostname.replace(/^www\./, '').toLowerCase().split('.');
  return parts.length >= 2 ? parts[parts.length - 2] : parts[0];
}

// Betekenisvolle tokens uit de onderwerptitel (≥4 tekens), voor de domein-match.
// "amsterdam" wordt uitgesloten: het staat in bijna elke titel (en in de query)
// en zou stads-/portaaldomeinen (amsterdam.nl e.d.) vals als "officieel" matchen.
const TOKEN_STOPWORDS = new Set(['amsterdam']);
function topicTokens(topic: string): string[] {
  // Gededupliceerd: "De Boule De Boule" gaf ["boule","boule"], waardoor
  // looksOfficial's tweetokens-eis door één herhaald token werd gehaald.
  return [...new Set(
    topic.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter(w => w.length >= 4 && !TOKEN_STOPWORDS.has(w))
  )];
}

// Is deze host een aggregator (agenda/tickets/social/reviews)? Dan nooit "de
// officiële site". Een onbereikbare/ongeldige URL behandelen we defensief als
// aggregator, zodat 'ie de homepage-detectie niet vervuilt.
export function isAggregatorHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return AGGREGATOR_HOSTS.some(a => host.includes(a));
  } catch {
    return true;
  }
}

// Is dit waarschijnlijk de eigen site van het onderwerp? Geen aggregator, en het
// domeinlabel (bv. "paradiso" in paradiso.nl) bevat de naam van het onderwerp.
// STRIKT en éénrichting (alleen label.includes(needle), nooit needle.includes
// (label)): het domeinlabel moet óf de samengetrokken volledige onderwerpnaam
// bevatten (alle tokens aaneen zonder spaties, bv. topic "ClubWST" -> "clubwst",
// "Club West" -> "clubwest"), óf minstens twee losse tokens van >=4 tekens. Zo
// matcht een losse token "club" niet langer met domein "clubwest".
function looksOfficial(url: string, tokens: string[]): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    if (AGGREGATOR_HOSTS.some(a => host.includes(a))) return false;
    const parts = host.split('.');
    const label = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    const full = tokens.join('');
    if (full.length >= 4 && label.includes(full)) return true;
    return tokens.filter(t => t.length >= 4 && label.includes(t)).length >= 2;
  } catch {
    return false;
  }
}

// Hoort deze URL aantoonbaar bij deze naam/dit onderwerp? Zelfde strikte
// domeinlabel-match als looksOfficial, maar dan als losse poort voor callers
// (writer.ts, backfill-route) die willen weten of een gedetecteerde origin
// naam-gerelateerd is voordat ze 'm als website in de research schrijven.
export function hostMatchesTopic(url: string, topic: string): boolean {
  return looksOfficial(url, topicTokens(topic));
}

// Verwantschapspoort voor de laatste kandidaat-trap: een zoekresultaat komt
// alleen in aanmerking als de PAGINATITEL aantoonbaar over het onderwerp gaat
// (token-overlap met de onderwerpnaam). Dit verving de blinde fallback "eerste
// niet-aggregator-resultaat", die vijf productie-topics evident verkeerde
// websites gaf (een Storyblok-CDN-URL, blogs en gidsen van derden). Geen match
// betekent: geen officialUrl — dat is legitiem, de research-prompt staat een
// lege website toe.
function titleMatchesTopic(result: TavilyResult, tokens: string[]): boolean {
  if (!result.url || isAggregatorHost(result.url)) return false;
  if (!tokens.length) return false;
  const titel = (result.title || '').toLowerCase();
  const matched = tokens.filter(t => titel.includes(t)).length;
  return matched >= Math.min(2, tokens.length);
}

// opts stuurt de aanvullende researchronde (writer.ts stepResearchAanvullend):
// die zoekt gericht op wat de eerste ronde niet vond ("<naam> <stad>
// openingstijden") in plaats van breed op het onderwerp, met een kleinere
// resultatenset omdat er dan al bronnen liggen. Zonder opts is het gedrag
// exact als voorheen — de eerste ronde mag hier niets van merken.
// `forcedOfficialUrl`: door de redactie opgegeven officiële website
// (topic.website, zie writer.ts stepResearch). Anders dan de detectie-ladder
// hieronder is dit géén gok — de URL wordt zonder matchcheck als kandidaat
// gebruikt, en een mislukte extractie is dan geen stille terugval maar een
// fout die de aanroeper moet zien (zie de catch bij `chosen` hieronder).
export async function researchWithTavily(
  topic: string,
  opts?: { query?: string; maxResults?: number; detectOfficial?: boolean; forcedOfficialUrl?: string },
): Promise<ResearchResult> {
  const apiKey = await getTavilyApiKey();
  if (!apiKey) throw new Error('Tavily is niet geconfigureerd. Voeg TAVILY_API_KEY toe aan de omgevingsvariabelen.');

  // Een URL als onderwerp zoekt op het domeinlabel, niet op de letterlijke
  // link: "https://www.noartfestival.com/ Amsterdam" levert andere (slechtere)
  // treffers dan "noartfestival Amsterdam".
  const topicUrl = topicAsUrl(topic);
  const zoeknaam = topicUrl ? hostLabel(topicUrl) : topic;
  // Het jaartal altijd in de query: Tavily kent geen instructieprompt, dus
  // actualiteit stuur je via de zoekterm zelf. Zonder jaartal ranken bij
  // terugkerende events de pagina's van de vórige editie het hoogst — zo kreeg
  // draft 87452 de line-up van vorig jaar. Alleen het jaartal, geen harde
  // publicatiedatum-filter: officiële homepages van vaste zaken zijn vaak
  // oudere pagina's en moeten blijven meekomen.
  const jaar = amsterdamToday().slice(0, 4);

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    signal: AbortSignal.timeout(TAVILY_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      query: `${opts?.query || `${zoeknaam} Amsterdam`} ${jaar}`,
      topic: 'general',
      search_depth: 'advanced',
      max_results: opts?.maxResults ?? 5,
      include_raw_content: 'markdown',
    }),
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({})) as TavilyResponse;
  if (!res.ok) {
    // Tavily geeft detail soms als string, soms als object {"error": "..."}.
    // Die laatste werd voorheen als "[object Object]" gelogd.
    const detail = typeof data.detail === 'string' ? data.detail : data.detail?.error;
    throw new TavilyHttpError(`Tavily ${res.status}: ${detail || data.message || 'onderzoek mislukt'}`, res.status);
  }

  // Concurrenten eruit vóórdat er iets met de resultaten gebeurt. Zij zijn de
  // reden dat artikel 87365 bestond: hun listicle was de beste treffer op een
  // van hun eigen koppen, waarna de homepage-detectie hieronder hun site tot
  // "officiële site van het onderwerp" verklaarde. Weggooien op dit punt dekt
  // in één keer de bron, de entiteit, de website én de feiten die de schrijver
  // te zien krijgt.
  const alleResults = data.results || [];
  const results = alleResults.filter(r => !competitorInHost(r.url));
  const geweerd = alleResults.length - results.length;
  const searchSources = results
    .filter(r => r.url && (r.raw_content || r.content))
    .map(r => ({ title: r.title || r.url!, url: r.url!, content: (r.raw_content || r.content || '').slice(0, 12_000) }));

  // Homepage van het onderwerp vooraan: de eigen site heeft doorgaans de
  // betrouwbaarste feiten (adres, openingstijden, event-datum) en canonieke
  // spelling van de naam/website. We detecteren de officiële site onder de
  // resultaten, extracten de hoofdpagina (site-root) en zetten 'm als bron [1].
  // Eén extra call (bounded i.v.m. de 60s-limiet), best-effort: mislukt het,
  // dan gewoon de zoekresultaten. Vervangt het oude n8n-gedrag dat de tool
  // kwijt was — zie writer.ts stepResearch.
  // De officiële homepage moet bekeken worden voor basale info (adres,
  // openingstijden, canonieke naam) — maar alleen als een kandidaat aantoonbaar
  // bij het onderwerp hoort. Ladder: geplakte URL → resultaat waarvan het
  // domeinlabel de onderwerpnaam draagt (looksOfficial) → resultaat waarvan de
  // paginatitel over het onderwerp gaat (titleMatchesTopic). Matcht niets, dan
  // is officialUrl null — legitiem, de research-prompt staat een lege website
  // toe. De oude blinde fallback ("eerste niet-aggregator-resultaat") maakte
  // hier willekeurige derden tot officiële site en is geschrapt.
  // Bij een eigen query (aanvullende ronde) slaan we dit standaard over: de
  // homepage is in ronde 1 al gecrawld en staat al bij de bewaarde bronnen.
  // officialUrl blijft dan null; alleen de entiteits-herkansing (writer.ts)
  // zet detectOfficial aan om mét een eigen query tóch te detecteren.
  // Is het onderwerp zelf een URL, dan is DÁT de officiële site — geen
  // detectie nodig (mits geen aggregator of concurrent, dan gedraagt de
  // pipeline zich als voorheen en zoekt de detectie de echte site).
  const tokens = topicTokens(zoeknaam);
  const resultUrls = results.map(r => r.url).filter((u): u is string => !!u);
  const geplakteUrl = topicUrl && !isAggregatorHost(topicUrl.href) && !competitorInHost(topicUrl.href)
    ? topicUrl.href : null;
  // Een door de redactie opgegeven website wint van de hele detectie-ladder:
  // die is geverifieerd bij intake (topicValidation.ts) en hoeft niet nog eens
  // te matchen op domeinlabel of paginatitel.
  const chosen = opts?.forcedOfficialUrl
    ? opts.forcedOfficialUrl
    : opts?.query && !opts.detectOfficial
      ? null
      : geplakteUrl
        ?? resultUrls.find(u => looksOfficial(u, tokens))
        ?? results.find(r => titleMatchesTopic(r, tokens))?.url
        ?? null;
  let officialUrl: string | null = null;
  let homepage: ResearchSource | null = null;
  if (chosen) {
    try {
      const origin = new URL(chosen).origin;
      const text = (await extractPageText(origin)).trim();
      // officialUrl pas ná een geslaagde, niet-lege extract: een onleesbare of
      // lege pagina mag niet alsnog de canonieke website van het topic worden.
      if (!text) throw new Error('lege pagina');
      officialUrl = origin;
      homepage = { title: `Officiële site — ${new URL(origin).hostname.replace(/^www\./, '')}`, url: origin, content: text.slice(0, 12_000) };
    } catch {
      if (opts?.forcedOfficialUrl) {
        // Geen best-effort-terugval: de redactie gaf deze site expliciet op,
        // dus onbereikbaar/onleesbaar is een echte fout (zie stepResearch).
        throw new Error(
          `De door de redactie opgegeven website (${opts.forcedOfficialUrl}) is niet bereikbaar of geeft geen leesbare content. Controleer de URL of verwijder 'm van het onderwerp.`
        );
      }
      /* best-effort: val terug op de zoekresultaten */
    }
  }

  // Dedupliceer op URL (zonder trailing slash) zodat de site-root niet dubbel
  // staat als 'ie ook een zoekresultaat was; homepage blijft vooraan.
  const seen = new Set<string>();
  const sources: ResearchSource[] = [];
  for (const s of [homepage, ...searchSources]) {
    if (!s) continue;
    const key = s.url.replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push(s);
  }
  if (!sources.length) {
    // Bleef er niets over omdat álles van concurrenten kwam, dan is dat de
    // echte reden — en die hoort in de foutmelding, anders gaat de redactie
    // zoeken naar een Tavily-storing die er niet is.
    if (geweerd) {
      throw new Error(
        'Alle gevonden bronnen komen van concurrerende stadsgidsen. Dit onderwerp bestaat kennelijk alleen in hún artikel; schrijf het niet over maar kies de onderliggende zaak of het event als onderwerp.'
      );
    }
    throw new Error('Tavily vond geen bruikbare bronnen voor dit onderwerp.');
  }
  return { sources: sources.slice(0, 6), officialUrl };
}

// Leest de tekst van één specifieke pagina uit voor de bronscanner. Eerst via
// Tavily /extract (rendert JS, zoals veel agendapagina's nodig hebben); zonder
// key of bij een lege/mislukte extract valt het terug op een platte fetch.
export async function extractPageText(url: string): Promise<string> {
  const apiKey = await getTavilyApiKey();
  if (apiKey) {
    try {
      const res = await fetch('https://api.tavily.com/extract', {
        method: 'POST',
        signal: AbortSignal.timeout(TAVILY_TIMEOUT_MS),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ urls: [url], extract_depth: 'basic' }),
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({})) as { results?: { raw_content?: string }[] };
      const text = (data.results?.[0]?.raw_content || '').trim();
      if (res.ok && text) return text.slice(0, 16_000);
    } catch { /* val door naar platte fetch */ }
  }
  return plainFetchText(url);
}

async function plainFetchText(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(TAVILY_TIMEOUT_MS),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AmsterdamNOW-bronscanner)' },
      cache: 'no-store',
    });
  } catch {
    throw new Error('Bron niet bereikbaar — de pagina gaf geen antwoord.');
  }
  if (!res.ok) throw new Error(`Bron niet bereikbaar — de pagina gaf HTTP ${res.status}.`);
  const text = stripHtml(await res.text());
  if (!text) throw new Error('De pagina gaf geen leesbare inhoud.');
  return text.slice(0, 16_000);
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
