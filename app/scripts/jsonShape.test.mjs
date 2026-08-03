// Hermetische tests voor de minimale JSON-schema shape-check
// (lib/jsonShape.ts). Geen netwerkverkeer. Draaien met: npm run test:jsonshape
//
// Achtergrond: Omniroute ondersteunt geen structured outputs, dus de geparste
// JSON wordt daar niet door de API gegarandeerd conform het schema. Deze check
// vangt vormfouten (bv. categories als string in plaats van array) en laat de
// corrigerende herkansing in claude.ts triggeren.
import assert from 'node:assert/strict';

const { conformsToSchema } = await import('../lib/jsonShape.ts');

const stringArr = { type: 'array', items: { type: 'string' } };
const researchSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'categories', 'quote', 'flag'],
  properties: {
    title: { type: 'string' },
    categories: stringArr,
    tags: { type: 'array', items: { type: 'string' } },
    district: { type: 'string' },
    quote: { anyOf: [{ type: 'object', required: ['tekst', 'bron'], properties: { tekst: { type: 'string' }, bron: { type: 'string' } } }, { type: 'null' }] },
    flag: { type: 'boolean' },
    count: { type: 'integer' },
    status: { type: 'string', enum: ['verified', 'rejected'] },
    extra: { type: 'string' },
  },
};

const ok = {
  title: 'Club Strozzi',
  categories: ['Uit eten'],
  tags: ['club'],
  district: 'Zuid',
  quote: { tekst: 'hallo', bron: 'https://x.nl' },
  flag: true,
  count: 3,
  status: 'verified',
};
assert.equal(conformsToSchema(ok, researchSchema), null, 'geldig object: geen fout');

// categories als string (het echte 2026-08-03 incident) — moet afgewezen.
assert.match(conformsToSchema({ ...ok, categories: 'Uit eten' }, researchSchema), /\$\.categories moet array zijn/);
// Lege-array is qua vorm geldig (niet-lege-eis is downstream, nonEmptyStrings).
assert.equal(conformsToSchema({ ...ok, categories: [] }, researchSchema), null);
// Ontbrekend verplicht veld.
const zonderFlag = { ...ok };
delete zonderFlag.flag;
assert.match(conformsToSchema(zonderFlag, researchSchema), /\$\.flag ontbreekt/);
// quote: null mag (anyOf-null), een getal niet.
assert.equal(conformsToSchema({ ...ok, quote: null }, researchSchema), null);
assert.match(conformsToSchema({ ...ok, quote: 42 }, researchSchema), /\$\.quote/);
// Array-items: verkeerd type element.
assert.match(conformsToSchema({ ...ok, tags: ['a', 5] }, researchSchema), /\$\.tags\[1\] moet string zijn/);
// boolean / integer / enum.
assert.match(conformsToSchema({ ...ok, flag: 'ja' }, researchSchema), /\$\.flag moet boolean zijn/);
assert.match(conformsToSchema({ ...ok, count: 2.5 }, researchSchema), /\$\.count moet integer zijn/);
assert.match(conformsToSchema({ ...ok, status: 'cap' }, researchSchema), /\$\.status moet een van/);
// additionalProperties: false wordt bewust NIET afgedwongen (extra key ok).
assert.equal(conformsToSchema({ ...ok, nietInSchema: 'mag' }, researchSchema), null);
// Root is geen object.
assert.match(conformsToSchema(['geen', 'object'], researchSchema), /\$ moet object zijn/);
assert.equal(conformsToSchema(null, { anyOf: [{ type: 'object' }, { type: 'null' }] }), null);

console.log('jsonShape.test: alle checks geslaagd');
