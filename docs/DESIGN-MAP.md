# Design ↔ code map — AmsterdamNOW artikel-tool

**Doel:** bij een volgende designwijziging niet opnieuw de hele codebase hoeven
uitpluizen. Lees eerst dít bestand, importeer het verse design, diff de
schermlabels tegen de tabel hieronder, en bouw alléén de delta.

_Laatst bijgewerkt: 25 juli 2026 (TURN 5 — Instellingen-redesign: rail + één
paneel + versielade, schermen 5a/5b vervangen 2a/2b; nieuwe componenten
`meta.ts`/`PanelHeader.tsx`/`VersionDrawer.tsx`/`PlaceholderPanel.tsx`. Daarvoor:
TURN 4 — Instagram Carousel-pagina, scherm 4a-4d; scanner-redactionaliseren;
auto-publisher).
Klopt er iets niet meer? Werk deze tabel bij in dezelfde PR als de
codewijziging._

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
| **1b** | Bulk toevoegen (modal) | `app/components/BulkModal.tsx`. Sectie **"Bestaat al op de site"** na submit: per titel die de WP-dedup-check afwijst (§4) een rij met de bestaande WP-titel als link, status-chip en reden, plus knop "Toch toevoegen" (herhaalt `POST /api/topics` met `forceTitles`). Zie §4 (WP-dedup-index). |
| **1c** | Artikel-detail / beeldwerk | `app/components/ArticleDetail.tsx`; route `app/app/artikel/[id]/page.tsx`. **Beeld-slots (standaard):** 1 featured, 2 slider (streefwaarde **1**), 3 **inline in tekst**, 4 kandidaten. Het inline-beeld leeft ín de content-HTML als `<figure class="an-inline">` (splice/parse in `lib/wp.ts` — `spliceInlineImage`/`parseInline`, tussen alinea 2/3 of achteraan); `Article.inline` + `imageCount` in `types.ts`; `inlineId` door `updateImages`, PATCH `/api/articles/[id]`, media `?role=inline`, autofill. **Alleen standaard-artikelen** (lijst houdt itemfoto-flow). Backfill bestaande concepten: `POST /api/admin/backfill-inline` (Bearer `CRON_SECRET`, laatste slider → inline). **Klaar-regel (juli 2026)**: standaard = 3 beelden (`REQUIRED_IMAGES`); **lijstartikel = featured + ≥1 slider + élke item een foto** (`listImagesReady`/`articlePhase` in `types.ts`; geldt voor de kanban-kolommen, de publiceer-knop/route én de auto-publisher). UI toont bij lijsten een itemfoto-teller (x/y) i.p.v. x/3. |
| **1c** (sectie) | Voorgestelde beelden (beeldselectie + autofill top-3 + itemfoto-autofill) | sectie + `CandidateCard` in `ArticleDetail.tsx`; autofill-driver ook in `Pipeline.tsx`; backend `lib/imageSearch.ts` + `lib/imageScore.ts` + `api/articles/[id]/candidates{,/search,/score,/autofill}`; briefing `BRIEFING-claude-design-addendum-beeldselectie.md`; spec `docs/superpowers/specs/2026-07-20-beeldselectie-design.md`. **Itemfoto-autofill (juli 2026)**: bij lijstartikelen vult dezelfde autofill-route ná featured+slider per aanroep máx één itemfoto (zoeken op itemnaam+buurt → één scorebatch → upload + her-assemblage via `assembleListHtml`); geen vondst ≥ drempel → melding in `list.meldingen`, item wordt daarna overgeslagen. Client-drivers loopen tot `done: true` (respons: `filledItem`/`skippedItem`/`remainingItems`). |
| **3d** | Voorgestelde beelden — states (leeg/bezig/lijstartikel item-kiezer) | losse states-doc van dezelfde sectie/component als 1c hierboven — geen eigen scherm, geen eigen bestand. Bij lijstartikelen loopt autofill door in de itemfoto's (voortgang "Claude zoekt itemfoto's… nog N items" in `ArticleDetail.tsx`). |
| **1d** | Lege & fout-states wachtrij | onderdeel van `app/components/Pipeline.tsx` |
| **1e** | Mobiele invoer | `MobileHome`-subcomponent ín `Pipeline.tsx` + `.mobile-only` in `TopBar.tsx` |
| — | "Nieuw lijstartikel" (modal) | `app/components/ListArticleModal.tsx` |
| — | "Items controleren" (review, modal) | `app/components/ReviewModal.tsx` |
| **5a** (was 2a) | Instellingen — shell: rail links (zoek + groepen Standaard/Lijst/Algemeen, per-item versiebadges) → één paneel rechts → versielade | `app/app/instellingen/page.tsx` (rail, zoekfilter, badges via parallelle GETs, paneel-dispatch) + `meta.ts` (`RailKey`/`RAIL_GROUPS`/`panelMeta`) + `PanelHeader.tsx` + `VersionDrawer.tsx`. Prompt-paneel: `PromptEditor.tsx` (mono-box + variabelen-rij + versielade). **Sinds TURN 5 (juli 2026)**: weg met de dubbele tabrij + vaste versiekolom; versiegeschiedenis is nu een lade (`VersionDrawer`) die op "Versies (N)" over het paneel schuift. Frontend-only, backend (`/api/prompts`, `/api/constraints`, `/api/publish/settings`) ongewijzigd. |
| **5b** (was 2b) | Instellingen · Criteria (standaard/lijst) — anker-pills per sectie + versielade | `app/app/instellingen/CriteriaEditor.tsx` (herstyled: anker-pills scrollen naar secties via `sectionRefs`) + `criteria-fields.ts` (velddefinities, ongewijzigd) |
| — | Instellingen · Publiceren (auto-publisher) | `app/app/instellingen/AutoPublishPanel.tsx` (in `PanelHeader`-chrome, rail-item onder "Algemeen"); kolomkopje "auto: aan/uit" in `Pipeline.tsx` (kolom "Klaar voor publicatie") |
| — | Instellingen · Variabelen & context / Model & koppelingen | `app/app/instellingen/PlaceholderPanel.tsx` — rail-items onder "Algemeen" met "Binnenkort"-paneel; **nog geen backend** |
| — | Archief | `app/app/archief/page.tsx` |
| **3a/3b/3c** | Bronnen (agenda-scanner) | `app/app/bronnen/page.tsx`; nav in `TopBar.tsx`; backend §4 |
| toast | Meldingen | `app/components/toast.tsx` (`toast(...)` + `<ToastHost>` in `layout.tsx`) |
| **4a** | Carousel-overzicht (welke artikelen zijn Instagram-klaar) | `app/components/CarouselOverview.tsx`; route `app/app/carousel/page.tsx`; nav in `TopBar.tsx` (na Archief) |
| **4b** | Carousel-generator / editor (template kiezen, preview, slide-editor, caption/hashtags, klaarzetten/publiceren) | `app/components/CarouselGenerator.tsx` (orchestratie) + `CarouselSlidePreview.tsx` (swipebare preview/thumbstrip) + `CarouselSlideEditor.tsx` (rechterpaneel) + `CarouselPanels.tsx` (subcontext/template-strip/bottombar/modal, presentationeel); route `app/app/carousel/[articleId]/page.tsx`; instap-knop "Maak Instagram-carousel" in `ArticleDetail.tsx` (header, bij `status==='publish'` of `articlePhase===ready`) |
| **4c** | Laadstaat (genereren) en publiceren-bevestigingsmodal | `CarouselPanels.tsx` (`LoadingPanel`, `PublishModal`), aangestuurd door `CarouselGenerator.tsx` |
| **4d** | Lege staat (overzicht) & mislukte generatie (editor, met retry + toast) | leeg: `CarouselOverview.tsx`; fout: `CarouselPanels.tsx` (`GenerateErrorPanel`) |
| — | Mock-contract socials-engine (nog niet gebouwd, zie briefing `docs/briefings/2026-07-21-instagram-carousel-pagina-briefing.md` §5/§6) | `app/lib/carousel-mock.ts` — `CarouselContent`/`CarouselMeta`, in-memory (reset bij page-reload); vervang deze file zodra de echte socials-service er is, componenten blijven ongewijzigd |

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
  (`askClaudeJson` + `askClaudeJsonWithImages` (vision), `MODEL`=Opus 4.8,
  `FAST_WRITE_MODEL`=Sonnet 5), `lib/scanner.ts` (Bronnen),
  `lib/imageSearch.ts` (beeldselectie: Openverse/Commons/Pexels/Google,
  `MIN_EDGE` = 1000; Pexels alleen met `PEXELS_API_KEY`, Google via
  Serper.dev alleen met `SERPER_API_KEY`, CC-rechtenfilter vast aan —
  Googles eigen CSE/JSON API is sinds jan 2026 dicht voor nieuwe whole-web
  engines).
