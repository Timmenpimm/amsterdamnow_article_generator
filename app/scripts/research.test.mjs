// Standalone unit tests voor de anti-hallucinatie-poort: researchFactScore
// (lib/writer.ts), de sparse-modus van validateArticle (lib/validation.ts) en
// de bron-attributie in formatStandardArticleHtml (lib/articleHtml.ts).
// Pure functies, geen netwerk/DB. Draaien met: npm run test:research
//
// Regressie voor de audit van 25-07-2026: vier van de vier publicatieklare
// artikelen bevatten verzonnen details (plafondhoogte, nationaliteit,
// zaalnamen) omdat de schrijf-prompt bij dunne research moest opvullen tot
// 400 woorden. De poort hieronder bepaalt wanneer de pipeline in plaats
// daarvan bijzoekt en korter schrijft.
import assert from 'node:assert/strict';
import { researchFactScore } from '../lib/writer.ts';
import { validateArticle } from '../lib/validation.ts';
import { formatStandardArticleHtml } from '../lib/articleHtml.ts';
import { DEFAULT_STANDAARD_CONSTRAINTS } from '../lib/types.ts';

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

const woorden = (n, woord = 'woord') => Array.from({ length: n }, () => woord).join(' ');

// Past binnen de standaard quote-eis van 25-40 woorden.
const QUOTE = 'Wij bakken hier elke ochtend ons eigen brood in de oven achterin en dat blijft ook na vijf jaar nog steeds het belangrijkste onderdeel van deze zaak';
const QUOTE_WOORDEN = QUOTE.split(/\s+/).length;

// Artikeltekst van precies `totaal` woorden, verdeeld over `alineas` alinea's,
// met de quote letterlijk in de eerste alinea (de verbatim-eis).
function content(totaal, alineas = 3) {
  const filler = totaal - QUOTE_WOORDEN;
  const per = Math.floor(filler / alineas);
  const blokken = Array.from({ length: alineas }, (_, i) => woorden(per + (i === 0 ? filler - per * alineas : 0)));
  blokken[0] = `${blokken[0]}. ${QUOTE}.`;
  return blokken.join('\n\n');
}

// Een artikel dat alle vaste regels haalt; per test overschrijven we alleen
// het veld dat we onderzoeken.
function artikel(overrides = {}) {
  return {
    title: 'Levain et le vin brengt brood en wijn naar de buurt',
    subregel: 'De bakkerij combineert zuurdesem met natuurwijn in een klein hoekpand',
    introductie_tekst: woorden(50),
    content: content(420, 5),
    quote: QUOTE,
    ...overrides,
  };
}

// ---------- researchFactScore ----------

test('researchFactScore: lege research scoort 0', () => {
  assert.equal(researchFactScore({}), 0);
  assert.equal(researchFactScore(null), 0);
  assert.equal(researchFactScore(undefined), 0);
});

test('researchFactScore: een lijst met 3+ items telt zwaarder dan een korte lijst', () => {
  const kort = researchFactScore({ key_people: ['Lasse'] });
  const lang = researchFactScore({ key_people: ['Lasse', 'Mira', 'Joost'] });
  assert.ok(lang > kort, `verwacht ${lang} > ${kort}`);
});

test('researchFactScore: dunne research blijft onder de standaarddrempel', () => {
  const score = researchFactScore({ samenvatting: 'Een broodjeszaak in het centrum.', adres: 'Sint Antoniesbreestraat 3f' });
  assert.ok(score < DEFAULT_STANDAARD_CONSTRAINTS.minFactScore, `score ${score} zou onder ${DEFAULT_STANDAARD_CONSTRAINTS.minFactScore} moeten liggen`);
});

test('researchFactScore: rijke research haalt de drempel', () => {
  const score = researchFactScore({
    samenvatting: 'Bakkerij en wijnwinkel in één pand.',
    concept_description: 'Zuurdesem uit eigen oven, natuurwijn per glas.',
    adres: 'Van Woustraat 12',
    website: 'https://levain.nl',
    key_people: ['Lasse', 'Mira', 'Joost'],
    distinctive_features: ['open bakkerij', 'wijn per glas', 'geen terras'],
    product_or_menu_highlights: ['zuurdesembrood', 'kouignamann'],
    company_facts: ['geopend in 2021'],
    space_and_building: ['voormalig garagepand'],
  });
  assert.ok(score >= DEFAULT_STANDAARD_CONSTRAINTS.minFactScore, `score ${score} zou minstens ${DEFAULT_STANDAARD_CONSTRAINTS.minFactScore} moeten zijn`);
});

// ---------- sparse-modus ----------

test('validateArticle: 280 woorden wordt afgekeurd zonder sparse', () => {
  const a = artikel({ content: content(280, 3) });
  assert.throws(() => validateArticle(a, 'Levain et le vin', DEFAULT_STANDAARD_CONSTRAINTS), /Artikeltekst/);
});

test('validateArticle: hetzelfde artikel is geldig mét sparse', () => {
  const a = artikel({ content: content(280, 3) });
  validateArticle(a, 'Levain et le vin', DEFAULT_STANDAARD_CONSTRAINTS, { sparse: true });
});

test('validateArticle: sparse verlaagt de alinea-eis maar schaft hem niet af', () => {
  const a = artikel({ content: content(280, 2) });
  assert.throws(() => validateArticle(a, 'Levain et le vin', DEFAULT_STANDAARD_CONSTRAINTS, { sparse: true }), /alinea/);
});

test('validateArticle: sparse laat de overige harde regels ongemoeid', () => {
  const a = artikel({ content: `${content(280, 3)} — met een em dash` });
  assert.throws(() => validateArticle(a, 'Levain et le vin', DEFAULT_STANDAARD_CONSTRAINTS, { sparse: true }), /dash/);
});

test('validateArticle: oude constraint-JSON zonder sparseContentWords valt terug op contentWords', () => {
  const oud = { ...DEFAULT_STANDAARD_CONSTRAINTS };
  delete oud.sparseContentWords;
  validateArticle(artikel(), 'Levain et le vin', oud, { sparse: true });
  assert.throws(() => validateArticle(artikel({ content: content(280, 3) }), 'Levain et le vin', oud, { sparse: true }), /Artikeltekst/);
});

// ---------- bron-attributie in de HTML ----------

test('formatStandardArticleHtml: zonder attributie geen cite (bestaande drafts blijven gelijk)', () => {
  const html = formatStandardArticleHtml(`${woorden(30)}\n\n${woorden(30)}\n\n${woorden(30)}`, 'Een pakkende zin uit de tekst');
  assert.ok(html.includes('<blockquote>'), 'blockquote ontbreekt');
  assert.ok(!html.includes('<cite'), 'cite hoort er niet te staan zonder attributie');
});

test('formatStandardArticleHtml: mét attributie verschijnt de bronvermelding', () => {
  const html = formatStandardArticleHtml(`${woorden(30)}\n\n${woorden(30)}\n\n${woorden(30)}`, 'Wij bakken elke ochtend zelf', 'eigenaar Lasse Jensen in Het Parool');
  assert.ok(html.includes('<cite'), 'cite ontbreekt');
  assert.ok(html.includes('eigenaar Lasse Jensen in Het Parool'), 'attributietekst ontbreekt');
});

// ---------- samenvatting ----------

console.log(`\n${passed} geslaagd, ${failures.length} mislukt`);
if (failures.length) {
  for (const f of failures) console.error(`\n${f.name}:\n${f.err.stack}`);
  process.exit(1);
}
