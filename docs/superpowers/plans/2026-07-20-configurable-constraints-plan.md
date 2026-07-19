# Instelbare artikel-constraints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Alle redactionele checks die nu hardcoded in `app/lib/validation.ts` staan (woordaantallen, verboden woorden, quote-bronnen blacklist, quote-norm, aan/uit-regels) worden bewerkbaar via een nieuwe "Criteria"-tab in de Instellingen-pagina, met versiegeschiedenis en rollback zoals de bestaande prompt-editor.

**Architecture:** Een nieuwe `constraints`-tabel (zelfde vorm als de bestaande `prompts`-tabel) bewaart per `kind` (`standaard` | `lijst`) een JSON-blob met de constraint-waarden, geversioneerd. `validation.ts` wordt parameterloos-hardcoded → configuratie-gedreven: elke functie krijgt de actieve config als parameter. De Instellingen-UI krijgt een structured-form editor (number-inputs, tag-chips, toggles) naast de bestaande tekstarea-prompt-editor.

**Tech Stack:** Next.js 15 App Router, TypeScript, better-sqlite3 (lokaal) / pg (Vercel/Supabase), React 19, geen externe UI-library (inline styles + bestaande CSS-variabelen in `app/app/globals.css`).

## Global Constraints

- Standaardwaarden van elke nieuwe instelling zijn exact de huidige hardcoded waarden in `validation.ts` — het gedrag van de pipeline verandert niet totdat iemand bewust iets aanpast in de UI.
- Geen generieke/dynamische form-builder: het formulier is hardcoded per `kind` (`standaard` | `lijst`), gebaseerd op de twee interfaces uit Task 1.
- De bestaande `prompts`-tabel, -API en -editor blijven ongewijzigd naast de nieuwe Criteria-tab.
- UI-copy is Nederlands, direct, zonder jargon (bestaande stijl van de pagina aanhouden).
- Visuele stijl volgt de bestaande CSS-variabelen in `app/app/globals.css` (`--card`, `--soft`, `--border-light`, `--ink`, `--amber-bg`, etc.) — geen nieuwe kleuren/stijlen introduceren.
- **Geen testframework aanwezig in dit project** (geen jest/vitest, geen `test`-script in `package.json`). Verificatie per taak gebeurt via `npx tsc --noEmit` (typecheck), handmatige `curl`-calls tegen de lokale dev-server (`npm run dev`, poort 3400), en voor de UI-taken een browsercheck. Voeg geen testframework toe als onderdeel van dit plan — dat is niet gevraagd en buiten scope.

---

## Task 1: Types en standaardwaarden

**Files:**
- Modify: `app/lib/types.ts` (toevoegen aan het eind van het bestand)

**Interfaces:**
- Produces: `ConstraintKind`, `CONSTRAINT_KINDS`, `WordRange`, `StandaardConstraints`, `ListConstraints`, `ConstraintVersion`, `DEFAULT_STANDAARD_CONSTRAINTS`, `DEFAULT_LIST_CONSTRAINTS` — gebruikt door Task 2 (db), Task 3 (validation), Task 5 (API), Task 6/7 (UI).

- [ ] **Step 1: Voeg de nieuwe types en defaults toe aan `app/lib/types.ts`**

Voeg dit toe aan het eind van `app/lib/types.ts` (na de bestaande `PromptVersion`-interface):

```ts
export type ConstraintKind = 'standaard' | 'lijst';

export const CONSTRAINT_KINDS: ConstraintKind[] = ['standaard', 'lijst'];

export interface WordRange {
  min: number;
  max: number;
}

export interface StandaardConstraints {
  titleWords: WordRange;
  subregelWords: WordRange;
  introWords: WordRange;
  contentWords: WordRange;
  quoteWords: WordRange;
  minParagraphs: number;
  titleMustContainTopic: boolean;
  quoteMustBeVerbatimInContent: boolean;
  noDashInText: boolean;
  noAmsterdamRepeatInTitleSubregelIntro: boolean;
}

export interface ListConstraints {
  titleMaxChars: number;
  introSentences: WordRange;
  minItems: number;
  itemSentences: WordRange;
  quoteNormPerItems: number;
  minNamedItemsInClosing: number;
  forbiddenWords: string[];
  quoteSourceBlacklist: string[];
  titleNoCount: boolean;
  subregelNoVanTotFormula: boolean;
  subregelNoAmsterdamRepeat: boolean;
  noDashInText: boolean;
  noBulletsInItem: boolean;
  addressNotInDescription: boolean;
  itemRequiresAddress: boolean;
  itemRequiresBuurt: boolean;
  noConsecutiveQuotes: boolean;
}

export interface ConstraintVersion {
  id: number;
  kind: ConstraintKind;
  version: number;
  content: string; // JSON van StandaardConstraints of ListConstraints
  note: string;
  author: string;
  created_at: string;
  active: 0 | 1;
}

export const DEFAULT_STANDAARD_CONSTRAINTS: StandaardConstraints = {
  titleWords: { min: 8, max: 12 },
  subregelWords: { min: 10, max: 15 },
  introWords: { min: 40, max: 60 },
  contentWords: { min: 400, max: 450 },
  quoteWords: { min: 15, max: 25 },
  minParagraphs: 5,
  titleMustContainTopic: true,
  quoteMustBeVerbatimInContent: true,
  noDashInText: true,
  noAmsterdamRepeatInTitleSubregelIntro: true,
};

export const DEFAULT_LIST_CONSTRAINTS: ListConstraints = {
  titleMaxChars: 75,
  introSentences: { min: 2, max: 3 },
  minItems: 3,
  itemSentences: { min: 3, max: 5 },
  quoteNormPerItems: 3,
  minNamedItemsInClosing: 2,
  forbiddenWords: [
    'hotspot', 'pareltje', 'bruisend', 'iconisch',
    'elektronische muziek',
    'opent zijn deuren', 'verwelkomt gasten', 'biedt een unieke ervaring',
    'mis het niet', 'een aanrader voor iedereen',
  ],
  quoteSourceBlacklist: [
    'ylbb', 'your little black book', 'yourlittleblackbook',
    'bartsboekje', 'barts boekje',
    'iamsterdam',
    'time out', 'timeout',
    'cityguys', 'dagjeweg', 'awesome amsterdam', 'amsterdamlokaal', 'kidsproof', 'roadbook',
  ],
  titleNoCount: true,
  subregelNoVanTotFormula: true,
  subregelNoAmsterdamRepeat: true,
  noDashInText: true,
  noBulletsInItem: true,
  addressNotInDescription: true,
  itemRequiresAddress: true,
  itemRequiresBuurt: true,
  noConsecutiveQuotes: true,
};
```

- [ ] **Step 2: Typecheck**

Run: `cd app && npx tsc --noEmit`
Expected: geen fouten (nieuwe exports worden nog nergens gebruikt, dat is geen probleem in TS).

- [ ] **Step 3: Commit**

```bash
git add app/lib/types.ts
git commit -m "Add constraint types and defaults for configurable validation rules"
```

---

## Task 2: Database-laag voor constraints

**Files:**
- Modify: `app/lib/db.ts`

