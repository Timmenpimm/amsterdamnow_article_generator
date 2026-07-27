import { activeConstraints, activePrompt, completeTopic, failTopicClassified, saveTopicProgress } from './db';
import { askClaudeJson, FAST_WRITE_MODEL, TITLE_MODEL } from './claude';
import { RESEARCH_SCHEMA, SEO_SCHEMA, ENTITY_VERIFY_SCHEMA, QUOTE_REWRITE_SCHEMA, INVALSHOEK_SCHEMA, CURATOR_SCHEMA } from './schemas';
import { createDraft, singleTag, taxonomyChoices } from './wp';
import { checkTopicAgainstWp } from './dedup';
import { researchWithTavily, hostMatchesTopic, topicAsUrl, type ResearchSource } from './tavily';
// GeneratedArticle expliciet als type importeren: de testrunner draait op
// --experimental-strip-types en die kan een type niet als waarde-import
// oplossen ("does not provide an export named GeneratedArticle").
import { validateArticle, checkTitle, quoteSourceAllowed, standaardQuoteSourceBlacklist, extractPromptExamples, findPromptExampleLeak, ArticleValidationError, type GeneratedArticle } from './validation';
import { DEFAULT_STANDAARD_CONSTRAINTS, parseStandaardState, type Article, type StandaardConstraints, type StandaardPhase, type StandaardState, type Topic, type WordRange } from './types';
import { formatStandardArticleHtml } from './articleHtml';
import { decodeHtmlEntities } from './htmlEntities';
import { amsterdamToday, eventEndReference, isPastEvent } from './eventDate';
import { detectProfiel, profielFocus, profielQueries } from './researchProfiles';
import { filterOpRelevantie, kernwoorden, onderwerpTokens } from './relevance';
import { competitorInTekst } from './competitors';

// Ruime marge boven een realistisch artikel (~450 woorden content + korte
// titel/subregel/intro/quote-velden ≈ 800-1000 tokens als JSON), maar veel
// krapper dan de standaard 6000: op productie liep de write-call een keer
// tot 58s door voordat 'ie tegen de oude limiet van 6000 aanliep (afgekapt,
// stop_reason=max_tokens) — gevaarlijk dicht bij de 60s-functielimiet. Bij
// 2000 (gemeten: ~25s tot afkapping) sloeg de cap voor sommige onderwerpen
// een ander legitiem iets langer antwoord af; 3000 geeft daar ruimte voor
// terwijl een op hol geslagen generatie nog altijd ruim (~35-40s, gemeten
// lineair) onder de 60s-limiet stopt in plaats van er tegenaan te lopen.
// De schrijfcall denkt bewust NIET (zie lib/claude.ts): op productie getest
// (2026-07-20) kapte adaptive thinking + structured outputs élk artikel af,
// zelfs op 4500 tokens. Zonder thinking is een artikel ~1100 output-tokens;
// 4500 geeft ruim marge voor lange legitieme artikelen terwijl een op hol
// geslagen generatie (~50s bij ~90 tokens/s) nog net binnen de
// 60s-functielimiet stopt. De max_tokens-throw in claude.ts is het vangnet.
const WRITE_MAX_TOKENS = 4500;
// Maximaal aantal herschrijfrondes na de eerste schrijfpoging.
const MAX_SCHRIJF_HERKANSINGEN = 2;
// Hoeveel bronnen en hoeveel tekst per bron er mee mogen naar de schrijffase.
// De schrijver krijgt sinds de anti-hallucinatie-fix niet alleen de
// research-JSON maar ook de brontekst, zodat elk detail herleidbaar is. Dat
// moet wél binnen de tokenruimte van de schrijfcall passen: 4 × 4000 tekens is
// ruwweg 4000 tokens invoer, naast prompt, regels en research-JSON. Ruimer
// maakt de call trager en riskeert de 60s-functielimiet; krapper haalt juist
// de concrete details weg die verzinsels moeten voorkomen.
const MAX_WRITE_SOURCES = 4;
const WRITE_SOURCE_CHARS = 4000;

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Claude liet ${label} leeg.`);
  return value.trim();
}

// Als string(), maar leeg is toegestaan (nooit gooien). Voor velden die
// legitiem leeg mogen zijn als er geen betrouwbaar gegeven is (adres, website).
function optionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every(v => typeof v === 'string' && v.trim())) throw new Error(`Claude gaf geen geldige ${label} terug.`);
  return value.map(v => v.trim());
}

// Zelfde check als strings(), maar wijst ook een lege array af. Nodig voor
// categorie: [].every(...) is in JS altijd true (vacuous truth), dus strings()
// liet een lege categorie-lijst ongemerkt door tot in de WordPress-draft
// (post zonder categorie). Categorie is — anders dan tags, die legitiem leeg
// mogen zijn — altijd verplicht.
function nonEmptyStrings(value: unknown, label: string): string[] {
  const result = strings(value, label);
  if (!result.length) throw new Error(`Claude gaf geen ${label} terug.`);
  return result;
}

// Event-datum uit de research: optioneel (niet elk onderwerp is een event), dus
// nooit gooien — een leeg/ongeldig veld levert '' op, waarna createDraft het
// ACF-datumveld gewoon overslaat. Accepteert alleen strikt JJJJ-MM-DD.
function optionalIsoDate(value: unknown): string {
  const s = typeof value === 'string' ? value.trim() : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

// De actieve Criteria als expliciete instructieregels bij de schrijfopdracht.
// Woordaantallen mikken op het midden van de bandbreedte: het model telt niet
// exact, dus wie op de ondergrens mikt valt er regelmatig onder — precies de
// fout die topics op "mislukt" zette.
// Bij sparse (dunne research, ook na de aanvullende ronde) geldt het kortere
// sparseContentWords-bereik. Het harde minimum van 400 woorden was de motor
// achter de verzinsels: wie te weinig feiten heeft en tóch die lengte moet
// halen, vult het verschil met fictie. Dan liever een kort, kloppend artikel.
function describeStandaardConstraints(c: StandaardConstraints, naam: string, opts?: { sparse?: boolean }): string {
  const mid = (r: WordRange) => Math.round((r.min + r.max) / 2);
  const contentWords = opts?.sparse ? c.sparseContentWords : c.contentWords;
  // De titelcheck (validateArticle) eist de naam létterlijk; zeg het model dus
  // precies welke tekenreeks er in de titel moet, niet alleen "de naam van het
  // onderwerp" — daar maakte het model zelf een kortere variant van (bv.
  // "AMAZE" waar naam_locatie "AMAZE by ID&T" is), die de check dan afkeurt.
  // De tekenlimiet voor de titel hoort hier expliciet bij het woordenbereik:
  // hij stond wél in validateArticle (titleMaxChars) maar niet in deze regels,
  // terwijl de schrijfprompt voor lengtes juist naar deze REGELS verwijst. En
  // de twee eisen schuren: 12 Nederlandse woorden is al gauw 78-85 tekens,
  // rekenkundig strijdig met 70. Daarom als bindend paar geformuleerd, met een
  // woord-bovengrens één lager dan het maximum en een expliciet mikpunt —
  // zonder dat mikpunt bleef het model op de bovengrens schrijven en daarmee
  // structureel door de tekenlimiet heen.
  const titelMaxWoorden = Math.max(c.titleWords.min, c.titleWords.max - 1);
  const titelMik = Math.floor((c.titleWords.min + titelMaxWoorden) / 2);
  const lines = [
    `- Titel: ${c.titleWords.min}-${titelMaxWoorden} woorden en maximaal ${c.titleMaxChars} tekens (spaties en leestekens tellen mee); mik op ~${titelMik}-${Math.min(titelMaxWoorden, titelMik + 1)} woorden, want ${c.titleWords.max} woorden past zelden binnen ${c.titleMaxChars} tekens${c.titleMustContainTopic ? `. Met daarin letterlijk: "${naam}"` : ''}.`,
    `- Subregel: ${c.subregelWords.min}-${c.subregelWords.max} woorden.`,
    `- Introductie: ${c.introWords.min}-${c.introWords.max} woorden; mik op ~${mid(c.introWords)}.`,
    `- Artikeltekst: ${contentWords.min}-${contentWords.max} woorden; mik op ~${mid(contentWords)}, verdeeld over minimaal ${c.minParagraphs} alinea's.${opts?.sparse ? ' Er is weinig harde research: blijf aan de ONDERKANT van dit bereik en rek de tekst niet op.' : ' Schrijf liever iets te ruim dan te krap.'}`,
    `- Quote: ${c.quoteWords.min}-${c.quoteWords.max} woorden${c.quoteMustBeVerbatimInContent ? ', en woord voor woord letterlijk terug te vinden in de artikeltekst' : ''}.`,
  ];
  if (c.noDashInText) lines.push('- Geen em dash (—) of en dash (–), nergens.');
  if (c.noAmsterdamRepeatInTitleSubregelIntro) lines.push('- Het woord "Amsterdam" mag níet in titel, subregel of introductie staan.');
  return lines.join('\n');
}

// Oudere constraint-versies in de database missen de anti-hallucinatie-velden
// (minFactScore, sparseContentWords, quoteSourceBlacklist, quotePreferSource).
// db.ts merget de actieve versie al met de codedefaults, maar die merge zit
// buiten dit bestand: één gemiste default zou hier een TypeError geven
// (constraints.sparseContentWords.min) en daarmee een topic laten crashen dat
// al middenin de pipeline zit. Deze regel is de goedkope garantie dat dat niet
// kan — een oude actieve versie mag de pipeline nooit breken.
async function standaardConstraints(): Promise<StandaardConstraints> {
  return { ...DEFAULT_STANDAARD_CONSTRAINTS, ...(await activeConstraints('standaard')) };
}

// Sufficiëntie-score van de research: hoeveel concrete haakjes heeft de
// schrijver om een artikel op te hangen? De audit liet zien dat verzinsels
// vrijwel altijd ontstaan bij research die er compleet uitziet (alle velden
// bestaan) maar leeg is (bijna alle velden leeg of eenregelig). Deze telling
// maakt dat verschil meetbaar:
//
// - de vijf feitenlijsten (key_people, distinctive_features,
//   product_or_menu_highlights, company_facts, space_and_building) tellen elk
//   1 punt als ze gevuld zijn en 2 punten vanaf 3 items — drie of meer items
//   is het verschil tussen "er is íets" en "hier kan een alinea van";
// - de vier kernvelden (adres, website, concept_description, samenvatting)
//   tellen elk 1 punt als ze niet leeg zijn.
//
// Maximum is dus 14; de drempel staat in constraints.minFactScore (default 5).
export function researchFactScore(research: Record<string, unknown> | null | undefined): number {
  const r = research ?? {};
  const lists = ['key_people', 'distinctive_features', 'product_or_menu_highlights', 'company_facts', 'space_and_building'];
  const singles = ['adres', 'website', 'concept_description', 'samenvatting'];
  let score = 0;
  for (const key of lists) {
    const value = Array.isArray(r[key]) ? (r[key] as unknown[]).filter(v => typeof v === 'string' && v.trim()) : [];
    if (value.length >= 3) score += 2;
    else if (value.length >= 1) score += 1;
  }
  for (const key of singles) {
    if (optionalString(r[key])) score += 1;
  }
  return score;
}

// Bronnen klaarmaken voor bewaren in de topic-state: hooguit MAX_WRITE_SOURCES
// stuks, elk afgekapt op WRITE_SOURCE_CHARS. De state gaat als JSON de database
// in en komt bij élke fase-tik weer mee, dus ongelimiteerd bewaren zou zowel de
// schrijfcall als de wachtrij-tikken onnodig zwaar maken.
function trimSources(sources: ResearchSource[]): { title: string; url: string; content: string }[] {
  return sources.slice(0, MAX_WRITE_SOURCES).map(src => ({
    title: src.title,
    url: src.url,
    content: (src.content || '').slice(0, WRITE_SOURCE_CHARS),
  }));
}

// Is deze bron-URL dezelfde site als de officiële homepage van het onderwerp?
// Vergelijkt op hostname (zonder www.), niet op het volledige pad — de "quote"
// kan van een andere pagina van dezelfde site komen dan de gecrawlde homepage.
function sameOfficialHost(bronUrl: string, officialUrl: string | null | undefined): boolean {
  if (!officialUrl) return false;
  try {
    const a = new URL(bronUrl).hostname.replace(/^www\./, '').toLowerCase();
    const b = new URL(officialUrl).hostname.replace(/^www\./, '').toLowerCase();
    return a === b;
  } catch {
    return false;
  }
}

