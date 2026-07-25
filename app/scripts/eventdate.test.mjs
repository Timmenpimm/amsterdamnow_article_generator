// Standalone unit tests voor lib/eventDate.ts en de publisher-poort
// isExpiredEvent/pickNextForPublish — pure functies, geen netwerk/DB.
// Draaien met: npm run test:eventdate
//
// Regressie voor artikel 86418 (Still Processing, Nxt Museum): een expositie
// die op 29-06-2026 sloot werd op 20-07-2026 alsnog geschreven en als
// evergreen op het bord gezet.
import assert from 'node:assert/strict';
import { amsterdamToday, isoOrEmpty, eventEndReference, isPastEvent } from '../lib/eventDate.ts';
import { isExpiredEvent, pickNextForPublish } from '../lib/publisher.ts';

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

// ---------- isoOrEmpty ----------

test('isoOrEmpty: accepteert strikt JJJJ-MM-DD', () => {
  assert.equal(isoOrEmpty('2026-06-29'), '2026-06-29');
});

test('isoOrEmpty: weigert vrije tekst, null en losse formats', () => {
  for (const v of [null, undefined, '', 'doorlopend', '29-06-2026', '2026/06/29', new Date(), 20260629]) {
    assert.equal(isoOrEmpty(v), '');
  }
});

// ---------- eventEndReference ----------

test('eventEndReference: einddatum wint van startdatum', () => {
  assert.equal(eventEndReference('2025-02-06', '2026-06-29'), '2026-06-29');
});

test('eventEndReference: zonder einddatum valt terug op start (eendaags)', () => {
  assert.equal(eventEndReference('2026-08-01', ''), '2026-08-01');
});

test('eventEndReference: zonder bruikbare datum leeg', () => {
  assert.equal(eventEndReference(null, 'doorlopend'), '');
});

// ---------- isPastEvent ----------

test('isPastEvent: het geval 86418 — expositie gesloten op 29-06, vandaag 20-07', () => {
  assert.equal(isPastEvent('2025-02-06', '2026-06-29', '2026-07-20'), true);
});

test('isPastEvent: startdatum in het verleden maar loopt nog → niet voorbij', () => {
  assert.equal(isPastEvent('2025-02-06', '2026-12-31', '2026-07-20'), false);
});

test('isPastEvent: event dat vandaag afloopt telt nog als lopend', () => {
  assert.equal(isPastEvent('2026-07-20', '2026-07-20', '2026-07-20'), false);
});

test('isPastEvent: eendaags event van gisteren is voorbij', () => {
  assert.equal(isPastEvent('2026-07-19', '', '2026-07-20'), true);
});

test('isPastEvent: fail-open — zonder datum nooit blokkeren', () => {
  assert.equal(isPastEvent('', '', '2026-07-20'), false);
  assert.equal(isPastEvent(null, undefined, '2026-07-20'), false);
  assert.equal(isPastEvent('doorlopend', 'doorlopend', '2026-07-20'), false);
});

// ---------- amsterdamToday ----------

test('amsterdamToday: JJJJ-MM-DD in Europe/Amsterdam, niet UTC', () => {
  // 31 juli 23:30 UTC = 1 augustus 01:30 in Amsterdam (zomertijd).
  assert.equal(amsterdamToday(new Date('2026-07-31T23:30:00Z')), '2026-08-01');
  assert.match(amsterdamToday(), /^\d{4}-\d{2}-\d{2}$/);
});

// ---------- isExpiredEvent ----------

const NOW = new Date('2026-07-20T12:00:00Z');

test('isExpiredEvent: ACF-einddatum in het verleden → verlopen', () => {
  assert.equal(isExpiredEvent({ eventStart: '2025-02-06', eventEnd: '2026-06-29' }, undefined, NOW), true);
});

test('isExpiredEvent: ACF-datum weegt zwaarder dan de evergreen-vlag', () => {
  const meta = { evergreen: true, event_date: null, cluster: null };
  assert.equal(isExpiredEvent({ eventStart: '2025-02-06', eventEnd: '2026-06-29' }, meta, NOW), true);
});

test('isExpiredEvent: lopende expositie blijft publicabel', () => {
  assert.equal(isExpiredEvent({ eventStart: '2025-02-06', eventEnd: '2026-09-30' }, undefined, NOW), false);
});

test('isExpiredEvent: zonder ACF-datum telt de classificatiedatum', () => {
  assert.equal(isExpiredEvent({}, { evergreen: false, event_date: '2026-07-01', cluster: null }, NOW), true);
  assert.equal(isExpiredEvent({}, { evergreen: false, event_date: '2026-08-01', cluster: null }, NOW), false);
});

test('isExpiredEvent: echte evergreen zonder datum blijft publicabel', () => {
  assert.equal(isExpiredEvent({}, { evergreen: true, event_date: null, cluster: null }, NOW), false);
  assert.equal(isExpiredEvent({}, undefined, NOW), false);
});

// ---------- pickNextForPublish ----------

function article(id, extra = {}) {
  return { id, title: `Artikel ${id}`, category: `Cat${id}`, date: '2026-07-10T00:00:00Z', ...extra };
}

test('pickNextForPublish: verlopen event wordt nooit gekozen', () => {
  const ready = [article(1, { eventStart: '2025-02-06', eventEnd: '2026-06-29' }), article(2)];
  const picked = pickNextForPublish(ready, new Map(), [], 3, NOW);
  assert.equal(picked?.id, 2);
});

test('pickNextForPublish: alleen verlopen events → niets publiceren', () => {
  const ready = [article(1, { eventStart: '2026-06-01', eventEnd: '2026-06-29' })];
  assert.equal(pickNextForPublish(ready, new Map(), [], 3, NOW), null);
});

test('pickNextForPublish: uitsluiting gaat vóór de cluster-nooduitgang', () => {
  // Beide kandidaten zitten in de cooldown; normaal mag de geweerde pool dan
  // alsnog. Een verlopen event blijft ook dan geweerd.
  const ready = [article(1, { category: 'Cultuur', eventEnd: '2026-06-29' })];
  const published = [{ id: 9, category: 'Cultuur', date: '2026-07-19T00:00:00Z' }];
  assert.equal(pickNextForPublish(ready, new Map(), published, 3, NOW), null);
});

// ---------- samenvatting ----------

console.log(`\n${passed} geslaagd, ${failures.length} mislukt`);
if (failures.length) {
  for (const f of failures) console.error(`\n${f.name}:\n${f.err.stack}`);
  process.exit(1);
}
