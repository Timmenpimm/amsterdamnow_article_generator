# Match Existing Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the article-generation pipeline from ever creating new WordPress tags — tags must be chosen from the existing WordPress tag list, or left empty if none fit.

**Architecture:** Mirror the existing categories/district pattern (`taxonomyChoices()` already gives the AI the real category/district list to pick from). Extend it to also expose existing tags, inject that list into the user-message prompt for both the single-article and list-article flows (so the constraint takes effect immediately on deploy, independent of the database-backed prompt content — see Global Constraints), and remove the auto-create fallback in `wp.ts` as a hard safety net.

**Tech Stack:** TypeScript, Next.js (App Router), WordPress REST API (`wp/v2/tags`), no test framework in this repo (see Global Constraints).

## Global Constraints

- Tag list fetched from WordPress is capped at **30 tags**, one page, no pagination (`per_page=30`) — user-specified cap, not negotiable in this plan.
- `app/lib/prompt-seeds.ts` is a **code-level seed only**. `app/lib/db.ts` (`seedPrompts`, lines 312-335) inserts this content into the `prompts` table on first run, and on later runs only overwrites a row if its content still equals the legacy placeholder — it never overwrites a prompt that's already been seeded or manually edited via the `PromptEditor` UI. Editing `prompt-seeds.ts` alone will **not** change production behavior for the `research` prompt kind. Because of this, the actual tag constraint must be enforced entirely in code (the injected user-message text in `writer.ts` and `listWriter.ts`, plus the `wp.ts` safety net) — never rely on the DB-backed prompt content for correctness. The `prompt-seeds.ts` edit in Task 2 is still made, for consistency and for fresh/reset installs, but is not load-bearing.
- There is no test framework (no Jest/Vitest, no `test` npm script) in this repo. Verification per task is: (a) `npx tsc --noEmit` from `app/`, run after every code change, and (b) for Task 1's pure matching logic, a throwaway Node script in `/tmp` (deleted after use — never committed).
- Follow this repo's branch → commit → PR → merge workflow (see `CLAUDE.md`). This plan already runs inside the `match-existing-tags` worktree/branch.

---

### Task 1: `app/lib/wp.ts` — fetch existing tags, stop auto-creating new ones

**Files:**
- Modify: `app/lib/wp.ts:100-144`

**Interfaces:**
- Produces: `taxonomyChoices(): Promise<{ categories: string[]; districts: string[]; tags: string[] }>` — the `tags` field is new; `categories`/`districts` keep their existing shape. Consumed by Task 3 (`writer.ts`) and Task 4 (`listWriter.ts`).
- Produces: `matchExistingTagId(existing: { id: number; name: string }[], name: string): number | null` — new internal helper, pure function, no network calls.

- [ ] **Step 1: Read the current code to confirm line numbers haven't shifted**

Run: `sed -n '100,144p' app/lib/wp.ts`

Expected output starts with `// ---------- taxonomy caches ----------` and ends with the closing brace of `tagIdsForNames`. If line numbers differ, locate the same block by content instead of line number for the edits below.

- [ ] **Step 2: Add a tag-choices cache and extend `loadTaxonomies()`**

Replace:
```ts
// ---------- taxonomy caches ----------

let catCache: Record<number, string> | null = null;
let districtCache: Record<number, string> | null = null;
let tagCache: Record<number, string> = {};

async function loadTaxonomies() {
  if (catCache && districtCache) return;
  const [cats, districts] = await Promise.all([
    fetch(`${WP_URL}/wp-json/wp/v2/categories?per_page=100`, { cache: 'no-store' }).then(r => r.json()),
    fetch(`${WP_URL}/wp-json/wp/v2/district?per_page=100`, { cache: 'no-store' }).then(r => r.json()),
  ]);
  catCache = Object.fromEntries(cats.map((c: any) => [c.id, c.name]));
  districtCache = Object.fromEntries(districts.map((d: any) => [d.id, d.name]));
}

export async function taxonomyChoices(): Promise<{ categories: string[]; districts: string[] }> {
  if (!LIVE) return { categories: ['Cultuur', 'Uitgaan', 'Restaurants', 'Lifestyle'], districts: ['Amsterdam Centrum', 'Amsterdam Noord', 'Amsterdam Oost', 'Amsterdam Zuid'] };
  await loadTaxonomies();
  return { categories: Object.values(catCache || {}), districts: Object.values(districtCache || {}) };
}
```

