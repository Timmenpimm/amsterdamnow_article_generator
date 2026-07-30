# AmsterdamNOW artikel-tool — complete instructieset voor Claude Cowork

> **Wat is dit?** Een zelfstandige handleiding zodat een verse Cowork-sessie de
> tool volledig snapt en kan bedienen/doorontwikkelen zonder de hele codebase
> opnieuw uit te pluizen. Samengesteld uit de codebase + eerdere Claude Code
> sessies (21 juli 2026).
>
> **Lees hierna, afhankelijk van je taak:** `docs/DESIGN-MAP.md` (scherm→bestand,
> vóór élke UI/designwijziging), `HANDOFF.md` (laatste stand + openstaande bugs),
> `CLAUDE.md` (werkregels), `BRIEFING-claude-design*.md` (gedrag/inhoud).

---

## 1. Wat de tool doet (in één alinea)

AmsterdamNOW (amsterdamnow.com) is een online stadsmagazine over Amsterdam.
Artikelen worden vrijwel volledig door AI geschreven. Deze **interne redactietool**
(desktop-first dashboard, Nederlandstalige UI) vervangt de oude Google-Sheet-invoer
en beheert de hele pijplijn: je voert **onderwerpen** in (één of in bulk), de tool
doet zelf **research → schrijven → SEO** met Claude en zet het artikel als **draft**
in WordPress, waarna de redactie **beelden toevoegt** (min. 3) en **publiceert**.
Doelgroep: kleine niet-technische redactie (1–3 mensen), korte dagelijkse sessies,
snelheid en weinig klikken tellen.

**Belangrijk verschil met de originele briefing:** de briefing beschrijft n8n als
schrijf-pipeline. Dat is achterhaald — **de tool schrijft nu zelf in-house** via
`app/lib/writer.ts` / `listWriter.ts` met de Anthropic API. Er wordt nergens meer
n8n aangeroepen. WordPress blijft de publicatiebestemming.

## 2. Vindplaatsen & stack

| | |
|---|---|
| **Lokaal** | `~/Claude/amsterdamnow-artikel-tool` (app zelf leeft in submap `app/`) |
| **Repo** | https://github.com/Timmenpimm/amsterdamnow_article_generator |
| **Live** | https://amsterdamnow-article-generator.vercel.app/ |
| **Stack** | Next.js 15 (App Router, React 19) · legacy `@vercel/next` builder (zie `vercel.json`) · Postgres (Supabase) op productie / SQLite lokaal · Anthropic Claude API · WordPress REST API · Vercel **Hobby**-plan |
| **Vercel** | project `prj_sZS6Lu8ynmd8cDvui4wjnwpazaAP`, team `team_4wTDEc1Ts78ncJALyuJ2t5pT` |
| **Geen testrunner** | bewust; verificatie = `tsc --noEmit` + `next build` + handmatige UI/curl-test. (Wel twee losse node-testscripts: `npm run test:dedup`, `npm run test:wpsync`.) |

## 3. Architectuur in vogelvlucht

**Frontend (schermen)** — `app/app/*` (routes) + `app/components/*`:

- **Statusboard / kanban** = het hart van de UI: `components/Pipeline.tsx`
  (7 kolommen, pollt `/api/board`, toont `listProgress`), gerenderd door
  `app/app/page.tsx`.
- **Bulk toevoegen** (modal): `components/BulkModal.tsx` — incl. "Bestaat al op
  de site"-sectie (WP-dedup, zie §6).
- **Artikel-detail + beeldwerk**: `components/ArticleDetail.tsx`, route
  `app/app/artikel/[id]/page.tsx`.
- **Lijstartikel aanmaken** / **items controleren**: `ListArticleModal.tsx` /
  `ReviewModal.tsx`.
- **Bronnen** (agenda-scanner): `app/app/bronnen/page.tsx` (zie §7).
- **Instellingen**: `app/app/instellingen/` — `PromptEditor.tsx` (prompts) +
  `CriteriaEditor.tsx` (redactionele criteria, zie §8).
- **Archief**: `app/app/archief/page.tsx`.
- **Navigatie + snelle invoer + mobiel**: `components/TopBar.tsx`; toasts in
  `components/toast.tsx`.

