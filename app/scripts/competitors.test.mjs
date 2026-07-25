// Standalone unit tests voor de concurrentenblokkade (lib/competitors.ts en de
// poorten die erop leunen) — pure functies, geen netwerk/DB.
// Draaien met: npm run test:competitors
//
// Regressie voor artikel 87365 ("Your Little Black Book tipt: 18 museumbezoeken
// voor een culturele juli"). De keten die dat artikel opleverde:
//   1. bron ylbb.nl leverde de kop "Museumagenda Amsterdam juli 2026: 18 X
//      tentoonstellingstips" (20-07, één dag vóór de redactionaliseer-stap
//      bestond, dus die kop ging letterlijk de wachtrij in);
//   2. de research zocht daarop, vond het YLBB-artikel als beste treffer en
//      tavily.ts verklaarde yourlittleblackbook.me tot "officiële site";
//   3. naam_locatie/website werden hún merk, en daarmee ook titel, slug,
//      focus-keyword, meta-description en de beeld-zoekopdracht.
// Elke stap heeft hieronder een test.
import assert from 'node:assert/strict';
import { competitorInTekst, competitorInHost, competitorInBron } from '../lib/competitors.ts';
import { checkNoCompetitor, validateArticle } from '../lib/validation.ts';
import { buildImageQueries } from '../lib/imageSearch.ts';

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`NOT OK - ${name}`);
    console.log(`  ${err.message}`);
  }
}

// ---------- competitorInTekst ----------

test('competitorInTekst: pakt de merknaam ongeacht schrijfwijze', () => {
  assert.equal(competitorInTekst(['Your Little Black Book tipt: 18 museumbezoeken']), 'Your Little Black Book');
  assert.equal(competitorInTekst(['yourlittleblackbook']), 'Your Little Black Book');
  assert.equal(competitorInTekst(['YLBB — museumagenda']), 'Your Little Black Book');
  assert.equal(competitorInTekst(['Zoals Barts Boekje al schreef']), 'Barts Boekje');
});

test('competitorInTekst: pakt een domein in vrije tekst en in een credit', () => {
  assert.equal(competitorInTekst(['https://www.yourlittleblackbook.me']), 'Your Little Black Book');
  assert.equal(competitorInTekst(['Google · ylbb.nl']), 'Your Little Black Book');
});

test('competitorInTekst: matcht niet middenin een ander woord', () => {
  // "ylbb" mag niet aanslaan op een willekeurige lettercombinatie.
  assert.equal(competitorInTekst(['Bij Stylbbq draait alles om vuur']), null);
});

test('competitorInTekst: gewone artikeltekst blijft schoon', () => {
  assert.equal(competitorInTekst(['Het Rijksmuseum viert de zomervakantie met Toy Story']), null);
  assert.equal(competitorInTekst([]), null);
  assert.equal(competitorInTekst([null, undefined, '']), null);
});

test('competitorInTekst: extra termen uit de instellingen blokkeren net zo hard', () => {
  assert.equal(competitorInTekst(['Gezien bij Entree Magazine']), null);
  assert.equal(competitorInTekst(['Gezien bij Entree Magazine'], ['entree magazine']), 'entree magazine');
});

// ---------- competitorInHost / competitorInBron ----------

test('competitorInHost: host telt, een vermelding in het pad niet', () => {
  assert.equal(competitorInHost('https://www.yourlittleblackbook.me/musea-juli'), 'Your Little Black Book');
  assert.equal(competitorInHost('https://cdn.ylbb.nl/foto.jpg'), 'Your Little Black Book');
  // Een pagina die de concurrent noemt is zelf geen concurrent-pagina.
  assert.equal(competitorInHost('https://www.rijksmuseum.nl/pers/ylbb-recensie'), null);
  assert.equal(competitorInHost('geen url'), null);
  assert.equal(competitorInHost(null), null);
});

