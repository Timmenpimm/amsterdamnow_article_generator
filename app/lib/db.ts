import path from 'path';
import fs from 'fs';
import type {
  ListArticleStructure, ListState, StandaardState, PromptKind, Topic, PromptVersion,
  ConstraintKind, ConstraintVersion, StandaardConstraints, ListConstraints,
  Source, SourceSummary, SourceFinding, FindingState,
  ImageCandidate, ImageCandidateDraft, CandidateStatus,
} from './types';
import { DEFAULT_STANDAARD_CONSTRAINTS, DEFAULT_LIST_CONSTRAINTS } from './types';
import { PROMPT_SEEDS } from './prompt-seeds';

// Vóór dit bestand werden prompts vanuit losse .txt-bestanden onder
// app/seeds/ ingelezen via fs.readFileSync met een dynamisch pad. Vercel's
// build bundelde die bestanden niet betrouwbaar mee (vier eerdere
// fixpogingen loste dat niet blijvend op), waardoor prompts op productie
// stil bleven hangen op onderstaande placeholdertekst. PROMPT_SEEDS bevat
// nu de prompts als code-constanten, die elke bundler wél meeneemt.
const LEGACY_MISSING_SEED_PLACEHOLDER = '(Seed-bestand ontbreekt in deze deployment — plak hier de oorspronkelijke prompt en sla op als nieuwe versie.)';

// Opslaglaag met twee drivers:
// - Postgres (Supabase) zodra DATABASE_URL is gezet — persistent, voor Vercel
// - SQLite lokaal (op Vercel zonder DATABASE_URL: /tmp, níet persistent)
const PG_URL = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || process.env.POSTGRES_URL || '';
// Elke fase-stap is één Claude-call en past ruim binnen de 60s-serverless-
// limiet (gemeten op productie: 15-36s per stap) — Vercel killt een nog
// legitiem lopende stap dus sowieso uiterlijk na 60s. Een lease van 5 minuten
// betekende dat één weggevallen tik (afgesloten tabblad, netwerkhikje) de
// hele wachtrij tot 5 minuten blokkeerde, want er mag maar 1 taak tegelijk
// 'writing' zijn. 90s laat ruim marge over de 60s-limiet zonder dat gebruikers
// het gevoel krijgen dat de wachtrij "hangt".
const JOB_LEASE_MS = 90 * 1000;
const MAX_JOB_ATTEMPTS = 3;

export const STORAGE: 'postgres' | 'sqlite' = PG_URL ? 'postgres' : 'sqlite';

interface DB {
  all(q: string, p?: unknown[]): Promise<any[]>;
  get(q: string, p?: unknown[]): Promise<any | undefined>;
  run(q: string, p?: unknown[]): Promise<void>;
}

function now(): string {
  return new Date().toISOString();
}

// Query's zijn geschreven in Postgres-stijl ($1, $2). Voor SQLite vertalen we ze.
function toSqlite(q: string, p: unknown[]): [string, unknown[]] {
  const out: unknown[] = [];
  const sql = q.replace(/\$(\d+)/g, (_m, n) => {
    out.push(p[Number(n) - 1]);
    return '?';
  });
  return [sql, out];
}

