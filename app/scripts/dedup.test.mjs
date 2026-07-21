// Standalone unit tests voor lib/dedup.ts — pure functies, geen netwerk/DB.
// Draaien met: node --experimental-strip-types scripts/dedup.test.mjs
// (geen testframework toegevoegd; het project heeft er nog geen en de spec
// vraagt expliciet om geen nieuwe dependency hiervoor.)
import assert from 'node:assert/strict';
import { normalizeTitle, diceCoefficient, scoreCandidates } from '../lib/dedup.ts';

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

// ---------- normalizeTitle ----------

test('normalizeTitle: lowercase + interpunctie weg + tokenize', () => {
  assert.deepEqual(normalizeTitle('Morgan & Mees'), ['morgan', 'mees']);
});

test('normalizeTitle: decodeert HTML-entities zoals WP ze levert', () => {
  assert.deepEqual(normalizeTitle('Morgan &#038; Mees'), ['morgan', 'mees']);
});

test('normalizeTitle: strip diacritics', () => {
  assert.deepEqual(normalizeTitle('Café de Paris'), ['cafe', 'paris']);
});

test('normalizeTitle: verwijdert NL+EN stopwoorden', () => {
  assert.deepEqual(
    normalizeTitle('De beste nieuwe restaurants in Amsterdam-Noord'),
    ['restaurants', 'amsterdam', 'noord'],
  );
});

test('normalizeTitle: lege/whitespace-only titel geeft lege tokenlijst', () => {
  assert.deepEqual(normalizeTitle('   '), []);
  assert.deepEqual(normalizeTitle(''), []);
});

test('normalizeTitle: twee verschillend geschreven titels van hetzelfde onderwerp normaliseren identiek genoeg om overlap te scoren', () => {
  const a = normalizeTitle('AMAZE by ID&T: Immersive Audiovisual Experience in de Houthavens');
  const b = normalizeTitle('AMAZE Houthavens: audiovisuele beleving');
  const overlap = a.filter(t => b.includes(t));
  assert.ok(overlap.includes('amaze'), 'verwacht "amaze" als gedeeld token');
  assert.ok(overlap.includes('houthavens'), 'verwacht "houthavens" als gedeeld token');
});

// ---------- diceCoefficient ----------

test('diceCoefficient: identieke tokenlijsten scoren 1', () => {
  assert.equal(diceCoefficient(['a', 'b', 'c'], ['a', 'b', 'c']), 1);
});

test('diceCoefficient: volledig disjuncte tokenlijsten scoren 0', () => {
  assert.equal(diceCoefficient(['a', 'b'], ['c', 'd']), 0);
});

test('diceCoefficient: lege lijst scoort altijd 0', () => {
  assert.equal(diceCoefficient([], ['a']), 0);
  assert.equal(diceCoefficient(['a'], []), 0);
  assert.equal(diceCoefficient([], []), 0);
});

test('diceCoefficient: partiële overlap volgens de formule 2|A∩B| / (|A|+|B|)', () => {
  // A = {amaze, houthavens, immersive, experience} (4)
  // B = {amaze, houthavens, audiovisuele, beleving} (4)
  // overlap = {amaze, houthavens} (2) => 2*2 / (4+4) = 0.5
  const a = ['amaze', 'houthavens', 'immersive', 'experience'];
  const b = ['amaze', 'houthavens', 'audiovisuele', 'beleving'];
  assert.equal(diceCoefficient(a, b), 0.5);
});

// ---------- scoreCandidates (kandidaat-ranking) ----------