**Backend (libs)** — `app/lib/*`:

- `db.ts` — datalaag, **twee drivers** (zie §4).
- `queue.ts` — de motor: verwerkt **hooguit één atomisch geclaimde fase-stap**
  per aanroep (zowel het bord als de cron-worker roepen `processNextQueueJob()`).
- `writer.ts` — standaard-artikel pipeline (research → schrijf → seo).
- `listWriter.ts` — lijstartikel pipeline (select → verify → review → compose → finalize).
- `validation.ts` — redactionele checks (woordaantal, verboden woorden, quotes…).
- `wp.ts` — WordPress REST (posts/media/ACF), `createDraft`, `LIVE` = live/demo,
  inline-beeld splice (`spliceInlineImage`/`parseInline`).
- `wpSync.ts` + `dedup.ts` — WP-dedup-index (§6).
- `tavily.ts` — research + `extractPageText`.
- `scanner.ts` — Bronnen-scan (§7).
- `imageSearch.ts` + `imageScore.ts` — beeldkandidaten zoeken/scoren (§5).
- `claude.ts` — `askClaudeJson` + `askClaudeJsonWithImages` (vision).
  `MODEL` = Opus 4.8 (alleen nog default/override), `FAST_WRITE_MODEL` = Sonnet 5
  (alle pipeline-calls draaien hierop).
- `schemas.ts` — JSON-schema's per Claude-call (structured outputs).
- `articleHtml.ts` / `listHtml.ts` / `htmlEntities.ts` / `prompt-seeds.ts` /
  `demo-seed.ts` — rendering, prompt-constanten, seed-data.

## 4. Datalaag (`app/lib/db.ts`) — twee drivers

- **Postgres** zodra `DATABASE_URL` (of `SUPABASE_DB_URL`/`POSTGRES_URL`) is gezet;
  anders **SQLite** (lokaal `app/data/`, op Vercel `/tmp` = **niet-persistent**).
- Query's in **Postgres-stijl `$1,$2`**; `toSqlite()` vertaalt automatisch.
- Tabellen worden inline aangemaakt in **beide** `initSqlite()` én `initPostgres()`
  (plus migraties). **Een nieuwe tabel = in béide init-functies toevoegen**, met
  types in `lib/types.ts`.
- Kerntabellen: `topics` (de wachtrij), `articles`, `list_state`/list-items,
  `prompts`, `constraints`, `sources` + `source_findings` (Bronnen),
  `wp_posts` (dedup-index).

## 5. De pijplijn: van onderwerp naar gepubliceerd artikel

**Twee soorten onderwerpen** (`TopicType`): `standaard` (één locatie/onderwerp) en
`lijst` (lijstartikel, bv. "beste vegan restaurants"). Elk topic heeft een
`TopicStatus`: `queued → writing → review → failed → done`.

**Statusboard-fasen** (wat de redactie ziet), uit `BRIEFING`:

| Status | Betekenis |
|---|---|
| In wachtrij | Onderwerp ingevoerd, wacht op de AI |
| Wordt geschreven | tool doet research + schrijven + SEO |
| Klaar — beelden nodig | draft in WordPress, < 3 beelden |
| Klaar voor publicatie | ≥ 3 beelden, wacht op akkoord |
| Gepubliceerd | live op amsterdamnow.com |
| Mislukt | fout in pipeline; opnieuw proberen kan |

**Interne fasen in code:**
- Standaard (`writer.ts`, `StandaardPhase`): `research → schrijf → schrijf-retry → seo → createDraft`.
- Lijst (`listWriter.ts`, `ListPhase`): `select → verify → review → compose → finalize`.
- **Elke fase is één zelfstandige stap** binnen de 60s-serverlesslimiet: na een
  stap gaat het topic terug op `queued`, de volgende aanroep pikt het weer op via
  `claimNextQueued()`. Lange stukken (compose, verify) verwerken **2 items per tik**
  (`COMPOSE_PER_TICK`) om nooit tegen de 60s aan te lopen.

**Article-fasen** (`ArticlePhase`, afgeleid): `needImages → ready → published`;
`ready` zodra `imageCount ≥ REQUIRED_IMAGES` (3).