**Interfaces:**
- Consumes: `ConstraintKind`, `ConstraintVersion`, `StandaardConstraints`, `ListConstraints`, `DEFAULT_STANDAARD_CONSTRAINTS`, `DEFAULT_LIST_CONSTRAINTS` (Task 1).
- Produces: `listConstraints(kind: ConstraintKind): Promise<ConstraintVersion[]>`, `activeConstraints(kind: 'standaard'): Promise<StandaardConstraints>` / `activeConstraints(kind: 'lijst'): Promise<ListConstraints>`, `saveConstraintVersion(kind: ConstraintKind, content: StandaardConstraints | ListConstraints, note: string): Promise<ConstraintVersion>`, `activateConstraintVersion(id: number): Promise<ConstraintVersion | undefined>` — gebruikt door Task 4 (writer/listWriter) en Task 5 (API).

- [ ] **Step 1: Update de import bovenaan `app/lib/db.ts`**

Vervang:

```ts
import type { ListArticleStructure, ListState, PromptKind, Topic, PromptVersion } from './types';
```

door:

```ts
import type {
  ListArticleStructure, ListState, PromptKind, Topic, PromptVersion,
  ConstraintKind, ConstraintVersion, StandaardConstraints, ListConstraints,
} from './types';
import { DEFAULT_STANDAARD_CONSTRAINTS, DEFAULT_LIST_CONSTRAINTS } from './types';
```

- [ ] **Step 2: Voeg de `constraints`-tabel toe aan de SQLite-init**

In `initSqlite()`, in het bestaande `db.exec(\`...\`)`-blok (dat nu `topics`, `prompts`, `demo_articles` en `list_articles` aanmaakt), voeg vlak vóór de afsluitende backtick dit toe:

```sql
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
```

- [ ] **Step 3: Voeg de `constraints`-tabel toe aan de Postgres-init**

In `initPostgres()`, na het bestaande `pool.query` blok dat de `prompts`-tabel aanmaakt, voeg toe:

```ts
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
```

- [ ] **Step 4: Voeg een `seedConstraints`-functie toe**

Voeg toe direct na de bestaande `seedPrompts`-functie:

```ts
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
```

- [ ] **Step 5: Roep `seedConstraints` aan in `getDb()`**

Vervang in `getDb()`:

```ts
      const db = PG_URL ? await initPostgres() : await initSqlite();
      await seedPrompts(db);
      return db;
```

door:

```ts
      const db = PG_URL ? await initPostgres() : await initSqlite();
      await seedPrompts(db);
      await seedConstraints(db);
      return db;
```

- [ ] **Step 6: Voeg de CRUD-functies toe**

Voeg toe aan het eind van `app/lib/db.ts`, na de bestaande `activatePromptVersion`-functie (vóór de `// ---------- demo store ----------` sectie):

```ts
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
  return JSON.parse(row.content);
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
```

- [ ] **Step 7: Typecheck**

Run: `cd app && npx tsc --noEmit`
Expected: geen fouten.

- [ ] **Step 8: Commit**

```bash
git add app/lib/db.ts
git commit -m "Add constraints table with versioning, seeded from current defaults"
```

*(Functionele verificatie van deze laag — dat de tabel echt gevuld wordt en de CRUD-functies werken — gebeurt in Task 5 via de API-routes, omdat er geen testframework in dit project is opgezet.)*

---

## Task 3: `validation.ts` — hardcoded waarden vervangen door configuratie

**Files:**
- Modify: `app/lib/validation.ts`

**Interfaces:**
- Consumes: `StandaardConstraints`, `ListConstraints` (Task 1).
- Produces: `validateArticle(article: GeneratedArticle, topic: string, config: StandaardConstraints): void`, `validateListArticle(article: GeneratedListArticle, config: ListConstraints): string[]`, `quoteSourceAllowed(bron: string, blacklist: string[], herkomst?: string): boolean` — signatuur gewijzigd, gebruikt door Task 4.

- [ ] **Step 1: Vervang de volledige inhoud van `app/lib/validation.ts`**

