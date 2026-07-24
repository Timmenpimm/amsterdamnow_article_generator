import { activeConstraints, activePrompt, completeTopic, failTopic, saveTopicProgress } from './db';
import { askClaudeJson, FAST_WRITE_MODEL, TITLE_MODEL } from './claude';
import { RESEARCH_SCHEMA, ARTICLE_SCHEMA, SEO_SCHEMA, ENTITY_VERIFY_SCHEMA, QUOTE_REWRITE_SCHEMA } from './schemas';
import { createDraft, taxonomyChoices } from './wp';
import { checkTopicAgainstWp } from './dedup';
import { researchWithTavily } from './tavily';
import { validateArticle, checkTitle, GeneratedArticle } from './validation';
import { parseStandaardState, type Article, type StandaardConstraints, type StandaardPhase, type StandaardState, type Topic, type WordRange } from './types';
import { formatStandardArticleHtml } from './articleHtml';
import { decodeHtmlEntities } from './htmlEntities';

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
function describeStandaardConstraints(c: StandaardConstraints, naam: string): string {
  const mid = (r: WordRange) => Math.round((r.min + r.max) / 2);
  // De titelcheck (validateArticle) eist de naam létterlijk; zeg het model dus
  // precies welke tekenreeks er in de titel moet, niet alleen "de naam van het
  // onderwerp" — daar maakte het model zelf een kortere variant van (bv.
  // "AMAZE" waar naam_locatie "AMAZE by ID&T" is), die de check dan afkeurt.
  const lines = [
    `- Titel: ${c.titleWords.min}-${c.titleWords.max} woorden${c.titleMustContainTopic ? `, met daarin letterlijk: "${naam}"` : ''}.`,
    `- Subregel: ${c.subregelWords.min}-${c.subregelWords.max} woorden.`,
    `- Introductie: ${c.introWords.min}-${c.introWords.max} woorden; mik op ~${mid(c.introWords)}.`,
    `- Artikeltekst: ${c.contentWords.min}-${c.contentWords.max} woorden; mik op ~${mid(c.contentWords)}, verdeeld over minimaal ${c.minParagraphs} alinea's. Schrijf liever iets te ruim dan te krap.`,
    `- Quote: ${c.quoteWords.min}-${c.quoteWords.max} woorden${c.quoteMustBeVerbatimInContent ? ', en woord voor woord letterlijk terug te vinden in de artikeltekst' : ''}.`,
  ];
  if (c.noDashInText) lines.push('- Geen em dash (—) of en dash (–), nergens.');
  if (c.noAmsterdamRepeatInTitleSubregelIntro) lines.push('- Het woord "Amsterdam" mag níet in titel, subregel of introductie staan.');
  return lines.join('\n');
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
    topic.phase === 'schrijf' || topic.phase === 'schrijf-retry' || topic.phase === 'seo' ? topic.phase : 'research';
  try {
    switch (phase) {
      case 'research': return await stepResearch(topic, s);
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

  const system = 'Je bent eindredacteur van amsterdamnow.com, een lokale stadsgids door en voor Amsterdammers. Je bedenkt de kop: informeel, direct, nuchter en concreet. Nooit toeristisch, nooit marketingtaal.';
  const prompt = [
    'Bedenk drie mogelijke titels voor dit artikel.',
    '',
    'REGELS (hard):',
    `- ${constraints.titleWords.min}-${constraints.titleWords.max} woorden.`,
    `- De naam "${naam}" (of de kernnaam ervan) staat erin, bij voorkeur vooraan. Essentieel voor SEO.`,
    '- Prikkelend en concreet. Gebruik eventueel een dubbele punt voor spanning.',
    '- Vermijd saaie constructies als "Nieuw restaurant X opent zijn deuren".',
    constraints.noDashInText ? '- Geen em dash (—) of en dash (–).' : '',
    constraints.noAmsterdamRepeatInTitleSubregelIntro ? '- Het woord "Amsterdam" mag NIET in de titel staan.' : '',
    '',
    'Goede voorbeelden:',
    '- BOLIA aan de Utrechtsestraat: Deens design met koffie en maatwerk',
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
    const payload = await askClaudeJson(system, prompt, false, TITLE_MODEL, 600);
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
  const [researchPrompt, taxonomies] = await Promise.all([activePrompt('research'), taxonomyChoices()]);
  const { sources, officialUrl } = await researchWithTavily(topic.title);
  // Research = feiten extraheren uit aangeleverde bronnen, geen creatief werk:
  // Sonnet 5 volstaat en kost een fractie van Opus (zie FAST_WRITE_MODEL in
  // lib/claude.ts). Bronnen worden hier ook getrimd op 8000 tekens — relevante
  // info zoals adres/feiten staat doorgaans vooraan in de geëxtraheerde
  // content (zie VERIFY_SOURCE_CHARS in listWriter.ts voor dezelfde afweging).
  const research = await askClaudeJson(
    researchPrompt.content,
    `Onderwerp: ${topic.title}\n\nBeschikbare WordPress-categorieën: ${taxonomies.categories.join(', ')}\nBeschikbare WordPress-districten: ${taxonomies.districts.join(', ')}\nBeschikbare WordPress-tags: ${taxonomies.tags.join(', ')}\nKies "tags" uitsluitend uit deze lijst; verzin nooit nieuwe tags. Past geen enkele bestaande tag goed, geef dan een lege lijst terug.\n\nGaat dit onderwerp over een event met een concrete datum, geef die dan als "start_datum" (en "eind_datum", gelijk aan start bij een eendaags event) in JJJJ-MM-DD, letterlijk overgenomen uit de bronnen. Is het geen event of noemt geen bron een concrete datum, laat beide leeg ("").\n\nTavily-bronnen:\n${sources.map((src, i) => `\n[${i + 1}] ${src.title}\n${src.url}\n${src.content.slice(0, 8000)}`).join('\n')}`,
    false, FAST_WRITE_MODEL, 6000, RESEARCH_SCHEMA,
  );
  // Seed van de bronscanner is gezaghebbend: die datum komt rechtstreeks van de
  // agendapagina, betrouwbaarder dan wat het model uit de Tavily-bronnen afleidt.
  // Alleen overschrijven als er een seed is; anders blijft de research-datum staan.
  if (s.seedStartDatum) {
    (research as Record<string, unknown>).start_datum = s.seedStartDatum;
    (research as Record<string, unknown>).eind_datum = s.seedEindDatum || s.seedStartDatum;
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
  await saveTopicProgress(topic.id, { status: 'queued', phase: 'schrijf', state: s });
  return { topic, phase: 'schrijf', done: false, progress: 'Research klaar · schrijven start' };
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
  const payload = await askClaudeJson(system, prompt, false, FAST_WRITE_MODEL, 1000, ENTITY_VERIFY_SCHEMA);
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

async function stepSchrijf(topic: Topic, s: StandaardState): Promise<StandaardStepResult> {
  if (!s.research) throw new Error('Research ontbreekt voor de schrijffase.');
  const [writePrompt, constraints] = await Promise.all([activePrompt('schrijf'), activeConstraints('standaard')]);
  const rules = describeStandaardConstraints(constraints, subjectName(topic, s));
  const payload = await askClaudeJson(
    writePrompt.content,
    `Onderwerp: ${topic.title}\n\nGebruik uitsluitend deze gecontroleerde research van Tavily. Schrijf het artikel als geldige JSON volgens de actieve prompt.\n\nHoud je aan deze regels:\n${rules}\n\n${JSON.stringify(s.research)}`,
    false, FAST_WRITE_MODEL, WRITE_MAX_TOKENS, ARTICLE_SCHEMA,
  );
  try {
    const candidate = buildCandidate(payload);
    validateArticle(candidate, subjectName(topic, s), constraints);
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
  const [writePrompt, constraints] = await Promise.all([activePrompt('schrijf'), activeConstraints('standaard')]);
  const rules = describeStandaardConstraints(constraints, subjectName(topic, s));
  const payload = await askClaudeJson(
    writePrompt.content,
    `Je vorige versie van dit artikel is afgekeurd door de eindredactie.\n\nOnderwerp: ${topic.title}\nAfkeurreden: ${s.rejectReason}\n\nLever het VOLLEDIGE artikel opnieuw aan als JSON met exact dezelfde velden (title, subregel, introductie_tekst, content, quote). Los de afkeurreden op en houd de rest zoveel mogelijk intact. Alle regels blijven gelden:\n${rules}\n\nJe vorige versie:\n${JSON.stringify(s.draftPayload)}`,
    false, FAST_WRITE_MODEL, WRITE_MAX_TOKENS, ARTICLE_SCHEMA,
  );
  let checked: GeneratedArticle;
  try {
    checked = buildCandidate(payload);
    validateArticle(checked, subjectName(topic, s), constraints);
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
    false, FAST_WRITE_MODEL, 6000, SEO_SCHEMA,
  );
  const draft = await createDraft({
    title, subregel, intro, contentHtml: formatStandardArticleHtml(content, quote), quote,
    focusKeyword: string(seo.rank_math_focus_keyword, 'rank_math_focus_keyword'),
    slug: string(seo.slug, 'slug'),
    seoTitle: string(seo.rank_math_title, 'rank_math_title'),
    metaDescription: string(seo.rank_math_description, 'rank_math_description'),
    categories: nonEmptyStrings(s.research.categories, 'categories'),
    district: string(s.research.district, 'district'),
    tags: strings(s.research.tags, 'tags'),
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
export async function rewriteQuote(article: Article, contentHtml: string): Promise<QuoteRewriteOutcome> {
  const block = findExistingQuoteBlock(contentHtml);
  if (!block) throw new Error('Geen herkenbare quote-structuur (blockquote + bronparagraaf) gevonden.');

  const constraints = await activeConstraints('standaard');
  const { min: minWords, max: maxWords } = constraints.quoteWords;
  const paragraphText = plainText(block.paragraphHtml);

  const system = 'Je bent eindredacteur van amsterdamnow.com, een lokale stadsgids door en voor Amsterdammers. Je herschrijft een te korte pull-quote naar een langere, sterkere quote die zowel als losstaande pull-quote als in de lopende tekst goed leest. Nuchtere, informele toon, geen marketingtaal, je verzint geen nieuwe feiten.';
  const prompt = [
    `Artikel: ${article.title}`,
    '',
    `Bestaande (te korte) quote: "${block.quoteText}"`,
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
    '',
    'Antwoord ALLEEN met JSON: "quote" (de nieuwe quote) en "herschreven_paragraaf" (de volledige, aangepaste bronparagraaf).',
  ].join('\n');

  const payload = await askClaudeJson(system, prompt, false, FAST_WRITE_MODEL, 1200, QUOTE_REWRITE_SCHEMA);
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

  return { html, quote };
}