// Neemt de quote uit de research alleen over als er écht een uitspraak mét
// bron staat én die bron niet op de blacklist staat (concurrerende stadsgidsen
// citeren is de facto overschrijven). Alles wat niet aan die vorm voldoet
// wordt null: geen quote is beter dan een quote van onduidelijke herkomst.
function acceptBronQuote(value: unknown, constraints: StandaardConstraints, officialUrl?: string | null): StandaardState['bronQuote'] {
  if (!value || typeof value !== 'object') return null;
  const q = value as Record<string, unknown>;
  const tekst = optionalString(q.tekst);
  const bron = optionalString(q.bron);
  const herkomst = optionalString(q.herkomst);
  if (!tekst || !bron) return null;
  // Een bronquote mét em/en dash is onbruikbaar: "neem letterlijk over" botst
  // dan frontaal met het dash-verbod uit validateArticle, en omdat de retry
  // dezelfde instructie krijgt zou zo'n quote het topic gegarandeerd op
  // "mislukt" zetten. Krantencitaten bevatten die streepjes regelmatig.
  if (/[—–]/.test(tekst)) return null;
  if (!quoteSourceAllowed(bron, constraints.quoteSourceBlacklist, herkomst)) return null;
  // Een "quote" die letterlijk van de eigen website van de zaak komt is geen
  // uitspraak van een betrokkene maar marketingcopy die het model per ongeluk
  // als citaat aanmerkte — precies wat er bij artikel 87441 (Clash Bar & Bites)
  // gebeurde: een zin uit de eigen homepage-tekst werd "quote" en kwam zo dubbel
  // in het artikel terecht (lopende tekst + blockquote). Een échte quote van een
  // betrokkene staat vrijwel nooit op de homepage van de zaak zelf, maar in een
  // interview, recensie of ander extern stuk.
  if (sameOfficialHost(bron, officialUrl)) return null;
  return { tekst, bron, herkomst };
}

// Attributie onder de pull-quote, maar alleen als de gekozen quote écht de
// uitspraak uit de bron ís. Paste de bronquote niet in het quote-veld, dan
// koos de schrijver een eigen redactiezin; die toeschrijven aan een echt
// persoon is erger dan helemaal geen bronvermelding.
function bronAttributie(s: StandaardState, quote: string): string | undefined {
  const q = s.bronQuote;
  if (!q?.herkomst) return undefined;
  const normaliseer = (v: string) => decodeHtmlEntities(v).replace(/[""'']/g, '"').replace(/\s+/g, ' ').trim().toLocaleLowerCase('nl-NL');
  return normaliseer(q.tekst) === normaliseer(quote) ? q.herkomst : undefined;
}

