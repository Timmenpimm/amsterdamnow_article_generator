// Hermetische db-tests voor de wp_posts-index (fase 2, wp-dedup-index-design):
// dekt de db-helpers die wpSync.ts gebruikt (upsertWpPosts, getWpSyncState,
// deleteWpPostsNotIn) tegen een throwaway temp-SQLite-bestand — geen
// netwerk, geen aanraking van de echte lokale data/tool.db.
// Draaien met: npm run test:wpsync
// (zelfde aanpak als scripts/dedup.test.mjs: geen testframework, want het
// project heeft er nog geen.)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Moet vóór de (dynamische) import van lib/db.ts gebeuren: db.ts leest
// DATABASE_URL/SUPABASE_DB_URL/POSTGRES_URL en SQLITE_DB_FILE op module-
// niveau resp. bij initSqlite(). Een statische top-level import zou hier al
// zijn uitgevoerd vóórdat onderstaande env-vars gezet zijn — vandaar de
// dynamische import verderop.
delete process.env.DATABASE_URL;
delete process.env.SUPABASE_DB_URL;
delete process.env.POSTGRES_URL;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpsync-db-test-'));
const tmpFile = path.join(tmpDir, 'test.db');
process.env.SQLITE_DB_FILE = tmpFile;

const { upsertWpPosts, getWpSyncState, deleteWpPostsNotIn, STORAGE } = await import('../lib/db.ts');

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`NOT OK - ${name}`);
    console.log(`  ${err.message}`);
  }
}

function row(wpId, overrides = {}) {
  return {
    wp_id: wpId,
    title: `Post ${wpId}`,
    slug: `post-${wpId}`,
    excerpt: `Excerpt ${wpId}`,
    link: `https://www.amsterdamnow.com/post-${wpId}/`,
    status: 'publish',
    categories: '[]',
    wp_modified: new Date(2026, 0, wpId).toISOString(),
    ...overrides,
  };
}

// ---------- sanity ----------

await test('sanity: draait tegen de sqlite-driver (geen per ongeluk live Postgres)', () => {
  assert.equal(STORAGE, 'sqlite');
});

// ---------- getWpSyncState ----------

await test('getWpSyncState: lege tabel geeft count 0 en null-timestamps', async () => {
  const state = await getWpSyncState();
  assert.equal(state.count, 0);
  assert.equal(state.maxModified, null);
  assert.equal(state.lastSyncedAt, null);
});

// ---------- upsertWpPosts ----------

await test('upsertWpPosts: lege array raakt de db niet aan en geeft 0 terug', async () => {
  const n = await upsertWpPosts([]);
  assert.equal(n, 0);
  const state = await getWpSyncState();
  assert.equal(state.count, 0, 'een lege upsert mag geen rijen aanmaken');
});

await test('upsertWpPosts: voegt nieuwe rijen toe, zichtbaar via getWpSyncState', async () => {
  const n = await upsertWpPosts([row(1), row(2), row(3)]);
  assert.equal(n, 3);
  const state = await getWpSyncState();
  assert.equal(state.count, 3);
  assert.ok(state.maxModified, 'verwacht een maxModified na upsert');
  assert.ok(state.lastSyncedAt, 'verwacht een lastSyncedAt na upsert');
});

await test('upsertWpPosts: upsert op wp_id overschrijft i.p.v. te dupliceren', async () => {
  await upsertWpPosts([row(1, { title: 'Gewijzigde titel' })]);
  const state = await getWpSyncState();
  assert.equal(state.count, 3, 'nog steeds 3 rijen — geen extra rij voor een bestaande wp_id');
});

// ---------- deleteWpPostsNotIn ----------

await test('deleteWpPostsNotIn: met een niet-lege id-lijst verwijdert alleen wat ontbreekt', async () => {
  const deleted = await deleteWpPostsNotIn([1, 2]);
  assert.equal(deleted, 1, 'verwacht dat alleen wp_id 3 verwijderd wordt');
  const state = await getWpSyncState();
  assert.equal(state.count, 2);
});

await test(
  'deleteWpPostsNotIn: een LEGE id-lijst wist de hele tabel — dit is precies de delete-all-danger ' +
  'die de zero-posts-guard in wpSync.syncWpPosts moet voorkomen (een 200-met-lege-body mag nooit hier belanden)',
  async () => {
    await upsertWpPosts([row(10), row(11)]);
    const before = await getWpSyncState();
    assert.equal(before.count, 4, 'verwacht wp_id 1, 2, 10, 11');

    const deleted = await deleteWpPostsNotIn([]);
    assert.equal(deleted, 4, 'lege ids-array verwijdert alle rijen');
    const after = await getWpSyncState();
    assert.equal(after.count, 0);
  }
);

console.log(`\n${passed} geslaagd, ${failures.length} mislukt`);

fs.rmSync(tmpDir, { recursive: true, force: true });

if (failures.length) process.exit(1);
