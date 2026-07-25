// Standalone unit tests voor de voorbeeldzin-lek-check in lib/validation.ts —
// pure functies, geen netwerk/DB. Draaien met: npm run test:promptexample
//
// Regressie voor artikel 87322 (Dekmantel Into the City): de pull-quote "De
// wijnkaart is hier net zo serieus als de keuken. En dat is precies de
// bedoeling." kwam letterlijk uit <example type="quote"> in de schrijfprompt.
// Omdat de quote ook woord voor woord in de content moet staan, plakte het
// model diezelfde wijnzin midden in een alinea over de line-up. Dezelfde zin
// stond in minstens elf gepubliceerde artikelen, waaronder een sportwinkel en
// een theater.
import assert from 'node:assert/strict';
import { extractPromptExamples, findPromptExampleLeak, validateArticle } from '../lib/validation.ts';

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

const WIJNZIN = 'De wijnkaart is hier net zo serieus als de keuken. En dat is precies de bedoeling.';

const PROMPT = `<tone_guide>
<example type="vague_vs_concrete">
<vaag>De sfeer is huiselijk, en dat is bewust.</vaag>
<concreet>Houten vloeren die kraken, tafels die niet bij elkaar passen, en een bar waar de eigenaar zelf achter staat.</concreet>
</example>
</tone_guide>

<examples>
<example type="title">
<good>KLM Open 2026 op de baan van Ian Woosnam</good>
</example>

<example type="subregel">
<good>Eigenaar Matthijs van Stapele en sommelier Rutger Bogers runnen de zaak</good>
</example>

<example type="quote">
<bad>Wijn is bij Chez Chloé geen bijzaak maar een structurele pijler van de ervaring.</bad>
<good>${WIJNZIN}</good>
</example>

<example type="food_description">
<good>De uitsmijter: drie biologische spiegeleieren, rijpe Beemster, boerenachterham van de slager om de hoek.</good>
</example>
</examples>`;

// ---------- extractPromptExamples ----------

test('extractPromptExamples: pakt quote-, food- en tone-voorbeelden', () => {
  const examples = extractPromptExamples(PROMPT);
  assert.ok(examples.includes(WIJNZIN));
  assert.ok(examples.some(e => e.startsWith('De uitsmijter:')));
  assert.ok(examples.some(e => e.startsWith('Houten vloeren')));
});

test('extractPromptExamples: laat titel- en subregelvoorbeelden staan', () => {
  // Die noemen echte zaken; een artikel over precies dát onderwerp mag
  // legitiem op dezelfde kop uitkomen.
  const examples = extractPromptExamples(PROMPT);
  assert.ok(!examples.some(e => e.includes('KLM Open')));
  assert.ok(!examples.some(e => e.includes('Matthijs van Stapele')));
});

test('extractPromptExamples: korte voorbeelden tellen niet mee', () => {
  assert.deepEqual(extractPromptExamples('<example type="x"><good>Hier eet je goed.</good></example>'), []);
});

test('extractPromptExamples: lege of voorbeeldloze prompt geeft lege lijst', () => {
  assert.deepEqual(extractPromptExamples(''), []);
  assert.deepEqual(extractPromptExamples('<role>Je bent journalist.</role>'), []);
});

// ---------- findPromptExampleLeak ----------

test('findPromptExampleLeak: vindt de zin ongeacht hoofdletters en leestekens', () => {
  const examples = extractPromptExamples(PROMPT);
  const tekst = 'Ook SNPLO en Molina staan op het affiche. de wijnkaart is hier net zo serieus als de keuken en dat is precies de bedoeling! Deze diversiteit maakt de avond.';
  assert.equal(findPromptExampleLeak(tekst, examples), WIJNZIN);
});

test('findPromptExampleLeak: eigen tekst over hetzelfde onderwerp mag wel', () => {
  const examples = extractPromptExamples(PROMPT);
  const tekst = 'De wijnkaart bij Chez Chloé telt veertig flessen, allemaal Frans en allemaal uitgezocht door de sommelier.';
  assert.equal(findPromptExampleLeak(tekst, examples), null);
});

test('findPromptExampleLeak: zonder voorbeelden nooit een lek', () => {
  assert.equal(findPromptExampleLeak(WIJNZIN, []), null);
});

// ---------- validateArticle ----------

const CONFIG = {
  titleWords: { min: 1, max: 40 }, titleMaxChars: 200,
  subregelWords: { min: 1, max: 40 }, introWords: { min: 1, max: 200 },
  contentWords: { min: 1, max: 2000 }, quoteWords: { min: 1, max: 60 },
  titleMustContainTopic: false, quoteMustBeVerbatimInContent: true,
  noDashInText: false, noAmsterdamRepeatInTitleSubregelIntro: false, minParagraphs: 1,
};

function article(overrides = {}) {
  return {
    title: 'Dekmantel Festival verliest heilige grenzen: Into the City',
    subregel: 'Dit festival neemt op 30 juli de podia van Melkweg en Paradiso over.',
    introductie_tekst: 'Voor het eerst verlaat het evenement de vertrouwde grenzen en trekt het de stad in.',
    content: 'DARKSIDE en INFINITI staan op het affiche.\n\nDe zalen krijgen een andere dynamiek.',
    quote: 'De zalen krijgen een andere dynamiek.',
    ...overrides,
  };
}

test('validateArticle: keurt een overgenomen voorbeeldzin af', () => {
  const besmet = article({
    content: `DARKSIDE en INFINITI staan op het affiche. ${WIJNZIN}\n\nDe zalen krijgen een andere dynamiek.`,
    quote: WIJNZIN,
  });
  assert.throws(
    () => validateArticle(besmet, 'Dekmantel', CONFIG, extractPromptExamples(PROMPT)),
    /Voorbeeldzin uit de prompt letterlijk overgenomen/,
  );
});

test('validateArticle: eigen quote komt gewoon door de keuring', () => {
  validateArticle(article(), 'Dekmantel', CONFIG, extractPromptExamples(PROMPT));
});

test('validateArticle: zonder voorbeeldlijst blijft het gedrag ongewijzigd', () => {
  // Bestaande aanroepers die de vierde parameter niet meegeven (backfills,
  // tests) mogen niet opeens gaan afkeuren.
  const besmet = article({
    content: `DARKSIDE staat op het affiche. ${WIJNZIN}`,
    quote: WIJNZIN,
  });
  validateArticle(besmet, 'Dekmantel', CONFIG);
});

// ---------- samenvatting ----------

console.log(`\n${passed} geslaagd, ${failures.length} mislukt`);
if (failures.length) {
  for (const f of failures) console.error(`\n${f.name}:\n${f.err.stack}`);
  process.exit(1);
}
