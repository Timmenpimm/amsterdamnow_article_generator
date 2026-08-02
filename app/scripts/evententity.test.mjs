// Standaalone unit tests voor withEventHomepageWaarschuwing (lib/writer.ts) —
// de uitzondering die voorkomt dat de entiteitscontrole events onterecht
// afkeurt. Pure functie, geen netwerk/DB. Draaien met: npm run test:evententity
//
// Achtergrond: de entiteitscontrole eiste tot nu toe impliciet dat de
// officiële homepage het GEVRAAGDE onderwerp bevestigt. Voor events klopt dat
// bijna nooit — de homepage van een venue noemt vrijwel nooit één specifiek
// toekomstig evenement — waardoor terechte drafts hard faalden (bv.
// "Wolvenroedel organiseert tijdens ADE een evenement in Fabrique des
// Lumières" faalde met "de homepage bevat geen enkele vermelding van
// Wolvenroedel of een ADE-evenement"). Sindsdien beoordeelt
// verifyEntityFields entiteit_consistent alleen nog op de PARTIJ (hoort de
// homepage bij dezelfde zaak, of bij een nieuwssite/aggregator/naamgenoot).
// withEventHomepageWaarschuwing voegt daarna, los van dat oordeel, een
// niet-blokkerende waarschuwing toe als het onderwerp een event is dat de
// homepage niet noemt.
//
// Deze tests dekken de drie scenario's uit de opdracht door
// withEventHomepageWaarschuwing te combineren met resolveEntityGate
// (scripts/topicwebsite.test.mjs), precies zoals writer.ts stepResearch ze
// na elkaar aanroept.
import assert from 'node:assert/strict';
import { withEventHomepageWaarschuwing, resolveEntityGate } from '../lib/writer.ts';

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

// ---------- withEventHomepageWaarschuwing op zichzelf ----------

test('event + homepage noemt onderwerp niet + geen bestaande waarschuwing: krijgt de standaardopmerking', () => {
  const result = withEventHomepageWaarschuwing('', true, false);
  assert.equal(result, 'Venue-homepage noemt het event niet; eventfeiten komen uit overige bronnen.');
});

test('event + homepage noemt onderwerp niet + bestaande waarschuwing: opmerking wordt toegevoegd, niet vervangen', () => {
  const result = withEventHomepageWaarschuwing('adres wijkt licht af', true, false);
  assert.match(result, /^adres wijkt licht af /);
  assert.match(result, /Venue-homepage noemt het event niet/);
});

test('event + homepage noemt onderwerp wél: waarschuwing blijft ongewijzigd', () => {
  assert.equal(withEventHomepageWaarschuwing('', true, true), '');
  assert.equal(withEventHomepageWaarschuwing('bestaande tekst', true, true), 'bestaande tekst');
});

test('geen event: waarschuwing blijft ongewijzigd, ook als de homepage niets noemt', () => {
  assert.equal(withEventHomepageWaarschuwing('', false, false), '');
  assert.equal(withEventHomepageWaarschuwing('bestaande tekst', false, false), 'bestaande tekst');
});

// ---------- volledige beslispijplijn: withEventHomepageWaarschuwing → resolveEntityGate ----------

test('event + juiste partij + homepage zonder vermelding: entiteit blijft consistent, pipeline gaat door met waarschuwing', () => {
  // entiteit_consistent = true, zoals verifyEntityFields nu voor dit geval teruggeeft.
  const waarschuwing = withEventHomepageWaarschuwing('', true, false);
  const result = resolveEntityGate(true, waarschuwing, null);
  assert.equal(result, 'Venue-homepage noemt het event niet; eventfeiten komen uit overige bronnen.');
});

test('homepage van een andere partij (nieuwssite/aggregator/naamgenoot): harde fail, ongeacht event of waarschuwing-opmerking', () => {
  // entiteit_consistent = false: dit blijft de bestaande harde fail.
  const waarschuwing = withEventHomepageWaarschuwing('homepage hoort bij een nieuwssite, niet bij de organisator', true, false);
  assert.throws(
    () => resolveEntityGate(false, waarschuwing, null),
    /Entiteitscontrole faalt: homepage hoort bij een nieuwssite, niet bij de organisator/,
  );
});

test('niet-event: gedrag exact zoals vóór de uitzondering — inconsistente homepage is een harde fail', () => {
  const waarschuwing = withEventHomepageWaarschuwing('homepage bevestigt het onderwerp niet', false, false);
  assert.throws(
    () => resolveEntityGate(false, waarschuwing, null),
    /Entiteitscontrole faalt: homepage bevestigt het onderwerp niet/,
  );
});

test('niet-event + consistente entiteit: gedrag exact zoals voorheen — geen fout, geen extra waarschuwing', () => {
  const waarschuwing = withEventHomepageWaarschuwing('', false, false);
  assert.equal(resolveEntityGate(true, waarschuwing, null), '');
});

// ---------- samenvatting ----------

console.log(`\n${passed} geslaagd, ${failures.length} mislukt`);
if (failures.length) {
  for (const f of failures) console.error(`\n${f.name}:\n${f.err.stack}`);
  process.exit(1);
}
