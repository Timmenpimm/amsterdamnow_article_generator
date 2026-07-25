// Standalone unit tests voor lib/tokenCost.ts — pure functies, geen netwerk/DB.
// Draaien met: npm run test:tokenlog
//
// Waarom deze test: de logregel is de basis waarop we de maandkosten van de
// tool narekenen. Een verkeerde cache-factor of een model dat stilletjes op
// tarief 0 valt maakt die cijfers onbruikbaar zonder dat iets zichtbaar faalt.
import assert from 'node:assert/strict';
import { costOf, priceFor, usageLine } from '../lib/tokenCost.ts';

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

// ---------- prijzen ----------

test('alias wordt herkend', () => {
  assert.deepEqual(priceFor('claude-sonnet-5'), { in: 3, out: 15 });
});

test('datumsuffix valt terug op de alias-prijs', () => {
  assert.deepEqual(priceFor('claude-haiku-4-5-20251001'), { in: 1, out: 5 });
});

test('onbekend model geeft tarief 0 in plaats van een crash', () => {
  assert.deepEqual(priceFor('claude-toekomst-9'), { in: 0, out: 0 });
});

// ---------- kosten ----------

test('verse invoer + uitvoer op Sonnet-tarief', () => {
  // 10.000 in × $3/M = $0,03; 1.000 out × $15/M = $0,015.
  assert.equal(
    costOf('claude-sonnet-5', { input_tokens: 10_000, output_tokens: 1_000 }).toFixed(4),
    '0.0450',
  );
});

test('cache-write kost 1,25x en cache-read 0,1x de invoerprijs', () => {
  // 8.000 write × $3/M × 1,25 = $0,03; 8.000 read × $3/M × 0,1 = $0,0024.
  assert.equal(
    costOf('claude-sonnet-5', { cache_creation_input_tokens: 8_000 }).toFixed(4),
    '0.0300',
  );
  assert.equal(
    costOf('claude-sonnet-5', { cache_read_input_tokens: 8_000 }).toFixed(4),
    '0.0024',
  );
});

test('een cache-read is goedkoper dan dezelfde tokens vers', () => {
  const vers = costOf('claude-sonnet-5', { input_tokens: 6_500 });
  const gelezen = costOf('claude-sonnet-5', { cache_read_input_tokens: 6_500 });
  assert.ok(gelezen < vers, `cache-read (${gelezen}) moet onder vers (${vers}) liggen`);
});

test('leeg usage-blok kost niets', () => {
  assert.equal(costOf('claude-sonnet-5', {}), 0);
});

test('onbekend model logt tokens maar rekent geen kosten', () => {
  assert.equal(costOf('claude-toekomst-9', { input_tokens: 10_000, output_tokens: 1_000 }), 0);
});

// ---------- logregel ----------

test('logregel bevat alle velden in vaste key=value-vorm', () => {
  const line = usageLine(
    'schrijf#1234',
    'claude-sonnet-5',
    { input_tokens: 812, output_tokens: 1_108, cache_creation_input_tokens: 6_431, cache_read_input_tokens: 0 },
    8_123,
    'end_turn',
  );
  assert.equal(
    line,
    // 812×3 + 6431×3×1,25 + 1108×15 = 43.172,25 → $0,0432.
    '[claude] label=schrijf#1234 model=claude-sonnet-5 in=812 cache_write=6431 cache_read=0 out=1108 cost=0.0432 ms=8123 stop=end_turn',
  );
});

test('ontbrekend label en stop_reason worden expliciet "onbekend"', () => {
  const line = usageLine('', 'claude-haiku-4-5', { input_tokens: 100 }, 42, undefined);
  assert.match(line, /^\[claude\] label=onbekend /);
  assert.match(line, / stop=onbekend$/);
});

test('ontbrekende tokenvelden worden 0, niet NaN of undefined', () => {
  const line = usageLine('dedup', 'claude-haiku-4-5', {}, 10, 'end_turn');
  assert.equal(
    line,
    '[claude] label=dedup model=claude-haiku-4-5 in=0 cache_write=0 cache_read=0 out=0 cost=0.0000 ms=10 stop=end_turn',
  );
});

// ---------- samenvatting ----------

console.log(`\n${passed} geslaagd, ${failures.length} mislukt`);
if (failures.length) {
  for (const f of failures) console.error(`\n${f.name}:\n${f.err.stack}`);
  process.exit(1);
}