async function initSqlite(): Promise<DB> {
  const Database = (await import('better-sqlite3')).default;
  // SQLITE_DB_FILE: alleen voor de hermetische db-tests (scripts/wpsync.db.test.mjs)
  // — die zetten 'm op een throwaway temp-bestand zodat tests nooit de
  // echte lokale data/tool.db aanraken. In productie/dev blijft dit ongezet.
  const dbFile = process.env.SQLITE_DB_FILE || (() => {
    const dir = process.env.VERCEL ? '/tmp/artikel-tool' : path.join(process.cwd(), 'data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'tool.db');
  })();
  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      type TEXT NOT NULL DEFAULT 'standaard',
      phase TEXT,
      list_state TEXT,
      sort REAL NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      error TEXT,
      error_step TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      post_id INTEGER,
      locked_at TEXT,
      lock_owner TEXT
    );
    CREATE TABLE IF NOT EXISTS prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      version INTEGER NOT NULL,
      content TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL DEFAULT 'Martijn',
      created_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS demo_articles (
      id INTEGER PRIMARY KEY,
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS list_articles (
      post_id INTEGER PRIMARY KEY,
      topic_id INTEGER,
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS constraints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      version INTEGER NOT NULL,
      content TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL DEFAULT 'Martijn',
      created_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      last_scan_at TEXT,
      last_scan_status TEXT,
      last_scan_error TEXT,
      last_new_count INTEGER,
      content_hash TEXT
    );
    CREATE TABLE IF NOT EXISTS source_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      dedup_key TEXT NOT NULL,
      found_at TEXT NOT NULL,
      topic_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_findings_source ON source_findings (source_id);
    CREATE TABLE IF NOT EXISTS image_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      url TEXT NOT NULL,
      thumb_url TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT '',
      source_page TEXT NOT NULL DEFAULT '',
      license TEXT NOT NULL DEFAULT '',
      license_url TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      query TEXT NOT NULL DEFAULT '',
      score INTEGER,
      reason TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_candidates_post ON image_candidates (post_id);
    CREATE TABLE IF NOT EXISTS wp_posts (
      wp_id INTEGER PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      slug TEXT NOT NULL DEFAULT '',
      excerpt TEXT NOT NULL DEFAULT '',
      link TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      categories TEXT NOT NULL DEFAULT '[]',
      wp_modified TEXT NOT NULL DEFAULT '',
      synced_at TEXT NOT NULL DEFAULT ''
    );
  `);
  // Migratie voor databases van vóór de lijstpipeline.
  for (const col of ["type TEXT NOT NULL DEFAULT 'standaard'", 'phase TEXT', 'list_state TEXT', 'locked_at TEXT', 'lock_owner TEXT']) {
    try { db.exec(`ALTER TABLE topics ADD COLUMN ${col}`); } catch { /* kolom bestaat al */ }
  }
  // Migratie voor databases van vóór de pagina-hash: sla per bron de hash van
  // de laatst gescande paginatekst op, zodat een ongewijzigde pagina de
  // Claude-call kan overslaan.
  for (const col of ['content_hash TEXT']) {
    try { db.exec(`ALTER TABLE sources ADD COLUMN ${col}`); } catch { /* kolom bestaat al */ }
  }
  // Migratie voor databases van vóór de WP-dedup-index: force-toegevoegde
  // topics slaan de tweede (her)check tegen wp_posts over.
  for (const col of ['dedup_override INTEGER NOT NULL DEFAULT 0']) {
    try { db.exec(`ALTER TABLE topics ADD COLUMN ${col}`); } catch { /* kolom bestaat al */ }
  }
  return {
    async all(q, p = []) { const [s, sp] = toSqlite(q, p); return db.prepare(s).all(...sp); },
    async get(q, p = []) { const [s, sp] = toSqlite(q, p); return db.prepare(s).get(...sp); },
    async run(q, p = []) { const [s, sp] = toSqlite(q, p); db.prepare(s).run(...sp); },
  };
}

async function initPostgres(): Promise<DB> {
  const { Pool } = await import('pg');
  const pool = new Pool({
    connectionString: PG_URL,
    ssl: PG_URL.includes('localhost') ? undefined : { rejectUnauthorized: false },
    max: 3,
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS topics (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      sort DOUBLE PRECISION NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      error TEXT,
      error_step TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      post_id INTEGER,
      locked_at TEXT,
      lock_owner TEXT
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS prompts (
      id SERIAL PRIMARY KEY,
      kind TEXT NOT NULL,
      version INTEGER NOT NULL,
      content TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL DEFAULT 'Martijn',
      created_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS demo_articles (
      id BIGINT PRIMARY KEY,
      json TEXT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS list_articles (
      post_id BIGINT PRIMARY KEY,
      topic_id INTEGER,
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS constraints (
      id SERIAL PRIMARY KEY,
      kind TEXT NOT NULL,
      version INTEGER NOT NULL,
      content TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL DEFAULT 'Martijn',
      created_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sources (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      last_scan_at TEXT,
      last_scan_status TEXT,
      last_scan_error TEXT,
      last_new_count INTEGER,
      content_hash TEXT
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS source_findings (
      id SERIAL PRIMARY KEY,
      source_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      dedup_key TEXT NOT NULL,
      found_at TEXT NOT NULL,
      topic_id INTEGER
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_findings_source ON source_findings (source_id)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS image_candidates (
      id SERIAL PRIMARY KEY,
      post_id BIGINT NOT NULL,
      url TEXT NOT NULL,
      thumb_url TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT '',
      source_page TEXT NOT NULL DEFAULT '',
      license TEXT NOT NULL DEFAULT '',
      license_url TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      query TEXT NOT NULL DEFAULT '',
      score INTEGER,
      reason TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new',
      created_at TEXT NOT NULL
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_candidates_post ON image_candidates (post_id)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wp_posts (
      wp_id BIGINT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      slug TEXT NOT NULL DEFAULT '',
      excerpt TEXT NOT NULL DEFAULT '',
      link TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      categories TEXT NOT NULL DEFAULT '[]',
      wp_modified TEXT NOT NULL DEFAULT '',
      synced_at TEXT NOT NULL DEFAULT ''
    );
  `);
  // Migratie voor databases van vóór de lijstpipeline.
  await pool.query(`ALTER TABLE topics ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'standaard'`);
  await pool.query(`ALTER TABLE topics ADD COLUMN IF NOT EXISTS phase TEXT`);
  await pool.query(`ALTER TABLE topics ADD COLUMN IF NOT EXISTS list_state TEXT`);
  await pool.query(`ALTER TABLE topics ADD COLUMN IF NOT EXISTS locked_at TEXT`);
  await pool.query(`ALTER TABLE topics ADD COLUMN IF NOT EXISTS lock_owner TEXT`);
  // Migratie voor databases van vóór de pagina-hash: sla per bron de hash van
  // de laatst gescande paginatekst op, zodat een ongewijzigde pagina de
  // Claude-call kan overslaan.
  await pool.query(`ALTER TABLE sources ADD COLUMN IF NOT EXISTS content_hash TEXT`);
  // Migratie voor databases van vóór de WP-dedup-index: force-toegevoegde
  // topics slaan de tweede (her)check tegen wp_posts over.
  await pool.query(`ALTER TABLE topics ADD COLUMN IF NOT EXISTS dedup_override INTEGER NOT NULL DEFAULT 0`);
  return {
    async all(q, p = []) { return (await pool.query(q, p)).rows; },
    async get(q, p = []) { return (await pool.query(q, p)).rows[0]; },
    async run(q, p = []) { await pool.query(q, p); },
  };
}

let dbPromise: Promise<DB> | null = null;

async function getDb(): Promise<DB> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = PG_URL ? await initPostgres() : await initSqlite();
      await seedPrompts(db);
      await seedConstraints(db);
      return db;
    })();
  }
  return dbPromise;
}

