# WP Dedup Index — Design

**Datum:** 2026-07-21 · **Status:** goedgekeurd door Martijn (methode, gedrag en scope)

## Doel

Voorkomen dat de artikel-tool artikelen genereert over onderwerpen die al op
amsterdamnow.com staan. Alle WordPress-posts (incl. drafts/pending) worden
geïndexeerd in de bestaande database; bij topic-invoer en vlak vóór
draft-creatie wordt daartegen gecheckt.

## Goedgekeurde keuzes

1. **Methode:** lexicale shortlist (top-10 kandidaten) + één Haiku-call die
   beoordeelt of het echt hetzelfde onderwerp is. Geen embeddings, geen nieuwe
   dependencies.
2. **Bij duplicaat:** waarschuwen + override. Topic wordt geweigerd met link
   naar bestaand artikel; UI biedt "Toch toevoegen" (force).
3. **Scope:** ook WP drafts/pending/future tellen mee (opgehaald met bestaande
   `WP_USER`/`WP_APP_PASSWORD` basic auth).

## Feiten uit verkenning

- 1.097 gepubliceerde posts; publieke REST API; `modified_after` werkt;
  100 posts/request in ~1,2 s → volledige backfill = ~11 requests.
- App: Next.js 15, dual DB (better-sqlite3 lokaal / pg op Supabase prod) via
  `app/lib/db.ts`. WP-client: `app/lib/wp.ts` (`wpFetch`, `wpFetchAllPages`,
  `createDraft` regel ~449). Topics: `POST /api/topics` → `addTopics()`
  (db.ts ~358) — dedupt nu alleen tegen eigen topics-tabel.
- Gotcha: `vercel.json` gebruikt legacy builder — **nieuwe API-routes hebben een
  expliciete rewrite nodig**, anders 404 op prod. Cron-routes gebruiken
  `Bearer CRON_SECRET`.

## Componenten

### 1. Tabel `wp_posts` (beide drivers, in `db.ts` schema-init)

| kolom | type | opm. |
|---|---|---|
| `wp_id` | INTEGER PK | WordPress post-ID |
| `title` | TEXT | plain text, HTML-entities gedecodeerd |
| `slug` | TEXT | |
| `excerpt` | TEXT | HTML gestript |
| `link` | TEXT | |
| `status` | TEXT | publish / draft / pending / future |
| `categories` | TEXT | JSON-array van category-ids |
| `wp_modified` | TEXT | ISO, uit WP `modified` |
| `synced_at` | TEXT | ISO |

Extra: kolom `dedup_override INTEGER DEFAULT 0` op `topics` (force-toegevoegde
topics slaan de tweede check over).

### 2. Sync — `app/lib/wpSync.ts` + route `/api/wp-sync`

- `syncWpPosts({ full? })`: authed fetch met
  `_fields=id,slug,title,excerpt,link,status,categories,modified`,
  `status=publish,draft,pending,future`, `per_page=100`.
  - **Incremental** (default): `modified_after = max(wp_modified) − 10 min`
    buffer, upsert.
  - **Full** (`?full=1`): alles ophalen, upsert, en rijen verwijderen die niet
    meer terugkomen (vangt verwijderde posts af).
- Route `POST/GET /api/wp-sync`: `Bearer CRON_SECRET` (bestaand patroon) +
  rewrite in `vercel.json`.
- **Staleness-guard:** `checkTopicAgainstWp()` triggert zelf een incremental
  sync als de laatste sync > 6 uur oud is of de tabel leeg is.

### 3. Dedup — `app/lib/dedup.ts`

- `normalizeTitle()`: lowercase, diacritics/entities weg, NL+EN-stopwoorden
  eruit, tokenize.
- `lexicalCandidates(title, limit=10)`: alle ~1.100 titels+excerpts in
  geheugen; score = token-overlap (Dice) + boost voor exacte naam/substring-hit.
  Exacte genormaliseerde titelmatch → direct duplicaat, geen LLM-call.
- `judgeDuplicate(title, candidates)`: één Haiku-call
  (`claude-haiku-4-5-20251001` via bestaande `claude.ts`-wrapper), JSON-out:
  `{ duplicate, wp_id, reason }`. Prompt benadrukt: zelfde *onderwerp/venue*,
  niet slechts zelfde thema (nieuw restaurant-lijstje ≠ dupe van ander lijstje,
  artikel over zelfde venue = dupe).
- `checkTopicAgainstWp(title)` → `{ verdict: 'duplicate'|'ok'|'unknown', existing?, reason? }`.
- **Fail-open:** WP onbereikbaar of Haiku-fout → `unknown`, topic mag door
  (wel gelogd + exacte-titelmatch blijft blokkeren).

### 4. Hooks

- **`POST /api/topics`:** per titel checken. Response krijgt naast
  `added`/`skipped` ook `duplicates: [{ title, existing: { wp_id, title, link, status }, reason }]`.
  Body-param `force: true` (of per-titel lijst) → toevoegen met
  `dedup_override=1`.
- **Writer, vóór `createDraft()`:** hercheck (topics kunnen lang in de wachtrij
  staan). Bij dupe zonder override → topic `failed` met melding
  "Duplicaat van {link}". Met override → doorlaten.

### 5. UI — `BulkModal.tsx`

Na submit: sectie "Bestaat al op de site" met per dupe de bestaande titel als
link + reden + knop **"Toch toevoegen"** (herhaalt POST met force voor die
titel). Toegevoegde/geskipte titels blijven zoals nu.

## Testen

- Unit: `normalizeTitle`, Dice-score, kandidaat-selectie (fixtures met echte
  titels van de site).
- Integratie: sync tegen live API (read-only) lokaal; check-endpoint met
  bekende dupe ("AMAZE by ID&T…") en bekende niet-dupe.
- `npm run build` groen.

## Buiten scope

Embeddings/vector search; dedup van reeds bestaande WP-posts onderling;
verwijder-detectie realtime (alleen bij full sync); n8n-koppeling.
