# Handoff — AmsterdamNOW artikel-tool

**Datum:** 20 juli 2026
**Repo:** https://github.com/Timmenpimm/amsterdamnow_article_generator
**Live:** https://amsterdamnow-article-generator.vercel.app/
**Stack:** Next.js (legacy `@vercel/next` builder in `vercel.json`), Postgres (Supabase) op productie / SQLite lokaal, Anthropic Claude API, WordPress REST API, Vercel Hobby-plan.

## Nieuw (21 juli): WP-dedup-index

Voorkomt dat de tool onderwerpen genereert die al op amsterdamnow.com staan
(incl. drafts/pending/future). Ontwerp/status: zie
`docs/superpowers/specs/2026-07-21-wp-dedup-index-design.md` en
`docs/DESIGN-MAP.md` §4. Gebouwd op branch `feat/wp-dedup-index` in de
`amsterdamnow-wt-dedup`-worktree, in drie fases (backend-tabel+sync,
dedup-logica+hooks, UI — deze sessie deed fase 3/UI + verificatie).

- **Nieuw/gewijzigd deze fase:** `app/components/BulkModal.tsx` — sectie
  "Bestaat al op de site" na een submit met afgewezen titels, met per titel
  de bestaande WP-titel als link, status-chip en reden, plus knop "Toch
  toevoegen" (herpost met `forceTitles`, verplaatst de rij weg uit de
  dupe-lijst bij succes, triggert dezelfde `onAdded()`/`load()`-refresh als
  een normale toevoeging zodat het bord meteen bijwerkt). `docs/DESIGN-MAP.md`
  bijgewerkt met de wp_posts-tabel, `/api/wp-sync`, `lib/dedup.ts`-flow,
  `forceTitles`/`dedup_override` en het fail-open-gedrag.