async function seedPrompts(db: DB) {
  for (const [kind, note] of [
    ['research', 'Tavily-researchprompt voor Claude.'],
    ['schrijf', 'Oorspronkelijke schrijf-prompt voor Claude.'],
    ['seo', 'Oorspronkelijke SEO-prompt voor Claude.'],
    ['lijst-selectie', 'Kandidaat-items voorstellen voor een lijstartikel.'],
    ['lijst-research', 'Per lijstitem verifiëren en researchen (o.b.v. de redactionele instructie).'],
    ['lijst-schrijf', 'Lijstartikel componeren uit geverifieerde items (o.b.v. de redactionele instructie).'],
    ['lijst-seo', 'RankMath-velden voor lijstartikelen (titel eindigt op | Amsterdam Now).'],
  ] as [PromptKind, string][]) {
    const seed = PROMPT_SEEDS[kind];
    const row = await db.get('SELECT COUNT(*) AS c FROM prompts WHERE kind = $1', [kind]);
    if (Number(row.c) === 0) await db.run(
      `INSERT INTO prompts (kind, version, content, note, author, created_at, active) VALUES ($1, 1, $2, $3, 'import', $4, 1)`,
      [kind, seed, note, now()]
    );
    // Herstel uitsluitend de bekende placeholder van vóór PROMPT_SEEDS;
    // handmatig aangepaste prompts blijven intact.
    else await db.run(
      `UPDATE prompts SET content = $1, note = $2, author = 'import', created_at = $3 WHERE kind = $4 AND active = 1 AND content = $5`,
      [seed, note, now(), kind, LEGACY_MISSING_SEED_PLACEHOLDER]
    );
  }
}

async function seedConstraints(db: DB) {
  const defaults: [ConstraintKind, StandaardConstraints | ListConstraints, string][] = [
    ['standaard', DEFAULT_STANDAARD_CONSTRAINTS, 'Standaardwaarden overgenomen uit de code.'],
    ['lijst', DEFAULT_LIST_CONSTRAINTS, 'Standaardwaarden overgenomen uit de code.'],
  ];
  for (const [kind, content, note] of defaults) {
    const row = await db.get('SELECT COUNT(*) AS c FROM constraints WHERE kind = $1', [kind]);
    if (Number(row.c) === 0) await db.run(
      `INSERT INTO constraints (kind, version, content, note, author, created_at, active) VALUES ($1, 1, $2, $3, 'import', $4, 1)`,
      [kind, JSON.stringify(content), note, now()]
    );
  }
}

// ---------- topics ----------

export async function listTopics(): Promise<Topic[]> {
  const db = await getDb();
  return db.all(`SELECT * FROM topics WHERE status != 'done' ORDER BY (status = 'failed'), sort ASC`);
}

// `forceTitles` (lowercase+trim, zoals de eigen dedup-sleutel hieronder):
// titels in deze set worden ingevoegd met dedup_override=1, zodat de
// herkans-check vlak vóór createDraft() ze niet nog een keer blokkeert. Zie
// docs/superpowers/specs/2026-07-21-wp-dedup-index-design.md §4.
export async function addTopics(titles: string[], forceTitles: Set<string> = new Set()): Promise<{ added: Topic[]; skipped: string[] }> {
  const db = await getDb();
  const rows = await db.all(`SELECT lower(trim(title)) AS t FROM topics WHERE status IN ('queued','writing','failed')`);
  const existing = new Set(rows.map(r => r.t as string));
  const maxRow = await db.get('SELECT COALESCE(MAX(sort), 0) AS m FROM topics');
  let sort = Number(maxRow.m);
  const added: Topic[] = [];
  const skipped: string[] = [];
  for (const raw of titles) {
    const title = raw.trim();
    if (!title) continue;
    const key = title.toLowerCase();
    if (existing.has(key)) { skipped.push(title); continue; }
    existing.add(key);
    sort += 1;
    const override = forceTitles.has(key) ? 1 : 0;
    const rec = await db.get(
      `INSERT INTO topics (title, status, phase, sort, created_at, dedup_override) VALUES ($1, 'queued', 'research', $2, $3, $4) RETURNING *`,
      [title, sort, now(), override]
    );
    added.push(rec as Topic);
  }
  return { added, skipped };
}

export async function updateTopicTitle(id: number, title: string) {
  const db = await getDb();
  await db.run('UPDATE topics SET title = $1 WHERE id = $2', [title.trim(), id]);
}

export async function deleteTopic(id: number) {
  const db = await getDb();
  await db.run('DELETE FROM topics WHERE id = $1', [id]);
}

export async function reorderTopics(ids: number[]) {
  const db = await getDb();
  if (!ids.length || ids.some(id => !Number.isInteger(id)) || new Set(ids).size !== ids.length) {
    throw new Error('Ongeldige wachtrijvolgorde.');
  }
  const rows = await db.all(`SELECT id FROM topics WHERE status = 'queued' AND id IN (${ids.map((_, i) => `$${i + 1}`).join(', ')})`, ids);
  if (rows.length !== ids.length) throw new Error('De wachtrij is gewijzigd; vernieuw het bord en probeer opnieuw.');

  const cases = ids.map((_, i) => `WHEN $${i + 1} THEN ${i + 1}`).join(' ');
  await db.run(
    `UPDATE topics SET sort = CASE id ${cases} END WHERE status = 'queued' AND id IN (${ids.map((_, i) => `$${i + 1}`).join(', ')})`,
    ids
  );
}

