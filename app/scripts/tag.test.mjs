// Standalone unit tests voor de tagkeuze: lib/wp.ts singleTag.
// Pure functie, geen netwerk/DB. Draaien met: npm run test:tag
//
// Achtergrond: "max 5 tags" stond alleen als zin in de prompt en het schema was
// een ongelimiteerde string-array, dus niets garandeerde het aantal. Een artikel
// krijgt nu hoogstens één tag: de best passende, of geen.
import assert from 'node:assert/strict';
import { singleTag } from '../lib/wp.ts';

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

// ---------- nieuw veld: tag (string) ----------

test('singleTag: pakt het stringveld tag', () => {
  assert.deepEqual(singleTag({ tag: 'Musea' }), ['Musea']);
});

test('singleTag: trimt witruimte', () => {
  assert.deepEqual(singleTag({ tag: '  Cocktailbars  ' }), ['Cocktailbars']);
});

test('singleTag: lege tag levert geen tag op', () => {
  assert.deepEqual(singleTag({ tag: '' }), []);
  assert.deepEqual(singleTag({ tag: '   ' }), []);
});

test('singleTag: ontbrekend veld levert geen tag op', () => {
  assert.deepEqual(singleTag({}), []);
});

test('singleTag: negeert niet-string waarden', () => {
  assert.deepEqual(singleTag({ tag: 42 }), []);
  assert.deepEqual(singleTag({ tag: null }), []);
});

// ---------- terugval: oud veld tags (array) ----------
// Topics/lijsten die al in de wachtrij stonden hebben nog een opgeslagen state
// met het oude array-veld. Die moeten niet alsnog meerdere tags doorgeven.

test('singleTag: valt terug op het oude tags-array en houdt er één over', () => {
  assert.deepEqual(singleTag({ tags: ['Musea', 'Galeries', 'Jordaan'] }), ['Musea']);
});

test('singleTag: terugval slaat lege elementen over', () => {
  assert.deepEqual(singleTag({ tags: ['', '  ', 'Podia'] }), ['Podia']);
});

test('singleTag: leeg tags-array levert geen tag op', () => {
  assert.deepEqual(singleTag({ tags: [] }), []);
});

test('singleTag: het nieuwe veld wint van het oude array', () => {
  assert.deepEqual(singleTag({ tag: 'Clubs', tags: ['Musea', 'Galeries'] }), ['Clubs']);
});

test('singleTag: geeft nooit meer dan één tag terug', () => {
  const cases = [
    { tag: 'Musea', tags: ['a', 'b', 'c'] },
    { tags: ['a', 'b', 'c', 'd', 'e', 'f'] },
    { tag: 'Kids' },
  ];
  for (const input of cases) assert.ok(singleTag(input).length <= 1, JSON.stringify(input));
});

console.log(`\n${passed} geslaagd, ${failures.length} gefaald`);
if (failures.length) process.exit(1);