const FIXTURE_POSTS = [
  {
    id: 101,
    title: 'AMAZE by ID&T: Immersive Audiovisual Experience in de Houthavens',
    excerpt: 'Een nieuwe audiovisuele belevenis opent haar deuren in de Houthavens, met een uniek concept van ID&T.',
    link: 'https://www.amsterdamnow.com/amaze-idt-houthavens/',
    status: 'publish',
  },
  {
    id: 102,
    title: 'De beste terrassen van Amsterdam-Oost',
    excerpt: 'Een overzicht van de mooiste terrassen die Oost te bieden heeft, van klein en knus tot ruim aan het water.',
    link: 'https://www.amsterdamnow.com/terrassen-oost/',
    status: 'publish',
  },
  {
    id: 103,
    title: 'Vermut opent in Amsterdam: restaurant én aperitivobar ineen',
    excerpt: 'Een nieuwe zaak op de grens van restaurant en bar, met Spaanse en Italiaanse invloeden.',
    link: 'https://www.amsterdamnow.com/vermut-opent/',
    status: 'draft',
  },
];

test('scoreCandidates: rangschikt een herformulering van hetzelfde onderwerp bovenaan', () => {
  const query = 'AMAZE Houthavens: audiovisuele beleving';
  const results = scoreCandidates(query, FIXTURE_POSTS);
  assert.ok(results.length > 0, 'verwacht minstens één kandidaat boven de score-floor');
  assert.equal(results[0].wp_id, 101, `verwacht de AMAZE-post bovenaan, kreeg wp_id ${results[0]?.wp_id}`);
  assert.ok(results[0].score > 0.3, `verwacht een duidelijk hogere score dan de floor, kreeg ${results[0].score}`);
});

test('scoreCandidates: onderwerp zonder enige token-overlap (titel én excerpt) levert geen kandidaten op (onder de floor)', () => {
  const query = 'Fotografie-expositie in het Rijksmuseum deze zomer';
  const results = scoreCandidates(query, FIXTURE_POSTS);
  assert.equal(results.length, 0, `verwacht geen kandidaten, kreeg ${JSON.stringify(results.map(r => r.wp_id))}`);
});

test('scoreCandidates: een enkel toevallig gedeeld alledaags woord ("opent") tikt niet de hele shortlist vol', () => {
  // Bewust een geval waarin er precies één gedeeld token is met één van de
  // fixtures ("opent" in zowel de query als post 103) — dit hoort een lage,
  // maar niet per se onder-floor score te geven; dit demonstreert waarom de
  // Haiku-beoordeling (judgeDuplicate) nodig is bovenop de lexicale shortlist.
  const results = scoreCandidates('Nieuw museum voor moderne kunst opent op het IJ', FIXTURE_POSTS);
  const amaze = results.find(r => r.wp_id === 101);
  const terrassen = results.find(r => r.wp_id === 102);
  assert.equal(amaze, undefined, 'AMAZE-post deelt geen tokens met deze query en hoort niet mee te doen');
  assert.equal(terrassen, undefined, 'terrassen-post deelt geen tokens met deze query en hoort niet mee te doen');
});

test('scoreCandidates: substring-boost laat een titel die de andere bevat prominenter scoren dan alleen tokenoverlap zou geven', () => {
  const withSubstring = scoreCandidates('AMAZE Houthavens', FIXTURE_POSTS)[0];
  const tokensOnlyScore = diceCoefficient(normalizeTitle('AMAZE Houthavens'), normalizeTitle(FIXTURE_POSTS[0].title));
  assert.ok(withSubstring.score > tokensOnlyScore, 'verwacht dat de substring-boost de pure Dice-score overtreft');
});

test('scoreCandidates: respecteert de limit-parameter', () => {
  const manyPosts = FIXTURE_POSTS.concat(
    Array.from({ length: 5 }, (_, i) => ({
      id: 200 + i,
      title: `AMAZE Houthavens extra variant ${i}`,
      excerpt: '',
      link: `https://www.amsterdamnow.com/amaze-variant-${i}/`,
      status: 'publish',
    })),
  );
  const results = scoreCandidates('AMAZE Houthavens', manyPosts, 3);
  assert.ok(results.length <= 3, `verwacht maximaal 3 kandidaten, kreeg ${results.length}`);
});

console.log(`\n${passed} geslaagd, ${failures.length} mislukt`);
if (failures.length) process.exit(1);
