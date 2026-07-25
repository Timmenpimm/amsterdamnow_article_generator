import type { ListConstraints, StandaardConstraints, WordRange } from './types';

export type GeneratedArticle = {
  title: string; subregel: string; introductie_tekst: string; content: string; quote: string;
};

function words(value: string) {
  return value.replace(/<[^>]*>/g, ' ').trim().split(/\s+/).filter(Boolean).length;
}

function normal(value: string) {
  return value.toLocaleLowerCase('nl-NL').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function range(label: string, value: string, min: number, max: number) {
  const count = words(value);
  if (count < min || count > max) throw new Error(`${label} moet ${min}-${max} woorden bevatten (nu ${count}).`);
}

// De "kern" van een onderwerpnaam: de merknaam vóór een kwalificatie. De
// research levert vaak een volledige naam als "AMAZE by ID&T", "Bar Basquiat x
// Mistral", "Vondelpark Openluchttheater: zomerseizoen" of "Modelstad
// Haven-Stad — Arcam"; eisen dat die hele string létterlijk in de titel staat
// perste het model in klungelige koppen. We accepteren daarom ook de kernnaam:
// het deel vóór by/x/:/|/feat/presenteert óf vóór een gespatieerde streep
// (" — ", " – ", " - "), waarmee de research vaak de locatie of ondertitel
// aanplakt. De niet-gespatieerde koppelstreep (Haven-Stad) blijft intact.
function coreName(topic: string): string {
  const core = topic.split(/\s+by\s+|\s+x\s+|:|\||\s+feat\.?\s+|\s+presenteert\s+|\s+[—–-]\s+/i)[0]?.trim();
  return core || topic;
}

// De titel bevat de naam van het onderwerp als de volledige naam óf de kernnaam
// erin voorkomt (genormaliseerd, dus hoofdletter- en leesteken-ongevoelig).
export function subjectInTitle(title: string, topic: string): boolean {
  const t = normal(title);
  if (t.includes(normal(topic))) return true;
  const core = normal(coreName(topic));
  return core.length > 1 && t.includes(core);
}

// Alle titel-eisen op een rij, als één (of geen) foutmelding. Wordt gebruikt om
// de los-gegenereerde titelkandidaten (writer.ts polishTitle) te keuren met
// exact dezelfde regels als validateArticle voor de titel hanteert.
export function checkTitle(title: string, topic: string, config: StandaardConstraints): string | null {
  const count = words(title);
  if (count < config.titleWords.min || count > config.titleWords.max) {
    return `Titel moet ${config.titleWords.min}-${config.titleWords.max} woorden bevatten (nu ${count}).`;
  }
  if (title.length > config.titleMaxChars) return `Titel is ${title.length} tekens; maximaal ${config.titleMaxChars}.`;
  if (config.titleMustContainTopic && !subjectInTitle(title, topic)) {
    return `De titel moet de naam van het onderwerp bevatten ("${topic}", of de kernnaam "${coreName(topic)}").`;
  }
  if (config.noDashInText && /[—–]/.test(title)) return 'De titel mag geen em dash of en dash bevatten.';
  if (config.noAmsterdamRepeatInTitleSubregelIntro && /\bAmsterdam\b/i.test(title)) {
    return 'Amsterdam mag niet in de titel staan.';
  }
  return null;
}

// ---------- voorbeeldzinnen uit de prompt ----------

// De schrijfprompt bevat voorbeeldzinnen (<good>, <concreet>) die laten zien
// HOE je schrijft. Het model nam die soms letterlijk over: de quote "De
// wijnkaart is hier net zo serieus als de keuken. En dat is precies de
// bedoeling." uit <example type="quote"> belandde zo in artikelen over een
// techno-festival, een sportwinkel en een theater. Omdat de quote ook
// letterlijk in de artikeltekst moet staan (quoteMustBeVerbatimInContent),
// plakte het model diezelfde zin er nog eens middenin een alinea bij.
//
// Titel- en subregelvoorbeelden blijven buiten beschouwing: die noemen echte
// zaken (KLM Open, Chez Chloé) en een artikel over precies dát onderwerp mag
// legitiem op dezelfde kop uitkomen.
const EXAMPLE_BLOCK_RE = /<example\b([^>]*)>[\s\S]*?<\/example>/gi;
const SAMPLE_RE = /<(good|concreet)>([\s\S]*?)<\/\1>/gi;
const SKIPPED_EXAMPLE_TYPES = ['title', 'subregel'];
// Kortere voorbeelden ("Hier eet je goed.") zijn gewone Nederlandse zinnen die
// een artikel toevallig ook kan bevatten; die afkeuren levert vals alarm op.
const MIN_EXAMPLE_WORDS = 6;

// Alle voorbeeldzinnen uit een promptversie, als platte tekst. Werkt op de
// prompt zoals die op dat moment actief is (DB), niet op een vaste lijst —
// nieuwe voorbeelden zijn zo automatisch gedekt.
export function extractPromptExamples(promptContent: string): string[] {
  const relevant = (promptContent || '').replace(EXAMPLE_BLOCK_RE, (block, attrs: string) => {
    const type = /type\s*=\s*["']?([a-z_-]+)/i.exec(attrs || '')?.[1]?.toLowerCase() || '';
    return SKIPPED_EXAMPLE_TYPES.includes(type) ? '' : block;
  });
  const found = new Set<string>();
  for (const match of relevant.matchAll(SAMPLE_RE)) {
    const text = match[2].trim();
    if (words(text) >= MIN_EXAMPLE_WORDS) found.add(text);
  }
  return [...found];
}

// Ook een halve voorbeeldzin is een lek. Het model nam de wijnzin niet altijd
// heel over maar boog hem om: "De wijnkaart is hier net zo serieus als de
// keuken, zeggen ze bij restaurants. Bij Technogym geldt iets vergelijkbaars"
// (sportwinkel), "…maar dan voor geluid" (studio), "…Nee, wacht: hier is het de
// bassline die alles bepaalt" (techno-club). Daarom keuren we niet alleen de
// hele zin af maar ook elk stuk van acht opeenvolgende woorden eruit: lang
// genoeg dat toeval is uitgesloten, kort genoeg om een omgebogen kopie te
// pakken.
const LEAK_SHINGLE_WORDS = 8;

// Het stuk voorbeeldtekst dat (genormaliseerd) in de tekst voorkomt, of null.
export function findPromptExampleLeak(text: string, examples: string[]): string | null {
  const haystack = normal(text);
  if (!haystack) return null;
  for (const example of examples) {
    const needle = normal(example);
    if (!needle) continue;
    if (haystack.includes(needle)) return example;
    const parts = needle.split(' ');
    for (let i = 0; i + LEAK_SHINGLE_WORDS <= parts.length; i++) {
      const shingle = parts.slice(i, i + LEAK_SHINGLE_WORDS).join(' ');
      if (haystack.includes(shingle)) return shingle;
    }
  }
  return null;
}

// ---------- lijstartikelen ----------

export interface ListItemDraft {
  naam: string;
  beschrijving: string;
  adres: string;
  buurt: string;
  quote?: { tekst: string; bron: string } | null;
}

export interface GeneratedListArticle {
  title: string;
  subregel: string;
  introcontent: string;
  inleiding: string;
  items: ListItemDraft[];
  afsluiting: string;
}

function sentences(value: string): number {
  return value.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => s.length > 1).length;
}

function forbiddenIn(label: string, value: string, forbiddenWords: string[]) {
  const lower = value.toLocaleLowerCase('nl-NL');
  for (const word of forbiddenWords) {
    if (lower.includes(word)) throw new Error(`${label} bevat verboden formulering "${word}".`);
  }
}

export function quoteSourceAllowed(bron: string, blacklist: string[], herkomst = ''): boolean {
  const haystack = `${bron} ${herkomst}`.toLocaleLowerCase('nl-NL');
  return !blacklist.some(b => haystack.includes(b));
}

export function validateListArticle(article: GeneratedListArticle, config: ListConstraints): string[] {
  const meldingen: string[] = [];
  if (article.title.length > config.titleMaxChars) {
    throw new Error(`Titel is ${article.title.length} tekens; maximaal ${config.titleMaxChars}.`);
  }
  if (config.titleNoCount && /\b(twee|drie|vier|vijf|zes|zeven|acht|negen|tien|elf|twaalf|\d+)\s+(beste|leukste|mooiste|fijnste|lekkerste)\b/i.test(article.title)) {
    throw new Error('Titel mag geen aantal bevatten ("De 10 beste…"): de lijst kan later aangevuld worden.');
  }
  if (config.subregelNoVanTotFormula && /\bvan\s+\S+([^.]{0,30})\s+tot\s+/i.test(article.subregel)) {
    throw new Error('Subregel mag niet de vaste formule "van X tot Y" gebruiken.');
  }
  if (config.subregelNoAmsterdamRepeat && /\bamsterdam\b/i.test(article.title) && /\bamsterdam\b/i.test(article.subregel)) {
    throw new Error('Subregel mag "Amsterdam" niet herhalen als dat al in de titel staat.');
  }
  const introSentences = sentences(article.introcontent);
  if (introSentences < config.introSentences.min || introSentences > config.introSentences.max) {
    throw new Error(`Introcontent moet ${config.introSentences.min}-${config.introSentences.max} zinnen zijn (nu ${introSentences}).`);
  }
  if (article.items.length < config.minItems) {
    throw new Error(`Een lijstartikel heeft minimaal ${config.minItems} items (nu ${article.items.length}).`);
  }

  const allText = [article.title, article.subregel, article.introcontent, article.inleiding, article.afsluiting, ...article.items.map(i => i.beschrijving)].join('\n');
  forbiddenIn('Het artikel', allText, config.forbiddenWords);
  // Em/en-dash in lopende tekst verboden; het adres-streepje wordt pas bij de
  // HTML-assemblage toegevoegd en valt hier dus buiten.
  if (config.noDashInText && /[—–]/.test(allText)) throw new Error('Het artikel bevat een em-dash of en-dash in de lopende tekst.');

  let lastQuoteAt = -2;
  let quoteCount = 0;
  article.items.forEach((item, i) => {
    const s = sentences(item.beschrijving);
    if (s < config.itemSentences.min || s > config.itemSentences.max) {
      throw new Error(`Item "${item.naam}" heeft ${s} zinnen; het moeten er ${config.itemSentences.min}-${config.itemSentences.max} zijn.`);
    }
    if (config.noBulletsInItem && /[•\-*]\s/m.test(item.beschrijving.trimStart()) && /\n/.test(item.beschrijving)) {
      throw new Error(`Item "${item.naam}" bevat een opsomming; schrijf lopende tekst.`);
    }
    if (config.itemRequiresAddress && !item.adres?.trim()) throw new Error(`Item "${item.naam}" heeft geen adres.`);
    if (config.itemRequiresBuurt && !item.buurt?.trim()) throw new Error(`Item "${item.naam}" heeft geen buurt.`);
    if (config.addressNotInDescription && item.adres && new RegExp(item.adres.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(item.beschrijving)) {
      throw new Error(`Item "${item.naam}": het adres hoort niet in de beschrijving.`);
    }
    if (item.quote) {
      if (!quoteSourceAllowed(item.quote.bron, config.quoteSourceBlacklist)) {
        throw new Error(`Quote bij "${item.naam}" komt van een concurrerende stadsgids; dat mag niet.`);
      }
      if (config.noConsecutiveQuotes && i === lastQuoteAt + 1) throw new Error('Twee quotes bij opeenvolgende items; verspreid ze door het artikel.');
      lastQuoteAt = i;
      quoteCount += 1;
    }
  });

  const quoteNorm = Math.floor(article.items.length / config.quoteNormPerItems);
  if (quoteNorm > 0 && quoteCount < quoteNorm) {
    const tekort = `Quote-norm niet gehaald: ${quoteCount} quote${quoteCount === 1 ? '' : 's'} bij ${article.items.length} items (norm: minimaal ${quoteNorm}).`;
    if (config.quoteNormMandatory) {
      throw new Error(`${tekort} Haal een geverifieerde quote uit de research voor een item dat er nog geen heeft.`);
    }
    meldingen.push(`${tekort} Voeg eventueel handmatig een geverifieerde quote toe in WordPress.`);
  }

  const namedInClosing = article.items.filter(i => article.afsluiting.toLocaleLowerCase('nl-NL').includes(i.naam.toLocaleLowerCase('nl-NL').split(' ')[0])).length;
  if (namedInClosing < config.minNamedItemsInClosing) {
    meldingen.push('De afsluiting combineert minder dan twee items bij naam; check of het slot concreet genoeg is.');
  }
  return meldingen;
}

// ---------- standaardartikelen ----------

// Constraint-JSON wordt versiebeheerd in de database: een actieve rij kan van
// vóór een veld-uitbreiding stammen en dus velden missen die de code intussen
// verwacht. Lezen gaat daarom altijd via deze helpers, met een veilige
// terugval. Een oude constraint-versie mag de validatie nooit laten crashen —
// dat zou de hele pipeline blokkeren op een puur redactionele instelling.
type LooseStandaard = StandaardConstraints & Partial<{
  sparseContentWords: WordRange;
  quoteSourceBlacklist: string[];
}>;

// Het "sparse"-bereik: het kortere woordenaantal dat geldt als de research te
// dun bleef. Waarom dit bestaat: het harde minimum van 400 woorden dwong de
// schrijf-agent om te vullen, en dat vullen wás de bron van de verzonnen
// details. Liever 260 onderbouwde woorden dan 400 met opvulling. Ontbreekt het
// veld (oude constraint-versie), dan valt de regel terug op contentWords en
// gedraagt de validatie zich exact als voorheen.
function sparseContentRange(config: StandaardConstraints): WordRange {
  return (config as LooseStandaard).sparseContentWords ?? config.contentWords;
}

// De blacklist van bronnen waar geen quote uit mag komen (concurrerende
// stadsgidsen). Ontbreekt hij in de standaard-constraints, dan blokkeert hij
// niets in plaats van te crashen.
export function standaardQuoteSourceBlacklist(config: StandaardConstraints): string[] {
  return (config as LooseStandaard).quoteSourceBlacklist ?? [];
}

// opts.sparse = true → de sufficiëntie-poort heeft vastgesteld dat de research
// te dun is voor een volwaardig artikel. Alle overige regels blijven onverkort
// gelden; alleen de lengte-eis voor de hoofdtekst wordt verruimd naar beneden.
export function validateArticle(
  article: GeneratedArticle,
  topic: string,
  config: StandaardConstraints,
  promptExamples: string[] = [],
  opts?: { sparse?: boolean },
) {
  range('Titel', article.title, config.titleWords.min, config.titleWords.max);
  if (article.title.length > config.titleMaxChars) {
    throw new Error(`Titel is ${article.title.length} tekens; maximaal ${config.titleMaxChars}.`);
  }
  range('Subregel', article.subregel, config.subregelWords.min, config.subregelWords.max);
  range('Introductie', article.introductie_tekst, config.introWords.min, config.introWords.max);
  const contentRange = opts?.sparse ? sparseContentRange(config) : config.contentWords;
  range('Artikeltekst', article.content, contentRange.min, contentRange.max);
  range('Quote', article.quote, config.quoteWords.min, config.quoteWords.max);
  if (config.titleMustContainTopic && !subjectInTitle(article.title, topic)) {
    // Noem de vereiste naam letterlijk: deze melding wordt als afkeurreden aan
    // de herschrijfronde meegegeven, en zonder de concrete naam blijft het
    // model gokken welke formulering de check verwacht. De kernnaam (zonder
    // "by X"/"x Y"-toevoeging) volstaat — zie subjectInTitle/coreName.
    throw new Error(`De titel moet de naam van het onderwerp bevatten ("${topic}", of de kernnaam "${coreName(topic)}").`);
  }
  if (config.quoteMustBeVerbatimInContent && !normal(article.content).includes(normal(article.quote))) {
    throw new Error('De quote moet letterlijk in de artikeltekst voorkomen.');
  }
  const leak = findPromptExampleLeak([article.quote, article.content, article.introductie_tekst, article.subregel].join('\n'), promptExamples);
  if (leak) {
    throw new Error(`Voorbeeldzin uit de prompt letterlijk overgenomen: "${leak}". De voorbeelden tonen alleen stijl; schrijf een eigen zin over dit onderwerp, op basis van de research.`);
  }
  if (config.noDashInText && [article.title, article.subregel, article.introductie_tekst, article.content, article.quote].some(v => /[—–]/.test(v))) {
    throw new Error('Een artikel mag geen em dash of en dash bevatten.');
  }
  if (config.noAmsterdamRepeatInTitleSubregelIntro && /\bAmsterdam\b/i.test(`${article.title} ${article.subregel} ${article.introductie_tekst}`)) {
    throw new Error('Amsterdam mag niet in titel, subregel of introductie staan.');
  }
  // Bij dunne research schrijft het model bewust korter (250 i.p.v. 400+
  // woorden). Vijf alinea's afdwingen betekent dan alinea's van vijftig
  // woorden, of erger: opvullen om het quotum te halen. Precies wat de
  // sparse-modus moet voorkomen, dus de eis zakt mee naar drie.
  const minAlineas = opts?.sparse ? Math.min(3, config.minParagraphs) : config.minParagraphs;
  if (article.content.split(/\n\s*\n/).filter(Boolean).length < minAlineas) {
    throw new Error(`Artikeltekst moet uit minimaal ${minAlineas} alinea's bestaan.`);
  }
}