// Hostname van de in ronde 1 gedetecteerde officiële site, voor de
// festival-focusregel van de verdiepingsronde (line-up alleen van het eigen
// domein). Leeg als er geen officiële site bekend is of de URL niet parseert.
function officialHostOf(s: StandaardState): string | undefined {
  if (!s.officialUrl) return undefined;
  try {
    return new URL(s.officialUrl).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

// Lijst met wat de research NIET vond, defensief uit onbekende JSON.
function missingFactsOf(research: Record<string, unknown>): string[] {
  const raw = research.missing_facts;
  if (!Array.isArray(raw)) return [];
  return raw.map(v => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
}

// De brontekst zoals de schrijffase 'm krijgt. Dit is de kern van de
// anti-hallucinatie-fix: zonder brontekst kende de schrijver alleen de
// samengevatte research-JSON en vulde hij de gaten daartussen zelf in.
function describeSources(s: StandaardState): string {
  const sources = s.researchSources ?? [];
  if (!sources.length) return '';
  const blocks = sources.map((src, i) => `[B${i + 1}] ${src.title}\n${src.url}\n${src.content}`).join('\n\n');
  return [
    '',
    'BRONTEKST (letterlijk uit de gecontroleerde bronnen):',
    blocks,
    '',
    'HARDE REGEL: elk concreet detail in het artikel (namen, aantallen, materialen, herkomst, openingstijden, prijzen, jaartallen) moet herleidbaar zijn tot de research-JSON hierboven of tot deze brontekst. Staat het er niet, schrijf het dan niet. Liever een zin minder dan een verzonnen detail.',
  ].join('\n');
}

// Instructie voor de quote. Staat er een echte uitspraak in de bronnen, dan
// gaat die letterlijk het artikel in — een citaat van een betrokkene is
// precies wat de schrijver anders zelf verzint. Twee smaken, omdat de
// quoteWords-regel (25-40 woorden) hard door validateArticle wordt getoetst:
// past de bronquote binnen dat bereik, dan is 'ie óók het quote-veld (en blijft
// de verbatim-controle vanzelf kloppen); is 'ie korter of langer, dan zou dat
// elke poging laten afkeuren, dus dan hoort de uitspraak wél in de lopende
// tekst maar kiest de schrijver het quote-veld zoals gebruikelijk.
function describeQuoteInstruction(s: StandaardState, c: StandaardConstraints): string {
  const q = s.bronQuote;
  if (!q || !c.quotePreferSource) return '';
  const attributie = q.herkomst ? `, zegt ${q.herkomst}` : ' (met attributie aan de bron)';
  const woorden = wordCount(q.tekst);
  const past = woorden >= c.quoteWords.min && woorden <= c.quoteWords.max;
  return [
    '',
    // Kop en veldnaam volgen letterlijk de schrijf-prompt (bron_quote), anders
    // verwijst de prompt naar iets dat in de user-message anders heet.
    'BRON_QUOTE (echte uitspraak uit de bronnen, verplicht gebruiken):',
    `"${q.tekst}"${q.herkomst ? `, ${q.herkomst}` : ''} (bron: ${q.bron})`,
    `Neem deze quote LETTERLIJK, woord voor woord, op in de lopende tekst mét attributie ("…"${attributie}).`,
    past
      ? 'Gebruik exact diezelfde zin ook als "quote"-veld. Verzin geen andere quote.'
      : `Deze uitspraak is ${woorden} woorden en past niet in het quote-veld (${c.quoteWords.min}-${c.quoteWords.max} woorden); kies daarvoor zoals gebruikelijk een pakkende zin uit je eigen artikeltekst.`,
  ].join('\n');
}

export interface StandaardStepResult {
  topic: Topic;
  phase: StandaardPhase;
  done: boolean;           // true zodra de draft er staat
  progress: string;        // korte statusregel voor het bord
  article?: { id: number; title: string };
}

// Eén fase-stap van de standaardpipeline. Was ooit één aaneengesloten aanroep
// (research + schrijven + evt. herschrijfronde + SEO + WordPress-draft, dus
// tot 4 Claude-calls in één request) — dat liep regelmatig over de 60s-
// serverless-limiet heen (FUNCTION_INVOCATION_TIMEOUT), waarna de taak zonder
// foutafhandeling op 'writing' bleef staan en de wachtrij blokkeerde (zie
// lib/queue.ts: er mag maar 1 taak tegelijk 'writing' zijn). Nu net als de
// lijstpipeline: één fase per process-aanroep.
export async function processStandaardStep(topic: Topic): Promise<StandaardStepResult> {
  const s = parseStandaardState(topic) ?? {};
  const phase: StandaardPhase =
    topic.phase === 'research-aanvullend' || topic.phase === 'invalshoek' || topic.phase === 'schrijf' || topic.phase === 'schrijf-retry' || topic.phase === 'curator' || topic.phase === 'seo'
      ? topic.phase : 'research';
  try {
    switch (phase) {
      case 'research': return await stepResearch(topic, s);
      case 'research-aanvullend': return await stepResearchAanvullend(topic, s);
      case 'invalshoek': return await stepInvalshoek(topic, s);
      case 'schrijf': return await stepSchrijf(topic, s);
      case 'schrijf-retry': return await stepSchrijfRetry(topic, s);
      case 'curator': return await stepCurator(topic, s);
      case 'seo': return await stepSeo(topic, s);
    }
  } catch (error: any) {
    // Foutclassificatie (lib/errorKind.ts): infra-fouten gaan automatisch
    // terug de wachtrij in (met quotum-pauze bij accountbrede fouten), al het
    // andere wordt 'failed' met een soort-label voor het bord.
    await failTopicClassified(topic.id, error, `standaardfase: ${phase}`);
    throw error;
  }
}

// De "naam van het onderwerp" voor de titelcheck in validateArticle. De
// bron-scanner maakt tegenwoordig hele zinstitels als wachtrijtitel ("Vermut
// opent in Amsterdam: restaurant én aperitivobar ineen"); eisen dat de
// artikeltitel die volledige zin bevat is onhaalbaar én botst frontaal met de
// regel dat "Amsterdam" niet in de titel mag — elke scanner-titel met
// "Amsterdam" faalde daardoor gegarandeerd. De research-fase extraheert al de
// echte naam van de zaak of het evenement (naam_locatie); dáár hoort de
// titelcheck op te toetsen, met de wachtrijtitel als vangnet.
function subjectName(topic: Topic, s: StandaardState): string {
  const naam = s.research?.naam_locatie;
  return typeof naam === 'string' && naam.trim() ? naam.trim() : topic.title;
}

function buildCandidate(payload: Record<string, unknown>): GeneratedArticle {
  return {
    title: string(payload.title, 'title'),
    subregel: string(payload.subregel, 'subregel'),
    introductie_tekst: string(payload.introductie_tekst, 'introductie_tekst'),
    content: string(payload.content, 'content'),
    quote: string(payload.quote, 'quote'),
  };
}

// Genereert de titel apart en VRIJ, buiten de structured-output-call om. De
// hoofd-schrijfcall levert geldige JSON via constrained decoding (output_config
// .format), en juist dat sloeg de titel plat: het meest creatieve veld lijdt
// het meest onder token-voor-token grammatica-dwang. De oude n8n-workflow liet
// het model vrije tekst schrijven en parste die achteraf — punchier titels.
// Hier halen we dat gedrag terug voor alléén de titel: een losse, goedkope
// call (TITLE_MODEL) zonder schema levert drie kandidaten; we nemen de eerste
// die door dezelfde titel-keuring komt als validateArticle. Komt geen kandidaat
// erdoor (of hapert de call), dan houden we de al-gevalideerde bestaande titel:
// deze stap kan de titel dus nooit slechter of ongeldig maken.
async function polishTitle(
  article: GeneratedArticle, s: StandaardState, naam: string, constraints: StandaardConstraints, topicId: number,
): Promise<string> {
  const r = s.research ?? {};
  const facts = [
    `Naam onderwerp: ${naam}`,
    typeof r.samenvatting === 'string' && r.samenvatting ? `Samenvatting: ${r.samenvatting}` : '',
    Array.isArray(r.key_people) && r.key_people.length ? `Mensen/acts: ${r.key_people.join(', ')}` : '',
    Array.isArray(r.distinctive_features) && r.distinctive_features.length ? `Onderscheidend: ${r.distinctive_features.join('; ')}` : '',
  ].filter(Boolean).join('\n');

  const system = 'Je bent eindredacteur van amsterdamnow.com, een lokale stadsgids door en voor Amsterdammers. Je bedenkt de kop zoals de ene Amsterdammer de andere over een plek vertelt: informeel, direct, nuchter en concreet. Nooit toeristisch, nooit marketingtaal.';
  const prompt = [
    'Bedenk drie mogelijke titels voor dit artikel, elk met een ANDERE zinsbouw.',
    '',
    'REGELS (hard):',
    // Zelfde bindende paar als describeStandaardConstraints: woorden én
    // tekens. checkTitle keurt op titleMaxChars, dus een kandidaat die alleen
    // het woordenbereik hoort blijft anders op 71+ tekens hangen.
    `- ${constraints.titleWords.min}-${Math.max(constraints.titleWords.min, constraints.titleWords.max - 1)} woorden en maximaal ${constraints.titleMaxChars} tekens, inclusief spaties en leestekens. Tel na: een langere kop wordt afgekeurd.`,
    `- De naam "${naam}" (of de kernnaam ervan) staat erin, bij voorkeur vooraan. Essentieel voor SEO.`,
    '- Prikkelend en concreet, met een detail dat nieuwsgierig maakt.',
    // Sturing weg van het dubbele-punt-sjabloon: in de april-steekproef leunde
    // bijna de helft van de koppen op "Naam: uitleg". De drie kandidaten moeten
    // drie verschillende structuren zijn, dan wint de beste in plaats van de
    // gewoonste.
    '- Drie verschillende structuren: bijvoorbeeld werkwoord-leidend, een komma-bijstelling, een waarom-vraag. Hooguit één van de drie mag een dubbele punt gebruiken.',
    '- Na een dubbele punt of komma: kleine letter, tenzij het woord een eigennaam is.',
    '- Vermijd saaie constructies als "Nieuw restaurant X opent zijn deuren".',
    constraints.noDashInText ? '- Geen em dash (—) of en dash (–).' : '',
    constraints.noAmsterdamRepeatInTitleSubregelIntro ? '- Het woord "Amsterdam" mag NIET in de titel staan.' : '',
    '',
    'Goede voorbeelden (drie verschillende structuren):',
    // Het oude BOLIA-voorbeeld ("…brengt Deens design met koffie en maatwerk")
    // was zelf 71 tekens en overtrad daarmee de limiet die deze prompt
    // afdwingt; een regel-overtredend voorbeeld traint het model precies de
    // verkeerde kant op. Zelfde fix als in de schrijf-seed (prompt-seeds.ts).
    '- BOLIA aan de Utrechtsestraat brengt Deens design en maatwerk',
    '- Waarom De Kaaskamer al veertig jaar dezelfde toonbank gebruikt',
    '- Chez Chloé op de Overtoom: klassiek Frans van chef Marcelo Hernandez',
    '',
    'Context uit de research:',
    facts,
    '',
    `Huidige kop (mag beter): ${article.title}`,
    `Subregel: ${article.subregel}`,
    `Introductie: ${article.introductie_tekst}`,
    '',
    'Antwoord ALLEEN met JSON: {"titels": ["...", "...", "..."]}',
  ].filter(line => line !== '').join('\n');

  try {
    // Geen schema → vrije generatie (extractJson-vangnet in claude.ts). Klein
    // token-budget: drie korte koppen zijn ruim binnen ~400 tokens.
    const payload = await askClaudeJson(system, prompt, TITLE_MODEL, 600, undefined, false, `titel#${topicId}`);
    const kandidaten = Array.isArray(payload.titels) ? payload.titels : [];
    for (const kandidaat of kandidaten) {
      if (typeof kandidaat === 'string' && kandidaat.trim() && checkTitle(kandidaat.trim(), naam, constraints) === null) {
        return kandidaat.trim();
      }
    }
  } catch {
    // Titel-polish is nice-to-have: bij een hapering houden we de bestaande
    // (al gevalideerde) titel en laten we de pipeline gewoon doorlopen.
  }
  return article.title;
}

// Mag een gedetecteerde origin research.website overschrijven? Alleen als hij
// aantoonbaar bij het onderwerp hoort: het domeinlabel draagt de onderwerptitel
// of de gevonden naam_locatie (hostMatchesTopic in tavily.ts). Een geplakte
// URL als onderwerp is per definitie de eigen site. Zo lekt een verkeerd
// gekozen zoekresultaat (blog, gids, CDN) niet meer als "website" de draft in;
// zonder match blijft het antwoord van het researchmodel gewoon staan.
function originHoortBijOnderwerp(origin: string, topicTitle: string, naamLocatie: string): boolean {
  if (topicAsUrl(topicTitle)) return true;
  return hostMatchesTopic(origin, topicTitle) || (!!naamLocatie && hostMatchesTopic(origin, naamLocatie));
}

async function stepResearch(topic: Topic, s: StandaardState): Promise<StandaardStepResult> {
  const [researchPrompt, taxonomies, constraints] = await Promise.all([
    activePrompt('research'), taxonomyChoices(), standaardConstraints(),
  ]);
  // Poort 1 — het onderwerp zelf. Een topic dat de merknaam van een concurrent
  // draagt is een bronkop die niet geredactionaliseerd is (scanner.ts doet dat
  // sinds 21-07-2026 bij binnenkomst; alles wat daarvóór in de wachtrij kwam
  // heeft die stap nooit gezien). Vóór de eerste Tavily- of Claude-call, zodat
  // zo'n topic geen geld kost en met een leesbare reden op "mislukt" komt.
  const concurrentInTopic = competitorInTekst([topic.title], standaardQuoteSourceBlacklist(constraints));
  if (concurrentInTopic) {
    throw new Error(
      `Onderwerp draagt de naam van concurrent ${concurrentInTopic}. Dit is een overgenomen bronkop, geen eigen onderwerp — herformuleer het naar de zaak of het event zelf, of verwijder het uit de wachtrij.`
    );
  }
  let { sources, officialUrl } = await researchWithTavily(topic.title);
  // Research = feiten extraheren uit aangeleverde bronnen, geen creatief werk:
  // Sonnet 5 volstaat en kost een fractie van Opus (zie FAST_WRITE_MODEL in
  // lib/claude.ts). Bronnen worden hier ook getrimd op 8000 tekens — relevante
  // info zoals adres/feiten staat doorgaans vooraan in de geëxtraheerde
  // content (zie VERIFY_SOURCE_CHARS in listWriter.ts voor dezelfde afweging).
  const research = await askClaudeJson(
    researchPrompt.content,
    `Onderwerp: ${topic.title}\n\nVandaag is ${amsterdamToday()} (Europe/Amsterdam).\n\nBeschikbare WordPress-categorieën: ${taxonomies.categories.join(', ')}\nBeschikbare WordPress-districten: ${taxonomies.districts.join(', ')}\nBeschikbare WordPress-tags: ${taxonomies.tags.join(', ')}\nKies precies één "tag" uit deze lijst: de best passende. Verzin nooit een nieuwe tag. Past geen enkele bestaande tag echt goed, geef dan "" terug.\n\nGaat dit onderwerp over een event, tentoonstelling, festival of ander tijdelijk programma, geef dan de looptijd als "start_datum" en "eind_datum" in JJJJ-MM-DD, letterlijk overgenomen uit de bronnen. Bij een eendaags event is eind_datum gelijk aan start_datum.\n\nNoemt een bron een slotdatum ("t/m 29 juni 2026", "loopt tot en met…", "te zien tot…"), vul die dan ALTIJD in als eind_datum — ook als de tentoonstelling al maanden loopt, en ook als die datum inmiddels verstreken is. Die datum bepaalt of wij het onderwerp nog mogen publiceren; hem weglaten of doorschuiven is een fout. Alleen bij een vaste zaak (restaurant, winkel, museum als instelling) of nieuws zonder looptijd laat je beide velden leeg ("").\n\nTavily-bronnen:\n${sources.map((src, i) => `\n[${i + 1}] ${src.title}\n${src.url}\n${src.content.slice(0, 8000)}`).join('\n')}`,
    FAST_WRITE_MODEL, 6000, RESEARCH_SCHEMA, false, `research#${topic.id}`,
  );
  // Seed van de bronscanner is gezaghebbend: die datum komt rechtstreeks van de
  // agendapagina, betrouwbaarder dan wat het model uit de Tavily-bronnen afleidt.
  // Alleen overschrijven als er een seed is; anders blijft de research-datum staan.
  if (s.seedStartDatum) {
    (research as Record<string, unknown>).start_datum = s.seedStartDatum;
    (research as Record<string, unknown>).eind_datum = s.seedEindDatum || s.seedStartDatum;
  }
  // Harde poort: een event dat al is afgelopen wordt niet geschreven. Dit is
  // het enige punt in de pipeline waar élk topic langskomt — de scanner-check
  // geldt alleen voor gescande items, dus handmatig ingevoerde onderwerpen
  // (zoals de al gesloten expositie in artikel 86418) kwamen er anders
  // ongehinderd doorheen. Gooien vóór de entiteitsverificatie en vóór de
  // schrijffase: geen extra Claude-calls, geen WordPress-draft, en het topic
  // komt met een leesbare reden op "mislukt" te staan.
  const eindDatum = eventEndReference(research.start_datum, research.eind_datum);
  if (isPastEvent(research.start_datum, research.eind_datum, amsterdamToday())) {
    throw new Error(
      `Event is voorbij: liep t/m ${eindDatum}. Dit onderwerp wordt niet geschreven — pas het aan of verwijder het uit de wachtrij.`
    );
  }
  // De homepage/origin is de betrouwbaarste bron voor de website — maar alleen
  // als die aantoonbaar bij het onderwerp hoort (originHoortBijOnderwerp).
  // Anders blijft staan wat het researchmodel zelf als website gaf: een
  // ongerelateerde origin onvoorwaardelijk overschrijven was precies hoe blogs
  // en gidsen van derden als "officiële site" in drafts belandden.
  const naamLocatie = optionalString((research as Record<string, unknown>).naam_locatie);
  if (officialUrl && originHoortBijOnderwerp(officialUrl, topic.title, naamLocatie)) {
    (research as Record<string, unknown>).website = officialUrl;
  }
  s.research = research;
  // Entiteitsverificatie: controleer dat naam_locatie, adres en website bij
  // dezelfde echte zaak horen (en canoniseer de naam) op basis van de gecrawlde
  // officiële homepage. Fail-open: bij een hapering blijven de originele waarden
  // staan. Moet vóór saveTopicProgress zodat de gecorrigeerde staat wordt bewaard.
  const homepageContent = officialUrl ? (sources.find(src => src.url === officialUrl)?.content ?? '') : '';
  await verifyEntity(s, officialUrl, homepageContent, topic.id, topic.title);
  // Entiteitsconsistentie-poort. verifyEntity berekende tot nu toe wel
  // entiteitConsistent/entiteitWaarschuwing, maar niets las het ooit terug —
  // een expliciete "false" (naam/adres/website horen NIET bij dezelfde zaak)
  // ging gewoon door naar de schrijffase. Precies zo kreeg artikel 87441 (Clash
  // Bar & Bites) het adres van de Johan Cruijff ArenA: de research wees een
  // ander adres aan dan de echte zaak, en niets hield dat tegen. Strikt op
  // `=== false` (niet `!== true`): undefined betekent dat verifyEntity zelf
  // faalde (fail-open, zie verifyEntity) en mag de topic niet blokkeren — alleen
  // een expliciete, geslaagde afkeuring doet dat.
  // Herkansing vóór de harde poort: één gerichte Tavily-zoekronde op
  // "<naam> officiële website". De eerste detectie kan de verkeerde site
  // hebben gekozen (blog, gids, CDN) — dan is de entiteit terecht inconsistent,
  // maar bestaat de echte site vaak wél. Vind 'm gericht, zet de website
  // opnieuw (met dezelfde verwantschapspoort) en beoordeel de entiteit
  // nogmaals. entiteitZoekAttempts bewaakt dat dit max één keer gebeurt;
  // best-effort: faalt de herkansing zelf, dan beslist de poort hieronder.
  if (s.entiteitConsistent === false && !(s.entiteitZoekAttempts ?? 0)) {
    s.entiteitZoekAttempts = 1;
    try {
      const rr = research as Record<string, unknown>;
      const zoekNaam = optionalString(rr.naam_locatie) || topic.title;
      const herkansing = await researchWithTavily(topic.title, {
        query: `${zoekNaam} officiële website`, detectOfficial: true,
      });
      if (herkansing.officialUrl) {
        officialUrl = herkansing.officialUrl;
        const homepage = herkansing.sources.find(src => src.url === herkansing.officialUrl) ?? null;
        if (homepage && !sources.some(src => src.url.replace(/\/+$/, '').toLowerCase() === homepage.url.replace(/\/+$/, '').toLowerCase())) {
          sources = [homepage, ...sources];
        }
        if (originHoortBijOnderwerp(officialUrl, topic.title, optionalString(rr.naam_locatie))) {
          rr.website = officialUrl;
        }
        await verifyEntity(s, officialUrl, homepage?.content ?? '', topic.id, topic.title);
      }
    } catch { /* herkansing is best-effort; de poort hieronder beslist */ }
  }
  if (s.entiteitConsistent === false) {
    throw new Error(
      `Entiteitscontrole faalt: ${s.entiteitWaarschuwing || 'naam, adres en website lijken niet bij dezelfde zaak te horen'}. Controleer het onderwerp handmatig.`
    );
  }
  // Poort 2 — de entiteit. tavily.ts weert concurrent-bronnen al, maar de
  // research kan een concurrent nog steeds als onderwerp aanwijzen (hun naam
  // staat in een citaat, een tip-vermelding of een tweedehands bron). Dan is
  // naam_locatie/website hún merk en loopt alles wat daarna komt — titel,
  // slug, SEO, beeld-zoekopdracht — op de concurrent. Precies wat artikel
  // 87365 was. Afkeuren vóór de schrijffase: geen WordPress-draft, geen
  // beelden, en het topic komt met een leesbare reden op "mislukt".
  const r = s.research as Record<string, unknown>;
  const concurrentInEntiteit = competitorInTekst(
    [optionalString(r.naam_locatie), optionalString(r.website)],
    standaardQuoteSourceBlacklist(constraints),
  );
  if (concurrentInEntiteit) {
    throw new Error(
      `De research wijst ${concurrentInEntiteit} aan als onderwerp; dat is een concurrerende stadsgids, geen zaak of event. Kies de onderliggende zaak of het event als onderwerp.`
    );
  }
  // Bronnen, gaten en score bewaren voor de volgende fases: de schrijver krijgt
  // de brontekst mee (zie describeSources) en de sufficiëntie-poort hieronder
  // heeft de score nodig. Eerst het relevantiefilter (lib/relevance.ts):
  // bronnen zonder één onderscheidende onderwerptoken gaan over iets ánders en
  // horen niet in de invalshoek- of schrijfprompt. Blijven er minder dan twee
  // relevante bronnen over, dan komen de overige gedegradeerd (als laatste)
  // terug — zie filterOpRelevantie voor die afweging.
  const relevantieTokens = onderwerpTokens(topic.title, optionalString(r.naam_locatie));
  s.researchSources = trimSources(filterOpRelevantie(sources, relevantieTokens));
  s.missingFacts = missingFactsOf(research);
  s.factScore = researchFactScore(research);
  s.researchRounds = 1;
  s.officialUrl = officialUrl;
  s.bronQuote = acceptBronQuote(research.quote, constraints, officialUrl);
  // Verdiepingsronde is standaard, niet alleen bij dunne research. De
  // kalibratie van 25-07 liet zien dat ronde 1 vrijwel altijd op de eigen
  // homepage en aggregator-blurbs uitkomt: research die er compleet uitziet
  // (score boven de drempel) maar alleen marketingcopy bevat — een festival
  // zonder line-up, een restaurant zonder één concreet gerecht. De tweede
  // ronde zoekt daarom altijd gericht per categorie (zie researchProfiles.ts)
  // naar wat dít soort artikel inhoud geeft. Kost één extra tik en hooguit
  // drie Tavily-calls; researchRounds houdt het bij één verdieping.
  if ((s.researchRounds ?? 1) < 2) {
    const profiel = detectProfiel(s.research as Record<string, unknown>);
    await saveTopicProgress(topic.id, { status: 'queued', phase: 'research-aanvullend', state: s });
    return { topic, phase: 'research-aanvullend', done: false, progress: `Research klaar (score ${s.factScore}) · verdieping (${profiel})` };
  }
  await saveTopicProgress(topic.id, { status: 'queued', phase: 'schrijf', state: s });
  return { topic, phase: 'schrijf', done: false, progress: 'Research klaar · schrijven start' };
}

// Aanvullende researchronde: gericht zoeken op wat de eerste ronde niet vond.
// Bewust bescheiden binnen de 60s-limiet — hooguit drie Tavily-calls en één
// Claude-call — en volledig fail-open: gaat hier iets mis, dan schrijven we met
// wat we al hebben, want het topic heeft al bruikbare research.
//
// Tweede rol sinds de invalshoek-herstelfix: wijst de invalshoek-poort een
// topic af (publicabel false), dan stuurt stepInvalshoek het topic éénmalig
// terug naar deze fase mét de afwijsreden in s.invalshoekAfwijzing. De queries
// worden dan niet door het categorie-profiel gestuurd maar door die reden en
// de openstaande missing_facts — gericht zoeken naar precies het gat waarop
// het topic sneuvelde, waarna de poort opnieuw oordeelt.
async function stepResearchAanvullend(topic: Topic, s: StandaardState): Promise<StandaardStepResult> {
  if (!s.research) throw new Error('Research ontbreekt voor de aanvullende researchronde.');
  const r = s.research as Record<string, unknown>;
  const constraints = await standaardConstraints();
  const herstel = !!s.invalshoekAfwijzing;
  let gevonden = 0;
  try {
    const naam = optionalString(r.naam_locatie) || topic.title;
    // Adres is specifieker dan de stad (twee vestigingen met dezelfde naam), dus
    // die krijgt voorrang als plaatsbepaling in de zoekterm.
    const plaats = optionalString(r.adres) || optionalString(r.stad) || 'Amsterdam';
    // Categorie-profiel bepaalt de eerste twee queries: wat dít soort artikel
    // inhoud geeft (festival: line-up + organisatie; restaurant: chef + kaart;
    // winkel: onderscheid; enz. — zie researchProfiles.ts). Het grootste gat
    // uit ronde 1 mag er als derde query bij. Drie i.p.v. twee calls kan
    // binnen de 60s-tik: ze lopen parallel (elk met een timeout van 15s,
    // zie tavily.ts) en de Claude-extractie erna blijft er één.
    // In de herstelronde sturen de afwijsreden en missing_facts de queries;
    // de profielqueries zijn dan al eens gedraaid en zouden deterministisch
    // dezelfde bronnen (en hetzelfde oordeel) opleveren. Naam tussen
    // aanhalingstekens, net als in profielQueries: strakke binding aan het
    // onderwerp houdt vreemd materiaal buiten de deur.
    const profiel = detectProfiel(r);
    const gaten = (s.missingFacts ?? []).slice(0, herstel ? 2 : 1);
    const nQ = `"${naam.replace(/"/g, '')}"`;
    const herstelQueries = [
      `${nQ} ${kernwoorden(s.invalshoekAfwijzing ?? '')}`.trim(),
      ...gaten.map(gat => `${nQ} ${plaats} ${gat}`),
    ].filter(q => q.length > nQ.length + 1);
    const queries = (herstel && herstelQueries.length ? herstelQueries : [
      ...profielQueries(profiel, naam, plaats),
      ...gaten.map(gat => `${naam} ${plaats} ${gat}`),
    ]).slice(0, 3);

    // De zoekopdrachten tegelijk: ze zijn onafhankelijk, en er moet in
    // deze tik ook nog een Claude-extractie bij binnen de 60s. allSettled i.p.v.
    // all, want een mislukte tweede query mag de opbrengst van de eerste niet
    // weggooien. Dedupliceren gebeurt daarna in queryvolgorde, zodat de uitkomst
    // niet afhangt van welke call het eerst terug is.
    const uitkomsten = await Promise.allSettled(
      queries.map(query => researchWithTavily(topic.title, { query, maxResults: 3 })),
    );
    const bekend = new Set((s.researchSources ?? []).map(src => src.url.replace(/\/+$/, '').toLowerCase()));
    const binnengekomen: ResearchSource[] = [];
    for (const uitkomst of uitkomsten) {
      if (uitkomst.status !== 'fulfilled') continue;
      for (const src of uitkomst.value.sources) {
        const key = src.url.replace(/\/+$/, '').toLowerCase();
        if (bekend.has(key)) continue;
        bekend.add(key);
        binnengekomen.push(src);
      }
    }
    // Relevantiefilter, hier STRIKT (minBronnen 0): een ronde-2-bron zonder
    // één onderwerptoken gaat over iets anders (de DGTL-pagina bij een
    // ADE-onderwerp) en mag nooit een relevante ronde-1-bron verdringen —
    // de ronde-1-bronnen liggen er al als vangnet, dus weglaten is veilig.
    const relevantieTokens = onderwerpTokens(topic.title, naam);
    const nieuw = filterOpRelevantie(binnengekomen, relevantieTokens, 0);
    gevonden = nieuw.length;

    if (nieuw.length) {
      const bestaand = s.researchSources ?? [];
      const nieuwGetrimd = trimSources(nieuw);
      const [researchPrompt, taxonomies] = await Promise.all([activePrompt('research'), taxonomyChoices()]);
      const alle = [...bestaand, ...nieuwGetrimd];
      // In de herstelronde weet de extractie waaróm de invalshoek-poort het
      // topic afwees, zodat ze gericht op dat gat let in plaats van generiek
      // te verzamelen.
      const focus = herstel
        ? `De invalshoek-poort wees dit onderwerp af met deze reden: "${s.invalshoekAfwijzing}". Zoek in de bronnen gericht naar concrete feiten die precies dat gat dichten.\n\n${profielFocus(profiel, officialHostOf(s))}`
        : profielFocus(profiel, officialHostOf(s));
      const extra = await askClaudeJson(
        researchPrompt.content,
        `Onderwerp: ${topic.title}\n\nVandaag is ${amsterdamToday()} (Europe/Amsterdam).\n\nBeschikbare WordPress-categorieën: ${taxonomies.categories.join(', ')}\nBeschikbare WordPress-districten: ${taxonomies.districts.join(', ')}\nBeschikbare WordPress-tags: ${taxonomies.tags.join(', ')}\nKies precies één "tag" uit deze lijst: de best passende. Verzin nooit een nieuwe tag. Past geen enkele bestaande tag echt goed, geef dan "" terug.\n\nDit is een AANVULLENDE ronde: er is al research gedaan, maar deze feiten ontbraken nog: ${(s.missingFacts ?? []).join(', ') || '(niet gespecificeerd)'}. Let vooral op die punten. Verzin nooit iets: staat het niet in de bronnen, laat het veld leeg en zet het in "missing_facts".\n\n${focus}\n\nBronnen:\n${alle.map((src, i) => `\n[${i + 1}] ${src.title}\n${src.url}\n${src.content}`).join('\n')}`,
        FAST_WRITE_MODEL, 6000, RESEARCH_SCHEMA, false, `research-aanvullend#${topic.id}`,
      );
      mergeResearch(r, extra);
      // missing_facts van de tweede ronde is de actuelere lijst: die is
      // opgesteld tegen álle bronnen samen.
      s.missingFacts = missingFactsOf(extra);
      if (!s.bronQuote) s.bronQuote = acceptBronQuote(extra.quote, constraints, s.officialUrl);
      // Bewaarde bronnen blijven begrensd op MAX_WRITE_SOURCES (tokenruimte van
      // de schrijfcall). De eerste twee van ronde 1 blijven staan — daar zit de
      // officiële homepage bij, de betrouwbaarste bron — daarna krijgen de
      // nieuwe bronnen voorrang, en pas als er dan nog plek is de rest van
      // ronde 1.
      s.researchSources = [...bestaand.slice(0, 2), ...nieuwGetrimd, ...bestaand.slice(2)].slice(0, MAX_WRITE_SOURCES);
    }
  } catch {
    // FAIL-OPEN: we schrijven met de research van ronde 1.
  }
  // Altijd door naar de invalshoek-poort, nooit een derde reguliere ronde. Ook
  // de herstelronde komt hier terug: de poort oordeelt dan opnieuw, en de
  // teller invalshoekHerstelRounds (gezet in stepInvalshoek) bewaakt dat er
  // hooguit één herstelronde is.
  s.researchRounds = 2;
  s.factScore = researchFactScore(s.research as Record<string, unknown>);
  await saveTopicProgress(topic.id, { status: 'queued', phase: 'invalshoek', state: s });
  const bronnenTekst = `${gevonden} extra bron${gevonden === 1 ? '' : 'nen'}`;
  return {
    topic, phase: 'invalshoek', done: false,
    progress: herstel
      ? `Herstelronde (${bronnenTekst}, score ${s.factScore}) · invalshoek opnieuw beoordelen`
      : `Aanvullende research (${bronnenTekst}, score ${s.factScore}) · invalshoek bepalen`,
  };
}

// Invalshoek-fase: bepaalt vóór de schrijffase waaróm de ene Amsterdammer de
// andere dit zou tippen, en fungeert als poort. De kalibratie van 25-07 liet
// zien dat de pijplijn zonder deze stap feiten formatteert in plaats van een
// verhaal vertelt: research verzamelt, de schrijver vult het sjabloon, en
// niets beslist of er eigenlijk wel iets te vertellen valt (Circoloco zonder
// line-up, Veganees zonder één concreet gerecht). Drie uitkomsten:
// - hoek gevonden → de hoek en story beats gaan als blok mee de schrijffase in;
// - geen hoek te halen uit de feiten → éénmalig een gerichte herstelronde
//   (terug naar research-aanvullend, gestuurd door de afwijsreden); sneuvelt
//   het topic daarna opnieuw → mislukt mét leesbare reden, vóór er een draft
//   of beeldzoektocht aan wordt uitgegeven. Direct failen was zinloos streng:
//   een retry op dezelfde research geeft deterministisch hetzelfde oordeel
//   (het "poging 3"-label op het bord is een fase-teller, geen herkansing),
//   dus de enige zinvolle herkansing is er een mét nieuwe research;
// - de research spreekt zichzelf tegen: alléén fataal als het model dat zelf
//   zwaar genoeg vindt voor publicabel false. Het tegenspraak-veld is required
//   in het schema, dus het model vult er onder druk van structured output
//   graag íets in — productie failde zo op capaciteits- en datumtrivia
//   (Neoseum: "FAQ zegt tot 10 vs tot 5 personen") die de schrijffase prima
//   kan omzeilen en die de event-poort (datums) al gezaghebbend afdekt. Een
//   niet-blokkerende tegenspraak gaat daarom als waarschuwing mee naar de
//   schrijffase (describeInvalshoek) in plaats van het topic te killen.
async function stepInvalshoek(topic: Topic, s: StandaardState): Promise<StandaardStepResult> {
  if (!s.research) throw new Error('Research ontbreekt voor de invalshoek-fase.');
  const naam = subjectName(topic, s);
  const system = 'Je bent chef-redactie van amsterdamnow.com, een stadsgids door en voor Amsterdammers. Jij beslist of een onderwerp een artikel waard is en met welke invalshoek. De maatstaf: zou een Amsterdammer dit uit zichzelf aan een vriend vertellen, en wát dan precies? Je verzint niets: hoek en beats steunen uitsluitend op de aangeleverde research en brontekst.';
  const prompt = [
    `Onderwerp: ${naam}`,
    '',
    'Beoordeel de research hieronder en geef ALLEEN JSON terug.',
    '',
    'Bepaal:',
    '- publicabel: is hier een concreet, niet-generiek verhaal uit te halen? "Een nieuwe plek met een fijne sfeer" is GEEN verhaal; "de chef van restaurant X begint voor zichzelf in het pand van Y" wel. Te dun of alleen marketingtaal: false.',
    '- hoek: de local-tip in één zin. Niet wat de zaak over zichzelf zegt, maar wat een Amsterdammer erover doorvertelt.',
    '- beats: twee à drie concrete feiten uit de research die de hoek dragen.',
    '- tegenspraak: spreekt de research zichzelf tegen op een kernfeit van HET ONDERWERP ZELF — de naam, wie erachter zit, of het event überhaupt bestaat? Noem het kort; anders lege string. GEEN tegenspraak zijn: capaciteit, openingstijden, prijzen, datumverschillen tussen bronnen (de event-poort dekt datums al), en bronnen die over een ánder onderwerp of event gaan — negeer zulke bronnen volledig.',
    '- reden: alleen bij publicabel false één leesbare zin waarom niet, met daarin welk concreet feit ontbreekt.',
    '',
    `Research-JSON:\n${JSON.stringify(s.research)}`,
    describeSources(s),
  ].join('\n');
  const payload = await askClaudeJson(system, prompt, FAST_WRITE_MODEL, 1500, INVALSHOEK_SCHEMA, false, `invalshoek#${topic.id}`);
  const tegenspraak = optionalString(payload.tegenspraak);
  // Poortvolgorde bewust omgedraaid t.o.v. de eerste versie: eerst publicabel,
  // dán tegenspraak. Een tegenspraak is alleen fataal als het model 'm zelf
  // zwaar genoeg vond om publicabel op false te zetten.
  if (payload.publicabel !== true) {
    const afwijzing = optionalString(payload.reden)
      || (tegenspraak ? `de research spreekt zichzelf tegen op een kernfeit: ${tegenspraak}` : 'de research bevat te weinig concreet verhaal');
    // Eénmalige herstelronde: terug naar research-aanvullend, met de
    // afwijsreden als querysturing. Meer dan één keer is zinloos — als ook de
    // gerichte ronde het gat niet dicht, is het gat echt.
    if ((s.invalshoekHerstelRounds ?? 0) < 1) {
      s.invalshoekHerstelRounds = 1;
      s.invalshoekAfwijzing = afwijzing;
      await saveTopicProgress(topic.id, { status: 'queued', phase: 'research-aanvullend', state: s });
      return {
        topic, phase: 'research-aanvullend', done: false,
        progress: `Invalshoek-poort: nog niet publicabel (${afwijzing.slice(0, 60)}) · gerichte herstelronde`,
      };
    }
    throw new Error(`Geen artikel waard volgens de invalshoek-poort, ook niet na een gerichte extra researchronde: ${afwijzing}.`);
  }
  // Publicabel: een eventuele herstel-sturing is niet meer nodig, en een
  // niet-blokkerende tegenspraak gaat als waarschuwing mee de schrijffase in
  // zodat het omstreden detail niet als feit in het artikel belandt.
  delete s.invalshoekAfwijzing;
  if (tegenspraak) s.invalshoekWaarschuwing = tegenspraak;
  const hoek = optionalString(payload.hoek);
  const beats = Array.isArray(payload.beats) ? payload.beats.filter((b): b is string => typeof b === 'string' && !!b.trim()).slice(0, 3) : [];
  // Publicabel zonder hoek is een halfslachtig antwoord; dan schrijven we
  // zoals voorheen, zonder invalshoek-blok, in plaats van een leeg blok mee
  // te sturen dat de schrijver in verwarring brengt.
  if (hoek) s.invalshoek = { hoek, beats };
  await saveTopicProgress(topic.id, { status: 'queued', phase: 'schrijf', state: s });
  return { topic, phase: 'schrijf', done: false, progress: hoek ? `Invalshoek: ${hoek.slice(0, 70)} · schrijven start` : 'Invalshoek onbepaald · schrijven start' };
}

// Het invalshoek-blok voor de schrijffase: de hoek als kapstok, de beats als
// verplichte dragers, plus (sinds de tegenspraak-fix) een eventuele
// niet-blokkerende tegenspraak als waarschuwing — het omstreden detail mag
// niet als feit in het artikel belanden. Leeg als de invalshoek-fase niets
// opleverde (of voor topics van vóór deze fase die al in de schrijffase
// hangen).
export function describeInvalshoek(s: StandaardState): string {
  const i = s.invalshoek;
  const waarschuwing = s.invalshoekWaarschuwing;
  if (!i?.hoek && !waarschuwing) return '';
  const regels: string[] = [''];
  if (i?.hoek) {
    regels.push(
      'INVALSHOEK (door de chef-redactie bepaald, verplicht aanhouden):',
      i.hoek,
      ...(i.beats.length ? ['Draag de invalshoek met deze story beats, verspreid over het artikel:', ...i.beats.map(b => `- ${b}`)] : []),
      'Open het artikel vanuit deze invalshoek, niet met een algemene beschrijving van de zaak.',
    );
  }
  if (waarschuwing) {
    regels.push(`LET OP: de bronnen spreken elkaar tegen op dit punt: ${waarschuwing}. Neem dit omstreden detail NIET als feit in het artikel op; laat het gewoon weg.`);
  }
  return regels.join('\n');
}

// Merge-regel van de aanvullende ronde: AANVULLEN, nooit overschrijven. De
// eerste ronde zag de officiële homepage en is door de entiteitsverificatie
// gekomen; de tweede ronde zoekt op deelaspecten en is dus per definitie
// minder gezaghebbend over de kern. Datumvelden en website blijven daarom
// volledig buiten schot: de event-poort en createDraft leunen erop, en de
// homepage-detectie van ronde 1 (officialUrl) is de betere bron.
// 'categories' hoort hier ook thuis: het is een array, maar géén feitenlijst
// die je mag aanvullen. Ronde 2 zou er een tweede categorie bij kunnen zetten
// en die belandt via createDraft echt in WordPress.
const NOOIT_OVERSCHRIJVEN = new Set(['start_datum', 'eind_datum', 'website', 'categories']);

function mergeResearch(doel: Record<string, unknown>, extra: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(extra)) {
    if (NOOIT_OVERSCHRIJVEN.has(key)) continue;
    if (key === 'quote' || key === 'missing_facts') continue; // apart afgehandeld
    if (Array.isArray(value)) {
      const nieuw = value.filter(v => typeof v === 'string' && v.trim()).map(v => (v as string).trim());
      const huidig = Array.isArray(doel[key]) ? (doel[key] as unknown[]).filter(v => typeof v === 'string' && (v as string).trim()).map(v => (v as string).trim()) : [];
      // Toevoegen en dedupliceren (hoofdletterongevoelig), volgorde behouden.
      const gezien = new Set(huidig.map(v => v.toLocaleLowerCase('nl-NL')));
      for (const item of nieuw) {
        const sleutel = item.toLocaleLowerCase('nl-NL');
        if (gezien.has(sleutel)) continue;
        gezien.add(sleutel);
        huidig.push(item);
      }
      doel[key] = huidig;
      continue;
    }
    if (typeof value === 'string') {
      if (!optionalString(doel[key]) && value.trim()) doel[key] = value.trim();
    }
  }
}

export interface EntityVerifyInput {
  // De wachtrijtitel: het onderwerp waarvoor dit artikel gevraagd is. Zonder
  // deze context kon de check een gekaapte website niet herkennen — naam,
  // adres en website van een verkeerd gekozen site zijn onderling immers
  // keurig consistent.
  onderwerp: string;
  naam: string;
  adres: string;
  website: string;
  rubriek: string;
  officialUrl: string | null;
  homepageContent: string;
}

export interface EntityVerifyResult {
  canonical_naam_locatie: string;
  entiteit_consistent: boolean;
  waarschuwing: string;
}

// Queue-onafhankelijke kern van de entiteitsverificatie: één goedkope Claude-
// call (FAST_WRITE_MODEL) die controleert of naam, adres en website bij één
// en dezelfde echte zaak of instelling horen, gegeven de gecrawlde officiële
// homepage, en de naam canoniseert (strip Google-Maps-achtige toevoegingen).
// Gooit door bij een fout — de aanroeper bepaalt zelf hoe fail-open te zijn.
// Gebruikt zowel door de research-fase van de queue (verifyEntity hieronder)
// als door de admin-backfill-route voor bestaande drafts.
// `label` is puur voor de tokenlogging (lib/tokenCost.ts): de queue geeft
// `entiteit#<topic-id>` mee, de backfill-route laat het op de default staan.
export async function verifyEntityFields(
  input: EntityVerifyInput, label = 'entiteit',
): Promise<EntityVerifyResult> {
  const { onderwerp, naam, adres, website, rubriek, officialUrl, homepageContent } = input;
  const system = 'Je bent verificatieredacteur voor amsterdamnow.com. Je controleert of de naam, het adres en de website die de research opleverde bij ÉÉN en dezelfde echte zaak of instelling horen — én of die zaak het gevraagde onderwerp is — op basis van de aangeleverde officiële homepage-tekst. Je verzint niets.';
  const prompt = [
    'Controleer de onderstaande entiteit en geef ALLEEN JSON terug.',
    '',
    `Gevraagd onderwerp (wachtrijtitel): ${onderwerp || '(onbekend)'}`,
    `Rubriek: ${rubriek || '(onbekend)'}`,
    `naam_locatie: ${naam || '(leeg)'}`,
    `adres: ${adres || '(leeg)'}`,
    `website: ${website || '(leeg)'}`,
    officialUrl ? `Officiële homepage-URL: ${officialUrl}` : 'Geen officiële homepage gevonden.',
    '',
    'Officiële homepage-tekst (kan leeg zijn):',
    homepageContent ? homepageContent.slice(0, 8000) : '(geen homepage-tekst beschikbaar)',
    '',
    'Bepaal:',
    '- canonical_naam_locatie: de echte, beknopte merk-/organisatienaam zoals die op de officiële site staat. Strip Google-Maps-achtige toevoegingen (keukentype, gerecht, plaatsnaam, "Museum"), bv. "Jinweide Lanzhou Beef Noodles Amsterdam Museum" wordt "Jinweide". Bij een evenement is dit de organiserende plek/instelling, niet de titel van het evenement. Leeg laten als je het niet betrouwbaar kunt bepalen.',
    '- entiteit_consistent: horen naam, adres en website bij dezelfde zaak, én hoort de homepage bij het GEVRAAGDE onderwerp hierboven? Een homepage van een andere partij dan het onderwerp zelf — een nieuwssite of blog die óver het onderwerp schrijft, een stadsgids, een ticket- of verzamelsite, een CDN — maakt de entiteit inconsistent, ook als naam en adres verder kloppen.',
    '- waarschuwing: korte NL-zin bij een probleem, anders lege string.',
  ].join('\n');
  const payload = await askClaudeJson(system, prompt, FAST_WRITE_MODEL, 1000, ENTITY_VERIFY_SCHEMA, false, label);
  return {
    canonical_naam_locatie: optionalString(payload.canonical_naam_locatie),
    entiteit_consistent: payload.entiteit_consistent === true,
    waarschuwing: optionalString(payload.waarschuwing),
  };
}

// Canoniseert naam_locatie op de topic-state en bewaart consistentie +
// waarschuwing, op basis van verifyEntityFields hierboven. FAIL-OPEN: bij een
// fout gaan we door met de originele waarden en een lege waarschuwing. Logt
// niets gevoeligs.
async function verifyEntity(
  s: StandaardState, officialUrl: string | null, homepageContent: string, topicId: number, onderwerp: string,
): Promise<void> {
  const r = s.research as Record<string, unknown> | undefined;
  if (!r) return;
  const naam = optionalString(r.naam_locatie);
  const adres = optionalString(r.adres);
  const website = optionalString(r.website);
  const rubriek = optionalString(r.rubriek);
  try {
    const result = await verifyEntityFields(
      { onderwerp, naam, adres, website, rubriek, officialUrl, homepageContent },
      `entiteit#${topicId}`,
    );
    if (result.canonical_naam_locatie) r.naam_locatie = result.canonical_naam_locatie;
    s.entiteitConsistent = result.entiteit_consistent;
    s.entiteitWaarschuwing = result.waarschuwing;
  } catch {
    // FAIL-OPEN: originele waarden behouden, geen waarschuwing.
    s.entiteitWaarschuwing = '';
  }
}

// Blijft de research ook ná de aanvullende ronde onder de drempel, dan mag het
// artikel korter (sparseContentWords). Topics van vóór deze fix hebben geen
// factScore in hun staat; die tellen nooit als dun en houden dus exact het
// oude gedrag — een halverwege de pipeline hangend topic mag hier niets van
// merken.
function isSparseResearch(s: StandaardState, c: StandaardConstraints): boolean {
  return typeof s.factScore === 'number' && s.factScore < c.minFactScore;
}

async function stepSchrijf(topic: Topic, s: StandaardState): Promise<StandaardStepResult> {
  if (!s.research) throw new Error('Research ontbreekt voor de schrijffase.');
  const [writePrompt, constraints] = await Promise.all([activePrompt('schrijf'), standaardConstraints()]);
  const sparse = isSparseResearch(s, constraints);
  const rules = describeStandaardConstraints(constraints, subjectName(topic, s), { sparse });
  // Bewust GEEN output-schema (constrained decoding) meer op de schrijfcall.
  // Token-voor-token grammatica-dwang slaat juist het creatieve werk plat —
  // precies waarom polishTitle bestaat: de titel werd al vrij hergenereerd
  // omdat de constrained versie vlak was. Nu krijgt het hele artikel die vrije
  // generatie; het extractJson-vangnet in claude.ts (incl. corrigerende
  // herkansing) vangt kapotte JSON op. Thinking blijft uit: op productie
  // getest (2026-07-20) liep de schrijfcall daarmee tegen afkap en de
  // 60s-functielimiet aan — zie de toelichting bij WRITE_MAX_TOKENS.
  const payload = await askClaudeJson(
    writePrompt.content,
    `Onderwerp: ${topic.title}\n\nGebruik uitsluitend deze gecontroleerde research van Tavily. Schrijf het artikel als geldige JSON volgens de actieve prompt.\n\nHoud je aan deze regels:\n${rules}\n\n${JSON.stringify(s.research)}${describeSources(s)}${describeInvalshoek(s)}${describeQuoteInstruction(s, constraints)}`,
    FAST_WRITE_MODEL, WRITE_MAX_TOKENS, undefined, false, `schrijf#${topic.id}`,
  );
  try {
    const candidate = buildCandidate(payload);
    // Voorbeeldzinnen uit de actieve prompt zelf: het model mag ze niet
    // letterlijk overnemen (zie validation.ts extractPromptExamples).
    validateArticle(candidate, subjectName(topic, s), constraints, extractPromptExamples(writePrompt.content), { sparse, sources: s.researchSources, quoteTekst: s.bronQuote?.tekst });
    // Titel apart, vrij (her)genereren voor meer punch — zie polishTitle. Nooit
    // slechter: valt terug op de zojuist gevalideerde titel als geen kandidaat
    // de keuring haalt.
    candidate.title = await polishTitle(candidate, s, subjectName(topic, s), constraints, topic.id);
    s.article = candidate;
    await saveTopicProgress(topic.id, { status: 'queued', phase: 'curator', state: s });
    return { topic, phase: 'curator', done: false, progress: 'Artikel geschreven en gevalideerd · stijlcurator' };
  } catch (e: any) {
    // Herkansing als eigen fase-stap (niet meer als 2e Claude-call binnen
    // dezelfde aanroep): een validatiefout (te weinig woorden, dash, quote
    // niet letterlijk, …) gaat mét afkeurreden en de vorige versie naar de
    // volgende tik, in plaats van het topic direct op "mislukt" te zetten.
    // De veld-tags gaan mee: faalden alleen titel en/of quote, dan probeert
    // stepSchrijfRetry eerst een gerichte reparatie (goedkope call) in plaats
    // van het hele artikel weg te gooien. De reparatie zit bewust in de
    // retry-tik en niet hier: de schrijfcall heeft dan al tot ~40s van de
    // 60s-functielimiet opgesnoept.
    s.draftPayload = payload;
    s.rejectReason = e.message;
    s.rejectReasons = [e.message];
    s.rejectViolations = e instanceof ArticleValidationError ? e.violations : undefined;
    await saveTopicProgress(topic.id, { status: 'queued', phase: 'schrijf-retry', state: s });
    return { topic, phase: 'schrijf-retry', done: false, progress: `Afgekeurd (${String(e.message).slice(0, 60)}…) · herkansing start` };
  }
}

// Alle afkeurredenen tot nu toe, nieuwste eerst en ontdubbeld. rejectReason
// staat er altijd bij (de curator zet alléén dat veld, zonder rejectReasons
// aan te raken); zo werkt de cumulatieve lijst ook voor afkeuringen die niet
// via de schrijf-catches lopen.
function cumulatieveRedenen(s: StandaardState): string[] {
  const alles = [...(s.rejectReasons ?? [])];
  if (s.rejectReason && !alles.includes(s.rejectReason)) alles.push(s.rejectReason);
  const uniek: string[] = [];
  for (const reden of alles.reverse()) {
    if (!uniek.includes(reden)) uniek.push(reden);
  }
  return uniek;
}

// De actuele meting van de vorige versie, naast de eis. Het model telt zelf
// niet betrouwbaar; zonder deze regel zag de retry alleen de laatste
// afkeurreden en oscilleerde hij tussen twee regels (titel 76 tekens →
// inkorten → 7 woorden → verlengen → weer te veel tekens). Defensief uit de
// ruwe payload gelezen: die kan velden missen als buildCandidate al faalde.
function beschrijfMeting(payload: Record<string, unknown>, c: StandaardConstraints, sparse: boolean): string {
  const veld = (key: string) => (typeof payload[key] === 'string' ? (payload[key] as string) : '');
  const titel = veld('title');
  const quote = veld('quote');
  const content = veld('content');
  const contentRange = sparse ? c.sparseContentWords : c.contentWords;
  const regels: string[] = [];
  if (titel) regels.push(`titel nu ${wordCount(titel)} woorden en ${titel.length} tekens (eis: ${c.titleWords.min}-${c.titleWords.max} woorden én maximaal ${c.titleMaxChars} tekens)`);
  if (quote) regels.push(`quote nu ${wordCount(quote)} woorden (eis: ${c.quoteWords.min}-${c.quoteWords.max})`);
  if (content) regels.push(`artikeltekst nu ${wordCount(content)} woorden (eis: ${contentRange.min}-${contentRange.max})`);
  return regels.length ? `\nActuele meting van je vorige versie: ${regels.join('; ')}.` : '';
}

// Kiest de alinea waarop de gerichte quote-reparatie mag werken: bij voorkeur
// de alinea die de quote letterlijk bevat (quoteMustBeVerbatimInContent eist
// dat die bestaat als alleen de lengte fout is), anders — bij een
// niet-verbatim-fout bestaat zo'n alinea per definitie niet — de alinea met de
// grootste woordoverlap met de quote.
function vindQuoteAlinea(content: string, quote: string): { index: number; alinea: string; letterlijk: boolean } | null {
  const alineas = content.split(/\n\s*\n/).map(a => a.trim()).filter(Boolean);
  if (!alineas.length) return null;
  const needle = normalizeForVerbatim(quote);
  const letterlijkIndex = alineas.findIndex(a => normalizeForVerbatim(a).includes(needle));
  if (letterlijkIndex !== -1) return { index: letterlijkIndex, alinea: alineas[letterlijkIndex], letterlijk: true };
  const quoteWoorden = new Set(needle.split(' ').filter(Boolean));
  let besteIndex = 0;
  let besteScore = -1;
  alineas.forEach((alinea, i) => {
    const score = normalizeForVerbatim(alinea).split(' ').filter(w => quoteWoorden.has(w)).length;
    if (score > besteScore) { besteScore = score; besteIndex = i; }
  });
  return { index: besteIndex, alinea: alineas[besteIndex], letterlijk: false };
}

// Gerichte quote-reparatie in de pipeline: dezelfde reparateur als de
// admin-backfills (vraagQuoteHerschrijving, de kern van rewriteQuote), maar
// dan op de platte artikeltekst van een nog niet gepubliceerd kandidaat-
// artikel. Omdat de quote woord voor woord in de content moet staan
// (quoteMustBeVerbatimInContent) is quote-reparatie altijd óók een
// content-reparatie: de bronalinea wordt mee herschreven. Gooit bij elke
// twijfel; de aanroeper valt dan terug op de volledige herschrijfronde.
async function herstelQuote(
  kandidaat: GeneratedArticle, s: StandaardState, constraints: StandaardConstraints,
  redenen: string[], verboden: string[], topicId: number,
): Promise<{ content: string; quote: string }> {
  const plek = vindQuoteAlinea(kandidaat.content, kandidaat.quote);
  if (!plek) throw new Error('Geen alinea gevonden om de quote-reparatie op uit te voeren.');
  // Staat de geverifieerde bronquote (een écht citaat van een betrokkene) in
  // deze alinea, dan moet die uitspraak daar woord voor woord blijven staan:
  // aan een echt citaat mag de reparatie nooit iets veranderen. De nieuwe
  // pull-quote wordt dan een redactiezin naast het citaat — precies wat
  // describeQuoteInstruction voorschrijft als de bronquote niet in het
  // quote-bereik past.
  const bronTekst = s.bronQuote?.tekst;
  const behoudLetterlijk = bronTekst && normalizeForVerbatim(plek.alinea).includes(normalizeForVerbatim(bronTekst)) ? bronTekst : undefined;
  const uitkomst = await vraagQuoteHerschrijving({
    titel: kandidaat.title,
    bestaandeQuote: kandidaat.quote,
    reden: `afgekeurd: ${redenen.join(' ') || 'voldoet niet aan de eisen'}`,
    bronParagraaf: plek.alinea,
    quoteStaatInParagraaf: plek.letterlijk,
    contextTekst: kandidaat.content.slice(0, 6000),
    minWords: constraints.quoteWords.min,
    maxWords: constraints.quoteWords.max,
    verboden,
    behoudLetterlijk,
    label: `quote-herstel#${topicId}`,
  });
  const alineas = kandidaat.content.split(/\n\s*\n/).map(a => a.trim()).filter(Boolean);
  alineas[plek.index] = uitkomst.paragraaf.trim();
  return { content: alineas.join('\n\n'), quote: uitkomst.quote };
}

async function stepSchrijfRetry(topic: Topic, s: StandaardState): Promise<StandaardStepResult> {
  if (!s.research || !s.draftPayload || !s.rejectReason) throw new Error('Onvolledige staat voor de herschrijfronde.');
  // Lokale referentie: TS verliest de narrowing van s.draftPayload na de
  // awaits hieronder, en de vorige versie is overal dezelfde.
  const vorigePayload = s.draftPayload;
  const [writePrompt, constraints] = await Promise.all([activePrompt('schrijf'), standaardConstraints()]);
  const sparse = isSparseResearch(s, constraints);
  const naam = subjectName(topic, s);
  const promptExamples = extractPromptExamples(writePrompt.content);
  const valideerOpts = { sparse, sources: s.researchSources, quoteTekst: s.bronQuote?.tekst };

  // Stap 1 — veldgerichte reparatie vóór de volledige herschrijfronde.
  // Faalden ALLEEN titel en/of quote, dan is het artikel zelf goed en is
  // hergeneratie zonde: de vorige aanpak gooide dan 400 gevalideerde woorden
  // weg om een kop van 76 tekens, en de verse versie kon op een nieuwe regel
  // stranden. polishTitle (keurt via checkTitle, inclusief de 70-tekens-grens)
  // en herstelQuote (herschrijft quote + bronalinea naar het juiste bereik,
  // inclusief de verbatim-eis) repareren gericht; daarna keurt validateArticle
  // het geheel opnieuw. Lukt de reparatie niet, dan valt de fase geruisloos
  // terug op de volledige herschrijfronde hieronder.
  const falendeVelden = new Set((s.rejectViolations ?? []).map(v => v.field));
  const alleenTitelOfQuote = falendeVelden.size > 0 && [...falendeVelden].every(f => f === 'title' || f === 'quote');
  if (alleenTitelOfQuote) {
    try {
      const kandidaat = buildCandidate(vorigePayload);
      // Altijd via polishTitle: bij een titelfout is dit de reparatie, bij een
      // quote-only-fout dezelfde punch-up die de gewone succesroute ook
      // krijgt. Nooit slechter: valt terug op de bestaande titel.
      kandidaat.title = await polishTitle(kandidaat, s, naam, constraints, topic.id);
      if (falendeVelden.has('quote')) {
        const quoteRedenen = (s.rejectViolations ?? []).filter(v => v.field === 'quote').map(v => v.message);
        const fix = await herstelQuote(kandidaat, s, constraints, quoteRedenen, promptExamples, topic.id);
        kandidaat.content = fix.content;
        kandidaat.quote = fix.quote;
      }
      validateArticle(kandidaat, naam, constraints, promptExamples, valideerOpts);
      s.article = kandidaat;
      s.draftPayload = undefined;
      s.rejectReason = undefined;
      s.rejectReasons = undefined;
      s.rejectViolations = undefined;
      s.schrijfAttempts = undefined;
      await saveTopicProgress(topic.id, { status: 'queued', phase: 'curator', state: s });
      return { topic, phase: 'curator', done: false, progress: 'Gericht gerepareerd (titel/quote) · stijlcurator' };
    } catch {
      // Reparatie niet gelukt of het geheel keurt alsnog af: door naar de
      // volledige herschrijfronde, met alle redenen op een rij.
    }
  }

  // Stap 2 — volledige herschrijfronde, met álle afkeurredenen én de actuele
  // meting. Alleen de laatste reden meegeven veroorzaakte oscillatie: het
  // model loste "te lang" op door te kort te worden en andersom.
  const rules = describeStandaardConstraints(constraints, naam, { sparse });
  const redenen = cumulatieveRedenen(s);
  const redenenBlok = redenen.length === 1
    ? `Afkeurreden: ${redenen[0]}`
    : `Afkeurredenen (nieuwste eerst; ook de oudere blijven gelden):\n${redenen.map((r, i) => `${i + 1}. ${r}`).join('\n')}`;
  const payload = await askClaudeJson(
    writePrompt.content,
    `Je vorige versie van dit artikel is afgekeurd door de eindredactie.\n\nOnderwerp: ${topic.title}\n${redenenBlok}${beschrijfMeting(vorigePayload, constraints, sparse)}\n\nLever het VOLLEDIGE artikel opnieuw aan als JSON met exact dezelfde velden (title, subregel, introductie_tekst, content, quote). Los ALLE afkeurredenen tegelijk op en houd de rest zoveel mogelijk intact; een eerdere afkeurreden opnieuw introduceren betekent opnieuw afgekeurd. Alle regels blijven gelden:\n${rules}\n\nJe vorige versie:\n${JSON.stringify(vorigePayload)}${describeSources(s)}${describeInvalshoek(s)}${describeQuoteInstruction(s, constraints)}`,
    FAST_WRITE_MODEL, WRITE_MAX_TOKENS, undefined, false, `schrijf-retry#${topic.id}`,
  );
  let checked: GeneratedArticle;
  try {
    checked = buildCandidate(payload);
    validateArticle(checked, naam, constraints, promptExamples, valideerOpts);
  } catch (e: any) {
    // Elke herkansing is sinds de fase-opsplitsing een eigen serverless-tick,
    // dus meerdere rondes kunnen veilig (zelfde patroon als composeAttempts in
    // listWriter.ts). Afkeuringen zijn vaak randmissers (intro 38/40 woorden,
    // quote 14/15); een extra ronde mét de nieuwe afkeurreden redt die bijna
    // altijd, tegen de prijs van één extra call — alleen bij falen.
    const attempts = (s.schrijfAttempts || 0) + 1;
    if (attempts >= MAX_SCHRIJF_HERKANSINGEN) {
      throw new Error(`${e.message} (ook na ${attempts} herschrijfrondes)`);
    }
    s.schrijfAttempts = attempts;
    s.draftPayload = payload;
    s.rejectReason = e.message;
    s.rejectReasons = [...redenen].reverse().concat(redenen.includes(e.message) ? [] : [e.message]);
    s.rejectViolations = e instanceof ArticleValidationError ? e.violations : undefined;
    await saveTopicProgress(topic.id, { status: 'queued', phase: 'schrijf-retry', state: s });
    return { topic, phase: 'schrijf-retry', done: false, progress: `Afgekeurd (${String(e.message).slice(0, 60)}…) · herkansing ${attempts + 1} start` };
  }
  checked.title = await polishTitle(checked, s, naam, constraints, topic.id);
  s.article = checked;
  s.draftPayload = undefined;
  s.rejectReason = undefined;
  s.rejectReasons = undefined;
  s.rejectViolations = undefined;
  s.schrijfAttempts = undefined;
  await saveTopicProgress(topic.id, { status: 'queued', phase: 'curator', state: s });
  return { topic, phase: 'curator', done: false, progress: 'Artikel geschreven en gevalideerd · stijlcurator' };
}

// Stijlcurator-fase: één beoordelingscall op het af-gevalideerde artikel,
// vóór SEO en de WordPress-draft. validateArticle toetst de harde regels
// (woordaantallen, dashes, sjabloonzinnen, lekken); wat daar doorheen komt
// kan alsnog nietszeggend zijn — de kalibratie van 25-07 vond drie soorten
// artikelen die formeel geldig waren maar niets vertelden. De curator toetst
// wat regels niet kunnen: staat er in elke alinea iets dat niet ook op de
// homepage van de zaak staat, is de toon local-to-local, en is er geen
// opgeblazen vulling. Afkeuring gaat mét concrete instructie de bestaande
// schrijf-retry in; hooguit één curatorronde (curatorRounds), daarna gaat de
// beste versie fail-open door — het blijft een draft die de redactie ziet.
async function stepCurator(topic: Topic, s: StandaardState): Promise<StandaardStepResult> {
  if (!s.research || !s.article) throw new Error('Onvolledige staat voor de curator-fase.');
  const a = s.article;
  const rondes = s.curatorRounds ?? 0;
  try {
    const system = 'Je bent stijlcurator van amsterdamnow.com, een stadsgids door en voor Amsterdammers. Je beoordeelt of een artikel écht iets vertelt, in de toon waarmee de ene local de andere tipt. Je herschrijft niet zelf; je keurt en geeft concrete aanwijzingen.';
    const prompt = [
      'Beoordeel dit artikel en geef ALLEEN JSON terug.',
      '',
      'Keur af ("herschrijven") bij een of meer van deze problemen:',
      '- een alinea die alleen sfeer- of marketingtaal bevat, zonder één concreet feit (naam, aantal, gerecht, jaartal, plek);',
      '- zinnen die de zaak naspreken zoals de zaak zichzelf verkoopt ("een unieke beleving", "voor ieder wat wils", opgeblazen missietaal);',
      '- VVV-toon: uitleggen wat een buurt of fenomeen is alsof de lezer geen Amsterdammer is;',
      '- vulling: zinnen die niets toevoegen aan wat er al stond, of hetzelfde punt twee keer maken;',
      '- een opening of afsluiting die boven elk willekeurig artikel zou kunnen staan.',
      '',
      'Keur goed ("goed") als het artikel concreet, specifiek en nuchter is. Wees streng op inhoud, niet op smaak: een sobere maar feitelijke tekst is goed; een zwierige maar lege tekst niet.',
      '',
      `TITEL: ${a.title}`,
      `SUBREGEL: ${a.subregel}`,
      `INTRODUCTIE: ${a.introductie_tekst}`,
      `ARTIKELTEKST:\n${a.content}`,
      `QUOTE: ${a.quote}`,
      '',
      `Ter referentie de research (het artikel mag hier niets aan toevoegen):\n${JSON.stringify(s.research)}`,
    ].join('\n');
    const payload = await askClaudeJson(system, prompt, FAST_WRITE_MODEL, 1200, CURATOR_SCHEMA, false, `curator#${topic.id}`);
    const problemen = Array.isArray(payload.problemen) ? payload.problemen.filter((p): p is string => typeof p === 'string' && !!p.trim()) : [];
    if (payload.oordeel === 'herschrijven' && problemen.length && rondes < 1) {
      s.curatorRounds = rondes + 1;
      s.draftPayload = { ...a };
      s.rejectReason = `Stijlcurator: ${problemen.join(' · ')}${optionalString(payload.herschrijfinstructie) ? ` — ${optionalString(payload.herschrijfinstructie)}` : ''}`;
      await saveTopicProgress(topic.id, { status: 'queued', phase: 'schrijf-retry', state: s });
      return { topic, phase: 'schrijf-retry', done: false, progress: `Curator keurt af (${problemen.length} punt${problemen.length === 1 ? '' : 'en'}) · herschrijven` };
    }
  } catch {
    // FAIL-OPEN: de curator is een kwaliteitspoort op een draft, geen reden om
    // een verder afgerond topic te laten mislukken.
  }
  await saveTopicProgress(topic.id, { status: 'queued', phase: 'seo', state: s });
  return { topic, phase: 'seo', done: false, progress: rondes ? 'Curator klaar (na herschrijfronde) · SEO en draft' : 'Curator akkoord · SEO en draft' };
}

async function stepSeo(topic: Topic, s: StandaardState): Promise<StandaardStepResult> {
  if (!s.research || !s.article) throw new Error('Onvolledige staat voor de SEO-fase.');
  // Herkans-check vlak vóór de draft: topics kunnen lang in de wachtrij staan,
  // dus de bij-invoer-check (POST /api/topics) kan intussen verouderd zijn.
  // Force-toegevoegde topics (dedup_override) slaan deze over. Zie
  // docs/superpowers/specs/2026-07-21-wp-dedup-index-design.md §4.
  if (!topic.dedup_override) {
    const dedup = await checkTopicAgainstWp(topic.title);
    if (dedup.verdict === 'duplicate' && dedup.existing) {
      throw new Error(`Duplicaat van bestaand artikel: ${dedup.existing.link}`);
    }
  }
  const { title, subregel, introductie_tekst: intro, content, quote } = s.article;
  const seoPrompt = await activePrompt('seo');
  const seo = await askClaudeJson(
    seoPrompt.content,
    `POST_TITLE: ${title}\nPOST_EXCERPT: ${intro}\nPOST_CONTENT: ${content}\nCATEGORY: ${nonEmptyStrings(s.research.categories, 'categories').join(', ')}\nDISTRICT: ${string(s.research.district, 'district')}`,
    FAST_WRITE_MODEL, 6000, SEO_SCHEMA, false, `seo#${topic.id}`,
  );
  const draft = await createDraft({
    title, subregel, intro, contentHtml: formatStandardArticleHtml(content, quote, bronAttributie(s, quote)), quote,
    focusKeyword: string(seo.rank_math_focus_keyword, 'rank_math_focus_keyword'),
    slug: string(seo.slug, 'slug'),
    seoTitle: string(seo.rank_math_title, 'rank_math_title'),
    metaDescription: string(seo.rank_math_description, 'rank_math_description'),
    categories: nonEmptyStrings(s.research.categories, 'categories'),
    district: string(s.research.district, 'district'),
    tags: singleTag(s.research),
    rubriek: string(s.research.rubriek, 'rubriek'),
    naamLocatie: string(s.research.naam_locatie, 'naam_locatie'),
    // adres en website mogen leeg zijn: niet elk onderwerp heeft een betrouwbaar
    // adres of homepage, en een verzonnen invulling is erger dan een leeg veld.
    adres: optionalString(s.research.adres),
    stad: string(s.research.stad, 'stad'),
    website: optionalString(s.research.website),
    startDatum: optionalIsoDate(s.research.start_datum),
    eindDatum: optionalIsoDate(s.research.eind_datum),
  });
  await completeTopic(topic.id, draft.id);
  return { topic, phase: 'seo', done: true, progress: 'Draft aangemaakt', article: { id: draft.id, title: draft.title } };
}

// ---------- quote-lengte backfill (admin) ----------
//
// Hulpfuncties voor de backfill-quote-length-route: verlengt een bestaande,
// te korte pull-quote (< 25 woorden, uit "Klaar"-drafts van vóór de
// quoteWords-regel) naar 25-40 woorden. validation.ts wordt hier bewust NIET
// aangeroerd (buiten de toegestane bestanden voor deze backfill) — words()
// en de quoteMustBeVerbatimInContent-vergelijking staan daar niet als losse
// export, dus die kleine, pure berekeningen worden hier 1-op-1 herhaald.

// Zelfde telling als validation.ts words(): tags eruit, op witruimte splitsen.
function wordCount(value: string): number {
  return value.replace(/<[^>]*>/g, ' ').trim().split(/\s+/).filter(Boolean).length;
}

// Zelfde normalisatie als validation.ts normal(): voor een hoofdletter- en
// leesteken-ongevoelige "komt letterlijk voor"-vergelijking.
function normalizeForVerbatim(value: string): string {
  return value.toLocaleLowerCase('nl-NL').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function plainText(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function escapeQuoteHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Top-level content-blokken van de artikeltekst. Lokale kopie van hetzelfde
// idee als BLOCK_RE in wp.ts (dat bestand mag voor deze backfill niet
// gewijzigd worden en exporteert die regex niet).
const CONTENT_BLOCK_RE = /<(p|h[1-6]|blockquote)\b[^>]*>[\s\S]*?<\/\1>/gi;

export interface ExistingQuoteBlock {
  quoteText: string;      // platte, gedecodeerde tekst van de bestaande blockquote
  blockquoteHtml: string; // het volledige <blockquote>...</blockquote>-blok, letterlijk uit contentHtml
  paragraphHtml: string;  // het bronparagraaf-blok (incl. tag), letterlijk uit contentHtml — bevat de quote woord voor woord
  paragraphTag: string;   // 'p', 'h2', ... — voor het herbouwen van het blok met dezelfde tag
}

// Vindt de bestaande blockquote plus de paragraaf die de quote letterlijk
// bevat (de "bronparagraaf" — zoals formatStandardArticleHtml/validateArticle
// die eis stellen: de quote moet woord voor woord in de artikeltekst
// voorkomen). Geeft null als er geen blockquote is, of als geen enkele
// andere paragraaf de quote letterlijk bevat — dan is de structuur niet
// betrouwbaar genoeg om veilig te herschrijven en slaat de aanroeper het
// artikel over.
export function findExistingQuoteBlock(contentHtml: string): ExistingQuoteBlock | null {
  const blocks = [...(contentHtml || '').matchAll(CONTENT_BLOCK_RE)].map(m => ({ html: m[0], tag: m[1].toLowerCase() }));
  const bqIndex = blocks.findIndex(b => b.tag === 'blockquote');
  if (bqIndex === -1) return null;
  const blockquoteHtml = blocks[bqIndex].html;
  const quoteText = plainText(blockquoteHtml);
  if (!quoteText) return null;
  const needle = normalizeForVerbatim(quoteText);
  if (!needle) return null;
  const source = blocks.find((b, i) => i !== bqIndex && b.tag !== 'blockquote' && normalizeForVerbatim(plainText(b.html)).includes(needle));
  if (!source) return null;
  return { quoteText, blockquoteHtml, paragraphHtml: source.html, paragraphTag: source.tag };
}

export interface QuoteRewriteOutcome {
  html: string;  // nieuwe, volledige content-HTML (bronparagraaf + blockquote vervangen)
  quote: string; // de nieuwe quote (25-40 woorden)
}

// Herschrijft een te korte pull-quote naar 25-40 woorden en past de
// bronparagraaf zo aan dat de nieuwe quote daar ook woord voor woord
// letterlijk in staat — dezelfde eis (quoteMustBeVerbatimInContent) als bij
// nieuw geschreven artikelen. Eén goedkope Claude-call (FAST_WRITE_MODEL).
// Gooit door bij elke fout of als de uitkomst niet aan de eisen voldoet; de
// aanroeper (backfill-quote-length-route) vangt dat af en slaat het artikel
// dan over — bij twijfel liever skippen dan een artikel fout herschrijven.
export interface RewriteQuoteOptions {
  // Waarom de bestaande quote weg moet, in de opdracht aan het model. Standaard
  // "te kort" (de oorspronkelijke backfill); de voorbeeldzin-backfill geeft hier
  // zijn eigen reden mee.
  reden?: string;
  // Zinnen die de nieuwe quote niet mag hergebruiken (voorbeeldzinnen uit de
  // prompt). Wordt na de call hard gecontroleerd, niet alleen gevraagd.
  verbodenZinnen?: string[];
}

// Invoer voor de gedeelde reparatiecall hieronder. `quoteStaatInParagraaf`
// stuurt alleen de kopregel boven de alinea: de backfills werken per definitie
// op een alinea die de quote letterlijk bevat, de pipeline kan ook een
// niet-verbatim-fout aanleveren. `behoudLetterlijk` is een uitspraak (de
// geverifieerde bronquote) die de herschreven alinea woord voor woord moet
// blijven bevatten — aan een echt citaat verandert de reparatie niets.
interface QuoteHerschrijfInput {
  titel: string;
  bestaandeQuote: string;
  reden: string;
  bronParagraaf: string;
  quoteStaatInParagraaf: boolean;
  contextTekst: string;
  minWords: number;
  maxWords: number;
  verboden: string[];
  behoudLetterlijk?: string;
  label: string;
}

// Gedeelde kern van de quote-reparatie: één goedkope Claude-call
// (FAST_WRITE_MODEL) die de afgekeurde quote herschrijft naar het gevraagde
// woordbereik én de bronalinea zo aanpast dat de nieuwe quote daar woord voor
// woord letterlijk in staat. Gebruikt door rewriteQuote (admin-backfills, op
// content-HTML) en herstelQuote (pipeline, op platte artikeltekst). Gooit
// zodra de uitkomst niet aan de harde eisen voldoet; de aanroeper bepaalt de
// terugval.
async function vraagQuoteHerschrijving(input: QuoteHerschrijfInput): Promise<{ quote: string; paragraaf: string }> {
  const system = 'Je bent eindredacteur van amsterdamnow.com, een lokale stadsgids door en voor Amsterdammers. Je herschrijft een afgekeurde pull-quote naar een sterkere quote die zowel als losstaande pull-quote als in de lopende tekst goed leest. Nuchtere, informele toon, geen marketingtaal, je verzint geen nieuwe feiten.';
  const prompt = [
    `Artikel: ${input.titel}`,
    '',
    `Bestaande (${input.reden}) quote: "${input.bestaandeQuote}"`,
    '',
    input.quoteStaatInParagraaf
      ? 'Bronparagraaf (bevat de quote letterlijk):'
      : 'Bronparagraaf (de alinea die inhoudelijk het dichtst bij de quote ligt; de quote staat er nu níet letterlijk in):',
    input.bronParagraaf,
    '',
    'Volledige artikeltekst, ter context (pas alleen de bronparagraaf hierboven aan):',
    input.contextTekst,
    '',
    'Opdracht:',
    `- Herschrijf de quote naar ${input.minWords}-${input.maxWords} woorden. Behoud de kernboodschap en toon; voeg geen nieuwe feiten toe die niet al in de tekst staan.`,
    '- Herschrijf de bronparagraaf zo dat de NIEUWE quote daar woord voor woord letterlijk in voorkomt, net als de oorspronkelijke opzet. Lopende tekst, geen opsomming.',
    ...(input.behoudLetterlijk
      ? [`- Deze letterlijke uitspraak uit de bronnen staat in de alinea en moet daar woord voor woord blijven staan, inclusief attributie: "${input.behoudLetterlijk}"`]
      : []),
    '- Geen em dash (—) of en dash (–).',
    '- Geen vraag en geen meta-taal ("zoals hij zelf zegt", etc.) in de quote zelf.',
    ...(input.verboden.length
      ? [
          '- De nieuwe quote gaat over DIT artikel en deze zaak. Hergebruik geen van deze zinnen, ook niet gedeeltelijk:',
          ...input.verboden.map(z => `  · "${z}"`),
        ]
      : []),
    '',
    'Antwoord ALLEEN met JSON: "quote" (de nieuwe quote) en "herschreven_paragraaf" (de volledige, aangepaste bronparagraaf).',
  ].join('\n');

  const payload = await askClaudeJson(system, prompt, FAST_WRITE_MODEL, 1200, QUOTE_REWRITE_SCHEMA, false, input.label);
  const quote = string(payload.quote, 'quote');
  const paragraaf = string(payload.herschreven_paragraaf, 'herschreven_paragraaf');

  const count = wordCount(quote);
  if (count < input.minWords || count > input.maxWords) {
    throw new Error(`Herschreven quote is ${count} woorden; moet ${input.minWords}-${input.maxWords} zijn.`);
  }
  if (!normalizeForVerbatim(paragraaf).includes(normalizeForVerbatim(quote))) {
    throw new Error('Herschreven quote staat niet letterlijk in de herschreven bronparagraaf.');
  }
  if (input.behoudLetterlijk && !normalizeForVerbatim(paragraaf).includes(normalizeForVerbatim(input.behoudLetterlijk))) {
    throw new Error('De letterlijke bronuitspraak is uit de herschreven alinea verdwenen.');
  }
  return { quote, paragraaf };
}

export async function rewriteQuote(article: Article, contentHtml: string, opts: RewriteQuoteOptions = {}): Promise<QuoteRewriteOutcome> {
  const block = findExistingQuoteBlock(contentHtml);
  if (!block) throw new Error('Geen herkenbare quote-structuur (blockquote + bronparagraaf) gevonden.');

  const constraints = await activeConstraints('standaard');
  const { min: minWords, max: maxWords } = constraints.quoteWords;
  const verboden = opts.verbodenZinnen?.filter(Boolean) || [];

  const { quote, paragraaf: herschrevenParagraaf } = await vraagQuoteHerschrijving({
    titel: article.title,
    bestaandeQuote: block.quoteText,
    reden: opts.reden || 'te korte',
    bronParagraaf: plainText(block.paragraphHtml),
    quoteStaatInParagraaf: true,
    contextTekst: plainText(contentHtml).slice(0, 6000),
    minWords,
    maxWords,
    verboden,
    label: `quote#${article.id}`,
  });

  const newParagraphHtml = `<${block.paragraphTag}>${herschrevenParagraaf.replace(/\n/g, '<br>')}</${block.paragraphTag}>`;
  const newBlockquoteHtml = `<blockquote><p>${escapeQuoteHtml(plainText(quote))}</p></blockquote>`;
  const html = contentHtml.replace(block.paragraphHtml, newParagraphHtml).replace(block.blockquoteHtml, newBlockquoteHtml);

  // Eindcontrole tegen de VOLLEDIGE nieuwe content (niet alleen de paragraaf),
  // als laatste vangnet vóór de aanroeper wegschrijft — exact dezelfde eis als
  // quoteMustBeVerbatimInContent in validation.ts validateArticle.
  if (constraints.quoteMustBeVerbatimInContent && !normalizeForVerbatim(plainText(html)).includes(normalizeForVerbatim(quote))) {
    throw new Error('De nieuwe quote staat niet letterlijk in de nieuwe artikeltekst.');
  }
  // Harde controle in plaats van vertrouwen op de instructie: staat er ergens in
  // het nieuwe artikel nog een voorbeeldzin, dan is de herschrijving mislukt en
  // slaat de aanroeper het artikel over.
  const restLeak = findPromptExampleLeak(plainText(html), verboden);
  if (restLeak) throw new Error(`Voorbeeldzin staat na het herschrijven nog in het artikel: "${restLeak}".`);

  return { html, quote };
}
