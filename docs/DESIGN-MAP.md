# Design ↔ code map — AmsterdamNOW artikel-tool

**Doel:** bij een volgende designwijziging niet opnieuw de hele codebase hoeven
uitpluizen. Lees eerst dít bestand, importeer het verse design, diff de
schermlabels tegen de tabel hieronder, en bouw alléén de delta.

_Laatst bijgewerkt: 20 juli 2026. Klopt er iets niet meer? Werk deze tabel bij
in dezelfde PR als de codewijziging._

---

## 1. Waar het design leeft & hoe je het ophaalt

- **Claude Design project** (canvas): `AmsterdamNOW artikel-tool`
  projectId **`93a10432-f563-4d77-8526-bcee65f32776`**, bestand
  **`Artikel-tool.dc.html`**.
- Ophalen via de **claude_design / DesignSync MCP** (auth: claude.ai-login of
  `/design-login`):
  1. `DesignSync get_project` (projectId) — check dat je erbij kunt.
  2. `DesignSync list_files` (projectId) — bestanden.
  3. `DesignSync get_file` (projectId, `Artikel-tool.dc.html`) — grote output;
     schrijf 'm over `design/Artikel-tool.dc.html` heen.
- Elk scherm in de `.dc.html` heeft een `data-screen-label="<code> <naam>"`.
  `grep -n data-screen-label design/Artikel-tool.dc.html` geeft je de index +
  regelnummers. **Diff die labels tegen de tabel hieronder** om te zien wat
  nieuw/gewijzigd is. Lees vervolgens alléén die secties + de bijbehorende
  bestanden — niet het hele design, niet de hele app.
- De briefings staan in de repo-root: `BRIEFING-claude-design*.md` (hoofd +
  addenda). Die zijn leidend voor gedrag/inhoud; de `.dc.html` voor de vorm.

## 2. Schermlabel → codebestand(en)

| Design | Scherm | Implementatie |
|---|---|---|
| topbar (overal) | Navigatie, snelle invoer, modus-indicator | `app/components/TopBar.tsx` |
| **1a** | Statusboard (kanban) | `app/components/Pipeline.tsx` (7 kolommen, poll `/api/board`, `listProgress`); gerenderd door `app/app/page.tsx` |
| **1b** | Bulk toevoegen (modal) | `app/components/BulkModal.tsx` |
| **1c** | Artikel-detail / beeldwerk | `app/components/ArticleDetail.tsx`; route `app/app/artikel/[id]/page.tsx` |
| **1d** | Lege & fout-states wachtrij | onderdeel van `app/components/Pipeline.tsx` |
| **1e** | Mobiele invoer | `MobileHome`-subcomponent ín `Pipeline.tsx` + `.mobile-only` in `TopBar.tsx` |
| — | "Nieuw lijstartikel" (modal) | `app/components/ListArticleModal.tsx` |
| — | "Items controleren" (review, modal) | `app/components/ReviewModal.tsx` |
| **2a** | Prompt & instellingen (prompt-editor) | `app/app/instellingen/page.tsx` + `app/app/instellingen/PromptEditor.tsx` |
| **2b** | Instellingen · Criteria (standaard/lijst) | `app/app/instellingen/CriteriaEditor.tsx` + `criteria-fields.ts` |
| — | Archief | `app/app/archief/page.tsx` |
| **3a/3b/3c** | Bronnen (agenda-scanner) | `app/app/bronnen/page.tsx`; nav in `TopBar.tsx`; backend §4 |
| toast | Meldingen | `app/components/toast.tsx` (`toast(...)` + `<ToastHost>` in `layout.tsx`) |

## 3. Design-tokens & stijl

- **Tokens**: `app/app/globals.css` `:root` (kleuren `--ink/--gray/--red/--green/
  --amber/--blue/…`, `--card/--panel/--soft/--sidebar/--border(-light)`,
  `--mono`). Font **Archivo** via `<link>` in `app/app/layout.tsx`.
  **De tokens matchen het design al** (warme paper-look `#e9e8e4`). Verander ze
  alleen als het design zelf van kleur/type verandert.
- **Stijl-aanpak**: géén Tailwind/CSS-modules. Een handjevol utility-classes in
  `globals.css` (`.btn`, `.btn-primary`, `.btn-green`, `.btn-small`, `.card`,
  `.colhead`, `.dot`, `.chip-amber`, `.chip-green`, `.hatch`, `.navlink`,
  `.desktop-only`/`.mobile-only`, …) + **inline `style={{…}}`** met
  `var(--token)` per element. Nieuwe schermen: kopieer dit patroon.