```ts
import type { ListConstraints, StandaardConstraints } from './types';

export type GeneratedArticle = {
  title: string; subregel: string; introductie_tekst: string; content: string; quote: string;
};

function words(value: string) {
  return value.replace(/<[^>]*>/g, ' ').trim().split(/\s+/).filter(Boolean).length;
}

function normal(value: string) {
  return value.toLocaleLowerCase('nl-NL').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function range(label: string, value: string, min: number, max: number) {
  const count = words(value);
  if (count < min || count > max) throw new Error(`${label} moet ${min}-${max} woorden bevatten (nu ${count}).`);
}

// ---------- lijstartikelen ----------

export interface ListItemDraft {
  naam: string;
  beschrijving: string;
  adres: string;
  buurt: string;
  quote?: { tekst: string; bron: string } | null;
}

export interface GeneratedListArticle {
  title: string;
  subregel: string;
  introcontent: string;
  inleiding: string;
  items: ListItemDraft[];
  afsluiting: string;
}

function sentences(value: string): number {
  return value.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => s.length > 1).length;
}

function forbiddenIn(label: string, value: string, forbiddenWords: string[]) {
  const lower = value.toLocaleLowerCase('nl-NL');
  for (const word of forbiddenWords) {
    if (lower.includes(word)) throw new Error(`${label} bevat verboden formulering "${word}".`);
  }
}

export function quoteSourceAllowed(bron: string, blacklist: string[], herkomst = ''): boolean {
  const haystack = `${bron} ${herkomst}`.toLocaleLowerCase('nl-NL');
  return !blacklist.some(b => haystack.includes(b));
}

export function validateListArticle(article: GeneratedListArticle, config: ListConstraints): string[] {
  const meldingen: string[] = [];
  if (article.title.length > config.titleMaxChars) {
    throw new Error(`Titel is ${article.title.length} tekens; maximaal ${config.titleMaxChars}.`);
  }
  if (config.titleNoCount && /\b(twee|drie|vier|vijf|zes|zeven|acht|negen|tien|elf|twaalf|\d+)\s+(beste|leukste|mooiste|fijnste|lekkerste)\b/i.test(article.title)) {
    throw new Error('Titel mag geen aantal bevatten ("De 10 beste…"): de lijst kan later aangevuld worden.');
  }
  if (config.subregelNoVanTotFormula && /\bvan\s+\S+([^.]{0,30})\s+tot\s+/i.test(article.subregel)) {
    throw new Error('Subregel mag niet de vaste formule "van X tot Y" gebruiken.');
  }
  if (config.subregelNoAmsterdamRepeat && /\bamsterdam\b/i.test(article.title) && /\bamsterdam\b/i.test(article.subregel)) {
    throw new Error('Subregel mag "Amsterdam" niet herhalen als dat al in de titel staat.');
  }
  const introSentences = sentences(article.introcontent);
  if (introSentences < config.introSentences.min || introSentences > config.introSentences.max) {
    throw new Error(`Introcontent moet ${config.introSentences.min}-${config.introSentences.max} zinnen zijn (nu ${introSentences}).`);
  }
  if (article.items.length < config.minItems) {
    throw new Error(`Een lijstartikel heeft minimaal ${config.minItems} items (nu ${article.items.length}).`);
  }

  const allText = [article.title, article.subregel, article.introcontent, article.inleiding, article.afsluiting, ...article.items.map(i => i.beschrijving)].join('\n');
  forbiddenIn('Het artikel', allText, config.forbiddenWords);
  // Em/en-dash in lopende tekst verboden; het adres-streepje wordt pas bij de
  // HTML-assemblage toegevoegd en valt hier dus buiten.
  if (config.noDashInText && /[—–]/.test(allText)) throw new Error('Het artikel bevat een em-dash of en-dash in de lopende tekst.');

  let lastQuoteAt = -2;
  let quoteCount = 0;
  article.items.forEach((item, i) => {
    const s = sentences(item.beschrijving);
    if (s < config.itemSentences.min || s > config.itemSentences.max) {
      throw new Error(`Item "${item.naam}" heeft ${s} zinnen; het moeten er ${config.itemSentences.min}-${config.itemSentences.max} zijn.`);
    }
    if (config.noBulletsInItem && /[•\-*]\s/m.test(item.beschrijving.trimStart()) && /\n/.test(item.beschrijving)) {
      throw new Error(`Item "${item.naam}" bevat een opsomming; schrijf lopende tekst.`);
    }
    if (config.itemRequiresAddress && !item.adres?.trim()) throw new Error(`Item "${item.naam}" heeft geen adres.`);
    if (config.itemRequiresBuurt && !item.buurt?.trim()) throw new Error(`Item "${item.naam}" heeft geen buurt.`);
    if (config.addressNotInDescription && item.adres && new RegExp(item.adres.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(item.beschrijving)) {
      throw new Error(`Item "${item.naam}": het adres hoort niet in de beschrijving.`);
    }
    if (item.quote) {
      if (!quoteSourceAllowed(item.quote.bron, config.quoteSourceBlacklist)) {
        throw new Error(`Quote bij "${item.naam}" komt van een concurrerende stadsgids; dat mag niet.`);
      }
      if (config.noConsecutiveQuotes && i === lastQuoteAt + 1) throw new Error('Twee quotes bij opeenvolgende items; verspreid ze door het artikel.');
      lastQuoteAt = i;
      quoteCount += 1;
    }
  });

  const quoteNorm = Math.floor(article.items.length / config.quoteNormPerItems);
  if (quoteNorm > 0 && quoteCount < quoteNorm) {
    meldingen.push(`Quote-norm niet gehaald: ${quoteCount} quote${quoteCount === 1 ? '' : 's'} bij ${article.items.length} items (norm: minimaal ${quoteNorm}). Voeg eventueel handmatig een geverifieerde quote toe in WordPress.`);
  }

  const namedInClosing = article.items.filter(i => article.afsluiting.toLocaleLowerCase('nl-NL').includes(i.naam.toLocaleLowerCase('nl-NL').split(' ')[0])).length;
  if (namedInClosing < config.minNamedItemsInClosing) {
    meldingen.push('De afsluiting combineert minder dan twee items bij naam; check of het slot concreet genoeg is.');
  }
  return meldingen;
}

export function validateArticle(article: GeneratedArticle, topic: string, config: StandaardConstraints) {
  range('Titel', article.title, config.titleWords.min, config.titleWords.max);
  range('Subregel', article.subregel, config.subregelWords.min, config.subregelWords.max);
  range('Introductie', article.introductie_tekst, config.introWords.min, config.introWords.max);
  range('Artikeltekst', article.content, config.contentWords.min, config.contentWords.max);
  range('Quote', article.quote, config.quoteWords.min, config.quoteWords.max);
  if (config.titleMustContainTopic && !normal(article.title).includes(normal(topic))) {
    throw new Error('De titel moet de naam van het onderwerp bevatten.');
  }
  if (config.quoteMustBeVerbatimInContent && !normal(article.content).includes(normal(article.quote))) {
    throw new Error('De quote moet letterlijk in de artikeltekst voorkomen.');
  }
  if (config.noDashInText && [article.title, article.subregel, article.introductie_tekst, article.content, article.quote].some(v => /[—–]/.test(v))) {
    throw new Error('Een artikel mag geen em dash of en dash bevatten.');
  }
  if (config.noAmsterdamRepeatInTitleSubregelIntro && /\bAmsterdam\b/i.test(`${article.title} ${article.subregel} ${article.introductie_tekst}`)) {
    throw new Error('Amsterdam mag niet in titel, subregel of introductie staan.');
  }
  if (article.content.split(/\n\s*\n/).filter(Boolean).length < config.minParagraphs) {
    throw new Error(`Artikeltekst moet uit minimaal ${config.minParagraphs} alinea's bestaan.`);
  }
}
```

- [ ] **Step 2: Typecheck (verwacht fouten in de callers — dat is de bedoeling)**

Run: `cd app && npx tsc --noEmit`
Expected: FAIL, met fouten in `lib/writer.ts` en `lib/listWriter.ts` (`Expected 3 arguments, but got 2` bij `validateArticle` en `validateListArticle`, en bij `quoteSourceAllowed`). Dit bevestigt dat de callers nog moeten worden bijgewerkt — dat gebeurt in Task 4.

- [ ] **Step 3: Commit**

```bash
git add app/lib/validation.ts
git commit -m "Parameterize validation.ts checks with a constraints config"
```

---

## Task 4: Configuratie doorgeven vanuit writer.ts en listWriter.ts

**Files:**
- Modify: `app/lib/writer.ts`
- Modify: `app/lib/listWriter.ts`

**Interfaces:**
- Consumes: `activeConstraints('standaard')`, `activeConstraints('lijst')` (Task 2); `validateArticle(article, topic, config)`, `validateListArticle(article, config)`, `quoteSourceAllowed(bron, blacklist, herkomst?)` (Task 3).

- [ ] **Step 1: Update `app/lib/writer.ts`**

Vervang:

```ts
import { activePrompt, claimNextTopic, completeTopic, failTopic } from './db';
```

door:

```ts
import { activeConstraints, activePrompt, claimNextTopic, completeTopic, failTopic } from './db';
```

Vervang:

```ts
    const [researchPrompt, writePrompt, seoPrompt, taxonomies] = await Promise.all([
      activePrompt('research'), activePrompt('schrijf'), activePrompt('seo'), taxonomyChoices(),
    ]);
```

door:

```ts
    const [researchPrompt, writePrompt, seoPrompt, taxonomies, constraints] = await Promise.all([
      activePrompt('research'), activePrompt('schrijf'), activePrompt('seo'), taxonomyChoices(), activeConstraints('standaard'),
    ]);
```

Vervang:

```ts
    validateArticle({ title, subregel, introductie_tekst: intro, content, quote }, topic.title);
```

door:

```ts
    validateArticle({ title, subregel, introductie_tekst: intro, content, quote }, topic.title, constraints);