export async function retryTopic(id: number) {
  const db = await getDb();
  const min = await db.get('SELECT COALESCE(MIN(sort), 1) AS m FROM topics');
  const topic = await db.get('SELECT type FROM topics WHERE id = $1', [id]);
  // Een bewuste retry door de redactie is een verse start: zonder attempts-
  // reset zou een topic dat ooit MAX_JOB_ATTEMPTS haalde bij de eerstvolgende
  // verlopen lease direct weer op 'failed' klappen, hoe vaak je ook opnieuw
  // probeert. Voor standaard-topics ook fase en tussentijdse staat wissen:
  // anders hervat de retry exact dezelfde afgekeurde schrijf(-retry)-poging
  // met dezelfde afkeurreden, en faalt hij keer op keer op precies dezelfde
  // manier (gezien op productie). Lijst-topics behouden hun staat — de
  // geselecteerde/geverifieerde items zijn kostbaar om opnieuw te doen.
  const resetPhase = topic?.type === 'standaard';
  await db.run(
    `UPDATE topics SET status = 'queued', error = NULL, error_step = NULL, locked_at = NULL, lock_owner = NULL, attempts = 0, sort = $1${resetPhase ? ', phase = NULL, list_state = NULL' : ''} WHERE id = $2`,
    [Number(min.m) - 1, id]
  );
}

async function claimNext(where = '', values: unknown[] = []): Promise<Topic | null> {
  const db = await getDb();
  const claimedAt = now();
  const owner = `process-${crypto.randomUUID()}`;
  const condition = where ? ` AND ${where}` : '';
  return db.get(
    `UPDATE topics
     SET status = 'writing', started_at = $1, locked_at = $1, lock_owner = $2, attempts = attempts + 1
     WHERE id = (
       SELECT id FROM topics WHERE status = 'queued'${condition} ORDER BY sort ASC LIMIT 1
     ) AND status = 'queued'
       AND NOT EXISTS (SELECT 1 FROM topics WHERE status = 'writing' AND lock_owner IS NOT NULL)
     RETURNING *`,
    [claimedAt, owner, ...values]
  );
}

export async function claimNextTopic(): Promise<Topic | null> {
  return claimNext('type = $3', ['standaard']);
}

export async function claimNextListTopic(): Promise<Topic | null> {
  return claimNext('type = $3', ['lijst']);
}

// Claimt het eerstvolgende werkstuk over beide pipelines heen. De UPDATE met
// statusvoorwaarde maakt dit veilig bij twee tabs, cron-runs of retries.
export async function claimNextQueued(): Promise<Topic | null> {
  return claimNext();
}

// Onderscheidt "de wachtrij is echt leeg" van "er ligt werk, maar er is al
// een taak actief" — claimNextQueued() geeft in beide gevallen null terug,
// en dat las de redactie ten onrechte als "niets te doen" terwijl er
// gewoon al iets liep.
export async function hasQueuedTopics(): Promise<boolean> {
  const db = await getDb();
  const row = await db.get(`SELECT 1 AS x FROM topics WHERE status = 'queued' LIMIT 1`);
  return !!row;
}

// Een lijstartikel blijft tussen stappen op `writing` staan. Claim ook die
// stap atomisch, zodat dubbelklikken of twee open borden niet dezelfde fase
// parallel uitvoeren.
export async function claimActiveListTopic(): Promise<Topic | null> {
  const db = await getDb();
  const claimedAt = now();
  const owner = `process-${crypto.randomUUID()}`;
  return db.get(
    `UPDATE topics SET locked_at = $1, lock_owner = $2
     WHERE id = (
       SELECT id FROM topics
       WHERE type = 'lijst' AND status = 'writing' AND lock_owner IS NULL
       ORDER BY sort ASC LIMIT 1
     ) AND lock_owner IS NULL
       AND NOT EXISTS (SELECT 1 FROM topics WHERE status = 'writing' AND lock_owner IS NOT NULL)
     RETURNING *`,
    [claimedAt, owner]
  );
}

export async function releaseTopicLock(id: number) {
  const db = await getDb();
  await db.run(`UPDATE topics SET lock_owner = NULL WHERE id = $1 AND status = 'writing'`, [id]);
}

export async function completeTopic(id: number, postId: number) {
  const db = await getDb();
  await db.run(`UPDATE topics SET status = 'done', post_id = $1, locked_at = NULL, lock_owner = NULL WHERE id = $2`, [postId, id]);
}

export async function recoverStaleTopics(): Promise<{ requeued: number; failed: number }> {
  const db = await getDb();
  const cutoff = new Date(Date.now() - JOB_LEASE_MS).toISOString();
  const stale = await db.all(`SELECT id, attempts FROM topics WHERE status = 'writing' AND COALESCE(locked_at, started_at) < $1`, [cutoff]);
  let requeued = 0;
  let failed = 0;
  for (const topic of stale) {
    if (Number(topic.attempts) >= MAX_JOB_ATTEMPTS) {
      await db.run(
        `UPDATE topics SET status = 'failed', error = $1, error_step = 'wachtrijherstel', locked_at = NULL, lock_owner = NULL WHERE id = $2 AND status = 'writing'`,
        ['Taak is na meerdere verlopen leases gestopt. Zet hem opnieuw in de wachtrij om opnieuw te proberen.', topic.id]
      );
      failed += 1;
    } else {
      await db.run(
        `UPDATE topics SET status = 'queued', error = $1, error_step = 'wachtrijherstel', locked_at = NULL, lock_owner = NULL WHERE id = $2 AND status = 'writing'`,
        ['Vorige verwerking is verlopen; automatisch opnieuw ingepland.', topic.id]
      );
      requeued += 1;
    }
  }
  return { requeued, failed };
}

// ---------- lijstpipeline ----------

export async function addListTopic(title: string, state: ListState): Promise<Topic> {
  const db = await getDb();
  const maxRow = await db.get('SELECT COALESCE(MAX(sort), 0) AS m FROM topics');
  const phase = state.aangeleverd ? 'verify' : 'select';
  return db.get(
    `INSERT INTO topics (title, status, type, phase, list_state, sort, created_at)
     VALUES ($1, 'queued', 'lijst', $2, $3, $4, $5) RETURNING *`,
    [title.trim(), phase, JSON.stringify(state), Number(maxRow.m) + 1, now()]
  );
}