With:
```ts
// ---------- taxonomy caches ----------

let catCache: Record<number, string> | null = null;
let districtCache: Record<number, string> | null = null;
let tagCache: Record<number, string> = {};
// Bestaande WP-tags waaruit de AI mag kiezen bij het classificeren van een
// artikel (zie taxonomyChoices). Bewust op één pagina gehouden: max 30 tags,
// geen paginering.
let tagChoicesCache: string[] | null = null;

async function loadTaxonomies() {
  if (catCache && districtCache && tagChoicesCache) return;
  const [cats, districts, tags] = await Promise.all([
    fetch(`${WP_URL}/wp-json/wp/v2/categories?per_page=100`, { cache: 'no-store' }).then(r => r.json()),
    fetch(`${WP_URL}/wp-json/wp/v2/district?per_page=100`, { cache: 'no-store' }).then(r => r.json()),
    fetch(`${WP_URL}/wp-json/wp/v2/tags?per_page=30`, { cache: 'no-store' }).then(r => r.json()),
  ]);
  catCache = Object.fromEntries(cats.map((c: any) => [c.id, c.name]));
  districtCache = Object.fromEntries(districts.map((d: any) => [d.id, d.name]));
  tagChoicesCache = tags.map((t: any) => t.name);
}

export async function taxonomyChoices(): Promise<{ categories: string[]; districts: string[]; tags: string[] }> {
  if (!LIVE) return {
    categories: ['Cultuur', 'Uitgaan', 'Restaurants', 'Lifestyle'],
    districts: ['Amsterdam Centrum', 'Amsterdam Noord', 'Amsterdam Oost', 'Amsterdam Zuid'],
    tags: ['Terras', 'Live muziek', 'Brunch', 'Hondvriendelijk'],
  };
  await loadTaxonomies();
  return { categories: Object.values(catCache || {}), districts: Object.values(districtCache || {}), tags: tagChoicesCache || [] };
}
```

- [ ] **Step 3: Extract the matching logic and stop auto-creating tags**

Replace:
```ts
async function tagIdsForNames(names: string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const name of [...new Set(names.map(n => n.trim()).filter(Boolean))]) {
    const existing = await wpFetch(`/wp/v2/tags?search=${encodeURIComponent(name)}&per_page=100`);
    const match = existing.find((tag: any) => normalized(tag.name) === normalized(name));
    if (match) ids.push(match.id);
    else {
      const created = await wpFetch('/wp/v2/tags', { method: 'POST', body: JSON.stringify({ name }) });
      ids.push(created.id);
    }
  }
  return ids;
}
```

With:
```ts
function matchExistingTagId(existing: { id: number; name: string }[], name: string): number | null {
  const match = existing.find(tag => normalized(tag.name) === normalized(name));
  return match ? match.id : null;
}

async function tagIdsForNames(names: string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const name of [...new Set(names.map(n => n.trim()).filter(Boolean))]) {
    const existing = await wpFetch(`/wp/v2/tags?search=${encodeURIComponent(name)}&per_page=100`);
    const id = matchExistingTagId(existing, name);
    // Geen match → tag overslaan. Er wordt nooit meer automatisch een nieuwe
    // WordPress-tag aangemaakt vanuit het aanmaak-pad.
    if (id !== null) ids.push(id);
  }
  return ids;
}
```

- [ ] **Step 4: Write and run a throwaway verification script for the matching logic**