```

- [ ] **Step 2: Update `app/lib/listWriter.ts` — imports**

Vervang:

```ts
import {
  activeListTopic, activePrompt, claimNextListTopic, completeTopic, failTopic,
  getTopic, saveListProgress, saveListStructure,
} from './db';
```

door:

```ts
import {
  activeConstraints, activeListTopic, activePrompt, claimNextListTopic, completeTopic, failTopic,
  getTopic, saveListProgress, saveListStructure,
} from './db';
```

- [ ] **Step 3: Update `stepVerify` om de blacklist mee te geven**

Vervang de openingsregel van `stepVerify`:

```ts
async function stepVerify(topic: Topic): Promise<ListStepResult> {
  const s = state(topic);
  const pending = s.items.filter(i => i.status === 'pending').slice(0, VERIFY_PER_TICK);
```

door:

```ts
async function stepVerify(topic: Topic): Promise<ListStepResult> {
  const s = state(topic);
  const constraints = await activeConstraints('lijst');
  const pending = s.items.filter(i => i.status === 'pending').slice(0, VERIFY_PER_TICK);
```

Vervang binnen dezelfde functie:

```ts
      item.quote = q && str(q.tekst) && str(q.bron) && quoteSourceAllowed(str(q.bron), str(q.herkomst))
        ? { tekst: str(q.tekst), bron: str(q.bron), herkomst: str(q.herkomst) || undefined }
        : null;
```

door:

```ts
      item.quote = q && str(q.tekst) && str(q.bron) && quoteSourceAllowed(str(q.bron), constraints.quoteSourceBlacklist, str(q.herkomst))
        ? { tekst: str(q.tekst), bron: str(q.bron), herkomst: str(q.herkomst) || undefined }
        : null;
```

- [ ] **Step 4: Update `stepCompose` om de constraints mee te geven aan `validateListArticle`**

Vervang de openingsregel van `stepCompose`:

```ts
async function stepCompose(topic: Topic): Promise<ListStepResult> {
  const s = state(topic);
  const verified = s.items.filter(i => i.status === 'verified');
  if (verified.length < 3) throw new Error('Minder dan 3 goedgekeurde items over; artikel niet te schrijven.');
  const [prompt, taxonomies] = await Promise.all([activePrompt('lijst-schrijf'), taxonomyChoices()]);
```

door:

```ts
async function stepCompose(topic: Topic): Promise<ListStepResult> {
  const s = state(topic);
  const verified = s.items.filter(i => i.status === 'verified');
  if (verified.length < 3) throw new Error('Minder dan 3 goedgekeurde items over; artikel niet te schrijven.');
  const [prompt, taxonomies, constraints] = await Promise.all([
    activePrompt('lijst-schrijf'), taxonomyChoices(), activeConstraints('lijst'),
  ]);
```

Vervang:

```ts
  const validated = toValidated(composed, verified);
  const meldingen = validateListArticle(validated);
```

door:

```ts
  const validated = toValidated(composed, verified);
  const meldingen = validateListArticle(validated, constraints);
```

- [ ] **Step 5: Typecheck**

Run: `cd app && npx tsc --noEmit`
Expected: geen fouten meer (de fouten uit Task 3, Step 2 zijn nu opgelost).

- [ ] **Step 6: Commit**

```bash
git add app/lib/writer.ts app/lib/listWriter.ts
git commit -m "Fetch active constraints and pass them into validation calls"
```

---

## Task 5: API-routes voor constraints

**Files:**
- Create: `app/app/api/constraints/route.ts`
- Create: `app/app/api/constraints/[id]/activate/route.ts`

**Interfaces:**
- Consumes: `listConstraints`, `saveConstraintVersion`, `activateConstraintVersion` (Task 2), `CONSTRAINT_KINDS`, `ConstraintKind` (Task 1).

- [ ] **Step 1: Maak `app/app/api/constraints/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { listConstraints, saveConstraintVersion } from '@/lib/db';
import { CONSTRAINT_KINDS, type ConstraintKind } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const rawKind = req.nextUrl.searchParams.get('kind') as ConstraintKind | null;
  const kind = rawKind && CONSTRAINT_KINDS.includes(rawKind) ? rawKind : 'standaard';
  return NextResponse.json({ versions: await listConstraints(kind) });
}

export async function POST(req: NextRequest) {
  const { kind, content, note } = await req.json();
  if (!content || !CONSTRAINT_KINDS.includes(kind)) {
    return NextResponse.json({ error: 'kind en content verplicht' }, { status: 400 });
  }
  const version = await saveConstraintVersion(kind, content, String(note || ''));
  return NextResponse.json({ version });
}
```

- [ ] **Step 2: Maak `app/app/api/constraints/[id]/activate/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { activateConstraintVersion } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const version = await activateConstraintVersion(Number(id));
  if (!version) return NextResponse.json({ error: 'niet gevonden' }, { status: 404 });
  return NextResponse.json({ version });
}
```

- [ ] **Step 3: Start de dev-server**

Run: `cd app && npm run dev`
Expected: server draait op `http://localhost:3400` (wacht tot "Ready" verschijnt in de output; laat de server draaien voor de volgende stappen).

- [ ] **Step 4: Verifieer dat de constraints geseed zijn**

Run: `curl -s 'http://localhost:3400/api/constraints?kind=lijst' | head -c 400`
Expected: JSON met `"versions":[{"id":...,"kind":"lijst","version":1,"content":"{\"titleMaxChars\":75,...`

- [ ] **Step 5: Verifieer opslaan van een nieuwe versie**

Run:
```bash
curl -s -X POST http://localhost:3400/api/constraints \
  -H 'Content-Type: application/json' \
  -d '{"kind":"lijst","content":{"titleMaxChars":80,"introSentences":{"min":2,"max":3},"minItems":3,"itemSentences":{"min":3,"max":5},"quoteNormPerItems":3,"minNamedItemsInClosing":2,"forbiddenWords":["hotspot"],"quoteSourceBlacklist":["iamsterdam"],"titleNoCount":true,"subregelNoVanTotFormula":true,"subregelNoAmsterdamRepeat":true,"noDashInText":true,"noBulletsInItem":true,"addressNotInDescription":true,"itemRequiresAddress":true,"itemRequiresBuurt":true,"noConsecutiveQuotes":true},"note":"test"}'
```
Expected: JSON met `"version":{"id":...,"kind":"lijst","version":2,...,"active":1}`

- [ ] **Step 6: Verifieer rollback**

Run: `curl -s -X POST http://localhost:3400/api/constraints/1/activate | head -c 200`
(vervang `1` door het echte `id` van v1 uit Step 4 als dat anders is)
Expected: JSON met `"version":{"id":1,...,"version":1,...,"active":1}`

- [ ] **Step 7: Commit**

```bash
git add app/app/api/constraints
git commit -m "Add API routes for reading and versioning constraints"
```

---

## Task 6: Veld-definities voor het Criteria-formulier

**Files:**
- Create: `app/app/instellingen/criteria-fields.ts`

**Interfaces:**
- Consumes: `StandaardConstraints`, `ListConstraints` (Task 1).
- Produces: `FieldDef<C>`, `STANDAARD_FIELDS`, `LIST_FIELDS` — gebruikt door Task 7 (`CriteriaEditor`).

- [ ] **Step 1: Maak `app/app/instellingen/criteria-fields.ts`**

```ts
import type { ListConstraints, StandaardConstraints } from '@/lib/types';

export interface RangeFieldDef<C> { type: 'range'; key: keyof C; label: string; unit: string; }
export interface NumberFieldDef<C> { type: 'number'; key: keyof C; label: string; unit: string; }
export interface TagsFieldDef<C> { type: 'tags'; key: keyof C; label: string; hint: string; placeholder: string; }
export interface ToggleFieldDef<C> { type: 'toggle'; key: keyof C; label: string; hint: string; }

export type FieldDef<C> = RangeFieldDef<C> | NumberFieldDef<C> | TagsFieldDef<C> | ToggleFieldDef<C>;

export const STANDAARD_FIELDS: { section: string; fields: FieldDef<StandaardConstraints>[] }[] = [
  {
    section: 'Lengtes / aantallen',
    fields: [
      { type: 'range', key: 'titleWords', label: 'Titel', unit: 'woorden' },
      { type: 'range', key: 'subregelWords', label: 'Subregel', unit: 'woorden' },
      { type: 'range', key: 'introWords', label: 'Introductie', unit: 'woorden' },
      { type: 'range', key: 'contentWords', label: 'Artikeltekst', unit: 'woorden' },
      { type: 'range', key: 'quoteWords', label: 'Quote', unit: 'woorden' },
      { type: 'number', key: 'minParagraphs', label: "Minimum aantal alinea's", unit: "alinea's" },
    ],
  },
  {
    section: 'Redactionele regels',
    fields: [
      { type: 'toggle', key: 'titleMustContainTopic', label: 'Titel moet het onderwerp bevatten', hint: 'Voorkomt een titel die niets met het onderwerp te maken heeft.' },
      { type: 'toggle', key: 'quoteMustBeVerbatimInContent', label: 'Quote moet letterlijk in de artikeltekst voorkomen', hint: 'Voorkomt dat Claude een quote verzint die niet matcht met de lopende tekst.' },
      { type: 'toggle', key: 'noDashInText', label: 'Geen em-/en-dash toegestaan', hint: 'Houdt de schrijfstijl consistent met de rest van de site.' },
      { type: 'toggle', key: 'noAmsterdamRepeatInTitleSubregelIntro', label: '"Amsterdam" niet in titel, subregel of introductie', hint: 'Voorkomt overbodige herhaling; de site heet al Amsterdam Now.' },
    ],
  },
];

export const LIST_FIELDS: { section: string; fields: FieldDef<ListConstraints>[] }[] = [
  {
    section: 'Lengtes / aantallen',
    fields: [
      { type: 'number', key: 'titleMaxChars', label: 'Titel — max. lengte', unit: 'tekens' },
      { type: 'range', key: 'introSentences', label: 'Introcontent', unit: 'zinnen' },
      { type: 'number', key: 'minItems', label: 'Minimum aantal items', unit: 'items' },
      { type: 'range', key: 'itemSentences', label: 'Itembeschrijving', unit: 'zinnen' },
      { type: 'number', key: 'quoteNormPerItems', label: 'Quote-norm — 1 quote per', unit: 'items' },
      { type: 'number', key: 'minNamedItemsInClosing', label: 'Min. genoemde items in afsluiting', unit: 'items' },
    ],
  },
  {
    section: 'Verboden woorden',
    fields: [
      { type: 'tags', key: 'forbiddenWords', label: 'Verboden woorden', hint: 'Claude vermijdt deze woorden en uitdrukkingen volledig in lijstartikelen.', placeholder: '+ woord toevoegen & Enter' },
    ],
  },
  {
    section: 'Quote-bronnen blacklist',
    fields: [
      { type: 'tags', key: 'quoteSourceBlacklist', label: 'Quote-bronnen blacklist', hint: 'Quotes afkomstig van deze domeinen/bronnen worden niet overgenomen.', placeholder: '+ domein & Enter' },
    ],
  },
  {
    section: 'Redactionele regels',
    fields: [
      { type: 'toggle', key: 'titleNoCount', label: 'Titel mag geen aantal bevatten ("De 10 beste…")', hint: 'De lijst kan later aangevuld worden, dus geen vast getal in de kop.' },
      { type: 'toggle', key: 'subregelNoVanTotFormula', label: 'Subregel: geen vaste formule "van X tot Y"', hint: 'Voorkomt een sjabloon-achtige subregel.' },
      { type: 'toggle', key: 'subregelNoAmsterdamRepeat', label: 'Subregel herhaalt "Amsterdam" niet als dat al in de titel staat', hint: 'Voorkomt overbodige herhaling.' },
      { type: 'toggle', key: 'noDashInText', label: 'Geen em-/en-dash in lopende tekst', hint: 'Houdt de schrijfstijl consistent met de rest van de site.' },
      { type: 'toggle', key: 'noBulletsInItem', label: 'Item mag geen opsomming bevatten', hint: 'Itembeschrijvingen moeten lopende tekst zijn, geen bullet-lijst.' },
      { type: 'toggle', key: 'addressNotInDescription', label: 'Adres mag niet in de itembeschrijving staan', hint: 'Het adres wordt apart getoond; herhaling in de tekst oogt raar.' },
      { type: 'toggle', key: 'itemRequiresAddress', label: 'Item moet een adres hebben', hint: 'Item wordt overgeslagen als het adres ontbreekt in de research.' },
      { type: 'toggle', key: 'itemRequiresBuurt', label: 'Item moet een buurt hebben', hint: 'Item wordt overgeslagen als de buurt ontbreekt in de research.' },
      { type: 'toggle', key: 'noConsecutiveQuotes', label: 'Niet twee quotes bij opeenvolgende items', hint: 'Spreidt quotes door het artikel in plaats van ze te clusteren.' },
    ],
  },
];
```

- [ ] **Step 2: Typecheck**

Run: `cd app && npx tsc --noEmit`
Expected: geen fouten.

- [ ] **Step 3: Commit**

```bash
git add app/app/instellingen/criteria-fields.ts
git commit -m "Add declarative field definitions for the Criteria settings form"
```

---

## Task 7: `CriteriaEditor`-component

**Files:**
- Create: `app/app/instellingen/CriteriaEditor.tsx`

**Interfaces:**
- Consumes: `/api/constraints` (Task 5), `STANDAARD_FIELDS`, `LIST_FIELDS`, `FieldDef` (Task 6), `ConstraintKind`, `ConstraintVersion` (Task 1).
- Produces: `CriteriaEditor({ kind: ConstraintKind })` React-component — gebruikt door Task 8.

- [ ] **Step 1: Maak `app/app/instellingen/CriteriaEditor.tsx`**

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from '@/components/toast';
import type { ConstraintKind, ConstraintVersion } from '@/lib/types';
import { STANDAARD_FIELDS, LIST_FIELDS, type FieldDef } from './criteria-fields';

const FIELD_GROUPS: Record<ConstraintKind, { section: string; fields: FieldDef<any>[] }[]> = {
  standaard: STANDAARD_FIELDS,
  lijst: LIST_FIELDS,
};

function parse(content: string): Record<string, any> {
  return JSON.parse(content);
}

export default function CriteriaEditor({ kind }: { kind: ConstraintKind }) {
  const [versions, setVersions] = useState<ConstraintVersion[]>([]);
  const [draft, setDraft] = useState<Record<string, any> | null>(null);
  const [viewing, setViewing] = useState<ConstraintVersion | null>(null);
  const [busy, setBusy] = useState(false);

  const active = versions.find(v => v.active === 1);
  const activeContent = active ? parse(active.content) : null;
  const dirty = Boolean(!viewing && active && draft && JSON.stringify(draft) !== JSON.stringify(activeContent));

  const load = useCallback(async (k: ConstraintKind) => {
    const res = await fetch(`/api/constraints?kind=${k}`);
    const data = await res.json();
    setVersions(data.versions);
    const act = (data.versions as ConstraintVersion[]).find(v => v.active === 1);
    setDraft(act ? parse(act.content) : null);
    setViewing(null);
  }, []);

  useEffect(() => { load(kind); }, [kind, load]);

  function updateField(key: string, value: any) {
    setDraft(prev => (prev ? { ...prev, [key]: value } : prev));
  }

  async function save() {
    if (!dirty || busy || !draft) return;
    const note = prompt('Korte omschrijving van de wijziging (voor de versiegeschiedenis):') || '';
    setBusy(true);
    try {
      await fetch('/api/constraints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, content: draft, note }),
      });
      toast(`Opgeslagen als v${(active?.version || 0) + 1} — geldt vanaf het volgende artikel`);
      load(kind);
    } finally {
      setBusy(false);
    }
  }

  async function rollback(v: ConstraintVersion) {
    if (!confirm(`v${v.version} terugzetten als actieve versie?`)) return;
    await fetch(`/api/constraints/${v.id}/activate`, { method: 'POST' });
    toast(`v${v.version} is nu actief`);
    load(kind);
  }

  if (!draft) return null;
  const shown = viewing ? parse(viewing.content) : draft;
  const groups = FIELD_GROUPS[kind];

  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      <div style={{ flex: 1, minWidth: 0, padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 18, background: 'var(--card)', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          {active && (
            <span className="chip-green" style={{ fontSize: 12 }}>
              v{active.version} · actief
            </span>
          )}
        </div>

        {viewing && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--soft)', border: '1px solid var(--border-light)', borderRadius: 8, padding: '9px 14px', fontSize: 12.5 }}>
            <span>Je bekijkt <b>v{viewing.version}</b> (alleen-lezen).</span>
            <button className="btn-small" style={{ marginLeft: 'auto' }} onClick={() => setViewing(null)}>Terug naar actieve versie</button>
            <button className="btn-primary" style={{ fontSize: 12.5, padding: '7px 14px' }} onClick={() => rollback(viewing)}>Terugzetten als actief</button>
          </div>
        )}

        {groups.map(group => (
          <div key={group.section} style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--border-light)', paddingTop: 16 }}>
            <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--gray)' }}>
              {group.section}
            </div>
            {group.fields.map(field => (
              <FieldRow
                key={String(field.key)}
                field={field}
                value={shown[field.key as string]}
                readOnly={Boolean(viewing)}
                onChange={value => updateField(field.key as string, value)}
              />
            ))}
          </div>
        ))}

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, borderTop: '1px solid var(--border-light)', padding: '14px 0 4px', marginTop: 'auto' }}>
          <span style={{ fontSize: 12.5, color: 'var(--gray)' }}>
            {active
              ? `Laatst gewijzigd ${new Date(active.created_at.replace(' ', 'T')).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })} · ${active.author}`
              : 'Nog geen versie'}
          </span>
          <button className="btn" style={{ marginLeft: 'auto' }} disabled={!dirty} onClick={() => setDraft(activeContent)}>
            Wijzigingen verwerpen
          </button>
          <button className="btn-primary" disabled={!dirty || busy} onClick={save}>
            {dirty ? `Opslaan als v${(active?.version || 0) + 1}` : 'Geen wijzigingen'}
          </button>
        </div>
      </div>

      <div
        style={{
          width: 340, flexShrink: 0, borderLeft: '1px solid var(--border-light)', background: 'var(--sidebar)',
          padding: 20, display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto',
        }}
        className="desktop-only-flex"
      >
        <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--gray)' }}>
          Versiegeschiedenis
        </div>
        {versions.map(v => (
          <div
            key={v.id}
            style={{
              background: 'var(--card)', borderRadius: 8, padding: '12px 14px',
              border: v.active ? '1.5px solid var(--ink)' : '1px solid var(--border-light)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 800 }}>v{v.version}</span>
              {v.active === 1 && <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--green-dark)' }}>actief</span>}
              <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--muted)' }}>
                {new Date(v.created_at.replace(' ', 'T')).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })} · {v.author}
              </span>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-soft)', marginTop: 5, lineHeight: 1.45 }}>
              {v.note || 'Geen omschrijving'}
            </div>
            {v.active !== 1 && (
              <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 12, fontWeight: 600 }}>
                <span style={{ textDecoration: 'underline', cursor: 'pointer' }} onClick={() => setViewing(v)}>Bekijk</span>
                <span style={{ textDecoration: 'underline', cursor: 'pointer' }} onClick={() => rollback(v)}>Terugzetten</span>
              </div>
            )}
          </div>
        ))}
        <div
          style={{
            background: 'var(--amber-bg)', border: '1px solid var(--amber-border)', borderRadius: 8,
            padding: '12px 14px', fontSize: 12.5, lineHeight: 1.5, color: 'var(--amber-dark)',
          }}
        >
          <span style={{ fontWeight: 800 }}>Let op:</span> deze criteria gelden voor élk volgend artikel. Check na een wijziging het eerstvolgende draft-artikel extra goed.
        </div>
      </div>
    </div>
  );
}