export async function getTopic(id: number): Promise<Topic | undefined> {
  const db = await getDb();
  return db.get('SELECT * FROM topics WHERE id = $1', [id]);
}

// Generiek: bewaart voortgang van zowel de lijst- als de standaardpipeline
// (beide fase-gebaseerd, beide met JSON-staat in dezelfde list_state-kolom).
export async function saveTopicProgress(
  id: number,
  upd: { status?: string; phase?: string | null; state?: ListState | StandaardState; errorClear?: boolean }
) {
  const db = await getDb();
  const sets: string[] = [];
  const params: unknown[] = [];
  const add = (frag: string, val: unknown) => { params.push(val); sets.push(`${frag} = $${params.length}`); };
  if (upd.status) add('status', upd.status);
  if (upd.phase !== undefined) add('phase', upd.phase);
  if (upd.state) add('list_state', JSON.stringify(upd.state));
  if (upd.status === 'writing') add('locked_at', now());
  if (upd.status === 'queued' || upd.status === 'review') {
    sets.push('locked_at = NULL');
    sets.push('lock_owner = NULL');
  }
  if (upd.errorClear) { sets.push('error = NULL'); sets.push('error_step = NULL'); }
  if (!sets.length) return;
  params.push(id);
  await db.run(`UPDATE topics SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
}

// De eerstvolgende lijst-topic waar de machine mee verder kan: een lopende run
// heeft voorrang op het claimen van nieuw werk.
export async function activeListTopic(): Promise<Topic | undefined> {
  const db = await getDb();
  return db.get(
    `SELECT * FROM topics WHERE type = 'lijst' AND status = 'writing' ORDER BY sort ASC LIMIT 1`
  );
}

export async function saveListStructure(postId: number, topicId: number | null, structure: ListArticleStructure) {
  const db = await getDb();
  await db.run(
    `INSERT INTO list_articles (post_id, topic_id, json, updated_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (post_id) DO UPDATE SET json = EXCLUDED.json, updated_at = EXCLUDED.updated_at`,
    [postId, topicId, JSON.stringify(structure), now()]
  );
}

export async function getListStructure(postId: number): Promise<ListArticleStructure | null> {
  const db = await getDb();
  const row = await db.get('SELECT json FROM list_articles WHERE post_id = $1', [postId]);
  if (!row) return null;
  try { return JSON.parse(row.json) as ListArticleStructure; } catch { return null; }
}

export async function deleteListStructure(postId: number) {
  const db = await getDb();
  await db.run('DELETE FROM list_articles WHERE post_id = $1', [postId]);
}

export async function listStructures(): Promise<Record<number, ListArticleStructure>> {
  const db = await getDb();
  const rows = await db.all('SELECT post_id, json FROM list_articles');
  const out: Record<number, ListArticleStructure> = {};
  for (const r of rows) {
    try { out[Number(r.post_id)] = JSON.parse(r.json); } catch { /* overslaan */ }
  }
  return out;
}

export async function failTopic(id: number, error: string, step: string) {
  const db = await getDb();
  await db.run(`UPDATE topics SET status = 'failed', error = $1, error_step = $2, locked_at = NULL, lock_owner = NULL WHERE id = $3`, [error, step, id]);
}

// ---------- prompts ----------

export async function listPrompts(kind: PromptKind): Promise<PromptVersion[]> {
  const db = await getDb();
  return db.all('SELECT * FROM prompts WHERE kind = $1 ORDER BY version DESC', [kind]);
}

export async function activePrompt(kind: PromptKind): Promise<PromptVersion> {
  const db = await getDb();
  const prompt = await db.get('SELECT * FROM prompts WHERE kind = $1 AND active = 1', [kind]);
  if (!prompt) throw new Error(`Geen actieve ${kind}-prompt gevonden`);
  return prompt as PromptVersion;
}

export async function savePromptVersion(kind: PromptKind, content: string, note: string): Promise<PromptVersion> {
  const db = await getDb();
  const max = await db.get('SELECT COALESCE(MAX(version), 0) AS m FROM prompts WHERE kind = $1', [kind]);
  await db.run('UPDATE prompts SET active = 0 WHERE kind = $1', [kind]);
  return db.get(
    `INSERT INTO prompts (kind, version, content, note, created_at, active) VALUES ($1, $2, $3, $4, $5, 1) RETURNING *`,
    [kind, Number(max.m) + 1, content, note, now()]
  );
}

export async function activatePromptVersion(id: number): Promise<PromptVersion | undefined> {
  const db = await getDb();
  const row = await db.get('SELECT * FROM prompts WHERE id = $1', [id]);
  if (!row) return undefined;
  await db.run('UPDATE prompts SET active = 0 WHERE kind = $1', [row.kind]);
  await db.run('UPDATE prompts SET active = 1 WHERE id = $1', [id]);
  return db.get('SELECT * FROM prompts WHERE id = $1', [id]);
}

// ---------- constraints ----------

export async function listConstraints(kind: ConstraintKind): Promise<ConstraintVersion[]> {
  const db = await getDb();
  return db.all('SELECT * FROM constraints WHERE kind = $1 ORDER BY version DESC', [kind]);
}

export async function activeConstraints(kind: 'standaard'): Promise<StandaardConstraints>;
export async function activeConstraints(kind: 'lijst'): Promise<ListConstraints>;
export async function activeConstraints(kind: ConstraintKind): Promise<StandaardConstraints | ListConstraints> {
  const db = await getDb();
  const row = await db.get('SELECT * FROM constraints WHERE kind = $1 AND active = 1', [kind]);
  if (!row) throw new Error(`Geen actieve constraints gevonden voor ${kind}`);
  // Oudere opgeslagen versies missen velden die pas later aan het type zijn
  // toegevoegd (bv. quoteNormMandatory); merge met de codedefaults zodat
  // nieuwe regels ook meteen gelden zonder dat iemand Instellingen hoeft te
  // openen en op te slaan.
  const defaults = kind === 'standaard' ? DEFAULT_STANDAARD_CONSTRAINTS : DEFAULT_LIST_CONSTRAINTS;
  return { ...defaults, ...JSON.parse(row.content) };
}

export async function saveConstraintVersion(
  kind: ConstraintKind, content: StandaardConstraints | ListConstraints, note: string
): Promise<ConstraintVersion> {
  const db = await getDb();
  const max = await db.get('SELECT COALESCE(MAX(version), 0) AS m FROM constraints WHERE kind = $1', [kind]);
  await db.run('UPDATE constraints SET active = 0 WHERE kind = $1', [kind]);
  return db.get(
    `INSERT INTO constraints (kind, version, content, note, created_at, active) VALUES ($1, $2, $3, $4, $5, 1) RETURNING *`,
    [kind, Number(max.m) + 1, JSON.stringify(content), note, now()]
  );
}

export async function activateConstraintVersion(id: number): Promise<ConstraintVersion | undefined> {
  const db = await getDb();
  const row = await db.get('SELECT * FROM constraints WHERE id = $1', [id]);
  if (!row) return undefined;
  await db.run('UPDATE constraints SET active = 0 WHERE kind = $1', [row.kind]);
  await db.run('UPDATE constraints SET active = 1 WHERE id = $1', [id]);
  return db.get('SELECT * FROM constraints WHERE id = $1', [id]);
}

// ---------- bronnen (agenda-scanner) ----------

// Dedup-sleutel per bron: kleine letters, randspaties weg, interne spaties samen.
function findingKey(title: string): string {
  return title.toLowerCase().trim().replace(/\s+/g, ' ');
}

// Canonieke opslag-URL: protocol afdwingen, trailing slashes weg.
function normalizeSourceUrl(raw: string): string {
  let u = (raw || '').trim();
  if (!u) return u;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u.replace(/\/+$/, '');
}

function findingState(topicId: number | null, topicStatus: string | null | undefined): FindingState {
  if (topicId == null) return 'deleted';
  if (topicStatus == null) return 'deleted'; // topic bestond, maar is door de redactie verwijderd
  if (topicStatus === 'done') return 'written';
  return 'queued';
}

export async function listSources(): Promise<SourceSummary[]> {
  const db = await getDb();
  const sources = await db.all('SELECT * FROM sources ORDER BY created_at ASC, id ASC') as Source[];
  const rows = await db.all(
    `SELECT f.id, f.source_id, f.title, f.found_at, f.topic_id, t.status AS topic_status
     FROM source_findings f LEFT JOIN topics t ON t.id = f.topic_id
     ORDER BY f.found_at DESC, f.id DESC`
  );
  const recent = new Map<number, SourceFinding[]>();
  const counts = new Map<number, number>();
  for (const r of rows) {
    const sid = Number(r.source_id);
    counts.set(sid, (counts.get(sid) || 0) + 1);
    const list = recent.get(sid) || [];
    if (list.length < 6) {
      list.push({ id: Number(r.id), title: r.title, found_at: r.found_at, state: findingState(r.topic_id, r.topic_status) });
    }
    recent.set(sid, list);
  }
  return sources.map(s => ({
    ...s,
    active: (Number(s.active) ? 1 : 0) as 0 | 1,
    foundCount: counts.get(Number(s.id)) || 0,
    recent: recent.get(Number(s.id)) || [],
  }));
}

export async function getSource(id: number): Promise<Source | undefined> {
  const db = await getDb();
  return await db.get('SELECT * FROM sources WHERE id = $1', [id]) as Source | undefined;
}

export async function activeSources(): Promise<Source[]> {
  const db = await getDb();
  return db.all('SELECT * FROM sources WHERE active = 1 ORDER BY created_at ASC, id ASC');
}

export async function addSource(url: string, name?: string, label?: string): Promise<{ source: Source; duplicate: boolean }> {
  const db = await getDb();
  const canonical = normalizeSourceUrl(url);
  if (!canonical) throw new Error('Geef een geldige URL op.');
  const existing = await db.get('SELECT * FROM sources WHERE lower(url) = lower($1)', [canonical]);
  if (existing) return { source: existing as Source, duplicate: true };
  let host = canonical;
  try { host = new URL(canonical).hostname.replace(/^www\./, ''); } catch { /* host blijft de hele URL */ }
  const finalName = (name && name.trim()) || host;
  const row = await db.get(
    `INSERT INTO sources (name, url, label, active, created_at) VALUES ($1, $2, $3, 1, $4) RETURNING *`,
    [finalName, canonical, (label || '').trim(), now()]
  );
  return { source: row as Source, duplicate: false };
}

export async function setSourceActive(id: number, active: boolean) {
  const db = await getDb();
  await db.run('UPDATE sources SET active = $1 WHERE id = $2', [active ? 1 : 0, id]);
}

export async function renameSource(id: number, name: string) {
  const db = await getDb();
  await db.run('UPDATE sources SET name = $1 WHERE id = $2', [name.trim(), id]);
}

export async function deleteSource(id: number) {
  const db = await getDb();
  await db.run('DELETE FROM source_findings WHERE source_id = $1', [id]);
  await db.run('DELETE FROM sources WHERE id = $1', [id]);
}

export async function updateSourceScan(
  id: number,
  upd: { status: 'ok' | 'error'; error?: string | null; newCount?: number; contentHash?: string | null }
) {
  const db = await getDb();
  // content_hash alleen meenemen als de aanroeper 'm meegeeft (bij een
  // geslaagde scan) — bij een fout blijft de laatst bekende hash staan.
  if (upd.contentHash !== undefined) {
    await db.run(
      `UPDATE sources SET last_scan_at = $1, last_scan_status = $2, last_scan_error = $3, last_new_count = $4, content_hash = $5 WHERE id = $6`,
      [now(), upd.status, upd.error ?? null, upd.newCount ?? null, upd.contentHash, id]
    );
  } else {
    await db.run(
      `UPDATE sources SET last_scan_at = $1, last_scan_status = $2, last_scan_error = $3, last_new_count = $4 WHERE id = $5`,
      [now(), upd.status, upd.error ?? null, upd.newCount ?? null, id]
    );
  }
}

export async function getFindingKeys(sourceId: number): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db.all('SELECT dedup_key FROM source_findings WHERE source_id = $1', [sourceId]);
  return new Set(rows.map(r => r.dedup_key as string));
}

export async function recordFindings(sourceId: number, entries: { title: string; topicId: number | null }[]) {
  const db = await getDb();
  for (const e of entries) {
    await db.run(
      `INSERT INTO source_findings (source_id, title, dedup_key, found_at, topic_id) VALUES ($1, $2, $3, $4, $5)`,
      [sourceId, e.title, findingKey(e.title), now(), e.topicId]
    );
  }
}

// Zoek topic-id's terug op titel (lower+trim, zoals addTopics dedupt), zodat een
// vondst aan het juiste topic gekoppeld kan worden — ook als addTopics 'm als
// "al bekend" oversloeg (dan wijst de vondst naar het bestaande topic).
export async function topicIdsByTitle(titles: string[]): Promise<Map<string, number>> {
  const db = await getDb();
  const map = new Map<string, number>();
  const keys = titles.map(t => t.toLowerCase().trim()).filter(Boolean);
  if (!keys.length) return map;
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
  const rows = await db.all(
    `SELECT id, lower(trim(title)) AS t FROM topics WHERE lower(trim(title)) IN (${placeholders})`,
    keys
  );
  for (const r of rows) if (!map.has(r.t)) map.set(r.t as string, Number(r.id));
  return map;
}

// ---------- beeldselectie (kandidaat-beelden per artikel) ----------

// Slaat nieuwe kandidaten op; URL's die al bij dit artikel horen (in welke
// status dan ook, inclusief 'dismissed') worden overgeslagen — zo komt een
// eerder afgewezen beeld bij "Vernieuwen" niet terug.
export async function addImageCandidates(postId: number, drafts: ImageCandidateDraft[]): Promise<number> {
  const db = await getDb();
  const rows = await db.all('SELECT url FROM image_candidates WHERE post_id = $1', [postId]);
  const existing = new Set(rows.map(r => String(r.url).split('?')[0]));
  let added = 0;
  for (const d of drafts) {
    if (existing.has(d.url.split('?')[0])) continue;
    existing.add(d.url.split('?')[0]);
    await db.run(
      `INSERT INTO image_candidates
         (post_id, url, thumb_url, width, height, source, source_page, license, license_url, author, title, query, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'new', $13)`,
      [postId, d.url, d.thumb_url, d.width, d.height, d.source, d.source_page,
       d.license, d.license_url, d.author.slice(0, 200), d.title.slice(0, 300), d.query, now()]
    );
    added += 1;
  }
  return added;
}

export async function listImageCandidates(postId: number): Promise<ImageCandidate[]> {
  const db = await getDb();
  const rows = await db.all(
    `SELECT * FROM image_candidates WHERE post_id = $1
     ORDER BY (status = 'used') DESC, (score IS NULL), score DESC, id ASC`,
    [postId]
  );
  return rows.map(r => ({ ...r, score: r.score == null ? null : Number(r.score) })) as ImageCandidate[];
}

export async function unscoredImageCandidates(postId: number, limit: number): Promise<ImageCandidate[]> {
  const db = await getDb();
  return db.all(
    `SELECT * FROM image_candidates WHERE post_id = $1 AND status = 'new' ORDER BY id ASC LIMIT ${Math.max(1, limit)}`,
    [postId]
  );
}

export async function scoreImageCandidate(id: number, score: number, reason: string, role: string) {
  const db = await getDb();
  await db.run(
    `UPDATE image_candidates SET score = $1, reason = $2, role = $3, status = 'scored' WHERE id = $4 AND status = 'new'`,
    [Math.max(0, Math.min(100, Math.round(score))), reason.slice(0, 400), role, id]
  );
}

export async function setImageCandidateStatus(postId: number, id: number, status: CandidateStatus) {
  const db = await getDb();
  await db.run('UPDATE image_candidates SET status = $1 WHERE id = $2 AND post_id = $3', [status, id, postId]);
}

export async function getImageCandidate(postId: number, id: number): Promise<ImageCandidate | undefined> {
  const db = await getDb();
  return db.get('SELECT * FROM image_candidates WHERE id = $1 AND post_id = $2', [id, postId]);
}

// ---------- wp-posts (dedup-index) ----------

export interface WpPostRow {
  wp_id: number;
  title: string;
  slug: string;
  excerpt: string;
  link: string;
  status: string;
  categories: string; // JSON-array van category-ids, als tekst
  wp_modified: string; // ISO, uit WP `modified`
}

export interface WpDedupCandidate {
  id: number;
  title: string;
  excerpt: string;
  link: string;
  status: string;
}

export interface WpSyncState {
  count: number;
  maxModified: string | null;
  lastSyncedAt: string | null;
}

// Kolommen per rij in de multi-row INSERT hieronder — bepaalt hoeveel
// $n-placeholders elke rij in de VALUES-lijst inneemt.
const WP_POST_COLUMNS = 9;
// Rijen per multi-row statement. Op 1.097 posts geeft dit 11 statements i.p.v.
// 1.097 (was: één INSERT per rij — de RTT naar Supabase Postgres, 40-80ms/stuk,
// duwde een volledige backfill over de 60s-serverless-limiet heen, zie
// productie-incident 2026-07-21 in het spec-document). 100 rijen × 9 kolommen
// = 900 parameters per statement, ruim onder de SQLite-limiet van 999
// bind-parameters (oudere better-sqlite3/SQLite-builds) — geldt dus voor
// beide drivers.
const UPSERT_CHUNK_SIZE = 100;

// Upsert op wp_id: een bestaande post wordt overschreven met de nieuwste
// WP-velden, een nieuwe wordt ingevoegd. `synced_at` wordt hier eenmalig
// bepaald zodat alle rijen van dezelfde sync-run exact dezelfde timestamp
// krijgen (handig voor staleness-checks). Rijen gaan in chunks van
// UPSERT_CHUNK_SIZE als één multi-row INSERT ... VALUES (...),(...) de deur
// uit — dezelfde $n-placeholder-vertaling (toSqlite) werkt hier ongewijzigd
// voor de SQLite-driver, zolang de $n's in de query in dezelfde volgorde
// staan als de bijbehorende waarden in `params`.
export async function upsertWpPosts(rows: WpPostRow[]): Promise<number> {
  if (!rows.length) return 0;
  const db = await getDb();
  const ts = now();
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK_SIZE);
    const valueGroups: string[] = [];
    const params: unknown[] = [];
    chunk.forEach((r, idx) => {
      const base = idx * WP_POST_COLUMNS;
      valueGroups.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`
      );
      params.push(r.wp_id, r.title, r.slug, r.excerpt, r.link, r.status, r.categories, r.wp_modified, ts);
    });
    await db.run(
      `INSERT INTO wp_posts (wp_id, title, slug, excerpt, link, status, categories, wp_modified, synced_at)
       VALUES ${valueGroups.join(', ')}
       ON CONFLICT (wp_id) DO UPDATE SET
         title = EXCLUDED.title, slug = EXCLUDED.slug, excerpt = EXCLUDED.excerpt,
         link = EXCLUDED.link, status = EXCLUDED.status, categories = EXCLUDED.categories,
         wp_modified = EXCLUDED.wp_modified, synced_at = EXCLUDED.synced_at`,
      params
    );
  }
  return rows.length;
}