Create `/tmp/verify-tag-match.mjs`:
```js
function normalized(value) {
  return value.toLocaleLowerCase('nl-NL').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function matchExistingTagId(existing, name) {
  const match = existing.find(tag => normalized(tag.name) === normalized(name));
  return match ? match.id : null;
}

const existing = [
  { id: 1, name: 'Terras' },
  { id: 2, name: 'Live Muziek' },
];

const cases = [
  ['Terras', 1],           // exact match
  ['terras', 1],           // case-insensitive match
  ['  Live   Muziek ', 2], // whitespace/normalization match
  ['Vegetarisch', null],   // no match → must be dropped, not created
];

let failed = false;
for (const [name, expected] of cases) {
  const got = matchExistingTagId(existing, name);
  const ok = got === expected;
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'}: matchExistingTagId(existing, ${JSON.stringify(name)}) = ${got}, expected ${expected}`);
}
process.exit(failed ? 1 : 0);
```

Run: `node /tmp/verify-tag-match.mjs`
Expected: four `PASS` lines, exit code 0.

- [ ] **Step 5: Delete the throwaway script**

Run: `rm /tmp/verify-tag-match.mjs`

- [ ] **Step 6: Typecheck**

Run (from `app/`): `npx tsc --noEmit`
Expected: no output, exit code 0.

- [ ] **Step 7: Commit**

```bash
git add app/lib/wp.ts
git commit -m "fix(wp): stop auto-creating WordPress tags, match against existing only"
```

---

### Task 2: `app/lib/prompt-seeds.ts` — update the research prompt's tag instructions

**Files:**
- Modify: `app/lib/prompt-seeds.ts:9` (the `"research"` seed string)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing consumed elsewhere in this plan — this is the code-level default seed only (see Global Constraints: not load-bearing for production behavior, Task 3 carries the real enforcement).

- [ ] **Step 1: Update the `<classification>` block**

Within the `"research"` string in `PROMPT_SEEDS`, replace this substring:
```
<classification>\nKies categorieën en district uitsluitend uit de lijsten die de gebruiker heeft meegegeven. Gebruik rubriek `Locatie` voor een vaste plek en `Evenement` voor een tijdelijk programma of festival. Tags zijn alleen relevante, concrete labels; maximaal vijf.\n</classification>
```

With:
```
<classification>\nKies categorieën en district uitsluitend uit de lijsten die de gebruiker heeft meegegeven. Gebruik rubriek `Locatie` voor een vaste plek en `Evenement` voor een tijdelijk programma of festival. Kies tags uitsluitend uit de meegegeven lijst bestaande WordPress-tags; verzin nooit nieuwe tags. Kies maximaal vijf tags die echt relevant zijn; past geen enkele bestaande tag goed, geef dan een lege lijst terug.\n</classification>
```

- [ ] **Step 2: Update the output-schema description for `tags`**

Within the same string, replace:
```
\"tags\": [\"maximaal vijf bestaande of duidelijke nieuwe tags\"],
```

With:
```
\"tags\": [\"uitsluitend bestaande tags uit de meegegeven lijst, leeg als er geen passen\"],
```

- [ ] **Step 3: Typecheck**

Run (from `app/`): `npx tsc --noEmit`
Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add app/lib/prompt-seeds.ts
git commit -m "docs(prompt-seeds): update research seed tag instructions to match-existing-only"
```

---

### Task 3: `app/lib/writer.ts` — expose existing tags to the single-article research step

**Files:**
- Modify: `app/lib/writer.ts:124-128`

**Interfaces:**
- Consumes: `taxonomyChoices()` from Task 1, specifically the new `tags: string[]` field.

- [ ] **Step 1: Add the tags list and an inline instruction to the research user-message**

Replace:
```ts
  const research = await askClaudeJson(
    researchPrompt.content,
    `Onderwerp: ${topic.title}\n\nBeschikbare WordPress-categorieën: ${taxonomies.categories.join(', ')}\nBeschikbare WordPress-districten: ${taxonomies.districts.join(', ')}\n\nTavily-bronnen:\n${sources.map((src, i) => `\n[${i + 1}] ${src.title}\n${src.url}\n${src.content.slice(0, 8000)}`).join('\n')}`,
    false, FAST_WRITE_MODEL, 6000, RESEARCH_SCHEMA,
  );
```

With:
```ts
  const research = await askClaudeJson(
    researchPrompt.content,
    `Onderwerp: ${topic.title}\n\nBeschikbare WordPress-categorieën: ${taxonomies.categories.join(', ')}\nBeschikbare WordPress-districten: ${taxonomies.districts.join(', ')}\nBeschikbare WordPress-tags: ${taxonomies.tags.join(', ')}\nKies "tags" uitsluitend uit deze lijst; verzin nooit nieuwe tags. Past geen enkele bestaande tag goed, geef dan een lege lijst terug.\n\nTavily-bronnen:\n${sources.map((src, i) => `\n[${i + 1}] ${src.title}\n${src.url}\n${src.content.slice(0, 8000)}`).join('\n')}`,
    false, FAST_WRITE_MODEL, 6000, RESEARCH_SCHEMA,
  );
```

- [ ] **Step 2: Typecheck**

Run (from `app/`): `npx tsc --noEmit`
Expected: no output, exit code 0. This confirms `taxonomies.tags` resolves against the updated `taxonomyChoices()` return type from Task 1.

- [ ] **Step 3: Commit**

```bash
git add app/lib/writer.ts
git commit -m "feat(writer): give the research step visibility into existing WordPress tags"
```

---

### Task 4: `app/lib/listWriter.ts` — expose existing tags to the list-article compose step

**Files:**
- Modify: `app/lib/listWriter.ts:307-314`

