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

// ---------- lijstartikelen ----------

// Verboden woorden uit de redactionele instructie. Als los woord gecheckt.
const FORBIDDEN_WORDS = [
  'hotspot', 'pareltje', 'bruisend', 'iconisch',
  'elektronische muziek',
  'opent zijn deuren', 'verwelkomt gasten', 'biedt een unieke ervaring',
  'mis het niet', 'een aanrader voor iedereen',
];

// Domeinen van concurrerende stadsgidsen: nooit als quotebron.
const QUOTE_BLACKLIST = [
  'ylbb', 'your little black book', 'yourlittleblackbook',
  'bartsboekje', 'barts boekje',
  'iamsterdam',
  'time out', 'timeout',
  'cityguys', 'dagjeweg', 'awesome amsterdam', 'amsterdamlokaal', 'kidsproof', 'roadbook',
];

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

function forbiddenIn(label: string, value: string) {
  const lower = value.toLocaleLowerCase('nl-NL');
  for (const word of FORBIDDEN_WORDS) {
    if (lower.includes(word)) throw new Error(`${label} bevat verboden formulering "${word}".`);
  }
}

export function quoteSourceAllowed(bron: string, herkomst = ''): boolean {
  const haystack = `${bron} ${herkomst}`.toLocaleLowerCase('nl-NL');
  return !QUOTE_BLACKLIST.some(b => haystack.includes(b));
}

export function validateListArticle(article: GeneratedListArticle): string[] {
  const meldingen: string[] = [];
  if (article.title.length > 75) throw new Error(`Titel is ${article.title.length} tekens; maximaal 75.`);
  if (/\b(twee|drie|vier|vijf|zes|zeven|acht|negen|tien|elf|twaalf|\d+)\s+(beste|leukste|mooiste|fijnste|lekkerste)\b/i.test(article.title)) {
    throw new Error('Titel mag geen aantal bevatten ("De 10 beste…"): de lijst kan later aangevuld worden.');
  }
  if (/\bvan\s+\S+([^.]{0,30})\s+tot\s+/i.test(article.subregel)) {
    throw new Error('Subregel mag niet de vaste formule "van X tot Y" gebruiken.');
  }
  if (/\bamsterdam\b/i.test(article.title) && /\bamsterdam\b/i.test(article.subregel)) {
    throw new Error('Subregel mag "Amsterdam" niet herhalen als dat al in de titel staat.');
  }
  const introSentences = sentences(article.introcontent);
  if (introSentences < 2 || introSentences > 3) throw new Error(`Introcontent moet 2-3 zinnen zijn (nu ${introSentences}).`);
  if (article.items.length < 3) throw new Error(`Een lijstartikel heeft minimaal 3 items (nu ${article.items.length}).`);

  const allText = [article.title, article.subregel, article.introcontent, article.inleiding, article.afsluiting, ...article.items.map(i => i.beschrijving)].join('\n');
  forbiddenIn('Het artikel', allText);
  // Em/en-dash in lopende tekst verboden; het adres-streepje wordt pas bij de
  // HTML-assemblage toegevoegd en valt hier dus buiten.
  if (/[—–]/.test(allText)) throw new Error('Het artikel bevat een em-dash of en-dash in de lopende tekst.');

  let lastQuoteAt = -2;
  let quoteCount = 0;
  article.items.forEach((item, i) => {
    const s = sentences(item.beschrijving);
    if (s < 3 || s > 5) throw new Error(`Item "${item.naam}" heeft ${s} zinnen; het moeten er 3-5 zijn.`);
    if (/[•\-*]\s/m.test(item.beschrijving.trimStart()) && /\n/.test(item.beschrijving)) {
      throw new Error(`Item "${item.naam}" bevat een opsomming; schrijf lopende tekst.`);
    }
    if (!item.adres?.trim()) throw new Error(`Item "${item.naam}" heeft geen adres.`);
    if (!item.buurt?.trim()) throw new Error(`Item "${item.naam}" heeft geen buurt.`);
    if (new RegExp(item.adres.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(item.beschrijving)) {
      throw new Error(`Item "${item.naam}": het adres hoort niet in de beschrijving.`);
    }
    if (item.quote) {
      if (!quoteSourceAllowed(item.quote.bron)) throw new Error(`Quote bij "${item.naam}" komt van een concurrerende stadsgids; dat mag niet.`);
      if (i === lastQuoteAt + 1) throw new Error('Twee quotes bij opeenvolgende items; verspreid ze door het artikel.');
      lastQuoteAt = i;
      quoteCount += 1;
    }
  });

  const quoteNorm = Math.floor(article.items.length / 3);
  if (quoteNorm > 0 && quoteCount < quoteNorm) {
    meldingen.push(`Quote-norm niet gehaald: ${quoteCount} quote${quoteCount === 1 ? '' : 's'} bij ${article.items.length} items (norm: minimaal ${quoteNorm}). Voeg eventueel handmatig een geverifieerde quote toe in WordPress.`);
  }

  const namedInClosing = article.items.filter(i => article.afsluiting.toLocaleLowerCase('nl-NL').includes(i.naam.toLocaleLowerCase('nl-NL').split(' ')[0])).length;
  if (namedInClosing < 2) {
    meldingen.push('De afsluiting combineert minder dan twee items bij naam; check of het slot concreet genoeg is.');
  }
  return meldingen;
}

export function validateArticle(article: GeneratedArticle, topic: string) {
  range('Titel', article.title, 8, 12);
  range('Subregel', article.subregel, 10, 15);
  range('Introductie', article.introductie_tekst, 40, 60);
  range('Artikeltekst', article.content, 400, 450);
  range('Quote', article.quote, 15, 25);
  if (!normal(article.title).includes(normal(topic))) throw new Error('De titel moet de naam van het onderwerp bevatten.');
  if (!normal(article.content).includes(normal(article.quote))) throw new Error('De quote moet letterlijk in de artikeltekst voorkomen.');
  if ([article.title, article.subregel, article.introductie_tekst, article.content, article.quote].some(v => /[—–]/.test(v))) {
    throw new Error('Een artikel mag geen em dash of en dash bevatten.');
  }
  if (/\bAmsterdam\b/i.test(`${article.title} ${article.subregel} ${article.introductie_tekst}`)) {
    throw new Error('Amsterdam mag niet in titel, subregel of introductie staan.');
  }
  if (article.content.split(/\n\s*\n/).filter(Boolean).length < 5) throw new Error('Artikeltekst moet uit minimaal vijf alinea’s bestaan.');
}