**⚠️ De trigger is bewust handmatig.** Er is géén schrijf-cron (Hobby-plan staat
max 1 cron/dag toe — te grof). De knop **"Schrijf volgend artikel met Claude"** op
het bord (of `POST /api/topics/process`) is de enige trigger. Zonder klik gebeurt
er niets; topics kunnen "stilstaand" ogen terwijl er niks kapot is.

### Beeldflow (het ontwerp-gevoeligste deel)

Per artikel in "Klaar — beelden nodig", in `ArticleDetail.tsx`:
- **Beeld-slots (standaard-artikel):** 1 featured (hero, verplicht) · 2 slider
  (min. 2 verplicht, ACF-veld `slider`) · 3 **inline in de tekst** · 4 kandidaten.
  Het inline-beeld leeft ín de content-HTML als `<figure class="an-inline">`
  (splice/parse in `lib/wp.ts`). Lijstartikelen houden hun eigen itemfoto-flow.
- **Aanleveren:** drag & drop upload + plakken van een afbeeldings-URL → gaan naar
  de WordPress-mediabibliotheek. Publiceren is **geblokkeerd tot ≥ 3 beelden** —
  de tool bewaakt dat, niet de gebruiker.
- **Voorgestelde beelden (autofill top-3):** `imageSearch.ts` zoekt kandidaten
  (Openverse/Commons/Pexels/Google-via-Serper), `imageScore.ts` scoort op
  thumbnails (max 48 kandidaten, `MIN_EDGE` 1000). Pexels alleen met
  `PEXELS_API_KEY`, Google alleen met `SERPER_API_KEY`. Routes:
  `api/articles/[id]/candidates{,/search,/score,/autofill}`.

## 6. WP-dedup-index — voorkomt dubbele onderwerpen

Voorkomt dat de tool onderwerpen genereert die al op amsterdamnow.com staan
(incl. drafts/pending/future). Spec:
`docs/superpowers/specs/2026-07-21-wp-dedup-index-design.md`.

- **Tabel `wp_posts`** (beide drivers). Extra kolom `dedup_override` op `topics`
  (1 = force-toegevoegd, slaat de herkans-check vóór `createDraft()` over).
- **Sync** (`lib/wpSync.ts`): haalt WP-posts op (`publish,draft,pending,future`)
  via `WP_USER`/`WP_APP_PASSWORD`. Incrementeel (default) of `?full=1`.
  Route `GET/POST /api/wp-sync` met `Bearer CRON_SECRET`.
- **Logica** (`lib/dedup.ts`): `normalizeTitle()` → `lexicalCandidates()` (exacte
  genormaliseerde titelmatch = direct duplicaat, geen LLM) → anders `judgeDuplicate()`
  (één **Haiku**-call). `checkTopicAgainstWp(title)` → `{ verdict:'duplicate'|'ok'|'unknown', existing?, reason? }`.
  **Staleness-guard:** sync ouder dan 6 uur (of lege tabel) → triggert zelf een
  incrementele sync. **Fail-open:** WP/Haiku onbereikbaar → `unknown`, topic mag
  door (exacte titelmatch blokkeert altijd).
- **Hooks:** `POST /api/topics` geeft naast `added`/`skipped` ook `duplicates[]`
  terug. Body `force:true` (alle titels) of `forceTitles:string[]` (specifiek)
  slaat de check over. In de UI: `BulkModal.tsx` toont "Bestaat al op de site" met
  per titel een link + knop "Toch toevoegen".

## 7. Bronnen — agenda-scanner

