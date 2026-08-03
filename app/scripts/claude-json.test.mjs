// Hermetische tests voor de JSON-extractie van een modelrespons (lib/claude.ts).
// Geen netwerkverkeer. Draaien met: npm run test:claudejson
//
// Achtergrond: het lokale Omniroute-model (huihui-qwen3.5-35b) schrijft JSON
// in een ```json-codeblock én laat letterlijke control karakters (newlines/tabs)
// in strings staan. Dat is ongeldig JSON en liet JSON.parse klappen, waardoor
// de hele schrijffase strandde op "geen geldige JSON, ook niet na een herkansing".
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { extractJson } = await import('../lib/claude.ts');

// Codeblock + nette JSON: moet gewoon parsen.
assert.equal(extractJson('```json\n{"a":1}\n```').a, 1);
// Proza vóór en na het object: isolatie moet het object vinden.
assert.equal(extractJson('Hier is het artikel:\n{"title":"x","n":2}\nEinde.').title, 'x');
// Letterlijke newline in een string (gebroken paragraaf): moet gerepareerd worden.
assert.equal(
  extractJson('{"title":"Club Strozzi","content":"Eerste regel\nTweede regel"}').content,
  'Eerste regel\nTweede regel'
);
// Meerdere control chars in één string (newline + tab + carriage return).
assert.equal(
  extractJson('{"a":"x\n\t\ry"}').a,
  'x\n\t\ry'
);
// Literale backslash + escaped quote mogen NIET dubbel worden ontsnapt.
assert.equal(extractJson('{"a":"c:\\ndir"}').a, 'c:\ndir');
assert.equal(extractJson('{"a":"rock-\'n-roll"}').a, 'rock-\'n-roll');
// Control char BÚITEN een string: laat het gewoon staan (geen crash).
assert.ok(extractJson('vooraf\n{"a":1}'));
// Onherstelbaar (geen object): null.
assert.equal(extractJson('geen json hier'), null);

// Echte gateway-output (vastgelegd op 2026-08-03) die vóór de fix faalde:
// ```json-fence + letterlijke newlines in de content-string.
const fixture = fs.readFileSync(process.env.FIXTURE_PATH || '/tmp/artikel-test.json', 'utf8');
const gw = JSON.parse(fixture);
const rawText = (gw.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
const parsed = extractJson(rawText);
assert.ok(parsed, 'extractJson moet de gateway-output repareren en parsen');
assert.equal(parsed.title, 'De Impact van Duurzame Energie op de Nederlandse Economie');
for (const k of ['title', 'subregel', 'introductie_tekst', 'content', 'quote']) {
  assert.ok(parsed[k] && String(parsed[k]).length > 10, `veld "${k}" aanwezig en gevuld`);
}
assert.match(parsed.quote, /Diederik Samsom/);

console.log('claude-json.test: alle checks geslaagd');