test('competitorInBron: host óf tekst, allebei genoeg', () => {
  assert.equal(competitorInBron({ url: 'https://indebuurt.nl/amsterdam' }), 'Indebuurt');
  assert.equal(competitorInBron({ url: 'https://example.com/foto.jpg', tekst: ['Google · Barts Boekje'] }), 'Barts Boekje');
  assert.equal(competitorInBron({ url: 'https://www.rijksmuseum.nl', tekst: ['Rijksmuseum'] }), null);
});

// ---------- tekstpoort in validation.ts ----------

test('checkNoCompetitor: meldt wat er moet gebeuren', () => {
  const melding = checkNoCompetitor('Zoals Your Little Black Book schreef is dit de mooiste expo.');
  assert.match(melding, /Your Little Black Book/);
  assert.match(melding, /eigen woorden/);
  assert.equal(checkNoCompetitor('Het Stedelijk toont nieuw werk van Carel Visser.'), null);
});

const CONFIG = {
  titleWords: { min: 1, max: 40 }, titleMaxChars: 200,
  subregelWords: { min: 1, max: 40 }, introWords: { min: 1, max: 200 },
  contentWords: { min: 1, max: 2000 }, quoteWords: { min: 1, max: 60 },
  titleMustContainTopic: false, quoteMustBeVerbatimInContent: true,
  noDashInText: false, noAmsterdamRepeatInTitleSubregelIntro: false, minParagraphs: 1,
};

function article(overrides = {}) {
  return {
    title: 'Rijksmuseum eert Willem de Kooning met ruim honderd tekeningen',
    subregel: 'De tentoonstelling loopt de hele zomer door in de tuinzaal.',
    introductie_tekst: 'Het museum toont werk dat zelden buiten het depot komt.',
    content: 'De tekeningen zijn voor het eerst samen te zien.\n\nDe zaal is opnieuw ingericht.',
    quote: 'De zaal is opnieuw ingericht.',
    ...overrides,
  };
}

test('validateArticle: keurt een artikel met een concurrent in de tekst af', () => {
  const besmet = article({
    content: 'De tekeningen zijn voor het eerst samen te zien, schreef Your Little Black Book.\n\nDe zaal is opnieuw ingericht.',
  });
  assert.throws(() => validateArticle(besmet, 'Rijksmuseum', CONFIG), /Your Little Black Book/);
});

test('validateArticle: keurt de kop van artikel 87365 af', () => {
  const besmet = article({ title: 'Your Little Black Book tipt: 18 museumbezoeken voor een culturele juli' });
  assert.throws(() => validateArticle(besmet, 'Rijksmuseum', CONFIG), /concurrerende stadsgids/);
});

test('validateArticle: een schoon artikel komt gewoon door', () => {
  validateArticle(article(), 'Rijksmuseum', CONFIG);
});

// ---------- beeldpoort ----------

test('buildImageQueries: zoekt nooit op de merknaam van een concurrent', () => {
  // Precies de zoekopdracht die de drie YLBB-foto's in de mediabibliotheek
  // van amsterdamnow.com zette.
  const queries = buildImageQueries({
    title: 'Your Little Black Book tipt: 18 museumbezoeken voor een culturele juli',
    naam_locatie: 'Your Little Black Book',
    district: 'Amsterdam Centrum',
    tags: ['Tentoonstellingen'],
    category: 'Cultuur',
  });
  assert.ok(!queries.some(q => /black book/i.test(q)), `concurrent in zoektermen: ${queries.join(' | ')}`);
  // De bruikbare, neutrale termen blijven wel staan.
  assert.ok(queries.includes('Tentoonstellingen Amsterdam'));
});

test('buildImageQueries: normaal artikel houdt zijn zoektermen', () => {
  const queries = buildImageQueries({
    title: 'Carel Visser in de Rijksmuseumtuinen',
    naam_locatie: 'Rijksmuseum',
    district: 'Amsterdam Zuid',
    tags: ['Tentoonstellingen'],
    category: 'Cultuur',
  });
  assert.equal(queries[0], 'Rijksmuseum Amsterdam');
});

// ---------- samenvatting ----------

console.log(`\n${passed} geslaagd, ${failures.length} mislukt`);
if (failures.length) {
  for (const f of failures) console.error(`\n${f.name}:\n${f.err.stack}`);
  process.exit(1);
}
