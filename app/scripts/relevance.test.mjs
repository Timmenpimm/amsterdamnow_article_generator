// Standalone unit tests voor het bronnen-relevantiefilter in lib/relevance.ts
// — pure functies, geen netwerk/DB. Draaien met: npm run test:relevance
//
// Achtergrond (productie, 26-07-2026): de profielqueries van de
// verdiepingsronde haalden een DGTL-festivalpagina binnen bij het onderwerp
// "Wolvenroedel … ADE … Fabrique des Lumières", waarna de invalshoek-poort
// het topic afkeurde op een "tegenspraak" over DGTL-data die niets met het
// onderwerp te maken had. Dit filter weert zulke bronnen op token-overlap.
import assert from 'node:assert/strict';
import { bronIsRelevant, filterOpRelevantie, kernwoorden, onderwerpTokens } from '../lib/relevance.ts';

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

// ---------- onderwerpTokens ----------

test('onderwerpTokens: onderscheidende woorden, zonder stopwoorden en korte tokens', () => {
  const tokens = onderwerpTokens('Wolvenroedel danst tijdens ADE in de Fabrique des Lumières', 'Wolvenroedel');
  assert.ok(tokens.includes('wolvenroedel'));
  assert.ok(tokens.includes('fabrique'));
  assert.ok(tokens.includes('lumieres'), 'diacritics gestript');
  assert.ok(!tokens.includes('ade'), 'tokens korter dan 4 tekens vallen af');
  assert.ok(!tokens.includes('de'));
});

test('onderwerpTokens: generieke domeinwoorden tellen niet mee', () => {
  const tokens = onderwerpTokens('Nieuw festival in Amsterdam: Neoseum museum opent');
  assert.deepEqual(tokens, ['neoseum']);
});

test('onderwerpTokens: dedupliceert over meerdere namen heen', () => {
  const tokens = onderwerpTokens('Pelusa opent in Noord', 'Pelusa');
  assert.deepEqual(tokens, ['pelusa', 'noord']);
});

// ---------- bronIsRelevant ----------

const wolvenTokens = onderwerpTokens('Wolvenroedel danst tijdens ADE in de Fabrique des Lumières');

test('bronIsRelevant: pagina over een ander festival (DGTL) valt af', () => {
  const dgtl = {
    title: 'DGTL Festival 2026 line-up en data',
    url: 'https://festivalsite.example/dgtl-2026',
    content: 'DGTL keert terug naar de NDSM-werf. Het festival maakt de data en de volledige line-up bekend.',
  };
  assert.equal(bronIsRelevant(dgtl, wolvenTokens), false);
});

test('bronIsRelevant: matcht de onderwerpnaam in titel of content', () => {
  const eigen = {
    title: 'Wolvenroedel: audiovisuele show tijdens ADE',
    url: 'https://voorbeeld.example/agenda',
    content: 'Tijdens ADE is er van alles te doen.',
  };
  assert.equal(bronIsRelevant(eigen, wolvenTokens), true);
});

test('bronIsRelevant: token matcht ook aaneengeschreven in een domeinnaam', () => {
  const homepage = { title: 'Home', url: 'https://www.fabriquedeslumieres.com/', content: '' };
  assert.equal(bronIsRelevant(homepage, wolvenTokens), true);
});

test('bronIsRelevant: meerwoordige naam matcht aaneengeschreven via het spatievrije venster', () => {
  // "des lumieres" als losse woorden in de hooiberg → token "lumieres" zit er
  // sowieso in; check de omgekeerde route: token uit een samengestelde naam.
  const tokens = onderwerpTokens('Club West');
  const bron = { title: 'ClubWest opent', url: 'https://x.example/', content: '' };
  assert.equal(bronIsRelevant(bron, tokens), true);
});

test('bronIsRelevant: zonder onderscheidende tokens wordt er niet gefilterd', () => {
  const bron = { title: 'Iets', url: 'https://x.example/', content: '' };
  assert.equal(bronIsRelevant(bron, []), true);
});

// ---------- filterOpRelevantie ----------

const relevantBron = { title: 'Neoseum opent', url: 'https://neoseum.example/', content: 'Neoseum is nieuw.' };
const vreemdeBron1 = { title: 'FAQ Groepen', url: 'https://andermuseum.example/faq', content: 'Tot 10 personen per groep.' };
const vreemdeBron2 = { title: 'Agenda', url: 'https://agenda.example/', content: 'Van alles te doen.' };
const neoTokens = onderwerpTokens('Neoseum');

test('filterOpRelevantie: irrelevante bronnen vallen weg als er genoeg relevante zijn', () => {
  const uit = filterOpRelevantie([relevantBron, vreemdeBron1, { ...relevantBron, url: 'https://neoseum.example/tickets' }, vreemdeBron2], neoTokens);
  assert.equal(uit.length, 2);
  assert.ok(uit.every(b => b.url.includes('neoseum')));
});

test('filterOpRelevantie: bij te weinig relevante bronnen degraderen de rest naar achteren', () => {
  const uit = filterOpRelevantie([vreemdeBron1, relevantBron, vreemdeBron2], neoTokens);
  assert.equal(uit.length, 3, 'niets weggegooid');
  assert.equal(uit[0].url, relevantBron.url, 'relevante bron vooraan');
});

test('filterOpRelevantie: minBronnen 0 is strikt (verdiepingsronde)', () => {
  const uit = filterOpRelevantie([vreemdeBron1, relevantBron, vreemdeBron2], neoTokens, 0);
  assert.deepEqual(uit, [relevantBron]);
});

// ---------- kernwoorden ----------

test('kernwoorden: haalt de zoektermen uit een afwijsreden', () => {
  const q = kernwoorden('De research bevat geen concrete gerechten van de menukaart en geen naam van de chef');
  assert.ok(q.includes('gerechten'));
  assert.ok(q.includes('menukaart'));
  assert.ok(q.includes('chef'));
  assert.ok(!q.includes('research'));
  assert.ok(!q.includes('geen'));
});

test('kernwoorden: lege zin geeft lege string', () => {
  assert.equal(kernwoorden(''), '');
});

// ---------- samenvatting ----------

console.log(`\n${passed} geslaagd, ${failures.length} mislukt`);
if (failures.length) {
  for (const f of failures) console.error(`\n${f.name}:\n${f.err.stack}`);
  process.exit(1);
}
