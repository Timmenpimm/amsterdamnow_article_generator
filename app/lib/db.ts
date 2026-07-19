import path from 'path';
import fs from 'fs';
import type { Topic, PromptVersion } from './types';

function readSeed(file: string): string {
  try {
    return fs.readFileSync(path.join(process.cwd(), 'seeds', file), 'utf8');
  } catch {
    return '(Seed-bestand ontbreekt in deze deployment — plak hier de oorspronkelijke prompt en sla op als nieuwe versie.)';
  }
}

// Opslaglaag met twee drivers:
// - Postgres (Supabase) zodra DATABASE_URL is gezet — persistent, voor Vercel
// - SQLite lokaal (op Vercel zonder DATABASE_URL: /tmp, níet persistent)
const PG_URL = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || process.env.POSTGRES_URL || '';

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
  const dir = process.env.VERCEL ? '/tmp/artikel-tool' : path.join(process.cwd(), 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'tool.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      sort REAL NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      error TEXT,
      error_step TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      post_id INTEGER
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
  `);
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
      post_id INTEGER
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
      return db;
    })();
  }
  return dbPromise;
}

async function seedPrompts(db: DB) {
  const row = await db.get('SELECT COUNT(*) AS c FROM prompts');
  if (Number(row.c) > 0) return;
  await db.run(
    `INSERT INTO prompts (kind, version, content, note, author, created_at, active) VALUES ($1, 1, $2, $3, 'import', $4, 1)`,
    ['schrijf', readSeed('schrijfprompt.txt'), 'Oorspronkelijke schrijf-prompt voor Claude.', now()]
  );
  await db.run(
    `INSERT INTO prompts (kind, version, content, note, author, created_at, active) VALUES ($1, 1, $2, $3, 'import', $4, 1)`,
    ['seo', readSeed('seoprompt.txt'), 'Oorspronkelijke SEO-prompt voor Claude.', now()]
  );
}

// ---------- topics ----------

export async function listTopics(): Promise<Topic[]> {
  const db = await getDb();
  return db.all(`SELECT * FROM topics WHERE status != 'done' ORDER BY (status = 'failed'), sort ASC`);
}

export async function addTopics(titles: string[]): Promise<{ added: Topic[]; skipped: string[] }> {
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
    const rec = await db.get(
      `INSERT INTO topics (title, status, sort, created_at) VALUES ($1, 'queued', $2, $3) RETURNING *`,
      [title, sort, now()]
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
  for (let i = 0; i < ids.length; i++) {
    await db.run('UPDATE topics SET sort = $1 WHERE id = $2', [i + 1, ids[i]]);
  }
}

export async function retryTopic(id: number) {
  const db = await getDb();
  const min = await db.get('SELECT COALESCE(MIN(sort), 1) AS m FROM topics');
  await db.run(
    `UPDATE topics SET status = 'queued', error = NULL, error_step = NULL, sort = $1 WHERE id = $2`,
    [Number(min.m) - 1, id]
  );
}

export async function claimNextTopic(): Promise<Topic | null> {
  const db = await getDb();
  const topic = await db.get(`SELECT * FROM topics WHERE status = 'queued' ORDER BY sort ASC LIMIT 1`);
  if (!topic) return null;
  await db.run(
    `UPDATE topics SET status = 'writing', started_at = $1, attempts = attempts + 1 WHERE id = $2`,
    [now(), topic.id]
  );
  return db.get('SELECT * FROM topics WHERE id = $1', [topic.id]);
}

export async function completeTopic(id: number, postId: number) {
  const db = await getDb();
  await db.run(`UPDATE topics SET status = 'done', post_id = $1 WHERE id = $2`, [postId, id]);
}

export async function failTopic(id: number, error: string, step: string) {
  const db = await getDb();
  await db.run(`UPDATE topics SET status = 'failed', error = $1, error_step = $2 WHERE id = $3`, [error, step, id]);
}

// ---------- prompts ----------

export async function listPrompts(kind: 'schrijf' | 'seo'): Promise<PromptVersion[]> {
  const db = await getDb();
  return db.all('SELECT * FROM prompts WHERE kind = $1 ORDER BY version DESC', [kind]);
}

export async function activePrompt(kind: 'schrijf' | 'seo'): Promise<PromptVersion> {
  const db = await getDb();
  const prompt = await db.get('SELECT * FROM prompts WHERE kind = $1 AND active = 1', [kind]);
  if (!prompt) throw new Error(`Geen actieve ${kind}-prompt gevonden`);
  return prompt as PromptVersion;
}

export async function savePromptVersion(kind: 'schrijf' | 'seo', content: string, note: string): Promise<PromptVersion> {
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