- **Tokenoptimalisatie (juli 2026, PR #29–#33)** — bij nieuwe Claude-calls
  aanhouden:
  - Álle pipeline-calls draaien expliciet op `FAST_WRITE_MODEL` (Sonnet 5);
    `MODEL` (Opus) is alleen nog de default/override via `ANTHROPIC_MODEL`.
    Nieuwe extractie-/verificatie-/SEO-stappen: Sonnet, tenzij aantoonbaar
    kwaliteit tekortschiet.
  - Elke JSON-call geeft een schema uit `lib/schemas.ts` mee (structured
    outputs via `output_config.format`); dan geldt gegarandeerd-geldige JSON
    en vervalt het herkansingspad. Nieuwe call = nieuw schema in `schemas.ts`
    (elk object `additionalProperties:false` + volledige `required`; geen
    min/max-keywords).
  - `[claude]`-logregel in `lib/claude.ts` logt tokens + cache-hits
    (tijdelijke instrumentatie). Cache-minimum: systeem-prompts onder ~2k
    tokens (Sonnet) cachen stilletjes níet.
  - Bronscanner slaat een `content_hash` per bron op (`sources`-tabel) en
    slaat de Claude-call over bij een ongewijzigde pagina.
  - **Redactionaliseren (juli 2026)**: gescande bronkoppen gaan níet meer
    letterlijk de wachtrij in. `editorializeTitles()` in `lib/scanner.ts`
    (Haiku, `SCAN_EDITORIALIZE_SCHEMA`, fail-open → originele titel) zet elke
    vondst om naar een eigen input-topic (bron-aantallen zoals "55 X" eruit,
    eigen invalshoek, zoekintentie behouden). De vondsten-historie
    (`source_findings.dedup_key`) blijft op de originele bronkop draaien,
    anders draagt elke scan hetzelfde item opnieuw aan. Backfill voor
    bestaande letterlijke wachtrij-topics: `POST /api/admin/editorialize-queue`
    (Bearer `CRON_SECRET`, batches, POST'en tot `done: true`; idempotent —
    herschreven titels matchen hun `dedup_key` niet meer).
  - Beeldselectie: max 48 kandidaten (`MAX_CANDIDATES` in `imageSearch.ts`),
    scoren alleen op thumbnails (bewust géén full-size fallback).
    **Itemfoto-autofill** (lijstartikelen, juli 2026): zelfde
    `candidates/autofill`-route, ná de featured/slider-fase per request máx
    één item (60s-limiet, één Claude-call): zoeken op itemnaam + buurt via
    `searchImageCandidates`, één `scoreOneBatch` van max 12 (drempel
    `AUTO_MIN_SCORE` = 55), `uploadMediaFromUrl` + `assembleListHtml` +
    `updateArticleContent` + `saveListStructure` (zelfde patroon als
    `item-media`). Geen bruikbare vondst → vaste melding in `list.meldingen`
    ("Geen geschikte itemfoto gevonden voor …"), zodat de loop het item
    daarna overslaat. Kandidaten belanden in dezelfde `image_candidates`-pool
    (dedup op URL).
- **WP-dedup-index (juli 2026)** — voorkomt dat de tool onderwerpen genereert
  die al op amsterdamnow.com staan (incl. drafts/pending/future). Spec:
  `docs/superpowers/specs/2026-07-21-wp-dedup-index-design.md`.
  - **Tabel `wp_posts`** (beide drivers, schema-init in `db.ts`): `wp_id` (PK),
    `title`, `slug`, `excerpt`, `link`, `status`, `categories` (JSON-array),
    `wp_modified`, `synced_at`. Extra kolom `dedup_override INTEGER DEFAULT 0`
    op `topics` — 1 = force-toegevoegd, slaat de herkans-check vóór
    `createDraft()` over.
  - **Sync**: `app/lib/wpSync.ts` (`syncWpPosts({ full? })`) haalt posts op met
    status `publish,draft,pending,future` via bestaande `WP_USER`/
    `WP_APP_PASSWORD` basic auth. Incrementeel (default) = `modified_after`
    met 10-min buffer, upsert; `?full=1` = alles ophalen + rijen verwijderen
    die niet terugkwamen. Route `GET/POST /api/wp-sync`: `Bearer CRON_SECRET`
    (zelfde patroon als `queue/worker`/`sources/scan`); collectie-route, dus
    geen `[id]`-valkuil, maar staat toch expliciet in `vercel.json` (geen
    cron-entry — alleen handmatig/on-demand, de staleness-guard hieronder
    triggert 'm ook automatisch).
  - **Dedup-logica**: `app/lib/dedup.ts`. `normalizeTitle()` (lowercase,
    diacritics/entities weg, NL+EN-stopwoorden eruit, tokenize) →
    `lexicalCandidates()` (top-10 uit alle wp_posts, Dice-score op tokens +
    substring-/excerpt-boost; exacte genormaliseerde titelmatch = direct
    duplicaat, geen LLM-call) → bij kandidaten `judgeDuplicate()`: één
    Haiku-call (`claude-haiku-4-5-20251001`, schema in `schemas.ts`) die
    beoordeelt of het écht hetzelfde onderwerp/venue is (niet slechts
    hetzelfde thema). `checkTopicAgainstWp(title)` bundelt dit tot
    `{ verdict: 'duplicate'|'ok'|'unknown', existing?, reason? }`.
    **Staleness-guard**: als de laatste sync > 6 uur oud is (of de tabel
    leeg is) triggert `checkTopicAgainstWp` zelf een incrementele sync.
    **Fail-open**: WP onbereikbaar of de Haiku-call faalt → `unknown`, topic
    mag door (wel gelogd); een exacte titelmatch blokkeert altijd, ook dan.
  - **Hooks**: `POST /api/topics` (`app/app/api/topics/route.ts`) checkt elke
    titel (met een concurrency-cap van 3 gelijktijdige Haiku-calls) en geeft
    naast `added`/`skipped` ook `duplicates: [{ title, existing: { wp_id,
    title, link, status }, reason }]` terug. Body `force: true` slaat de
    check voor alle titels over; `forceTitles: string[]` alleen voor die
    titels — beide zetten `dedup_override=1` via `addTopics()`. Vlak vóór
    `createDraft()` in de writer hercheckt dezelfde functie (topics kunnen
    lang in de wachtrij staan); zonder override gaat de topic naar `failed`
    met "Duplicaat van {link}", mét override gaat 'm gewoon door.
  - **UI**: zie tabel hierboven (§2, rij **1b**) voor `BulkModal.tsx`.
- **Auto-publisher (juli 2026)** — publiceert zelf artikelen uit "Klaar voor
  publicatie" (exact dezelfde ready-regel als Pipeline.tsx/`articlePhase()`:
  standaard = 3 beelden; **lijst = featured + ≥1 slider + élke item een
  itemfoto**, zie `listImagesReady` in `types.ts`) op een instelbaar
  interval, wanneer aangezet in Instellingen.
  - **Tabellen** (beide drivers, `db.ts`): `app_settings` (generieke key/value,
    autopublish-instellingen onder key `autopublish`) en `publish_meta`
    (`article_id` PK, `evergreen`, `event_date`, `classified_at` — per
    artikel-id de classificatie van `classifyArticles()`).
  - **`lib/publisher.ts`**: instellingen (`getAutoPublishSettings`/
    `saveAutoPublishSettings`), classificatie (`classifyArticles` — max 8
    nog-onbekende ready-artikelen per tik in ÉÉN Haiku-call, schema
    `AUTOPUBLISH_CLASSIFY_SCHEMA` in `schemas.ts`, fail-open) en selectie
    (`pickNextForPublish` — pure functie: tier op evergreen/naderend-event,
    plus een categorie-balansbonus capped op 72u zodat die nooit een tier
    kan overslaan; tie-break op oudste `date`).
  - **Routes**: `GET/POST /api/publish/tick` (client-driven poll zonder auth,
    accepteert ook `Bearer CRON_SECRET`; één Claude-call + één publicatie per
    tik, 60s-limiet) en `GET/POST /api/publish/settings` (geen auth, zoals
    `/api/prompts`). Beide staan expliciet in `vercel.json` (geen cron-entry).
  - **Driver**: `Pipeline.tsx` polt `/api/publish/tick` elke 60s; bij een
    gepubliceerd artikel ververst het bord + toast. Kolomkopje toont
    "auto: aan · volgende HH:MM" of "auto: uit".
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