function FieldRow({ field, value, readOnly, onChange }: { field: FieldDef<any>; value: any; readOnly: boolean; onChange: (value: any) => void }) {
  if (field.type === 'range') {
    const r = value as { min: number; max: number };
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--border-light)' }}>
        <span style={{ fontSize: 13.5, fontWeight: 500, flex: 1 }}>{field.label}</span>
        <input
          type="number"
          value={r.min}
          disabled={readOnly}
          onChange={e => onChange({ ...r, min: Number(e.target.value) })}
          style={{ width: 58, textAlign: 'center', fontSize: 13.5, fontWeight: 600, border: '1px solid var(--border)', borderRadius: 7, padding: '6px 0' }}
        />
        <span style={{ fontSize: 12.5, color: 'var(--gray)' }}>t/m</span>
        <input
          type="number"
          value={r.max}
          disabled={readOnly}
          onChange={e => onChange({ ...r, max: Number(e.target.value) })}
          style={{ width: 58, textAlign: 'center', fontSize: 13.5, fontWeight: 600, border: '1px solid var(--border)', borderRadius: 7, padding: '6px 0' }}
        />
        <span style={{ fontSize: 12.5, color: 'var(--gray)', width: 60 }}>{field.unit}</span>
      </div>
    );
  }

  if (field.type === 'number') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--border-light)' }}>
        <span style={{ fontSize: 13.5, fontWeight: 500, flex: 1 }}>{field.label}</span>
        <input
          type="number"
          value={value as number}
          disabled={readOnly}
          onChange={e => onChange(Number(e.target.value))}
          style={{ width: 58, textAlign: 'center', fontSize: 13.5, fontWeight: 600, border: '1px solid var(--border)', borderRadius: 7, padding: '6px 0' }}
        />
        <span style={{ fontSize: 12.5, color: 'var(--gray)', width: 84 }}>{field.unit}</span>
      </div>
    );
  }

  if (field.type === 'tags') {
    const tags = value as string[];
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 12.5, color: 'var(--gray)', lineHeight: 1.45 }}>{field.hint}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {tags.map((tag, i) => (
            <span key={tag} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, background: 'var(--soft)', borderRadius: 5, padding: '4px 8px' }}>
              {tag}
              {!readOnly && (
                <span style={{ color: 'var(--muted)', cursor: 'pointer', fontSize: 12 }} onClick={() => onChange(tags.filter((_, j) => j !== i))}>
                  ✕
                </span>
              )}
            </span>
          ))}
          {!readOnly && (
            <input
              placeholder={field.placeholder}
              onKeyDown={e => {
                if (e.key !== 'Enter') return;
                const el = e.currentTarget;
                const next = el.value.trim();
                if (next) onChange([...tags, next]);
                el.value = '';
              }}
              style={{
                fontSize: 12.5, color: 'var(--gray)', border: '1px dashed var(--faint)', borderRadius: 5,
                padding: '4px 10px', background: 'transparent', minWidth: 160,
              }}
            />
          )}
        </div>
      </div>
    );
  }

  const on = Boolean(value);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, padding: '11px 0', borderBottom: '1px solid var(--border-light)' }}>
      <button
        onClick={() => !readOnly && onChange(!on)}
        disabled={readOnly}
        style={{
          width: 34, height: 20, borderRadius: 999, border: 'none', position: 'relative', flexShrink: 0, marginTop: 1,
          background: on ? 'var(--ink)' : 'var(--border)', cursor: readOnly ? 'default' : 'pointer', padding: 0,
        }}
      >
        <span style={{ position: 'absolute', top: 2, left: on ? 16 : 2, width: 16, height: 16, borderRadius: '50%', background: '#fff' }} />
      </button>
      <div>
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>{field.label}</div>
        <div style={{ fontSize: 12.5, color: 'var(--gray)', lineHeight: 1.45, marginTop: 2 }}>{field.hint}</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd app && npx tsc --noEmit`
Expected: geen fouten (component wordt in deze taak nog nergens geïmporteerd, dat is geen probleem).

- [ ] **Step 3: Commit**

```bash
git add app/app/instellingen/CriteriaEditor.tsx
git commit -m "Add structured-form editor for constraint criteria"
```

---

## Task 8: `PromptEditor` uitfactoren en de Instellingen-pagina herschrijven

**Files:**
- Create: `app/app/instellingen/PromptEditor.tsx`
- Modify: `app/app/instellingen/page.tsx`

**Interfaces:**
- Consumes: `CriteriaEditor` (Task 7), bestaande `/api/prompts`-routes (ongewijzigd).
- Produces: `PromptEditor({ kind: PromptKind })` React-component; herschreven `Instellingen`-pagina die tussen `PromptEditor` en `CriteriaEditor` schakelt.

- [ ] **Step 1: Maak `app/app/instellingen/PromptEditor.tsx`**

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from '@/components/toast';
import type { PromptKind, PromptVersion } from '@/lib/types';

const VARS: Record<PromptKind, string[]> = {
  research: ['{{onderwerp}}', '{{tavily_bronnen}}', '{{categorieën}}', '{{districten}}'],
  schrijf: ['{{onderwerp}}', '{{research}}', '{{categorieën}}', '{{districten}}'],
  seo: ['{{post_title}}', '{{post_content}}', '{{category}}', '{{district}}'],
  'lijst-selectie': ['{{thema}}', '{{tavily_bronnen}}'],
  'lijst-research': ['{{thema}}', '{{item}}', '{{tavily_bronnen}}', '{{doelweekend}}'],
  'lijst-schrijf': ['{{thema}}', '{{items_research}}', '{{categorieën}}', '{{districten}}'],
  'lijst-seo': ['{{titel}}', '{{intro}}', '{{items}}'],
};

export default function PromptEditor({ kind }: { kind: PromptKind }) {
  const [versions, setVersions] = useState<PromptVersion[]>([]);
  const [content, setContent] = useState('');
  const [viewing, setViewing] = useState<PromptVersion | null>(null);
  const [busy, setBusy] = useState(false);

  const active = versions.find(v => v.active === 1);
  const dirty = !viewing && active && content !== active.content;

  const load = useCallback(async (k: PromptKind) => {
    const res = await fetch(`/api/prompts?kind=${k}`);
    const data = await res.json();
    setVersions(data.versions);
    const act = (data.versions as PromptVersion[]).find(v => v.active === 1);
    setContent(act?.content || '');
    setViewing(null);
  }, []);

  useEffect(() => { load(kind); }, [kind, load]);

  async function save() {
    if (!dirty || busy) return;
    const note = prompt('Korte omschrijving van de wijziging (voor de versiegeschiedenis):') || '';
    setBusy(true);
    try {
      await fetch('/api/prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, content, note }),
      });
      toast(`Opgeslagen als v${(active?.version || 0) + 1} — geldt vanaf het volgende Claude-artikel`);
      load(kind);
    } finally {
      setBusy(false);
    }
  }

  async function rollback(v: PromptVersion) {
    if (!confirm(`v${v.version} terugzetten als actieve prompt?`)) return;
    await fetch(`/api/prompts/${v.id}/activate`, { method: 'POST' });
    toast(`v${v.version} is nu actief`);
    load(kind);
  }

  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      <div style={{ flex: 1, minWidth: 0, padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14, background: 'var(--card)' }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          {active && (
            <span className="chip-green" style={{ fontSize: 12 }}>
              v{active.version} · actief
            </span>
          )}
        </div>

        {viewing && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--soft)', border: '1px solid var(--border-light)', borderRadius: 8, padding: '9px 14px', fontSize: 12.5 }}>
            <span>Je bekijkt <b>v{viewing.version}</b> (alleen-lezen).</span>
            <button className="btn-small" style={{ marginLeft: 'auto' }} onClick={() => { setViewing(null); setContent(active?.content || ''); }}>
              Terug naar actieve versie
            </button>
            <button className="btn-primary" style={{ fontSize: 12.5, padding: '7px 14px' }} onClick={() => rollback(viewing)}>
              Terugzetten als actief
            </button>
          </div>
        )}

        <textarea
          className="prompt-editor"
          style={{ flex: 1, minHeight: 380 }}
          value={viewing ? viewing.content : content}
          readOnly={Boolean(viewing)}
          onChange={e => setContent(e.target.value)}
          spellCheck={false}
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: 'var(--gray)', fontWeight: 600 }}>Variabelen — Claude vult deze bij elke run in:</span>
          {VARS[kind].map(v => (
            <span
              key={v}
              style={{
                fontFamily: 'var(--mono)', fontSize: 11.5, fontWeight: 600, background: 'var(--soft)',
                border: '1px solid var(--border-light)', padding: '3px 8px', borderRadius: 5,
              }}
            >
              {v}
            </span>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, borderTop: '1px solid var(--border-light)', padding: '14px 0 4px' }}>
          <span style={{ fontSize: 12.5, color: 'var(--gray)' }}>
            {active
              ? `Laatst gewijzigd ${new Date(active.created_at.replace(' ', 'T')).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })} · ${active.author}`
              : 'Nog geen versie'}
          </span>
          <button className="btn" style={{ marginLeft: 'auto' }} disabled={!dirty} onClick={() => setContent(active?.content || '')}>
            Wijzigingen verwerpen
          </button>
          <button className="btn-primary" disabled={!dirty || busy} onClick={save}>
            {dirty ? `Opslaan als v${(active?.version || 0) + 1}` : 'Geen wijzigingen'}
          </button>
        </div>
      </div>

      <div
        style={{
          width: 340, flexShrink: 0, borderLeft: '1px solid var(--border-light)', background: 'var(--sidebar)',
          padding: 20, display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto',
        }}
        className="desktop-only-flex"
      >
        <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--gray)' }}>
          Versiegeschiedenis
        </div>
        {versions.map(v => (
          <div
            key={v.id}
            style={{
              background: 'var(--card)', borderRadius: 8, padding: '12px 14px',
              border: v.active ? '1.5px solid var(--ink)' : '1px solid var(--border-light)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 800 }}>v{v.version}</span>
              {v.active === 1 && <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--green-dark)' }}>actief</span>}
              <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--muted)' }}>
                {new Date(v.created_at.replace(' ', 'T')).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })} · {v.author}
              </span>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-soft)', marginTop: 5, lineHeight: 1.45 }}>
              {v.note || 'Geen omschrijving'}
            </div>
            {v.active !== 1 && (
              <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 12, fontWeight: 600 }}>
                <span style={{ textDecoration: 'underline', cursor: 'pointer' }} onClick={() => setViewing(v)}>Bekijk</span>
                <span style={{ textDecoration: 'underline', cursor: 'pointer' }} onClick={() => rollback(v)}>Terugzetten</span>
              </div>
            )}
          </div>
        ))}
        <div
          style={{
            background: 'var(--amber-bg)', border: '1px solid var(--amber-border)', borderRadius: 8,
            padding: '12px 14px', fontSize: 12.5, lineHeight: 1.5, color: 'var(--amber-dark)',
          }}
        >
          <span style={{ fontWeight: 800 }}>Let op:</span> de prompt geldt voor élk volgend artikel. Check na een wijziging het eerstvolgende draft-artikel extra goed.
        </div>
        <div style={{ fontSize: 12, color: 'var(--gray)', lineHeight: 1.5 }}>
          {kind === 'research'
            ? 'De research-prompt zet Tavily-bronnen om naar controleerbare feiten en WordPress-metadata.'
            : kind === 'schrijf'
              ? 'De SEO-prompt (RankMath-titel, meta description, focus keyword, slug) staat in het derde tabblad en werkt op dezelfde manier.'
              : 'De schrijf-prompt (titel, subregel, intro, artikeltekst, quote) staat in het tweede tabblad en werkt op dezelfde manier.'}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Vervang de volledige inhoud van `app/app/instellingen/page.tsx`**

```tsx
'use client';

