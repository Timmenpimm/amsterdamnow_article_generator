import { activeConstraints, activePrompt, completeTopic, failTopic, saveTopicProgress } from './db';
import { askClaudeJson, FAST_WRITE_MODEL, TITLE_MODEL } from './claude';
import { RESEARCH_SCHEMA, ARTICLE_SCHEMA, SEO_SCHEMA, ENTITY_VERIFY_SCHEMA, QUOTE_REWRITE_SCHEMA } from './schemas';
import { createDraft, singleTag, taxonomyChoices } from './wp';
import { checkTopicAgainstWp } from './dedup';
import { researchWithTavily, type ResearchSource } from './tavily';
// GeneratedArticle expliciet als type importeren: de testrunner draait op
// --experimental-strip-types en die kan een type niet als waarde-import
// oplossen ("does not provide an export named GeneratedArticle").
import { validateArticle, checkTitle, quoteSourceAllowed, standaardQuoteSourceBlacklist, extractPromptExamples, findPromptExampleLeak, type GeneratedArticle } from './validation';
import { DEFAULT_STANDAARD_CONSTRAINTS, parseStandaardState, type Article, type StandaardConstraints, type StandaardPhase, type StandaardState, type Topic, type WordRange } from './types';
import { formatStandardArticleHtml } from './articleHtml';
import { decodeHtmlEntities } from './htmlEntities';
import { amsterdamToday, eventEndReference, isPastEvent } from './eventDate';
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
  const lines = [
    `- Titel: ${c.titleWords.min}-${c.titleWords.max} woorden${c.titleMustContainTopic ? `, met daarin letterlijk: "${naam}"` : ''}.`,
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

// Neemt de quote uit de research alleen over als er écht een uitspraak mét
// bron staat én die bron niet op de blacklist staat (concurrerende stadsgidsen
// citeren is de facto overschrijven). Alles wat niet aan die vorm voldoet
// wordt null: geen quote is beter dan een quote van onduidelijke herkomst.
function acceptBronQuote(value: unknown, constraints: StandaardConstraints): StandaardState['bronQuote'] {
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
    topic.phase === 'research-aanvullend' || topic.phase === 'schrijf' || topic.phase === 'schrijf-retry' || topic.phase === 'seo'
      ? topic.phase : 'research';
  try {
    switch (phase) {
      case 'research': return await stepResearch(topic, s);
      case 'research-aanvullend': return await stepResearchAanvullend(topic, s);
      case 'schrijf': return await stepSchrijf(topic, s);
      case 'schrijf-retry': return await stepSchrijfRetry(topic, s);
      case 'seo': return await stepSeo(topic, s);
    }
  } catch (error: any) {
    await failTopic(topic.id, error.message || 'Onbekende fout', `standaardfase: ${phase}`);
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
async function polishTitle(article: GeneratedArticle, s: StandaardState, naam: string, constraints: StandaardConstraints): Promise<string> {
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
    `- ${constraints.titleWords.min}-${constraints.titleWords.max} woorden.`,
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
    '- BOLIA aan de Utrechtsestraat brengt Deens design met koffie en maatwerk',
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
    const payload = await askClaudeJson(system, prompt, TITLE_MODEL, 600);
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
  const { sources, officialUrl } = await researchWithTavily(topic.title);
  // Research = feiten extraheren uit aangeleverde bronnen, geen creatief werk:
  // Sonnet 5 volstaat en kost een fractie van Opus (zie FAST_WRITE_MODEL in
  // lib/claude.ts). Bronnen worden hier ook getrimd op 8000 tekens — relevante
  // info zoals adres/feiten staat doorgaans vooraan in de geëxtraheerde
  // content (zie VERIFY_SOURCE_CHARS in listWriter.ts voor dezelfde afweging).
  const research = await askClaudeJson(
    researchPrompt.content,
    `Onderwerp: ${topic.title}\n\nVandaag is ${amsterdamToday()} (Europe/Amsterdam).\n\nBeschikbare WordPress-categorieën: ${taxonomies.categories.join(', ')}\nBeschikbare WordPress-districten: ${taxonomies.districts.join(', ')}\nBeschikbare WordPress-tags: ${taxonomies.tags.join(', ')}\nKies precies één "tag" uit deze lijst: de best passende. Verzin nooit een nieuwe tag. Past geen enkele bestaande tag echt goed, geef dan "" terug.\n\nGaat dit onderwerp over een event, tentoonstelling, festival of ander tijdelijk programma, geef dan de looptijd als "start_datum" en "eind_datum" in JJJJ-MM-DD, letterlijk overgenomen uit de bronnen. Bij een eendaags event is eind_datum gelijk aan start_datum.\n\nNoemt een bron een slotdatum ("t/m 29 juni 2026", "loopt tot en met…", "te zien tot…"), vul die dan ALTIJD in als eind_datum — ook als de tentoonstelling al maanden loopt, en ook als die datum inmiddels verstreken is. Die datum bepaalt of wij het onderwerp nog mogen publiceren; hem weglaten of doorschuiven is een fout. Alleen bij een vaste zaak (restaurant, winkel, museum als instelling) of nieuws zonder looptijd laat je beide velden leeg ("").\n\nTavily-bronnen:\n${sources.map((src, i) => `\n[${i + 1}] ${src.title}\n${src.url}\n${src.content.slice(0, 8000)}`).join('\n')}`,
    FAST_WRITE_MODEL, 6000, RESEARCH_SCHEMA,
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
  // De homepage/origin is de betrouwbaarste bron voor de website: overschrijf
  // altijd met de gedetecteerde origin (de site-root, geen diepe link) wanneer
  // die bekend is. Alleen zonder officialUrl vertrouwen we op wat het model gaf.
  if (officialUrl) (research as Record<string, unknown>).website = officialUrl;
  s.research = research;
  // Entiteitsverificatie: controleer dat naam_locatie, adres en website bij
  // dezelfde echte zaak horen (en canoniseer de naam) op basis van de gecrawlde
  // officiële homepage. Fail-open: bij een hapering blijven de originele waarden
  // staan. Moet vóór saveTopicProgress zodat de gecorrigeerde staat wordt bewaard.
  const homepageContent = officialUrl ? (sources.find(src => src.url === officialUrl)?.content ?? '') : '';
  await verifyEntity(s, officialUrl, homepageContent);
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
  // heeft de score nodig.
  s.researchSources = trimSources(sources);
  s.missingFacts = missingFactsOf(research);
  s.factScore = researchFactScore(research);
  s.researchRounds = 1;
  s.bronQuote = acceptBronQuote(research.quote, constraints);
  // Sufficiëntie-poort: te dunne research ging tot nu toe gewoon door naar de
  // schrijffase, waar het model het tekort opvulde met verzonnen details. Nu
  // is er een weg terug naar Tavily — hooguit één keer (researchRounds).
  if (s.factScore < constraints.minFactScore && (s.researchRounds ?? 1) < 2) {
    await saveTopicProgress(topic.id, { status: 'queued', phase: 'research-aanvullend', state: s });
    return { topic, phase: 'research-aanvullend', done: false, progress: `Research te dun (${s.factScore}/${constraints.minFactScore}) · extra ronde` };
  }
  await saveTopicProgress(topic.id, { status: 'queued', phase: 'schrijf', state: s });
  return { topic, phase: 'schrijf', done: false, progress: 'Research klaar · schrijven start' };
}

// Aanvullende researchronde: gericht zoeken op wat de eerste ronde niet vond.
// Bewust bescheiden binnen de 60s-limiet — hooguit twee Tavily-calls en één
// Claude-call — en volledig fail-open: gaat hier iets mis, dan schrijven we met
// wat we al hebben, want het topic heeft al bruikbare research.
async function stepResearchAanvullend(topic: Topic, s: StandaardState): Promise<StandaardStepResult> {
  if (!s.research) throw new Error('Research ontbreekt voor de aanvullende researchronde.');
  const r = s.research as Record<string, unknown>;
  const constraints = await standaardConstraints();
  let gevonden = 0;
  try {
    const naam = optionalString(r.naam_locatie) || topic.title;
    // Adres is specifieker dan de stad (twee vestigingen met dezelfde naam), dus
    // die krijgt voorrang als plaatsbepaling in de zoekterm.
    const plaats = optionalString(r.adres) || optionalString(r.stad) || 'Amsterdam';
    // Hooguit twee queries: elke query is een Tavily-call van enkele seconden.
    // Zonder bekende gaten vallen we terug op de twee dingen die vrijwel elk
    // artikel nodig heeft en die het vaakst ontbraken: praktische info en een
    // uitspraak van een betrokkene.
    const gaten = (s.missingFacts ?? []).slice(0, 2);
    const queries = (gaten.length ? gaten.map(gat => `${naam} ${plaats} ${gat}`) : [
      `${naam} ${plaats} openingstijden`,
      `${naam} interview eigenaar`,
    ]).slice(0, 2);

    // De twee zoekopdrachten tegelijk: ze zijn onafhankelijk, en er moet in
    // deze tik ook nog een Claude-extractie bij binnen de 60s. allSettled i.p.v.
    // all, want een mislukte tweede query mag de opbrengst van de eerste niet
    // weggooien. Dedupliceren gebeurt daarna in queryvolgorde, zodat de uitkomst
    // niet afhangt van welke call het eerst terug is.
    const uitkomsten = await Promise.allSettled(
      queries.map(query => researchWithTavily(topic.title, { query, maxResults: 3 })),
    );
    const bekend = new Set((s.researchSources ?? []).map(src => src.url.replace(/\/+$/, '').toLowerCase()));
    const nieuw: ResearchSource[] = [];
    for (const uitkomst of uitkomsten) {
      if (uitkomst.status !== 'fulfilled') continue;
      for (const src of uitkomst.value.sources) {
        const key = src.url.replace(/\/+$/, '').toLowerCase();
        if (bekend.has(key)) continue;
        bekend.add(key);
        nieuw.push(src);
      }
    }
    gevonden = nieuw.length;

    if (nieuw.length) {
      const bestaand = s.researchSources ?? [];
      const nieuwGetrimd = trimSources(nieuw);
      const [researchPrompt, taxonomies] = await Promise.all([activePrompt('research'), taxonomyChoices()]);
      const alle = [...bestaand, ...nieuwGetrimd];
      const extra = await askClaudeJson(
        researchPrompt.content,
        `Onderwerp: ${topic.title}\n\nVandaag is ${amsterdamToday()} (Europe/Amsterdam).\n\nBeschikbare WordPress-categorieën: ${taxonomies.categories.join(', ')}\nBeschikbare WordPress-districten: ${taxonomies.districts.join(', ')}\nBeschikbare WordPress-tags: ${taxonomies.tags.join(', ')}\nKies precies één "tag" uit deze lijst: de best passende. Verzin nooit een nieuwe tag. Past geen enkele bestaande tag echt goed, geef dan "" terug.\n\nDit is een AANVULLENDE ronde: er is al research gedaan, maar deze feiten ontbraken nog: ${(s.missingFacts ?? []).join(', ') || '(niet gespecificeerd)'}. Let vooral op die punten. Verzin nooit iets: staat het niet in de bronnen, laat het veld leeg en zet het in "missing_facts".\n\nBronnen:\n${alle.map((src, i) => `\n[${i + 1}] ${src.title}\n${src.url}\n${src.content}`).join('\n')}`,
        FAST_WRITE_MODEL, 6000, RESEARCH_SCHEMA,
      );
      mergeResearch(r, extra);
      // missing_facts van de tweede ronde is de actuelere lijst: die is
      // opgesteld tegen álle bronnen samen.
      s.missingFacts = missingFactsOf(extra);
      if (!s.bronQuote) s.bronQuote = acceptBronQuote(extra.quote, constraints);
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
  // Altijd door naar schrijven, nooit een derde ronde.
  s.researchRounds = 2;
  s.factScore = researchFactScore(s.research as Record<string, unknown>);
  await saveTopicProgress(topic.id, { status: 'queued', phase: 'schrijf', state: s });
  return {
    topic, phase: 'schrijf', done: false,
    progress: `Aanvullende research (${gevonden} extra bron${gevonden === 1 ? '' : 'nen'}, score ${s.factScore}) · schrijven start`,
  };
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
export async function verifyEntityFields(input: EntityVerifyInput): Promise<EntityVerifyResult> {
  const { naam, adres, website, rubriek, officialUrl, homepageContent } = input;
  const system = 'Je bent verificatieredacteur voor amsterdamnow.com. Je controleert of de naam, het adres en de website die de research opleverde bij ÉÉN en dezelfde echte zaak of instelling horen, op basis van de aangeleverde officiële homepage-tekst. Je verzint niets.';
  const prompt = [
    'Controleer de onderstaande entiteit en geef ALLEEN JSON terug.',
    '',
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
    '- entiteit_consistent: horen naam, adres en website bij dezelfde zaak?',
    '- waarschuwing: korte NL-zin bij een probleem, anders lege string.',
  ].join('\n');
  const payload = await askClaudeJson(system, prompt, FAST_WRITE_MODEL, 1000, ENTITY_VERIFY_SCHEMA);
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
async function verifyEntity(s: StandaardState, officialUrl: string | null, homepageContent: string): Promise<void> {
  const r = s.research as Record<string, unknown> | undefined;
  if (!r) return;
  const naam = optionalString(r.naam_locatie);
  const adres = optionalString(r.adres);
  const website = optionalString(r.website);
  const rubriek = optionalString(r.rubriek);
  try {
    const result = await verifyEntityFields({ naam, adres, website, rubriek, officialUrl, homepageContent });
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
  const payload = await askClaudeJson(
    writePrompt.content,
    `Onderwerp: ${topic.title}\n\nGebruik uitsluitend deze gecontroleerde research van Tavily. Schrijf het artikel als geldige JSON volgens de actieve prompt.\n\nHoud je aan deze regels:\n${rules}\n\n${JSON.stringify(s.research)}${describeSources(s)}${describeQuoteInstruction(s, constraints)}`,
    FAST_WRITE_MODEL, WRITE_MAX_TOKENS, ARTICLE_SCHEMA,
  );
  try {
    const candidate = buildCandidate(payload);
    // Voorbeeldzinnen uit de actieve prompt zelf: het model mag ze niet
    // letterlijk overnemen (zie validation.ts extractPromptExamples).
    validateArticle(candidate, subjectName(topic, s), constraints, extractPromptExamples(writePrompt.content), { sparse });
    // Titel apart, vrij (her)genereren voor meer punch — zie polishTitle. Nooit
    // slechter: valt terug op de zojuist gevalideerde titel als geen kandidaat
    // de keuring haalt.
    candidate.title = await polishTitle(candidate, s, subjectName(topic, s), constraints);
    s.article = candidate;
    await saveTopicProgress(topic.id, { status: 'queued', phase: 'seo', state: s });
    return { topic, phase: 'seo', done: false, progress: 'Artikel geschreven en gevalideerd · SEO en draft' };
  } catch (e: any) {
    // Herkansing als eigen fase-stap (niet meer als 2e Claude-call binnen
    // dezelfde aanroep): een validatiefout (te weinig woorden, dash, quote
    // niet letterlijk, …) gaat mét afkeurreden en de vorige versie naar de
    // volgende tik, in plaats van het topic direct op "mislukt" te zetten.
    s.draftPayload = payload;
    s.rejectReason = e.message;
    await saveTopicProgress(topic.id, { status: 'queued', phase: 'schrijf-retry', state: s });
    return { topic, phase: 'schrijf-retry', done: false, progress: `Afgekeurd (${String(e.message).slice(0, 60)}…) · herkansing start` };
  }
}

async function stepSchrijfRetry(topic: Topic, s: StandaardState): Promise<StandaardStepResult> {
  if (!s.research || !s.draftPayload || !s.rejectReason) throw new Error('Onvolledige staat voor de herschrijfronde.');
  const [writePrompt, constraints] = await Promise.all([activePrompt('schrijf'), standaardConstraints()]);
  const sparse = isSparseResearch(s, constraints);
  const rules = describeStandaardConstraints(constraints, subjectName(topic, s), { sparse });
  const payload = await askClaudeJson(
    writePrompt.content,
    `Je vorige versie van dit artikel is afgekeurd door de eindredactie.\n\nOnderwerp: ${topic.title}\nAfkeurreden: ${s.rejectReason}\n\nLever het VOLLEDIGE artikel opnieuw aan als JSON met exact dezelfde velden (title, subregel, introductie_tekst, content, quote). Los de afkeurreden op en houd de rest zoveel mogelijk intact. Alle regels blijven gelden:\n${rules}\n\nJe vorige versie:\n${JSON.stringify(s.draftPayload)}${describeSources(s)}${describeQuoteInstruction(s, constraints)}`,
    FAST_WRITE_MODEL, WRITE_MAX_TOKENS, ARTICLE_SCHEMA,
  );
  let checked: GeneratedArticle;
  try {
    checked = buildCandidate(payload);
    validateArticle(checked, subjectName(topic, s), constraints, extractPromptExamples(writePrompt.content), { sparse });
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
    await saveTopicProgress(topic.id, { status: 'queued', phase: 'schrijf-retry', state: s });
    return { topic, phase: 'schrijf-retry', done: false, progress: `Afgekeurd (${String(e.message).slice(0, 60)}…) · herkansing ${attempts + 1} start` };
  }
  checked.title = await polishTitle(checked, s, subjectName(topic, s), constraints);
  s.article = checked;
  s.draftPayload = undefined;
  s.rejectReason = undefined;
  s.schrijfAttempts = undefined;
  await saveTopicProgress(topic.id, { status: 'queued', phase: 'seo', state: s });
  return { topic, phase: 'seo', done: false, progress: 'Artikel geschreven en gevalideerd · SEO en draft' };
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
    FAST_WRITE_MODEL, 6000, SEO_SCHEMA,
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

export async function rewriteQuote(article: Article, contentHtml: string, opts: RewriteQuoteOptions = {}): Promise<QuoteRewriteOutcome> {
  const block = findExistingQuoteBlock(contentHtml);
  if (!block) throw new Error('Geen herkenbare quote-structuur (blockquote + bronparagraaf) gevonden.');

  const constraints = await activeConstraints('standaard');
  const { min: minWords, max: maxWords } = constraints.quoteWords;
  const paragraphText = plainText(block.paragraphHtml);
  const verboden = opts.verbodenZinnen?.filter(Boolean) || [];

  const system = 'Je bent eindredacteur van amsterdamnow.com, een lokale stadsgids door en voor Amsterdammers. Je herschrijft een afgekeurde pull-quote naar een sterkere quote die zowel als losstaande pull-quote als in de lopende tekst goed leest. Nuchtere, informele toon, geen marketingtaal, je verzint geen nieuwe feiten.';
  const prompt = [
    `Artikel: ${article.title}`,
    '',
    `Bestaande (${opts.reden || 'te korte'}) quote: "${block.quoteText}"`,
    '',
    'Bronparagraaf (bevat de quote letterlijk):',
    paragraphText,
    '',
    'Volledige artikeltekst, ter context (pas alleen de bronparagraaf hierboven aan):',
    plainText(contentHtml).slice(0, 6000),
    '',
    'Opdracht:',
    `- Herschrijf de quote naar ${minWords}-${maxWords} woorden. Behoud de kernboodschap en toon; voeg geen nieuwe feiten toe die niet al in de tekst staan.`,
    '- Herschrijf de bronparagraaf zo dat de NIEUWE quote daar woord voor woord letterlijk in voorkomt, net als de oorspronkelijke opzet. Lopende tekst, geen opsomming.',
    '- Geen em dash (—) of en dash (–).',
    '- Geen vraag en geen meta-taal ("zoals hij zelf zegt", etc.) in de quote zelf.',
    ...(verboden.length
      ? [
          '- De nieuwe quote gaat over DIT artikel en deze zaak. Hergebruik geen van deze zinnen, ook niet gedeeltelijk:',
          ...verboden.map(z => `  · "${z}"`),
        ]
      : []),
    '',
    'Antwoord ALLEEN met JSON: "quote" (de nieuwe quote) en "herschreven_paragraaf" (de volledige, aangepaste bronparagraaf).',
  ].join('\n');

  const payload = await askClaudeJson(system, prompt, FAST_WRITE_MODEL, 1200, QUOTE_REWRITE_SCHEMA);
  const quote = string(payload.quote, 'quote');
  const herschrevenParagraaf = string(payload.herschreven_paragraaf, 'herschreven_paragraaf');

  const count = wordCount(quote);
  if (count < minWords || count > maxWords) {
    throw new Error(`Herschreven quote is ${count} woorden; moet ${minWords}-${maxWords} zijn.`);
  }
  if (!normalizeForVerbatim(herschrevenParagraaf).includes(normalizeForVerbatim(quote))) {
    throw new Error('Herschreven quote staat niet letterlijk in de herschreven bronparagraaf.');
  }

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