// Voor de dedup-check (fase 2): lexicale kandidaten hebben alleen titel,
// excerpt, link en status nodig — categorieën/wp_modified blijven hier weg.
export async function getAllWpPosts(): Promise<WpDedupCandidate[]> {
  const db = await getDb();
  const rows = await db.all('SELECT wp_id, title, excerpt, link, status FROM wp_posts');
  return rows.map(r => ({
    id: Number(r.wp_id),
    title: r.title,
    excerpt: r.excerpt,
    link: r.link,
    status: r.status,
  }));
}

export async function getWpSyncState(): Promise<WpSyncState> {
  const db = await getDb();
  const row = await db.get('SELECT COUNT(*) AS c, MAX(wp_modified) AS mm, MAX(synced_at) AS ls FROM wp_posts');
  return {
    count: Number(row?.c || 0),
    maxModified: row?.mm || null,
    lastSyncedAt: row?.ls || null,
  };
}

// Gebruikt door de volledige sync om verwijderde WP-posts (niet meer terug-
// gekomen in de laatste full fetch) ook lokaal op te ruimen. `RETURNING`
// geeft de verwijderde id's terug, zodat het aantal zonder aparte COUNT-query
// bekend is — werkt zowel op Postgres als op de SQLite-versie die
// better-sqlite3 bundelt (>= 3.35).
export async function deleteWpPostsNotIn(ids: number[]): Promise<number> {
  const db = await getDb();
  if (!ids.length) {
    const deleted = await db.all('DELETE FROM wp_posts RETURNING wp_id');
    return deleted.length;
  }
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
  const deleted = await db.all(`DELETE FROM wp_posts WHERE wp_id NOT IN (${placeholders}) RETURNING wp_id`, ids);
  return deleted.length;
}