import { useState } from 'react';
import TopBar from '@/components/TopBar';
import type { ConstraintKind, PromptKind } from '@/lib/types';
import { CONSTRAINT_KINDS } from '@/lib/types';
import PromptEditor from './PromptEditor';
import CriteriaEditor from './CriteriaEditor';

type Section = PromptKind | ConstraintKind;

const TAB_GROUPS: { label: string; tabs: { key: Section; label: string }[] }[] = [
  {
    label: 'Standaard',
    tabs: [
      { key: 'research', label: 'Research' },
      { key: 'schrijf', label: 'Schrijven' },
      { key: 'seo', label: 'SEO' },
    ],
  },
  {
    label: 'Lijstartikelen',
    tabs: [
      { key: 'lijst-selectie', label: 'Selectie' },
      { key: 'lijst-research', label: 'Verificatie' },
      { key: 'lijst-schrijf', label: 'Schrijven' },
      { key: 'lijst-seo', label: 'SEO' },
    ],
  },
  {
    label: 'Criteria',
    tabs: [
      { key: 'standaard', label: 'Standaard artikel' },
      { key: 'lijst', label: 'Lijstartikel' },
    ],
  },
];

function isConstraintKind(kind: Section): kind is ConstraintKind {
  return (CONSTRAINT_KINDS as string[]).includes(kind);
}

