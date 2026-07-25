// Standalone unit tests voor de categorie-researchprofielen in
// lib/researchProfiles.ts — pure functies, geen netwerk/DB.
// Draaien met: npm run test:researchprofiles
//
// Achtergrond (kalibratie 25-07-2026): nietszeggende artikelen zijn vrijwel
// altijd onderwerpen waar ronde 1 alleen homepage-marketingcopy vond. Wat een
// artikel inhoud geeft verschilt per categorie: festival → line-up en
// organisatie, restaurant → chef en kaart, winkel → wat 'm anders maakt.
import assert from 'node:assert/strict';
import { detectProfiel, profielFocus, profielQueries } from '../lib/researchProfiles.ts';

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

// ---------- detectProfiel ----------

test('detectProfiel: festivaltag wint, ook binnen Uitgaan', () => {
  assert.equal(detectProfiel({ tag: 'Festivals', categories: ['Uitgaan'], rubriek: 'Evenement' }), 'festival');
});

test('detectProfiel: cultuur splitst in tentoonstelling en voorstelling', () => {
  assert.equal(detectProfiel({ tag: 'Tentoonstellingen', categories: ['Cultuur'], rubriek: 'Evenement' }), 'tentoonstelling');
  assert.equal(detectProfiel({ tag: 'Musea', categories: ['Cultuur'], rubriek: 'Locatie' }), 'tentoonstelling');
  assert.equal(detectProfiel({ tag: 'Theater', categories: ['Cultuur'], rubriek: 'Evenement' }), 'voorstelling');
});

test('detectProfiel: horeca, winkels en lifestyle', () => {
  assert.equal(detectProfiel({ tag: '', categories: ['Restaurants'], rubriek: 'Locatie' }), 'restaurant');
  assert.equal(detectProfiel({ tag: 'Koffie', categories: ['Eten & Drinken'], rubriek: 'Locatie' }), 'restaurant');
  assert.equal(detectProfiel({ tag: '', categories: ['Winkels'], rubriek: 'Locatie' }), 'winkel');
  assert.equal(detectProfiel({ tag: 'Wellness', categories: ['Lifestyle'], rubriek: 'Locatie' }), 'lifestyle');
});

test('detectProfiel: uitgaan zonder festivaltag volgt de rubriek', () => {
  assert.equal(detectProfiel({ tag: '', categories: ['Uitgaan'], rubriek: 'Evenement' }), 'evenement');
  assert.equal(detectProfiel({ tag: '', categories: ['Uitgaan'], rubriek: 'Locatie' }), 'restaurant');
});

test('detectProfiel: zonder herkenbare categorie valt de rubriek terug', () => {
  assert.equal(detectProfiel({ tag: '', categories: [], rubriek: 'Evenement' }), 'evenement');
  assert.equal(detectProfiel({ tag: '', categories: [], rubriek: 'Locatie' }), 'locatie');
  assert.equal(detectProfiel(null), 'locatie');
});

// ---------- profielQueries ----------

test('profielQueries: festival zoekt line-up en organisatie, zonder adres', () => {
  const q = profielQueries('festival', 'NO ART Closing Festival', 'Flevopark, Amsterdam-Oost');
  assert.equal(q.length, 2);
  assert.ok(q[0].includes('line-up'));
  assert.ok(q[1].includes('organisatie'));
  assert.ok(!q[0].includes('Flevopark'), 'events zoeken zonder adres');
});

test('profielQueries: restaurant zoekt chef/kaart mét plaats', () => {
  const q = profielQueries('restaurant', 'Pelusa', 'Noord');
  assert.ok(q[0].includes('chef') && q[0].includes('Noord'));
  assert.ok(q[1].includes('interview'));
});

test('profielQueries: locatie-fallback is het oude gedrag', () => {
  const q = profielQueries('locatie', 'Kometen Brood', 'Marineterrein');
  assert.ok(q[0].includes('openingstijden'));
  assert.ok(q[1].includes('interview eigenaar'));
});

// ---------- profielFocus ----------

test('profielFocus: festivalregel eist het eigen domein voor de line-up', () => {
  const focus = profielFocus('festival', 'noartfestival.com');
  assert.ok(focus.includes('noartfestival.com'));
  assert.ok(focus.includes('HUIDIGE editie'));
  assert.ok(focus.includes('missing_facts'));
});

test('profielFocus: elk profiel heeft een focusregel', () => {
  for (const p of ['festival', 'voorstelling', 'tentoonstelling', 'restaurant', 'winkel', 'lifestyle', 'evenement', 'locatie']) {
    assert.ok(profielFocus(p).length > 20, `leeg profiel: ${p}`);
  }
});

// ---------- samenvatting ----------

console.log(`\n${passed} geslaagd, ${failures.length} mislukt`);
if (failures.length) {
  for (const f of failures) console.error(`\n${f.name}:\n${f.err.stack}`);
  process.exit(1);
}
