// Standalone unit tests voor mediaFilenameFor uit lib/wp.ts — pure functie,
// geen netwerk/DB. Draaien met: npm run test:medianame
//
// Regressie: een beeld toevoegen via de Rosewood-CDN-URL
// https://picasso.rosewoodhotelgroup.com/transform/<uuid>/RWAMS_..._Pool_1
// (image/jpeg, maar géén extensie in het pad) gaf
// `rest_upload_sideload_error` — "Je hebt geen toestemming om dit bestandstype
// te uploaden." WordPress leidt het bestandstype af uit de extensie van de
// meegestuurde bestandsnaam, dus die moet er altijd zijn en moet bij het
// echte mime-type passen.
import assert from 'node:assert/strict';
import { mediaFilenameFor } from '../lib/wp.ts';

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

const ROSEWOOD =
  'https://picasso.rosewoodhotelgroup.com/transform/d575fc75-ef6b-4312-9ca1-ad3d697fdb80/RWAMS_Facilities_Wellness_Asaya_Pool_1';

test('URL zonder extensie krijgt de extensie van het mime-type', () => {
  assert.equal(
    mediaFilenameFor(ROSEWOOD, 'image/jpeg'),
    'RWAMS_Facilities_Wellness_Asaya_Pool_1.jpg',
  );
});

test('Content-Disposition-bestandsnaam wint van het URL-pad', () => {
  assert.equal(
    mediaFilenameFor(ROSEWOOD, 'image/jpeg', 'inline; filename="Asaya_Pool.jpg"'),
    'Asaya_Pool.jpg',
  );
});

test('filename* (RFC 5987) wordt gedecodeerd en gaat vóór filename', () => {
  assert.equal(
    mediaFilenameFor(ROSEWOOD, 'image/jpeg', "inline; filename=\"fallback.jpg\"; filename*=UTF-8''Asaya%20Pool.jpg"),
    'Asaya-Pool.jpg',
  );
});

test('bestaande, kloppende extensie blijft ongemoeid', () => {
  assert.equal(mediaFilenameFor('https://cdn.example.com/foto.png', 'image/png'), 'foto.png');
  assert.equal(mediaFilenameFor('https://cdn.example.com/foto.jpeg', 'image/jpeg'), 'foto.jpeg');
});

test('verkeerde extensie wordt gecorrigeerd naar het echte mime-type', () => {
  assert.equal(mediaFilenameFor('https://cdn.example.com/foto.png', 'image/webp'), 'foto.webp');
});

test('querystring en fragment blijven niet in de naam hangen', () => {
  assert.equal(
    mediaFilenameFor('https://cdn.example.com/foto.jpg?w=1200&auto=format#top', 'image/jpeg'),
    'foto.jpg',
  );
});

test('spaties en rare tekens worden gesaneerd', () => {
  assert.equal(
    mediaFilenameFor('https://cdn.example.com/Caf%C3%A9%20de%20Jaren.jpg', 'image/jpeg'),
    'Caf-de-Jaren.jpg',
  );
});

test('een punt die geen extensie is, wordt niet als extensie gezien', () => {
  assert.equal(mediaFilenameFor('https://cdn.example.com/v1.2/beeld', 'image/jpeg'), 'beeld.jpg');
  assert.equal(mediaFilenameFor('https://cdn.example.com/asaya.pool', 'image/jpeg'), 'asaya.pool.jpg');
});

test('lege of onbruikbare naam valt terug op afbeelding.<ext>', () => {
  assert.equal(mediaFilenameFor('https://cdn.example.com/', 'image/webp'), 'afbeelding.webp');
  assert.equal(mediaFilenameFor('https://cdn.example.com/....', 'image/jpeg'), 'afbeelding.jpg');
});

test('onbekend mime-type zonder extensie valt terug op .jpg', () => {
  assert.equal(mediaFilenameFor(ROSEWOOD, 'image/x-onbekend'), 'RWAMS_Facilities_Wellness_Asaya_Pool_1.jpg');
});

// ---------- samenvatting ----------

console.log(`\n${passed} geslaagd, ${failures.length} mislukt`);
if (failures.length) {
  for (const f of failures) console.error(`\n${f.name}:\n${f.err.stack}`);
  process.exit(1);
}
