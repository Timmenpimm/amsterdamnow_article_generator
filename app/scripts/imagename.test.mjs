// Standalone unit tests voor lib/mediaName.ts — pure functies, geen netwerk/DB.
// Draaien met: npm run test:imagename
//
// De naamconventie zelf is niet af te leiden uit de code maar uit de live site:
// bestandsnaam == media-slug == media-titel == alt-tekst, allemaal
// {venue-slug}-{type}-{plaats}_{n}. De vaste ijkpunten hieronder komen
// letterlijk uit de WP REST API (stadsbakkerij-as-winkel-amsterdam_1,
// caffe-toscanini-cafe-amsterdam_3), zodat een latere "verbetering" aan de
// slugificatie meteen zichtbaar wordt als afwijking van de bestaande beeldbank.
import assert from 'node:assert/strict';
import {
  slugifyName,
  venueTypeFor,
  imageBaseName,
  imageAltName,
  imageFileName,
  listItemNameContext,
  VENUE_TYPES,
  CATEGORY_TYPE_MAP,
} from '../lib/mediaName.ts';

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

// ---------- live-voorbeelden, end-to-end ----------

const STADSBAKKERIJ = {
  naamLocatie: 'Stadsbakkerij AS',
  title: 'Stadsbakkerij AS opent tweede zaak',
  slug: 'stadsbakkerij-as-winkel-de-pijp',
  category: 'Restaurants, Lifestyle',
  district: 'Amsterdam Zuid',
  stad: 'Amsterdam',
};

const TOSCANINI = {
  naamLocatie: 'Caffè Toscanini',
  title: 'Caffè Toscanini in de Jordaan',
  slug: 'caffe-toscanini-cafe-italiaans-jordaan',
  category: 'Restaurants',
  district: 'Amsterdam Centrum',
  stad: 'Amsterdam',
};

test('live: stadsbakkerij-as-winkel-amsterdam_1..3 (+bestandsnaam)', () => {
  assert.equal(imageBaseName(STADSBAKKERIJ), 'stadsbakkerij-as-winkel-amsterdam');
  assert.equal(imageAltName(STADSBAKKERIJ, 1), 'stadsbakkerij-as-winkel-amsterdam_1');
  assert.equal(imageAltName(STADSBAKKERIJ, 2), 'stadsbakkerij-as-winkel-amsterdam_2');
  assert.equal(imageAltName(STADSBAKKERIJ, 3), 'stadsbakkerij-as-winkel-amsterdam_3');
  assert.equal(
    imageFileName(STADSBAKKERIJ, 1, 'image/jpeg'),
    'stadsbakkerij-as-winkel-amsterdam_1.jpg',
  );
});

test('live: caffe-toscanini-cafe-amsterdam_1..3 (+bestandsnaam)', () => {
  assert.equal(imageBaseName(TOSCANINI), 'caffe-toscanini-cafe-amsterdam');
  assert.equal(imageAltName(TOSCANINI, 3), 'caffe-toscanini-cafe-amsterdam_3');
  assert.equal(imageFileName(TOSCANINI, 2, 'image/webp'), 'caffe-toscanini-cafe-amsterdam_2.webp');
});

// ---------- karakterbehandeling ----------

test('diakrieten gaan naar ASCII', () => {
  assert.equal(slugifyName('Caffè Toscanini'), 'caffe-toscanini');
  assert.equal(slugifyName('Café Noir'), 'cafe-noir');
  assert.equal(slugifyName('Størm'), 'storm');
});

test("apostrof verdwijnt zónder scheidingsteken", () => {
  assert.equal(slugifyName("Molly's"), 'mollys');
  assert.equal(slugifyName('Molly’s Coffeeshop'), 'mollys-coffeeshop');
});

test('&-teken valt weg en laat één streepje achter', () => {
  assert.equal(slugifyName('Morgan & Mees'), 'morgan-mees');
  assert.equal(slugifyName('Bar & Grill'), 'bar-grill');
});

test('leidende lidwoorden vallen weg', () => {
  assert.equal(slugifyName('De Prael'), 'prael');
  assert.equal(slugifyName('Het Bosch'), 'bosch');
  assert.equal(slugifyName("'t Westerhuys"), 'westerhuys');
  assert.equal(slugifyName('L’Entrecôte'), 'entrecote');
  assert.equal(slugifyName('The Duchess'), 'duchess');
  // Alleen als los lidwoord: 'Deli' begint óók met "de" en blijft heel.
  assert.equal(slugifyName('Deli Bakery'), 'deli-bakery');
});

test('cijfers blijven staan, scheidingstekens collapsen, geen rand-streepjes', () => {
  assert.equal(slugifyName('Helling 7'), 'helling-7');
  assert.equal(slugifyName('  Bar   Basquiat  '), 'bar-basquiat');
  assert.equal(slugifyName('--Foodhallen--'), 'foodhallen');
  assert.equal(slugifyName('Café/Restaurant Amsterdam'), 'cafe-restaurant-amsterdam');
});

