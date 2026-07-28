// Standalone unit tests voor parseListItemImages uit lib/listHtml.ts — pure
// functie, geen netwerk/DB. Draaien met: npm run test:listitemimages
//
// Waarvoor: de carousel-engine deelde de artikelfoto's op volgorde uit over de
// itemslides, terwijl het model zelf 2 tot 8 items kiest uit een artikel dat er
// 15 tot 25 heeft. Koos het item 3, 7 en 12, dan stond er een foto van de
// verkeerde zaak bij. De tool stuurt de koppeling naam → foto nu mee. Voor
// lijstartikelen die de tool zelf schreef komt die uit list_articles; voor oude
// en handmatige artikelen is de gepubliceerde HTML de enige bron, en dat is wat
// deze parser doet.
import assert from 'node:assert/strict';
import { assembleListHtml, parseListItemImages } from '../lib/listHtml.ts';

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

function item(naam, mediaId, extra = {}) {
  return {
    naam,
    beschrijving: `Waarom ${naam} de moeite waard is.`,
    adres: 'Straatnaam 1',
    buurt: 'Oost',
    media: mediaId ? { id: mediaId, url: `https://cdn.test/${mediaId}.jpg` } : null,
    ...extra,
  };
}

function structure(items) {
  return {
    postId: 1,
    introcontent: '',
    inleiding: 'De selectie.',
    items,
    afsluiting: 'Tot ziens.',
    meldingen: [],
  };
}

test('leest de koppeling terug uit HTML die de tool zelf assembleerde', () => {
  const html = assembleListHtml(
    structure([item('Café Loetje', 11), item('Bar Bukowski', 12), item('Wilde Zwijnen', 13)])
  );
  assert.deepEqual(parseListItemImages(html), [
    { naam: 'Café Loetje', imageUrl: 'https://cdn.test/11.jpg' },
    { naam: 'Bar Bukowski', imageUrl: 'https://cdn.test/12.jpg' },
    { naam: 'Wilde Zwijnen', imageUrl: 'https://cdn.test/13.jpg' },
  ]);
});

test('een item zonder foto pikt de foto van het volgende item niet in', () => {
  const html = assembleListHtml(
    structure([item('Café Loetje', null), item('Bar Bukowski', 12)])
  );
  assert.deepEqual(parseListItemImages(html), [
    { naam: 'Bar Bukowski', imageUrl: 'https://cdn.test/12.jpg' },
  ]);
});

test('per <h2> hooguit één foto, ook bij meerdere beelden onder één kop', () => {
  const html = [
    '<h2>Café Loetje</h2>',
    '<p>Tekst.</p>',
    '<p><img src="https://cdn.test/loetje-1.jpg" /></p>',
    '<p><img src="https://cdn.test/loetje-2.jpg" /></p>',
    '<h2>Bar Bukowski</h2>',
    '<p>Tekst.</p>',
    '<p><img src="https://cdn.test/bukowski.jpg" /></p>',
  ].join('\n');
  assert.deepEqual(parseListItemImages(html), [
    { naam: 'Café Loetje', imageUrl: 'https://cdn.test/loetje-1.jpg' },
    { naam: 'Bar Bukowski', imageUrl: 'https://cdn.test/bukowski.jpg' },
  ]);
});

test('entiteiten in de kop en in de src worden gedecodeerd', () => {
  const html = [
    '<h2>Bar &amp; Grill</h2>',
    '<p><img src="https://cdn.test/x.jpg?a=1&amp;b=2" /></p>',
  ].join('\n');
  assert.deepEqual(parseListItemImages(html), [
    { naam: 'Bar & Grill', imageUrl: 'https://cdn.test/x.jpg?a=1&b=2' },
  ]);
});

test('markup binnen de <h2> telt niet mee in de naam', () => {
  const html = '<h2 class="wp-block-heading"><strong>Café Loetje</strong></h2>\n<p><img src="https://cdn.test/l.jpg"></p>';
  assert.deepEqual(parseListItemImages(html), [
    { naam: 'Café Loetje', imageUrl: 'https://cdn.test/l.jpg' },
  ]);
});

test('enkele quotes en srcset naast src breken de parse niet', () => {
  const html =
    "<h2>Wilde Zwijnen</h2>\n<p><img srcset='https://cdn.test/z-300.jpg 300w' src='https://cdn.test/z.jpg' alt='iets anders'></p>";
  assert.deepEqual(parseListItemImages(html), [
    { naam: 'Wilde Zwijnen', imageUrl: 'https://cdn.test/z.jpg' },
  ]);
});

test('een beeld vóór de eerste <h2> hoort bij geen enkel item', () => {
  const html =
    '<p><img src="https://cdn.test/uitgelicht.jpg"></p>\n<h2>Café Loetje</h2>\n<p><img src="https://cdn.test/l.jpg"></p>';
  assert.deepEqual(parseListItemImages(html), [
    { naam: 'Café Loetje', imageUrl: 'https://cdn.test/l.jpg' },
  ]);
});

test('artikel zonder koppen levert een lege lijst, geen fout', () => {
  assert.deepEqual(parseListItemImages('<p>Gewoon een artikel.</p>'), []);
  assert.deepEqual(parseListItemImages(''), []);
});

console.log(`\n${passed} van de ${passed + failures.length} tests geslaagd.`);
if (failures.length) process.exit(1);