- **Toggle-switch** en **tag-editor** hebben geen utility-class; zie het
  inline-patroon in `bronnen/page.tsx` (`Toggle`) resp. `CriteriaEditor.tsx`.

## 4. Backend-patronen (voor schermen met eigen data/acties)

- **Datalaag**: `app/lib/db.ts` — twee drivers: Postgres zodra `DATABASE_URL`
  (`SUPABASE_DB_URL`/`POSTGRES_URL`) is gezet, anders SQLite (lokaal `data/`,
  op Vercel `/tmp`, niet-persistent). Query's in **Postgres-stijl `$1,$2`**;
  `toSqlite()` vertaalt. Tabellen worden inline aangemaakt in **beide**
  `initSqlite()` én `initPostgres()`, plus migraties. Types in
  `app/lib/types.ts`. Een nieuwe tabel = in beide init-functies toevoegen.
- **Pipeline-libs**: `lib/queue.ts` (één taak per tik), `lib/writer.ts`,
  `lib/listWriter.ts`, `lib/validation.ts`, `lib/wp.ts` (WordPress REST + `LIVE`
  = live/demo), `lib/tavily.ts` (research + `extractPageText`), `lib/claude.ts`
  (`askClaudeJson`, `MODEL`=Opus 4.8, `FAST_WRITE_MODEL`=Sonnet 5),
  `lib/scanner.ts` (Bronnen).
- **API-routes**: `app/app/api/*` — altijd `export const dynamic =
  'force-dynamic'`, `NextResponse.json`, dynamische `[id]` uit `params`.
  Cron/worker-routes: `GET` met `Bearer CRON_SECRET` (zie `queue/worker` &
  `sources/scan`).

### Valkuilen (belangrijk!)

1. **`vercel.json` is de legacy `@vercel/next` builder met expliciete
   `routes`-rewrites.** Elke **nieuwe geneste/dynamische API-route**
   (`/api/x/[id]`, `/api/x/[id]/sub`) heeft een eigen rewrite nodig, **vóór**
   de catch-all `/(.*)`, en **statische segmenten vóór `[id]`-segmenten**
   (anders vangt `[id]` bv. `/scan` op). Collectie-routes (`/api/x`) lopen
   vanzelf via de catch-all. Vergeet je dit → 404 op productie (lokaal werkt
   het wél, wat de fout verbergt).
2. **60s serverless-limiet.** Eén Claude-call per request; lange bewerkingen
   opknippen (client-side loop, of per-tik met een `MAX_*_PER_*`-guard).
3. **Crons** in `vercel.json` (`"crons":[{path,schedule}]`) draaien op Hobby
   max 1×/dag; Vercel stuurt automatisch `Authorization: Bearer $CRON_SECRET`
   mee als die env gezet is.

## 5. Lokaal draaien & testen

- Dev: `.claude/launch.json` config **`artikel-tool`** (`cwd: app`, `npm run
  dev`, poort **3400**). Gebruik `preview_start {name:"artikel-tool"}`, niet Bash.
- **Lokaal op SQLite**: `app/.env` bevat een (kapotte) Supabase `DATABASE_URL`;
  hernoem 'm tijdelijk (`mv app/.env app/.env.disabled`) zodat de app op SQLite
  terugvalt, en zet 'm daarna terug. Ruim `app/data/tool.db*` op voor een
  schone run.
- **Controlled inputs + browser-automatie**: `form_input` triggert React's
  `onChange` niet betrouwbaar → gebruik echte toetsaanslagen (`computer type`)
  of test de API rechtstreeks met `curl` op `localhost:3400`.
- Bouwcheck: `cd app && npx tsc --noEmit` + `npx next build`. **Er is geen
  testrunner** in de repo (bewust).

## 6. Efficiënt stappenplan bij een designwijziging

1. Lees dit bestand (je bent er).
2. Haal het verse design op (§1) en `grep` de `data-screen-label`s.
3. Diff die labels tegen §2 → bepaal wat **nieuw/gewijzigd** is.
4. Lees alléén die design-secties + de gemapte bestanden + relevante briefing.
5. Bouw de delta; volg de stijl (§3) en, bij data/acties, de patronen +
   valkuilen (§4).
6. Verifieer via preview op SQLite (§5). Werk §2 bij als de mapping verandert.