export default function Instellingen() {
  const [kind, setKind] = useState<Section>('research');

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <TopBar />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', padding: '20px 24px 0', background: 'var(--card)' }}>
          {TAB_GROUPS.map(group => (
            <div key={group.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--muted)', marginRight: 2 }}>
                {group.label}
              </span>
              {group.tabs.map(tab => (
                <button
                  key={tab.key}
                  onClick={() => setKind(tab.key)}
                  style={{
                    fontSize: 13, fontWeight: kind === tab.key ? 700 : 600, padding: '7px 14px', borderRadius: 999,
                    background: kind === tab.key ? 'var(--ink)' : 'transparent',
                    color: kind === tab.key ? '#fff' : 'var(--gray)',
                    border: kind === tab.key ? 'none' : '1px solid var(--border)',
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          ))}
        </div>
        {isConstraintKind(kind) ? <CriteriaEditor kind={kind} /> : <PromptEditor kind={kind} />}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `cd app && npx tsc --noEmit`
Expected: geen fouten.

- [ ] **Step 4: Build**

Run: `cd app && npm run build`
Expected: build slaagt zonder fouten (dit compileert alle App Router routes, inclusief de nieuwe `/api/constraints`-routes en de Instellingen-pagina).

- [ ] **Step 5: Browsercheck**

Run: `cd app && npm run dev` (als de server uit Task 5 niet meer draait)
Open `http://localhost:3400/instellingen` in de browser.
Verifieer:
- De bestaande tabs "Research", "Schrijven", "SEO", "Selectie", "Verificatie" tonen nog steeds de tekstarea-prompt-editor zoals voorheen.
- De nieuwe tab-groep "Criteria" met tabs "Standaard artikel" en "Lijstartikel" is zichtbaar.
- Klik op "Lijstartikel": toont secties "Lengtes / aantallen", "Verboden woorden" (tag-chips), "Quote-bronnen blacklist" (tag-chips), "Redactionele regels" (toggle-rijen), met de rechterkant-versiegeschiedenis ("v1 · actief").
- Wijzig een getal (bv. "Minimum aantal items" van 3 naar 4) → de knop onderaan verandert in "Opslaan als v2" en wordt actief.
- Klik "Opslaan als v2", vul een notitie in → toast verschijnt, nieuwe versie "v2 · actief" verschijnt in de geschiedenis.
- Klik "Terugzetten" bij v1 → v1 wordt weer actief, het getal staat weer op 3.
- Voeg een woord toe aan "Verboden woorden" via het invoerveld + Enter → chip verschijnt direct.

- [ ] **Step 6: Commit**

```bash
git add app/app/instellingen/PromptEditor.tsx app/app/instellingen/page.tsx
git commit -m "Split settings page into PromptEditor and add Criteria tab with CriteriaEditor"
```

---

## Self-review (uitgevoerd tijdens het schrijven van dit plan)

1. **Spec-dekking:** datamodel (Task 2), config-schema (Task 1), validation.ts-refactor (Task 3), koppeling in writer/listWriter (Task 4), API (Task 5), UI structured form met alle secties (Task 6–8), versiegeschiedenis/rollback voor constraints (Task 2 CRUD + Task 7 UI) — alles uit de spec is gedekt.
2. **Placeholder-scan:** geen "TBD"/"implementeer later"/"soortgelijk aan taak N" — elke stap bevat volledige code.
3. **Type-consistentie:** `ConstraintVersion`, `StandaardConstraints`, `ListConstraints` (Task 1) worden letterlijk zo gebruikt in `db.ts` (Task 2), `validation.ts` (Task 3), de API-routes (Task 5) en de UI (Task 6–8); functienamen (`listConstraints`, `activeConstraints`, `saveConstraintVersion`, `activateConstraintVersion`, `quoteSourceAllowed`) zijn overal identiek gespeld.
