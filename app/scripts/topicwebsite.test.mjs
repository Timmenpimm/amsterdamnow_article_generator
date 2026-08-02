// Standaalone unit tests voor resolveEntityGate (lib/writer.ts) — de
// pipeline-beslissing die bepaalt of een mislukte entiteitscontrole het
// onderwerp blokkeert of alleen een gelogde waarschuwing oplevert. Pure
// functie, geen netwerk/DB. Draaien met: npm run test:topicwebsite
//
// Achtergrond: de pipeline researchte tot nu toe uitsluitend op de titel, en
// Tavily's eigen "officiële site"-detectie kon een verkeerde site kiezen
// (nieuwssite, aggregator, naamgenoot) waarna de entiteitscontrole het
// onderwerp hard liet stranden — zelfs als de redactie de juiste URL al
// kende. Met een door de redactie opgegeven website (topic.website) is de
// redactie de autoriteit: dezelfde mismatch wordt dan een waarschuwing in
// plaats van een harde fail.
import assert from 'node:assert/strict';
import { resolveEntityGate } from '../lib/writer.ts';

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

// ---------- zonder door de redactie opgegeven website (ongewijzigd gedrag) ----------

test('geen forcedWebsite + entiteit consistent: geen fout, waarschuwing ongewijzigd', () => {
  const result = resolveEntityGate(true, '', null);
  assert.equal(result, '');
});

test('geen forcedWebsite + entiteit inconsistent: harde fail zoals voorheen', () => {
  assert.throws(
    () => resolveEntityGate(false, 'naam en adres komen niet overeen', null),
    /Entiteitscontrole faalt: naam en adres komen niet overeen/,
  );
});

test('geen forcedWebsite + inconsistent + lege waarschuwing: harde fail met terugvaltekst', () => {
  assert.throws(
    () => resolveEntityGate(false, '', null),
    /Entiteitscontrole faalt: naam, adres en website lijken niet bij dezelfde zaak te horen/,
  );
});

test('entiteitConsistent undefined (verifyEntity faalde, fail-open): geen fout', () => {
  assert.equal(resolveEntityGate(undefined, '', null), '');
});

// ---------- met een door de redactie opgegeven website: redactie is autoriteit ----------

test('forcedWebsite + entiteit inconsistent: GEEN harde fail, wel gelogde waarschuwing', () => {
  const website = 'https://echte-zaak.nl';
  const result = resolveEntityGate(false, 'adres wijkt af van de research', website);
  assert.match(result, /Redactie gaf https:\/\/echte-zaak\.nl op als officiële website/);
  assert.match(result, /adres wijkt af van de research/);
  assert.match(result, /pipeline gaat door/);
});

test('forcedWebsite + entiteit inconsistent + lege waarschuwing: terugvaltekst in de waarschuwing', () => {
  const result = resolveEntityGate(false, '', 'https://echte-zaak.nl');
  assert.match(result, /naam, adres en website lijken niet bij dezelfde zaak te horen/);
});

test('forcedWebsite + entiteit consistent: geen fout, waarschuwing blijft ongewijzigd (leeg)', () => {
  assert.equal(resolveEntityGate(true, '', 'https://echte-zaak.nl'), '');
});

test('forcedWebsite + entiteit consistent met bestaande waarschuwing: waarschuwing blijft ongewijzigd', () => {
  assert.equal(resolveEntityGate(true, 'niet-blokkerende opmerking', 'https://echte-zaak.nl'), 'niet-blokkerende opmerking');
});

// ---------- samenvatting ----------

console.log(`\n${passed} geslaagd, ${failures.length} mislukt`);
if (failures.length) {
  for (const f of failures) console.error(`\n${f.name}:\n${f.err.stack}`);
  process.exit(1);
}
