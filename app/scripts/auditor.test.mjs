// Standalone unit tests voor de deterministische kern van de auditor:
// fileNameTokens (lib/auditor.ts) en worstVerdict (lib/types.ts). Pure
// functies, geen netwerk/DB. Draaien met: npm run test:auditor
//
// Waarom juist deze twee: de bestandsnaam-check is de enige auditcontrole die
// zónder model een harde `fout` uitdeelt, en hij zat er in de eerste versie
// naast. De tool uploadt zelf als `<venue>-<type>-amsterdam_N.jpg`, waardoor
// het type-token ("restaurant", "winkel") als vreemde term werd gelezen en
// bijna elk artikel een onterechte fout kreeg. Een auditor die overal fout
// roept is net zo waardeloos als een auditor die overal ok roept.
import assert from 'node:assert/strict';
import { fileNameTokens } from '../lib/auditor.ts';
import { worstVerdict } from '../lib/types.ts';

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

// ---------- fileNameTokens: de echte gevallen uit de audits ----------

test('fileNameTokens: het Awakenings-beeld bij het Dekmantel-artikel valt op', () => {
  const tokens = fileNameTokens('awakenings-in-spaarnwoude-1024x682.jpg');
  assert.ok(tokens.includes('awakenings'), `verwacht "awakenings" in ${JSON.stringify(tokens)}`);
  assert.ok(tokens.includes('spaarnwoude'), `verwacht "spaarnwoude" in ${JSON.stringify(tokens)}`);
});

test('fileNameTokens: het eigen Dekmantel-beeld levert geen vreemde term', () => {
  const tokens = fileNameTokens('dekmantel-festival-1-1024x682.jpg');
  assert.deepEqual(tokens, ['dekmantel'], `"festival" en het formaat horen eruit, kreeg ${JSON.stringify(tokens)}`);
});

test('fileNameTokens: het eigen uploadpatroon <venue>-<type>-amsterdam levert alleen de venue', () => {
  // Het type-token ("restaurant", "winkel", "sauna") moet eruit: dat zegt niets
  // over het onderwerp en gaf voorheen een onterechte fout op de eigen beelden.
  // De venuenaam blijft staan — die hóórt in de titel voor te komen, en doet
  // dat ook ("Bij Sinne", "Stadsbakkerij As", "Badhus Noord").
  assert.deepEqual(fileNameTokens('sinne-restaurant-amsterdam_2.jpg'), ['sinne']);
  assert.deepEqual(fileNameTokens('stadsbakkerij-as-winkel-amsterdam_1.jpg'), ['stadsbakkerij']);
  assert.deepEqual(fileNameTokens('badhus-sauna-amsterdam_3.jpg'), ['badhus']);
});

test('fileNameTokens: WordPress-revisiesuffix telt niet als onderwerp', () => {
  assert.deepEqual(fileNameTokens('kometen-brood-e1612345678.jpg'), ['kometen', 'brood']);
});

test('fileNameTokens: een screenshot-bestandsnaam levert GEEN losse termen op', () => {
  // Regressie voor de eerste echte auditrun: deze bestandsnaam gaf twee
  // bevindingen met de "termen" screenshot2025 en 23at16 — ruis die het
  // rapport onleesbaar maakte. Alles met een cijfer erin is een tijdstempel of
  // een formaat, geen onderwerp.
  assert.deepEqual(fileNameTokens('Screenshot2025-10-23at16.47.02-852x1024.webp'), []);
  assert.deepEqual(fileNameTokens('Screenshot2025-10-23at16.46.50-813x1024.webp'), []);
  assert.deepEqual(fileNameTokens('IMG_20240101_120000.jpg'), []);
  assert.deepEqual(fileNameTokens('DSC_0043-1024x682.jpg'), []);
});

test('fileNameTokens: stockleveranciers en gewone woorden tellen niet mee', () => {
  assert.deepEqual(fileNameTokens('shutterstock_12345.jpg'), []);
  assert.deepEqual(fileNameTokens('grote-zaal-screenshot.png'), []);
});

test('fileNameTokens: tokens korter dan vijf tekens vallen af', () => {
  // "bar" en "ja" zijn te kort om betrouwbaar iets te zeggen; alleen de
  // langere eigennaam blijft over.
  assert.deepEqual(fileNameTokens('bar-basquiat-ja.jpg'), ['basquiat']);
});

// ---------- worstVerdict ----------

test('worstVerdict: geen bevindingen is ok', () => {
  assert.equal(worstVerdict([]), 'ok');
});

test('worstVerdict: één fout weegt zwaarder dan tien keer ok', () => {
  const findings = [...Array(10).fill({ verdict: 'ok' }), { verdict: 'fout' }];
  assert.equal(worstVerdict(findings), 'fout');
});

test('worstVerdict: twijfel wint van ok, verliest van fout', () => {
  assert.equal(worstVerdict([{ verdict: 'ok' }, { verdict: 'twijfel' }]), 'twijfel');
  assert.equal(worstVerdict([{ verdict: 'twijfel' }, { verdict: 'fout' }]), 'fout');
});

// ---------- samenvatting ----------

console.log(`\n${passed} geslaagd, ${failures.length} mislukt`);
if (failures.length) {
  for (const f of failures) console.error(`\n${f.name}:\n${f.err.stack}`);
  process.exit(1);
}
