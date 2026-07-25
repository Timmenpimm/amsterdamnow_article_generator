// Eenmalige verificatie: draait de échte pipeline-helpers tegen de opgeslagen
// productie-instellingen (Omniroute-tunnel + combo's). Schrijft niets weg.
import { askClaudeJson, askClaudeJsonWithImages, isCreditOrRateError } from '../lib/claude.ts';
import { getModelSettings } from '../lib/modelConfig.ts';

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;

// 1x1 rode PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const s = await getModelSettings();
console.log('provider   :', s.provider);
console.log('tekstmodel :', s.omniroute.model);
console.log('beeldmodel :', s.omniroute.visionModel);
console.log('failover   :', s.failover);
console.log('---');

let fails = 0;

// --- TEKST ---
try {
  const t0 = Date.now();
  const r = await askClaudeJson(
    'Antwoord uitsluitend met geldig JSON.',
    'Geef JSON met velden titel (string) en score (getal 1-10). Onderwerp: nieuw museum in Amsterdam-Noord.',
    undefined, 2000
  );
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(ok(`TEKST  OK  (${dt}s)`), JSON.stringify(r).slice(0, 110));
} catch (e) {
  fails++;
  console.log(bad('TEKST  FAIL'), e.message?.slice(0, 200));
}

// --- BEELD ---
try {
  const t0 = Date.now();
  const r = await askClaudeJsonWithImages(
    'Antwoord uitsluitend met geldig JSON.',
    'Geef JSON met veld kleur (string): welke kleur heeft deze afbeelding?',
    [{ media_type: 'image/png', data: PNG }]
  );
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(ok(`BEELD  OK  (${dt}s)`), JSON.stringify(r).slice(0, 110));
} catch (e) {
  fails++;
  console.log(bad('BEELD  FAIL'), e.message?.slice(0, 200));
}

// --- FAILOVER-DETECTIE (unit, geen netwerk) ---
const cases = [
  [{ status: 400, message: 'Claude 400: Your credit balance is too low to access the Anthropic API' }, true, 'credits op (400)'],
  [{ status: 429, message: 'Claude 429: rate limited' }, true, 'rate limit (429)'],
  [{ status: 529, message: 'overloaded' }, true, 'overloaded (529)'],
  [{ status: 500, message: 'boom' }, false, 'server error (geen failover)'],
];
for (const [err, want, label] of cases) {
  const got = isCreditOrRateError(err);
  if (got === want) console.log(ok('DETECT OK '), label, '->', got);
  else { fails++; console.log(bad('DETECT FAIL'), label, 'verwacht', want, 'kreeg', got); }
}

console.log('---');
console.log(fails === 0 ? ok('ALLES GOED') : bad(`${fails} FOUT(EN)`));
process.exit(fails === 0 ? 0 : 1);