Vierde kernscherm (`app/app/bronnen/page.tsx`). De redactie geeft agenda-/programma-
URL's op; de tool leest ze uit (`tavily.ts` extract + fallback), Claude haalt
relevante items eruit (`scanner.ts`, `scanSource`/`scanAllActiveSources`, max 20
nieuw per scan, `content_hash` slaat ongewijzigde pagina's over) en zet nieuwe
onderwerpen **direct in dezelfde `topics`-wachtrij**. Tabellen `sources` +
`source_findings`. Routes onder `/api/sources/*`. **Dit is de enige cron:**
`vercel.json` → `crons: /api/sources/scan @ 0 5 * * *` (≈07:00 CEST), vereist
`CRON_SECRET`. Kost Tavily- + Anthropic-credits.

## 8. Prompts & criteria (instellingen)

- **Prompts**: bewerkbaar in `/instellingen` (`PromptEditor.tsx`), met versie-
  geschiedenis/rollback. Opgeslagen in DB; seeds als **code-constanten** in
  `lib/prompt-seeds.ts` (níet als losse `.txt` — de legacy Vercel-builder bundelde
  die niet betrouwbaar mee). API: `/api/prompts`, `/api/prompts/[id]/activate`.
- **Criteria**: alle redactionele checks (woordaantallen, verboden woorden,
  quote-bronnen-blacklist, quote-norm, structuurregels) zijn bewerkbaar via de
  "Criteria"-tab (`CriteriaEditor.tsx` + `criteria-fields.ts`), per soort
  (`standaard`/`lijst`), met rollback. API: `/api/constraints`,
  `/api/constraints/[id]/activate`. De checks draaien in `lib/validation.ts`.

## 9. Environment variables (namen)

Zet op Vercel (productie) en in `app/.env` (lokaal):

- **Claude:** `ANTHROPIC_API_KEY` (+ optioneel `ANTHROPIC_MODEL`, `ANTHROPIC_FAST_MODEL`).
- **WordPress:** `WP_URL`, `WP_USER`, `WP_APP_PASSWORD`.
- **DB:** `DATABASE_URL` / `SUPABASE_DB_URL` / `POSTGRES_URL` (leeg = SQLite;
  `SQLITE_DB_FILE` override lokaal pad).
- **Research/beeld:** `TAVILY_API_KEY`, `PEXELS_API_KEY`, `SERPER_API_KEY`.
- **Cron/worker-auth:** `CRON_SECRET` (Vercel stuurt die auto mee als
  `Authorization: Bearer …` bij crons). `VERCEL` wordt door het platform gezet.

## 10. Lokaal draaien & testen

- **Dev-server:** `.claude/launch.json` config **`artikel-tool`** (`cwd: app`,
  `npm run dev`, poort **3400**). Start via `preview_start {name:"artikel-tool"}`,
  niet via Bash. In Cowork zonder die tool: `cd app && npm run dev` (poort 3400).
- **Op SQLite forceren:** `app/.env` bevat een (soms kapotte) Supabase
  `DATABASE_URL`. Hernoem 'm tijdelijk (`mv app/.env app/.env.disabled`) zodat de
  app op SQLite terugvalt, en zet 'm daarna terug. Ruim `app/data/tool.db*` op voor
  een schone run.
- **⚠️ Worktree-valkuil:** `preview_start {name:"artikel-tool"}` start `next dev`
  soms in de **primaire** checkout (`…/app`), óók als je cwd in een worktree ligt.
  Check bij twijfel `lsof -i :3400` → cwd van de PID vóór je tegen localhost test;
  start anders handmatig met expliciete cwd.
- **React controlled inputs:** `form_input` triggert `onChange` niet betrouwbaar →
  gebruik echte toetsaanslagen (`computer type`) of test de API met `curl`.
- **Bouwcheck (altijd vóór een PR):** `cd app && npx tsc --noEmit && npx next build`.

## 11. Deployment & de `vercel.json`-valkuilen

1. **Legacy `@vercel/next` builder met expliciete `routes`-rewrites.** Elke **nieuwe
   geneste/dynamische API-route** (`/api/x/[id]`, `/api/x/[id]/sub`) heeft een eigen
   rewrite nodig **vóór** de catch-all `/(.*)`, en **statische segmenten vóór
   `[id]`-segmenten** (anders vangt `[id]` bv. `/scan` op). Collectie-routes
   (`/api/x`) lopen vanzelf via de catch-all. Vergeet je dit → **404 op productie
   terwijl het lokaal wél werkt** (dat verbergt de fout).
2. **60s serverless-limiet.** Eén Claude-call per request; lange bewerkingen
   opknippen (per-tik met een `MAX_*_PER_*`-guard, zoals `COMPOSE_PER_TICK`).
3. **Crons** op Hobby max 1×/dag. Vercel stuurt automatisch `Bearer $CRON_SECRET`.
4. **API-routes:** altijd `export const dynamic = 'force-dynamic'`,
   `NextResponse.json`, dynamische `[id]` uit `params`. Cron/worker-routes: `GET`
   met `Bearer CRON_SECRET`.
5. **Deploys hangen soms op QUEUED/INITIALIZING** (platform-hik) — annuleer de
   vastgelopen deploy in het Vercel-dashboard. Check na een merge of de nieuwe
   commit-sha binnen ~1 min live staat.

## 12. Werkregels (uit `CLAUDE.md`) — belangrijk

- **Altijd branch + PR, nooit direct naar `main`.** Loop: branch off actueel
  `origin/main` → commit → `gh pr create` → `gh pr merge <n> --merge --delete-branch`.
  Nooit `reset --hard`/force-push op `main` of gedeelde branches.
- **Werk in een geïsoleerde git-worktree** voor elke niet-triviale wijziging
  (tool `EnterWorktree` of skill `superpowers:using-git-worktrees`). Alleen direct
  in de primaire checkout als de gebruiker daar expliciet om vraagt.
- **Deze repo wordt vaak door meerdere sessies tegelijk bewerkt.** De primaire
  checkout is gedeelde, muteerbare state. Vóór merge/rebase: check
  `git merge-base` tegen actueel `origin/main` (stale branch lijkt features te
  "verwijderen" — rebase eerst).
- **Bij een designwijziging:** lees éérst `docs/DESIGN-MAP.md`, haal het verse
  design op via de DesignSync MCP, diff de `data-screen-label`s tegen de tabel,
  bouw alléén de delta. Werk de DESIGN-MAP bij in dezelfde PR.

## 13. Handige commando's / API-cheatsheet

```bash
# Board-status (welke topics staan waar):
curl -s "https://amsterdamnow-article-generator.vercel.app/api/board"

# Eén verwerkingsstap triggeren (zelfde als de UI-knop):
curl -s -X POST "https://amsterdamnow-article-generator.vercel.app/api/topics/process" \
  -H "Content-Type: application/json"

# Vastgelopen/mislukte topic terug in de wachtrij:
curl -s -X PATCH "https://amsterdamnow-article-generator.vercel.app/api/topics/<id>" \
  -H "Content-Type: application/json" -d '{"action":"retry"}'

# Actieve prompt / criteria op productie bekijken:
curl -s "https://amsterdamnow-article-generator.vercel.app/api/prompts?kind=<kind>"
curl -s "https://amsterdamnow-article-generator.vercel.app/api/constraints?kind=<standaard|lijst>"

# Onderwerp toevoegen (met dedup-override desgewenst):
curl -s -X POST ".../api/topics" -H "Content-Type: application/json" \
  -d '{"titles":["Techlab Marineterrein: robots voor kids"],"forceTitles":[]}'

# WP-dedup-index handmatig syncen:
curl -s -X POST ".../api/wp-sync" -H "Authorization: Bearer $CRON_SECRET"

# Lokale bouwcheck vóór een PR:
cd app && npx tsc --noEmit && npx next build
```

## 14. Bekende openstaande punten (per 21 juli 2026, zie `HANDOFF.md`)

- **Bloknaad-bug bij lijstartikelen:** met compose in blokken van 2 kan de regel
  "geen twee quotes bij opeenvolgende items" falen over een bloknaad heen. Fix
  (nog niet geïmplementeerd): geef mee of het vorige blok met een quote eindigde,
  in `stepCompose()` (`lib/listWriter.ts`, ~r.195–230). Let op: bij validatiefout
  regenereert `stepCompose()` momenteel álle chunks (correct maar duur).
- **UX:** meerdere lijstartikelen tegelijk op "wordt geschreven" is onduidelijk;
  overweeg relatieve tijd sinds `started_at` en/of markering voor lang-stilliggend.
- **Branch-opruiming:** enkele gemergede branches staan nog op GitHub
  (`delete_branch_on_merge: false`).
- **Anthropic-credits** kunnen opraken ("credit balance too low") — geen codebug.

---

*Onderhoud: klopt er iets niet meer, werk dit bestand bij in dezelfde PR als de
codewijziging — net als `docs/DESIGN-MAP.md`.*