test('lege input geeft lege slug', () => {
  assert.equal(slugifyName(''), '');
  assert.equal(slugifyName(null), '');
  assert.equal(slugifyName(undefined), '');
  assert.equal(slugifyName('   '), '');
  assert.equal(slugifyName('!!!'), '');
});

// ---------- type-afleiding ----------

test('type komt uit de artikel-slug, niet uit de categorie', () => {
  // Post 85844: categorie "Restaurants", maar het beeld heet ...-winkel-...
  assert.equal(venueTypeFor(STADSBAKKERIJ), 'winkel');
  assert.equal(venueTypeFor(TOSCANINI), 'cafe');
});

test('zonder slug valt hij terug op titel of naam_locatie', () => {
  assert.equal(
    venueTypeFor({ naamLocatie: 'Sinne', title: 'Sinne is een bistro in de Rivierenbuurt' }),
    'bistro',
  );
  assert.equal(venueTypeFor({ naamLocatie: 'Hotel Jakarta', title: 'Slapen aan het IJ' }), 'hotel');
  // Meervoud → enkelvoud.
  assert.equal(venueTypeFor({ naamLocatie: 'Kaaskoning', title: 'De beste winkels van Oost' }), 'winkel');
  assert.equal(venueTypeFor({ naamLocatie: 'Bakhuys', title: 'Vier nieuwe bakkerijen' }), 'bakkerij');
  assert.equal(venueTypeFor({ naamLocatie: 'Zuid', title: "De mooiste cafés van de stad" }), 'cafe');
});

test('daarna pas de eerste WP-categorie', () => {
  assert.equal(venueTypeFor({ naamLocatie: 'Sinne', category: 'Restaurants, Uitgaan' }), 'restaurant');
  assert.equal(venueTypeFor({ naamLocatie: 'Sinne', category: 'Winkels' }), 'winkel');
  assert.equal(venueTypeFor({ naamLocatie: 'Sinne', category: 'Cultuur' }), 'museum');
  assert.equal(venueTypeFor({ naamLocatie: 'Sinne', category: 'Uitgaan' }), 'cafe');
  assert.equal(CATEGORY_TYPE_MAP.Restaurants, 'restaurant');
});

test('categorieën zonder dominant type leveren geen type op', () => {
  assert.equal(venueTypeFor({ naamLocatie: 'Kids', category: 'Lifestyle' }), '');
  assert.equal(venueTypeFor({ naamLocatie: 'Kids', category: 'Nieuws' }), '');
  assert.equal(venueTypeFor({ naamLocatie: 'Kids', category: 'Agenda' }), '');
  assert.equal(venueTypeFor({}), '');
});

test('geen type gevonden: het token valt gewoon weg', () => {
  // kids-amsterdam_1 bestaat echt in de beeldbank en is geldig.
  const ctx = { naamLocatie: 'Kids', title: 'Kids in de stad', category: 'Lifestyle' };
  assert.equal(imageBaseName(ctx), 'kids-amsterdam');
  assert.equal(imageAltName(ctx, 1), 'kids-amsterdam_1');
});

test('VENUE_TYPES bevat de geobserveerde vocabulaire', () => {
  for (const t of ['restaurant', 'cafe', 'winkel', 'museum', 'hotel', 'terras', 'galerie']) {
    assert.ok(VENUE_TYPES.includes(t), `${t} ontbreekt in VENUE_TYPES`);
  }
});

// ---------- samenstelling ----------

test('een type dat al in de naam zit wordt niet herhaald', () => {
  const ctx = { naamLocatie: 'Restaurant Sinne', title: 'Restaurant Sinne in de Rivierenbuurt' };
  assert.equal(imageBaseName(ctx), 'restaurant-sinne-amsterdam');
  assert.equal(imageAltName(ctx, 2), 'restaurant-sinne-amsterdam_2');
});

test('plaats is altijd amsterdam, nooit een stadsdeel', () => {
  const ctx = { naamLocatie: 'Sinne', title: 'Sinne restaurant', district: 'Amsterdam Noord' };
  assert.equal(imageBaseName(ctx), 'sinne-restaurant-amsterdam');
  assert.equal(imageBaseName({ ...ctx, stad: 'Amsterdam-Noord' }), 'sinne-restaurant-amsterdam');
  assert.equal(imageBaseName({ ...ctx, stad: '' }), 'sinne-restaurant-amsterdam');
});

test('buiten de gemeente telt de echte plaatsnaam', () => {
  assert.equal(
    imageBaseName({ naamLocatie: 'Mark', title: 'Mark restaurant', stad: 'Durgerdam' }),
    'mark-restaurant-durgerdam',
  );
  assert.equal(
    imageBaseName({ naamLocatie: 'Sinne', title: 'Sinne restaurant', stad: 'Amstelveen' }),
    'sinne-restaurant-amstelveen',
  );
});

