import type { ListConstraints, StandaardConstraints } from './types';

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
// Mistral" of "Vondelpark Openluchttheater: zomerseizoen"; eisen dat die hele
// string létterlijk in de titel staat perste het model in klungelige koppen.
// We accepteren daarom ook de kernnaam (het deel vóór by/x/:/|/feat/presenteert).
function coreName(topic: string): string {
  const core = topic.split(/\s+by\s+|\s+x\s+|:|\||\s+feat\.?\s+|\s+presenteert\s+/i)[0]?.trim();
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

export function validateArticle(article: GeneratedArticle, topic: string, config: StandaardConstraints) {
  range('Titel', article.title, config.titleWords.min, config.titleWords.max);
  if (article.title.length > config.titleMaxChars) {
    throw new Error(`Titel is ${article.title.length} tekens; maximaal ${config.titleMaxChars}.`);
  }
  range('Subregel', article.subregel, config.subregelWords.min, config.subregelWords.max);
  range('Introductie', article.introductie_tekst, config.introWords.min, config.introWords.max);
  range('Artikeltekst', article.content, config.contentWords.min, config.contentWords.max);
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
  if (config.noDashInText && [article.title, article.subregel, article.introductie_tekst, article.content, article.quote].some(v => /[—–]/.test(v))) {
    throw new Error('Een artikel mag geen em dash of en dash bevatten.');
  }
  if (config.noAmsterdamRepeatInTitleSubregelIntro && /\bAmsterdam\b/i.test(`${article.title} ${article.subregel} ${article.introductie_tekst}`)) {
    throw new Error('Amsterdam mag niet in titel, subregel of introductie staan.');
  }
  if (article.content.split(/\n\s*\n/).filter(Boolean).length < config.minParagraphs) {
    throw new Error(`Artikeltekst moet uit minimaal ${config.minParagraphs} alinea's bestaan.`);
  }
}