**Interfaces:**
- Consumes: `taxonomyChoices()` from Task 1, specifically the new `tags: string[]` field.

- [ ] **Step 1: Add `beschikbare_tags` to the payload and update the instruction line**

Replace:
```ts
      const [prompt, taxonomies] = await Promise.all([activePrompt('lijst-schrijf'), taxonomyChoices()]);
      result = await askClaudeJson(
        prompt.content,
        `Schrijf het lijstartikel. Kies "categories" (1-2) en "district" uit de beschikbare lijsten en voeg 3-6 "tags" en een "rubriek" (Locatie of Evenement) toe aan je JSON-output, naast de velden uit je instructie.\n\nHoud je aan deze regels:\n${describeArticleConstraints(constraints)}\n${describeItemConstraints(constraints)}${feedbackHint}\n\n${JSON.stringify({
          ...input,
          beschikbare_categorieen: taxonomies.categories,
          beschikbare_districten: taxonomies.districts,
        })}`,
        false, FAST_WRITE_MODEL, 6000, LIST_COMPOSE_FIRST_SCHEMA
      );
```

With:
```ts
      const [prompt, taxonomies] = await Promise.all([activePrompt('lijst-schrijf'), taxonomyChoices()]);
      result = await askClaudeJson(
        prompt.content,
        `Schrijf het lijstartikel. Kies "categories" (1-2) en "district" uit de beschikbare lijsten en kies 3-6 "tags" uitsluitend uit "beschikbare_tags" (nooit nieuwe tags verzinnen; laat "tags" leeg als er geen passen). Voeg ook een "rubriek" (Locatie of Evenement) toe aan je JSON-output, naast de velden uit je instructie.\n\nHoud je aan deze regels:\n${describeArticleConstraints(constraints)}\n${describeItemConstraints(constraints)}${feedbackHint}\n\n${JSON.stringify({
          ...input,
          beschikbare_categorieen: taxonomies.categories,
          beschikbare_districten: taxonomies.districts,
          beschikbare_tags: taxonomies.tags,
        })}`,
        false, FAST_WRITE_MODEL, 6000, LIST_COMPOSE_FIRST_SCHEMA
      );
```

- [ ] **Step 2: Typecheck**

Run (from `app/`): `npx tsc --noEmit`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add app/lib/listWriter.ts
git commit -m "feat(listWriter): give the compose step visibility into existing WordPress tags"
```

---

### Task 5: Final verification and PR

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck**

Run (from `app/`): `npx tsc --noEmit`
Expected: no output, exit code 0.

- [ ] **Step 2: Confirm no other callers of `taxonomyChoices()` were missed**

Run: `grep -rn "taxonomyChoices" app/lib --include="*.ts"`
Expected: exactly the definition in `wp.ts`, plus the two call sites already updated in `writer.ts` and `listWriter.ts`. If any other call site appears, it must also destructure/use `tags` consistently — stop and address it before opening the PR.

- [ ] **Step 3: Confirm no other reference to `POST /wp/v2/tags`-style creation remains**

Run: `grep -rn "wp/v2/tags" app/lib --include="*.ts"`
Expected: only read paths (`GET .../tags?search=`, `GET .../tags?include=`, `GET .../tags?per_page=`) — no `POST` to `/wp/v2/tags` anywhere.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin match-existing-tags
gh pr create --title "Match tags against existing WordPress tags only" --body "$(cat <<'EOF'
## Summary
- Article generation (single articles and list articles) now sees the real list of existing WordPress tags (capped at 30) and is instructed to choose only from it.
- `wp.ts` no longer auto-creates a new WordPress tag when the AI's suggestion doesn't match an existing one — it's dropped instead, so `tags` can end up empty.
- `prompt-seeds.ts`'s research seed text is updated for consistency, but per this repo's prompt-seeding rules it won't retroactively change an already-seeded production prompt — the actual constraint is enforced in code (`writer.ts`/`listWriter.ts` inline instruction + the `wp.ts` safety net), so it's effective immediately on deploy either way.

## Test plan
- [x] `npx tsc --noEmit` clean
- [x] Throwaway script confirmed `matchExistingTagId` matches exact/case/whitespace variants and returns `null` (dropped, not created) for no-match
- [ ] Spot-check one live single-article generation and one live list-article generation post-deploy to confirm tags come back from the existing set (or empty)
EOF
)"
```

- [ ] **Step 5: Report the PR URL to the user and stop.** Merging is a separate, explicit user decision per `CLAUDE.md` — do not merge automatically.