test('venue leeg: terugval op amsterdamnow in plaats van een error', () => {
  assert.equal(imageBaseName({}), 'amsterdamnow-amsterdam');
  assert.equal(imageAltName({ naamLocatie: '!!!', title: '' }, 1), 'amsterdamnow-amsterdam_1');
});

test('index is 1-based en onbruikbare waarden vallen terug op _1', () => {
  assert.equal(imageAltName(TOSCANINI, 1), 'caffe-toscanini-cafe-amsterdam_1');
  assert.equal(imageAltName(TOSCANINI, 12), 'caffe-toscanini-cafe-amsterdam_12');
  assert.equal(imageAltName(TOSCANINI, 0), 'caffe-toscanini-cafe-amsterdam_1');
  assert.equal(imageAltName(TOSCANINI, -3), 'caffe-toscanini-cafe-amsterdam_1');
  assert.equal(imageAltName(TOSCANINI, Number.NaN), 'caffe-toscanini-cafe-amsterdam_1');
  assert.equal(imageAltName(TOSCANINI, 2.7), 'caffe-toscanini-cafe-amsterdam_2');
});

test('extensie volgt het mime-type, onbekend/leeg wordt jpg', () => {
  const cases = [
    ['image/jpeg', 'jpg'],
    ['image/jpg', 'jpg'],
    ['image/pjpeg', 'jpg'],
    ['image/png', 'png'],
    ['image/gif', 'gif'],
    ['image/webp', 'webp'],
    ['image/avif', 'avif'],
    ['image/heic', 'heic'],
    ['IMAGE/PNG', 'png'],
    ['image/jpeg; charset=binary', 'jpg'],
    ['image/x-onbekend', 'jpg'],
    ['', 'jpg'],
  ];
  for (const [mime, ext] of cases) {
    assert.equal(
      imageFileName(TOSCANINI, 1, mime),
      `caffe-toscanini-cafe-amsterdam_1.${ext}`,
      `mime ${mime}`,
    );
  }
});

test('lange namen worden op token-grens afgekapt, type en plaats blijven', () => {
  const ctx = {
    naamLocatie: 'Zeer Uitzonderlijk Lange Naam Van Een Amsterdamse Zaak Aan De Amstel Met Prachtig Uitzicht',
    title: 'Dit restaurant heeft een erg lange naam',
    stad: 'Amsterdam',
  };
  const base = imageBaseName(ctx);
  assert.ok(base.length <= 80, `te lang: ${base.length} — ${base}`);
  assert.ok(base.startsWith('zeer-uitzonderlijk-lange-naam'), base);
  assert.ok(base.endsWith('-restaurant-amsterdam'), base);
  assert.ok(!base.includes('--') && !base.endsWith('-'), base);
  // Afkappen gebeurt op hele tokens: geen half woord vóór het type.
  const kop = base.slice(0, base.length - '-restaurant-amsterdam'.length);
  for (const token of kop.split('-')) {
    assert.ok(ctx.naamLocatie.toLowerCase().split(' ').includes(token), `half token: ${token}`);
  }
});

// ---------- lijstartikelen ----------

test('lijst-item: de itemnaam wordt de venue, het type komt uit het artikel', () => {
  const lijst = {
    naamLocatie: '',
    title: 'De 10 beste restaurants van Amsterdam Noord',
    slug: 'beste-restaurants-amsterdam-noord',
    category: 'Restaurants',
    district: 'Amsterdam Noord',
    stad: 'Amsterdam',
  };
  const item = listItemNameContext(lijst, 'Café de Ceuvel', 'Noord');
  assert.equal(imageBaseName(item), 'cafe-de-ceuvel-restaurant-amsterdam');
  assert.equal(imageAltName(item, 4), 'cafe-de-ceuvel-restaurant-amsterdam_4');
  // De buurt landt in district en mag de plaats niet vervangen.
  assert.equal(item.district, 'Noord');
  assert.equal(item.title, lijst.title);
  assert.ok(imageBaseName(item).endsWith('-amsterdam'));
});

test('lijst-item zonder bruikbare naam valt terug op de artikelcontext', () => {
  const lijst = { title: 'De beste terrassen van de stad', stad: 'Amsterdam' };
  const item = listItemNameContext(lijst, '');
  assert.equal(imageBaseName(item), 'beste-terrassen-van-de-stad-terras-amsterdam');
});

// ---------- samenvatting ----------

console.log(`\n${passed} geslaagd, ${failures.length} mislukt`);
if (failures.length) {
  for (const f of failures) console.error(`\n${f.name}:\n${f.err.stack}`);
  process.exit(1);
}