// ---------- demo store ----------

export async function demoGetAll(): Promise<{ id: number; json: string }[]> {
  const db = await getDb();
  return db.all('SELECT * FROM demo_articles');
}

export async function demoUpsert(id: number, json: string) {
  const db = await getDb();
  await db.run(
    'INSERT INTO demo_articles (id, json) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET json = EXCLUDED.json',
    [id, json]
  );
}

export async function demoDelete(id: number) {
  const db = await getDb();
  await db.run('DELETE FROM demo_articles WHERE id = $1', [id]);
}

export async function ensureDemoSeed(
  articles: { id: number; json: string }[],
  topics: { title: string; status: string; error?: string; error_step?: string }[]
) {
  const db = await getDb();
  const count = await db.get('SELECT COUNT(*) AS c FROM demo_articles');
  if (Number(count.c) > 0) return;
  for (const a of articles) await demoUpsert(a.id, a.json);
  const tCount = await db.get('SELECT COUNT(*) AS c FROM topics');
  if (Number(tCount.c) === 0) {
    for (let i = 0; i < topics.length; i++) {
      const t = topics[i];
      await db.run(
        `INSERT INTO topics (title, status, sort, created_at, started_at, error, error_step, attempts)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          t.title, t.status, i + 1, now(),
          t.status === 'writing' ? now() : null,
          t.error || null, t.error_step || null,
          t.status === 'failed' ? 2 : 0,
        ]
      );
    }
  }
}