- **Verificatie:** `tsc --noEmit` + `next build` schoon. End-to-end via curl
  op lokale SQLite (poort 3400, gestart uit de worktree — **niet** via
  `.claude/launch.json`/`preview_start`, dat resolvede naar de verkeerde
  checkout, zie waarschuwing hieronder): `POST /api/topics` met een titel die
  exact overeenkomt met een gepubliceerd artikel ("Beleef de wereld van
  Diptyque in stijlvolle boutique") kwam terug in `duplicates` met
  `reason: "Exacte titelmatch (genormaliseerd)."`; dezelfde POST met
  `forceTitles` gaf 'm terug in `added` met `dedup_override: 1` en hij
  verscheen op `/api/board`. Testtopic (id 9) daarna direct uit
  `app/data/tool.db` verwijderd (`DELETE FROM topics WHERE id=9`) — de
  overige, al langer wachtende topics (id's 1–8, van eerdere fase-testing)
  ongemoeid gelaten.
- **Concurrency-waarschuwing (herhaling van de les uit 20 juli):** `preview_start
  {name:"artikel-tool"}` startte in deze sessie ondanks een cwd in de
  worktree een `next dev`-proces met working directory
  `/Users/martijn/Claude/amsterdamnow-artikel-tool/app` (de **primaire**
  checkout), niet de worktree. Direct gestopt zodra dat bleek (`lsof`/`ps` op
  poort 3400 controleren vóórdat je 'm vertrouwt) en vervangen door een
  handmatige `npm run dev -p 3400` met cwd expliciet in de worktree. Volgende
  sessie: controleer bij twijfel altijd `lsof -i :3400` → cwd van de PID,
  vóór je tegen "localhost:3400" test.

## Nieuw (20 juli, 2e sessie): Bronnen — agenda-scanner

Vierde kernscherm **Bronnen** gebouwd naar het verse Claude-design (schermen
3a/3b/3c uit `design/Artikel-tool.dc.html`, geïmporteerd via de claude_design
MCP). De redactie geeft agenda-/programma-URL's op; de tool leest ze uit,
Claude haalt relevante items eruit en zet nieuwe onderwerpen **direct in de
wachtrij** (dezelfde `topics`-tabel). Scannen draait **in de tool zelf**.

**Nieuwe/gewijzigde bestanden (nog niet los gecommit — zie concurrency-notitie):**
- `app/lib/db.ts` — tabellen `sources` + `source_findings` (beide drivers) +
  helpers (listSources met afgeleide `foundCount`/`recent`, addSource met
  URL-normalisatie + dubbeldetectie, setSourceActive, renameSource,
  deleteSource, updateSourceScan, getFindingKeys, recordFindings,
  topicIdsByTitle). *(staat al in HEAD, meegecommit door een parallelle run)*
- `app/lib/types.ts` — `Source`, `SourceFinding` (afgeleide state
  queued/written/deleted via LEFT JOIN topics), `SourceSummary`, `ScanResult`.
  *(idem, al in HEAD)*
- `app/lib/tavily.ts` — `extractPageText(url)`: Tavily `/extract` met
  platte-fetch fallback (`stripHtml`).
- `app/lib/scanner.ts` — `scanSource(id)` (pagina → Claude-extractie met
  `FAST_WRITE_MODEL` → dedup → `addTopics` → `recordFindings` → scanstatus) en
  `scanAllActiveSources()`. Guard: max 20 nieuwe per scan.
- `app/app/api/sources/route.ts` (GET/POST), `…/[id]/route.ts` (PATCH/DELETE),
  `…/[id]/scan/route.ts` (POST), `…/sources/scan/route.ts` (GET cron +
  POST scan-all).
- `app/app/bronnen/page.tsx` — het scherm (zone A/B/C, states ok/bezig/fout/
  gepauzeerd + uitklapbare vondsten-historie, lege state, mobiel).
- `app/components/TopBar.tsx` — nav-link **Bronnen**.
- `vercel.json` — order-gevoelige route-rewrites vóór de catch-all
  (`/scan` vóór `[id]`) + **`crons`**-entry `0 5 * * *` (≈07:00 CEST) die
  `GET /api/sources/scan` aanroept.
- `docs/superpowers/plans/2026-07-20-bronnen-agenda-scanner-plan.md`.

**Verificatie:** `next build` groen, `tsc --noEmit` schoon, en volledig
door-de-UI getest op lokale SQLite (lege/gevulde/fout/bezig/gepauzeerd-states,
toevoegen + dubbeldetectie, scan end-to-end via de route, dedup-historie met de
drie pill-states, mobiele invoer). Een echte Claude-scan is lokaal niet
getest (geen ANTHROPIC/TAVILY-keys in de lokale env) — de scan-keten zelf is
wél end-to-end geraakt (route → scanner → tavily-fallback → db).

**Aandachtspunten voor deployment:**
- De dagelijkse cron vereist env `CRON_SECRET` op Vercel (Vercel stuurt die
  automatisch mee als `Authorization: Bearer …`, net als bij `queue/worker`).
  Zonder `CRON_SECRET` geeft de cron-GET 401 — de handmatige knoppen werken
  altijd. Hobby-plan staat 1 cron/dag toe; deze past daarbinnen. Wil je géén
  cron, verwijder dan het `crons`-blok uit `vercel.json`.
- Scannen kost Tavily- én Anthropic-credits (1 extract + 1 Claude-call per
  bron per scan, Sonnet 5).

**Concurrency-notitie:** tijdens deze sessie liep er een tweede proces op de
repo (commits `bdaaf16`/`7ba3ed2`/`29e653a` — de compose-feedback-loop). Dat
proces heeft `app/lib/db.ts` en `app/lib/types.ts` met mijn Bronnen-wijzigingen
meegecommit naar HEAD; de overige Bronnen-bestanden staan nog los in de working
tree. Ik heb bewust **niet** zelf gecommit (niet gevraagd). Controleer vóór een
eventuele commit even `git status` op dubbel werk.

## Wat er deze sessie is gebouwd/gefixt (chronologisch, alle gemerged naar `main`)

1. **Instelbare artikel-constraints** (PR #1) — alle redactionele checks die hardcoded in `app/lib/validation.ts` stonden (woordaantallen, verboden woorden, quote-bronnen blacklist, quote-norm, structurele regels) zijn nu bewerkbaar via een nieuwe "Criteria"-tab in `/instellingen`, met versiegeschiedenis/rollback zoals de bestaande prompts. Zie `docs/superpowers/specs/2026-07-20-configurable-constraints-design.md` en `docs/superpowers/plans/2026-07-20-configurable-constraints-plan.md` voor het volledige ontwerp.
2. **`.vercelignore` sloot `app/seeds/` uit van elke Vercel-deployment** (PR #2) — vier eerdere commits in de geschiedenis probeerden dit al te fixen zonder succes, omdat ze de vercelignore-regel niet raakten.
3. **Prompts zijn nu code-constanten i.p.v. losse `.txt`-bestanden** (PR #3, `app/lib/prompt-seeds.ts`) — de legacy Vercel-builder bundelde de `.txt`-bestanden niet betrouwbaar mee (vijfde poging, nu structureel opgelost: een import wordt altijd meegebundeld). `readSeed()`/`MISSING_SEED`/`app/seeds/` zijn weg.
4. **5 van de 7 prompts stonden op productie op een placeholder-tekst** door bovenstaande bug — handmatig hersteld via de prompts-API met de echte inhoud.
5. **`FUNCTION_INVOCATION_TIMEOUT`** (60s-limiet van Vercel serverless) op de compose-stap van lijstartikelen. Opgelost in drie stappen (PR #4, #5, #6+#7):
   - Sneller model (Sonnet 5 i.p.v. Opus 4.8) voor het schrijfwerk (`FAST_WRITE_MODEL` in `app/lib/claude.ts`).
   - Research-tekst per item inkorten (`trimFeiten()` in `app/lib/listWriter.ts`).
   - **De echte fix:** compose verwerkt nu 2 items per tik (`COMPOSE_PER_TICK`), net als de verify-fase al deed, i.p.v. alle items in één blokkerende call. Garandeert dat geen enkele Claude-call ooit in de buurt van de 60s-limiet komt, ongeacht lijstgrootte.
   - Voortgangsindicator in `Pipeline.tsx` (`listProgress()`) toont nu echte tussentijdse status ("Artikel wordt geschreven · 6/11 items") i.p.v. een statische tekst.

## Openstaand / bekend probleem (waar ik mee bezig was toen dit gesprek werd onderbroken)

**Nieuwe bug, direct gevolg van de chunking-fix (#5 hierboven):** met compose in blokken van 2 items kan de validatieregel "geen twee quotes bij opeenvolgende items" nu falen over een bloknaad heen — elk blok kiest quote-plaatsing zonder te weten wat het vorige blok deed. Net live gezien: `Twee quotes bij opeenvolgende items; verspreid ze door het artikel.` op het artikel "De beste vegan restaurants in Amsterdam" (topic id 4).

**Voorgestelde fix (nog niet geïmplementeerd):** geef het laatste item van het vorige blok (specifiek: had het een quote?) mee in de prompt van het volgende blok, met de instructie om geen quote op het eerste item van het nieuwe blok te zetten als het vorige blok al met een quote eindigde. Locatie: `stepCompose()` in `app/lib/listWriter.ts`, rond regel 195-230 — de `input`-object-constructie vóór de `askClaudeJson()`-call.

Let op: bij een validatiefout wist `stepCompose()` momenteel `s.composeChunks` volledig (regenereert alles opnieuw) — dat is correct gedrag, maar wel duur (opnieuw alle Claude-calls voor het hele artikel).

## Andere openstaande dingen

- **Branch-opruiming:** 4 branches zijn gemerged maar niet verwijderd op GitHub (`feature/configurable-constraints`, `fix/vercel-seed-files-excluded`, `fix/compose-timeout`, `fix/compose-chunking`) — repo heeft `delete_branch_on_merge: false`. Gebruiker heeft nog niet bevestigd of dit opgeruimd moet worden.
- **Kleine UI-copy-fix niet gemerged:** branch `fix/clarify-prompt-variables-copy` bestaat alleen lokaal (nooit gepusht). Vervangt de misleidende `{{onderwerp}}`-chips (suggereerden template-substitutie die niet bestaat) door platte namen + duidelijkere uitleg in `PromptEditor.tsx`. Gebruiker heeft nog niet bevestigd of dit gepusht/gemerged moet worden.
- **UX-klacht, nog niet opgelost:** gebruiker vindt het bord onduidelijk als er meerdere lijstartikelen tegelijk op "wordt geschreven" staan zonder duidelijk te maken welke actief is en hoe lang iets al stilligt. Mogelijke verbetering: relatieve tijd tonen sinds `started_at` op topic-cards, en/of een visuele markering voor topics die "wordt geschreven" zijn maar al langer dan bv. 2 minuten niet zijn bijgewerkt (wachtend op een handmatige klik, niet per se kapot).
- **Trigger blijft bewust handmatig:** gebruiker koos expliciet voor geen Vercel Cron (Hobby-plan beperkt cron tot 1x/dag, te grof) — de knop "Schrijf volgend artikel met Claude" is de enige trigger. Dit betekent: zonder iemand die klikt, gebeurt er niets, en topics kunnen "stilstaand" ogen terwijl er niks kapot is.
- **Anthropic API-credit was eerder deze sessie tijdelijk op** ("Your credit balance is too low") — gebruiker heeft dit zelf bijgevuld; kan in de toekomst weer gebeuren, geen codeprobleem.
- **Vercel-deployments liepen tijdens deze sessie een paar keer vast op "QUEUED"/"INITIALIZING"** zonder te bouwen (geen build-logs) — leek een tijdelijke platform-hik, opgelost door de gebruiker zelf vastgelopen deployments te annuleren in het dashboard. Geen structurele fix hiervoor; hou hier rekening mee als een deploy na een merge niet binnen ~1 min verschijnt op `amsterdamnow-article-generator.vercel.app` (check via Vercel MCP `get_deployment` op de alias, vergelijk `githubCommitSha` met de laatste merge-commit).

## Nuttige commando's/checks voor de volgende sessie

```bash
# Welke prompt/constraint staat er actief op productie:
curl -s "https://amsterdamnow-article-generator.vercel.app/api/prompts?kind=<kind>"
curl -s "https://amsterdamnow-article-generator.vercel.app/api/constraints?kind=<standaard|lijst>"

# Board-status (welke topics staan waar):
curl -s "https://amsterdamnow-article-generator.vercel.app/api/board"

# Eén verwerkingsstap handmatig triggeren (zelfde als de UI-knop):
curl -s -X POST "https://amsterdamnow-article-generator.vercel.app/api/topics/process" -H "Content-Type: application/json"

# Vastgelopen/mislukte topic terugzetten in de wachtrij:
curl -s -X PATCH "https://amsterdamnow-article-generator.vercel.app/api/topics/<id>" -H "Content-Type: application/json" -d '{"action":"retry"}'
```

Vercel project: `prj_sZS6Lu8ynmd8cDvui4wjnwpazaAP`, team: `team_4wTDEc1Ts78ncJALyuJ2t5pT` (voor de Vercel MCP-tools, indien beschikbaar).

Lokaal testen: `app/.env` bevat een Supabase `DATABASE_URL` die momenteel **niet werkt** (auth failed) — voor lokale runs die `.env` tijdelijk hernoemen (`mv app/.env app/.env.disabled`) zodat de app terugvalt op SQLite, en na afloop weer terugzetten. Vergeet niet `app/data/tool.db*` op te ruimen voor een schone testrun.
