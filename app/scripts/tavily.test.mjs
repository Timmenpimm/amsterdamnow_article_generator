// Standalone unit tests voor de URL-als-onderwerp- en aggregator-helpers in
// lib/tavily.ts — pure functies, geen netwerk. Draaien met: npm run test:tavily
//
// Regressie voor draft 87452 (NO ART Festival): de wachtrijtitel was de kale
// URL "https://www.noartfestival.com/". Als tekst behandeld werd de Tavily-
// query "https://www.noartfestival.com/ Amsterdam", faalde de officiële-site-
// detectie op het aaneengeschreven domein, en werd musicfestivalwizard.com
// (festival-verzamelsite, stond niet op de aggregatorlijst) tot "officiële
// site" verklaard — met de line-up van de vórige editie als gevolg.
import assert from 'node:assert/strict';
import { topicAsUrl, hostLabel, isAggregatorHost } from '../lib/tavily.ts';

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

// ---------- topicAsUrl ----------

test('topicAsUrl: herkent een geplakte URL als onderwerp', () => {
  const url = topicAsUrl('https://www.noartfestival.com/');
  assert.ok(url);
  assert.equal(url.origin, 'https://www.noartfestival.com');
});

test('topicAsUrl: gewone titels en tekst-met-link blijven tekst', () => {
  assert.equal(topicAsUrl('NO ART Festival in het Flevopark'), null);
  assert.equal(topicAsUrl('Vermut opent in Amsterdam'), null);
  // Een URL mét tekst eromheen is een titel, geen geplakte link.
  assert.equal(topicAsUrl('Kijk op https://www.noartfestival.com/ voor tickets'), null);
});

// ---------- hostLabel ----------

test('hostLabel: domeinlabel als zoeknaam', () => {
  assert.equal(hostLabel(new URL('https://www.noartfestival.com/')), 'noartfestival');
  assert.equal(hostLabel(new URL('https://paradiso.nl/programma')), 'paradiso');
});

// ---------- isAggregatorHost ----------

test('isAggregatorHost: festival-verzamelsites zijn nooit de officiële site', () => {
  assert.ok(isAggregatorHost('https://www.musicfestivalwizard.com/festivals/no-art-festival-2026'));
  assert.ok(isAggregatorHost('https://partyflock.nl/event/no-art'));
  assert.ok(isAggregatorHost('https://www.festivalinfo.nl/festival/no-art'));
});

test('isAggregatorHost: eigen sites blijven gewoon kandidaat', () => {
  assert.equal(isAggregatorHost('https://www.noartfestival.com/'), false);
  assert.equal(isAggregatorHost('https://paradiso.nl/'), false);
});

// ---------- samenvatting ----------

console.log(`\n${passed} geslaagd, ${failures.length} mislukt`);
if (failures.length) {
  for (const f of failures) console.error(`\n${f.name}:\n${f.err.stack}`);
  process.exit(1);
}
