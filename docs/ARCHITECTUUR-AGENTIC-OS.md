# NOW OS — architectuur voor de evolutie van de artikel-tool naar een agentic OS

Werktitel: **NOW OS**. Repo: `~/Claude/amsterdamnow-artikel-tool`. Dit document is de
leidende architectuurreferentie; wijzigt de architectuur, dan wijzigt dit document in
dezelfde PR (zelfde afspraak als `docs/DESIGN-MAP.md`).

---

## 1. Doel & principes

**Doel.** De huidige tool is één lineaire pipeline (onderwerp → wachtrij → schrijver →
beelden → WP-draft → auto-publish → carousel) met hardgecodeerde volgorde in
`app/lib/queue.ts` + `writer.ts`/`listWriter.ts`. NOW OS maakt daarvan een besturingslaag
waarin gespecialiseerde agents zelfstandig op gebeurtenissen reageren, binnen expliciete
mandaten, met volledige inspecteerbaarheid van elke run. Nieuwe capabilities (nieuwsbrief,
X, advertenties) worden dan een agent + connector erbij, geen verbouwing van de pipeline.

**Principes:**

1. **De huidige tool blijft in elke fase werken.** Geen big-bang. Elke laag wordt eerst
   naast de bestaande code gezet (shadow), dan omgeschakeld, dan pas wordt oud pad
   verwijderd.
2. **Hergebruik boven herbouw.** De fase-machine in `writer.ts` (StandaardPhase),
   `listWriter.ts` (ListPhase), de lease-claim in `db.ts` (`claimNextQueued`,
   `locked_at`/`lock_owner`, `recoverStaleTopics`, `infra_retries`) en de
   foutclassificatie (`errorKind.ts`) zijn al 80% van een agent-runtime. De kernel
   generaliseert die patronen; hij vervangt de code niet.
3. **Postgres is de bus, de queue én het geheugen.** Geen Redis/Kafka/extra infra zolang
   het niet moet. Eén `DATABASE_URL`, beide drivers (Postgres + SQLite-fallback) zoals nu
   in `db.ts` — nieuwe tabellen komen in **beide** init-functies (bestaande regel).
4. **Alles is een event, elke actie is een run.** Geen agent doet iets zonder een rij in
   `agent_runs`; geen zij-effect (WP-write, IG-publish) zonder trace-stap. Wat niet in de
   trace staat, is niet gebeurd.
5. **Mandaat vóór autonomie.** Elke agent start op het laagste autonomieniveau dat werkt
   ('alleen voorstellen' of 'na goedkeuring'). Opschalen naar 'autonoom' is een bewuste
   redactionele beslissing per agent per domein — zelfde filosofie als Wingman.
6. **Budget is een hard plafond, geen dashboard-metric.** Tokenkosten worden al per call
   gelogd (`lib/tokenCost.ts`, `[claude]`-regels); NOW OS maakt daar afdwingbare limieten
   van per agent en per connector.
7. **60s-serverless blijft de maat** zolang we op Vercel Hobby draaien: één modelcall of
   één zij-effect per tick, hervatbaar via bewaarde run-state (het bestaande
   `list_state`-patroon, gegeneraliseerd naar `agent_runs.state`).

---

## 2. Architectuuroverzicht — de 6 lagen

```
┌─────────────────────────────────────────────────────────────────┐
│ 6. Control plane (UI): Mission Control · agent-instellingen ·   │
│    goedkeuringen-inbox · observability · scheduler              │
├─────────────────────────────────────────────────────────────────┤
│ 3. Mandaatmodel   │ 5. Connectorregister (WP, Tavily, socials-  │
│    & goedkeuringen│    engine, beeldzoek, modelproviders, …)    │
├───────────────────┴─────────────────────────────────────────────┤
│ 1. Kernel / agent-runtime (orkestrator, runs, traces, retries)  │
├─────────────────────────────────────────────────────────────────┤
│ 2. Event-bus & werkgraaf (events, subscriptions, kanban=view)   │
├─────────────────────────────────────────────────────────────────┤
│ 4. Geheugen & kennislaag (entities, dedup, stijlgeheugen,       │
│    run-historie)                                                │
└─────────────────────────────────────────────────────────────────┘
```

### Laag 1 — Kernel / agent-runtime

**Verantwoordelijk voor:** agents registreren (definitie = prompt-kinds + tools +
model + budget + mandaat-verwijzing), runs starten op events, per tick precies één
run-stap uitvoeren, state bewaren, leases/timeouts/retries afhandelen, traces schrijven,
budget afdwingen vóór elke modelcall.

**Grens:** de kernel weet níets van journalistiek. Hij kent geen "artikel" of "research",
alleen agents, runs, events en stappen. Alle domeinlogica leeft in de agent-modules
(`app/lib/agents/*.ts`, zie §5), die de bestaande libs (`writer.ts`, `imageSearch.ts`,
`publisher.ts`, …) aanroepen.

Nieuwe code: `app/lib/kernel.ts` (tick-loop: claim run → laad agent-module → voer één
stap uit → schrijf trace + nieuwe events → geef lease vrij) en `app/lib/agentRegistry.ts`
(mapping `agents.slug` → module). `queue.ts` blijft in fase 1–2 bestaan als adapter en
verdwijnt daarna (§7).

### Laag 2 — Event-bus & werkgraaf

**Verantwoordelijk voor:** append-only `events`-tabel, subscriptions (welke agent
reageert op welk event-type, statisch gedefinieerd in de agent-definitie),
exactly-once-consumptie per (event, agent) via `event_consumptions`, en de werkgraaf:
de keten topic → artikel → publicatie → socials is een pad door de events, niet een
hardgecodeerde volgorde.

**Event-types (v1):** `topic.created`, `topic.validated`, `topic.rejected`,
`research.ready`, `angle.approved`, `angle.rejected`, `article.drafted`,
`article.curated`, `article.seo_ready`, `images.ready`, `article.ready_for_publish`,
`article.published`, `carousel.drafted`, `carousel.published`, `audit.finding`,
`connector.unhealthy`, `budget.exceeded`, `approval.requested`, `approval.decided`.

**Grens:** de bus levert af en garandeert idempotentie; hij interpreteert payloads niet.
Het kanban-board (`app/components/Pipeline.tsx`, `GET /api/board`) blijft bestaan als
**view**: `articlePhase()` in `types.ts` wordt gevoed vanuit topic/artikel-status zoals
nu, en krijgt er een event-gedreven activiteitenstrook naast (Mission Control, laag 6).
Het board wordt dus niet herbouwd; het krijgt een tweede databron.

### Laag 3 — Mandaatmodel & goedkeuringen

**Verantwoordelijk voor:** per agent per domein een autonomieniveau
(`voorstel` / `goedkeuring` / `autonoom`), een centrale goedkeuringen-inbox, en
escalatieregels (bv. Auditor-bevinding `fout` op een al gepubliceerd artikel → altijd
escaleren ongeacht mandaat). Een agent die een zij-effect wil plegen boven zijn mandaat
maakt een `approvals`-rij aan, zet zijn run op `waiting_approval` en de kernel hervat de
run pas na `approval.decided`.

**Grens:** mandaten gaan over **zij-effecten** (publiceren, WP-writes, IG-posts, geld
uitgeven boven budget), niet over interne stappen (research doen, tekst genereren mag
altijd — dat kost alleen budget, en budget is een eigen poort). Domeinen v1:
`wp-draft`, `wp-publish`, `socials-publish`, `queue-intake`, `media-upload`,
`seo-mutatie`, `budget-overschrijding`.

### Laag 4 — Geheugen & kennislaag

**Verantwoordelijk voor:** de entiteitenstore (venues, events, buurten, personen) als
canonieke bron waar dedup, research en beeldnaamgeving op leunen; embedding-zoek voor
"hebben we hier al over geschreven"; stijlgeheugen (curator-afkeuringen, handmatige
redigeer-feedback van Martijn, auditor-bevindingen) dat als context de schrijf- en
curatorprompts in gaat; run-historie als leerbron (welke invalshoeken haalden de poort,
welke beeldqueries scoorden).

**Grens:** geheugen adviseert, het beslist niet. De bestaande `wp_posts`-dedup
(`lib/dedup.ts`, `lib/wpSync.ts`) blijft de harde poort; entities verrijken hem
(alias-matching vóór de Haiku-judge). Embeddings zijn pgvector-optioneel: zonder
extensie valt de laag terug op de bestaande lexicale matching (`normalizeTitle`/
`lexicalCandidates`) — zelfde fail-open-stijl als de rest van de codebase.

### Laag 5 — Tool-/connectorregister

**Verantwoordelijk voor:** elke externe afhankelijkheid wordt een `connectors`-rij met
config, health, budget en rate-limit. De bestaande `app_settings`-keys
(`wordpress_connection` in `wpConfig.ts`, `socials_engine` in `socialsEngine.ts`,
`tavily_api_key` in `tavilyConfig.ts`, `model_provider` in `modelConfig.ts`) migreren
hierheen; de resolver-functies (`getWpUrl()`, `getTavilyApiKey()`, …) blijven de enige
toegangspoort en lezen voortaan uit het register. Health-checks hergebruiken de
bestaande test-routes (`/api/koppelingen/*/test`).

**Grens:** een connector is dom transport + credentials + limieten. Beslissen wát er
door de connector gaat is agent-werk. Nieuwe connectors (nieuwsbrief, X, TikTok,
advertenties) = rij + adaptermodule in `app/lib/connectors/`, geen kernelwijziging.

### Laag 6 — Control plane (UI)

**Verantwoordelijk voor:** vier schermen naast de bestaande navigatie
(`TopBar.tsx`):

- **Mission Control** (`/app/mission-control`): live run-feed, per agent status/kosten
  vandaag, open goedkeuringen-teller, laatste events. Polling zoals `Pipeline.tsx` nu
  `/api/board` polt.
- **Agents** (`/app/instellingen` krijgt per agent een rail-item, hergebruik van het
  bestaande rail+paneel-patroon uit `instellingen/page.tsx` + `meta.ts`): mandaten,
  prompt-koppeling (bestaande `PromptEditor.tsx`/versielade), model-keuze (patroon
  `ModelPanel.tsx`), budget.
- **Observability** (`/app/runs` + `/app/runs/[id]`): trace per run (stappen, tokens,
  kosten uit `tokenCost.ts`, foutklasse uit `errorKind.ts`), retry/cancel-knoppen.
- **Goedkeuringen-inbox** (`/app/goedkeuringen` + badge in TopBar): open approvals met
  diff/preview van het voorgestelde zij-effect, approve/reject met reden.

**Grens:** de UI muteert alleen via de API-routes uit §6; geen directe db-toegang
buiten de bestaande patronen (server components + `force-dynamic` routes).

---

## 3. Datamodel

Alle tabellen in **beide** drivers (`initSqlite()` én `initPostgres()` in `db.ts`,
bestaande regel). Typen hieronder in Postgres-notatie; SQLite-vertaling volgt het
bestaande patroon (TEXT/INTEGER/REAL, JSON als TEXT).

### Nieuwe tabellen

**`agents`** — definitie per agent (één rij per agent, geseed bij migratie):

| kolom | type | betekenis |
|---|---|---|
| id | SERIAL PK | |
| slug | TEXT UNIQUE | `scout`, `researcher`, `schrijver`, `beeldredacteur`, `stijlcurator`, `auditor`, `publisher`, `socials`, `seo` |
| name | TEXT | weergavenaam |
| enabled | BOOLEAN default true | uitzetten = agent reageert nergens meer op |
| subscriptions | JSONB | event-types waarop deze agent triggert |
| prompt_kinds | JSONB | verwijzing naar `prompts.kind`-waarden die deze agent gebruikt (bestaand versiebeheer blijft) |
| model | JSONB | `{provider, model, visionModel?}` — default uit `modelConfig.ts`, per agent overridebaar |
| tools | JSONB | connector-slugs die deze agent mag aanroepen |
| budget | JSONB | `{maxCentsPerDay, maxCentsPerRun, maxTokensPerRun}` |
| config | JSONB | agent-specifiek (bv. scout: scan-interval; publisher: interval — vervangt `app_settings.autopublish` op termijn) |
| created_at / updated_at | TIMESTAMPTZ | |

**`agent_runs`** — elke activering van een agent:

| kolom | type | betekenis |
|---|---|---|
| id | SERIAL PK | |
| agent_id | INT FK agents | |
| trigger_event_id | INT FK events NULL | null bij cron-/handmatige start |
| topic_id | INT FK topics NULL | koppeling met bestaand werk |
| post_id | INT NULL | WordPress-artikel-id (zoals `topics.post_id`) |
| status | TEXT | `queued` `running` `waiting_approval` `paused` `done` `failed` `cancelled` |
| step | TEXT | huidige stap (generalisatie van `topics.phase`) |
| state | JSONB | hervatbare tussenstand (generalisatie van `topics.list_state`) |
| attempts | INT default 0 | fase-claims, zoals `topics.attempts` |
| infra_retries | INT default 0 | transiënte herkansingen, cap zoals `MAX_INFRA_RETRIES` |
| locked_at / lock_owner | TIMESTAMPTZ / TEXT | lease, zelfde mechaniek als `claimNextQueued` |
| error / error_kind | TEXT / TEXT | foutmelding + klasse uit `errorKind.ts` |
| tokens_in / tokens_out | INT | som over stappen |
| cost_cents | INT | som over stappen (bron: `tokenCost.ts`) |
| created_at / started_at / finished_at | TIMESTAMPTZ | |

**`run_steps`** — trace (append-only, één rij per uitgevoerde stap):

| kolom | type |
|---|---|
| id | SERIAL PK |
| run_id | INT FK agent_runs |
| seq | INT |
| name | TEXT (bv. `research`, `schrijf-retry`, `wp-create-draft`) |
| status | TEXT (`ok` `failed` `skipped`) |
| detail | JSONB (in-/output-samenvatting, geen volledige prompts) |
| tokens_in / tokens_out / cost_cents / duration_ms | INT |
| created_at | TIMESTAMPTZ |

**`events`** — de bus (append-only):

| kolom | type |
|---|---|
| id | SERIAL PK |
| type | TEXT (zie §2 laag 2) |
| payload | JSONB |
| topic_id / post_id | INT NULL (voor de werkgraaf-view) |
| source_agent_id | INT FK agents NULL (null = systeem/UI) |
| source_run_id | INT FK agent_runs NULL |
| dedup_key | TEXT NULL UNIQUE (idempotent produceren) |
| created_at | TIMESTAMPTZ |

**`event_consumptions`** — exactly-once per (event, agent):

| kolom | type |
|---|---|
| event_id | INT FK events |
| agent_id | INT FK agents |
| run_id | INT FK agent_runs NULL |
| status | TEXT (`claimed` `done` `failed` `skipped`) |
| created_at | TIMESTAMPTZ |
| PK | (event_id, agent_id) |

**`mandates`** — autonomie per agent per domein:

| kolom | type |
|---|---|
| id | SERIAL PK |
| agent_id | INT FK agents |
| domain | TEXT (`wp-draft`, `wp-publish`, `socials-publish`, `queue-intake`, `media-upload`, `seo-mutatie`, `budget-overschrijding`) |
| level | TEXT (`voorstel` `goedkeuring` `autonoom`) |
| constraints | JSONB (bv. `{maxPerDay: 3}`, `{alleenEvergreen: true}`) |
| updated_at / updated_by | TIMESTAMPTZ / TEXT |
| UNIQUE | (agent_id, domain) |

**`approvals`** — de inbox:

| kolom | type |
|---|---|
| id | SERIAL PK |
| run_id | INT FK agent_runs |
| agent_id | INT FK agents |
| domain | TEXT |
| action | TEXT (menselijk leesbaar: "Publiceer 'Nieuw café in Oost'") |
| payload | JSONB (wat er precies gebeurt bij approve; preview-data voor de UI) |
| status | TEXT (`open` `approved` `rejected` `expired`) |
| reason | TEXT NULL (afwijsreden of escalatie-uitleg) |
| requested_at / decided_at | TIMESTAMPTZ |
| decided_by | TEXT NULL |
| expires_at | TIMESTAMPTZ NULL (verlopen = run faalt netjes, geen stille uitvoering) |

**`entities`** — kennislaag:

| kolom | type |
|---|---|
| id | SERIAL PK |
| kind | TEXT (`venue` `event` `buurt` `persoon`) |
| name / slug | TEXT |
| aliases | JSONB |
| address / neighborhood / website | TEXT NULL |
| wp_post_ids | JSONB (artikelen over deze entiteit) |
| attributes | JSONB (openingstijden, capaciteit, type-token voor `mediaName.ts`) |
| embedding | vector(1536) NULL (alleen Postgres+pgvector; SQLite: kolom afwezig, lexicale fallback) |
| first_seen_at / updated_at | TIMESTAMPTZ |

**`feedback`** — stijlgeheugen + leerbron:

| kolom | type |
|---|---|
| id | SERIAL PK |
| post_id | INT NULL |
| run_id | INT FK agent_runs NULL |
| source | TEXT (`curator` `auditor` `martijn` `publisher`) |
| kind | TEXT (`stijl` `feit` `beeld` `invalshoek`) |
| verdict | TEXT (`goed` `fout` `afgekeurd`) |
| note | TEXT |
| created_at | TIMESTAMPTZ |

**`connectors`** — register:

| kolom | type |
|---|---|
| id | SERIAL PK |
| slug | TEXT UNIQUE (`wordpress` `socials-engine` `tavily` `serper` `pexels` `anthropic` `omniroute` …) |
| name / kind | TEXT (kind: `cms` `socials` `search` `images` `model` `mail` …) |
| config | JSONB (secrets; GET-routes maskeren zoals `tavily/route.ts` nu doet) |
| enabled | BOOLEAN |
| last_health_at / last_health_ok / last_health_error | TIMESTAMPTZ / BOOLEAN / TEXT |
| rate_limit | JSONB (`{perMinute, perDay}`) |
| budget | JSONB (`{maxCentsPerDay}`) |
| created_at / updated_at | TIMESTAMPTZ |

**`usage_log`** — kosten-grootboek (voedt budgetten én Mission Control):

| kolom | type |
|---|---|
| id | SERIAL PK |
| run_id / agent_id / connector_id | INT NULL |
| label | TEXT (bestaand labelformaat `<fase>#<id>` uit `claude.ts`) |
| tokens_in / tokens_out / cost_cents / duration_ms | INT |
| created_at | TIMESTAMPTZ |

Bron: dezelfde plek waar `request()` in `lib/claude.ts` nu de `[claude]`-logregel
schrijft — die functie krijgt er een db-insert bij. Tavily/Serper-calls loggen per
call een vaste kostprijs via hun adapters.

### Relatie met bestaande tabellen

- **`topics` en `list_articles` blijven.** Een topic is het werkstuk; `agent_runs`
  verwijzen ernaar via `topic_id`. In fase 3 verhuizen `phase`/`list_state` naar
  `agent_runs.step`/`state`; de kolommen blijven staan tot het oude pad weg is.
- **`prompts` / `constraints` blijven ongewijzigd** (versiebeheer + `PromptEditor.tsx`).
  Agents verwijzen via `prompt_kinds` naar bestaande kinds (`research`, `schrijf`,
  `curator`, `audit-claims`, `audit-beeld`, …). Nieuwe agents = nieuwe kinds.
- **`app_settings`** blijft voor UI-voorkeuren; de koppelings-keys migreren naar
  `connectors`, de `autopublish`-key naar `agents.config` van de Publisher.
- **`sources` / `source_findings`** worden de configuratie + historie van de Scout
  (ongewijzigd schema; de Scout-agent leest/schrijft ze).
- **`audits` / `audit_findings`** blijven; de Auditor-agent schrijft er bovendien
  `audit.finding`-events en `feedback`-rijen bij.
- **`image_candidates`, `wp_posts`, `publish_meta`** ongewijzigd.

---

## 4. Agent-runtime concreet op de huidige stack

### Tick-model (Vercel serverless)

Eén nieuwe route **`GET/POST /api/kernel/tick`** (auth: `Bearer CRON_SECRET` óf
client-poll zonder auth, exact het patroon van `/api/publish/tick`). Eén tick doet:

1. `recoverStaleRuns()` — leases ouder dan de stap-timeout terug naar `queued`,
   `infra_retries + 1`, boven de cap → `failed` (generalisatie van
   `recoverStaleTopics`).
2. **Event-dispatch**: nieuwe events matchen tegen `agents.subscriptions`; per match een
   `event_consumptions`-claim (INSERT … ON CONFLICT DO NOTHING — de PK garandeert
   exactly-once) en een `agent_runs`-rij (`queued`).
3. **Run-claim**: één run claimen. Postgres: `SELECT … FOR UPDATE SKIP LOCKED LIMIT 1`;
   SQLite: de bestaande lease-UPDATE-truc uit `claimNextQueued`. Concurrency-cap per
   agent in `agents.config` (default 1, zoals de queue nu één taak per tik doet).
4. **Eén stap uitvoeren**: kernel laadt de agent-module, geeft `(run, state, tools)`
   mee; de stap doet **max één modelcall of één extern zij-effect** (60s-regel),
   retourneert `{nextStep, state, events[], approval?}`; kernel persisteert alles in
   één transactie: run-update + `run_steps`-rij + nieuwe events.
5. Mandaat-poort: vraagt de stap een zij-effect boven mandaat → `approvals`-rij,
   run → `waiting_approval`. `POST /api/approvals/[id]/approve` zet de run terug op
   `queued` met een `approved`-vlag in de state.

**Drivers van de tick** (drie, elkaar aanvullend, zoals nu ook board-poll + cron naast
elkaar bestaan):
- `Pipeline.tsx`/Mission Control pollen elke 30–60s (client-driven, zoals
  `/api/publish/tick` nu);
- de Vercel-cron (Hobby: 1×/dag) als vangnet in `vercel.json`;
- optioneel een externe pinger (bestaand launchd-patroon op Martijns Mac) voor
  's nachts.

**Valkuil die blijft gelden**: elke nieuwe geneste route in `vercel.json` expliciet
rewriten vóór de catch-all, statische segmenten vóór `[id]` (DESIGN-MAP §4-valkuil 1).

### Idempotentie, retries, timeouts, hervatten

- **Idempotent produceren**: events krijgen een `dedup_key`
  (bv. `article.drafted:{postId}`); dubbel emitten is een no-op.
- **Idempotent consumeren**: PK `(event_id, agent_id)` op `event_consumptions`.
- **Idempotente zij-effecten**: elk extern effect schrijft vóóraf een `run_steps`-rij
  met status `claimed` en het externe id erin zodra bekend; een herstart van de stap
  checkt eerst of het effect al bestaat (patroon bestaat al: `claimed_post_ids` op
  `audits`, en de publish-recovery in de socials-engine).
- **Retries**: transiënte fouten (`errorKind.ts`-klassen infra/rate-limit) → `queued`
  met `infra_retries+1` en exponentiële backoff in `locked_at`; inhoudelijke fouten →
  agent-eigen herkansingslogica in de state (zoals `schrijfAttempts`,
  `curatorRounds`, `invalshoekHerstelRounds` nu) en daarna `failed`.
- **Timeouts**: stap-timeout = lease-duur (default 120s, per agent instelbaar);
  verlopen lease = stap niet afgerond, zie recover hierboven.
- **Hervatten**: state in `agent_runs.state` (JSONB) — exact het `StandaardState`-
  patroon uit `types.ts`. Een gecancelde/gefaalde run kan met `POST /api/runs/[id]/retry`
  vanaf de laatste geslaagde stap verder.
- **Pauze**: de bestaande accountbrede quotum-pauze (`getQueuePause` in `db.ts`)
  generaliseert naar kernel-niveau: `budget.exceeded`/`connector.unhealthy` pauzeert
  alleen de runs die die connector nodig hebben, niet alles.

### Wanneer een aparte worker, en welke

De tick-architectuur is bewust worker-compatibel: de tick-functie is gewone
TypeScript in `app/lib/kernel.ts` en heeft geen Next-context nodig. Een aparte worker
wordt nodig zodra één van deze drie zich voordoet:

1. stappen die structureel niet in 60s passen (bv. video-render voor TikTok, grote
   embedding-backfills);
2. gewenste latentie < poll-interval terwijl er geen browser open staat
   ('s nachts publiceren binnen minuten van een event);
3. Vercel-cron-limieten gaan knellen en client-polling is niet meer de hoofddriver.

**Optie A (aanbevolen): langdraaiende Node-worker op een goedkope host** (Hetzner
CX-instapje of Fly.io machine). Zelfde repo, entry `app/worker.ts`: een while-loop die
`kernelTick()` aanroept met `LISTEN/NOTIFY` op Postgres (trigger op `events`-insert)
en een 30s-fallback-poll. Deploy als klein Dockerfile naast de Vercel-deploy; geen
routewijziging nodig — Vercel-routes en worker delen dezelfde db en dezelfde code.
**Optie B (gratis, fragieler): launchd op Martijns Mac** — bestaand patroon
(`nl.i2o.*`-jobs zoals de whatsapp-mcp en fable-bots): een plist die
`node worker.js` draait tegen de Supabase-`DATABASE_URL`. Prima als brug; niet als
eindstation (Mac dicht = OS traag, alleen het Vercel-vangnet blijft).

---

## 5. De negen agents

Per agent: input-events → stappen → output-events, tools (connectors), mandaat-default,
en welk bestaand bestand het werk al doet. Alle agent-modules komen in
`app/lib/agents/<slug>.ts`; ze **importeren** de bestaande libs, ze dupliceren ze niet.

### 5.1 Scout

- **Input**: cron/tick (interval in `agents.config`, nu hardcoded in de scan-flow) en
  handmatig `POST /api/agents/scout/run`.
- **Stappen**: per bron pagina ophalen → `content_hash`-check → vondsten extraheren +
  redactionaliseren (`editorializeTitles()`, Haiku) → WP-dedup-check
  (`checkTopicAgainstWp`, cap 3 concurrent) → topic-voorstel.
- **Output**: `topic.created` (bij mandaat `autonoom` op domein `queue-intake` direct in
  de wachtrij, zoals nu) of `approval.requested` (bij `goedkeuring`).
- **Tools**: `tavily` (extractie), `anthropic`/`omniroute`, `wordpress` (dedup-sync).
- **Mandaat-default**: `queue-intake: autonoom` — dit doet de scanner vandaag al
  onbewaakt; geen reden om terug te schroeven.
- **Bestaande code**: `lib/scanner.ts`, `/api/sources/scan`, tabellen
  `sources`/`source_findings`, UI `app/app/bronnen/page.tsx`. De agent-module is een
  dunne wrapper; de UI-pagina blijft de bronnen-CRUD.

### 5.2 Researcher

- **Input**: `topic.created` (na validatie; `topicValidation.ts` draait bij intake).
- **Stappen**: research (Tavily + extractie) → entiteitsverificatie
  (`verifyEntityFields`) → factscore (`researchFactScore`) → zo nodig aanvullende
  ronde (max 1, zoals `researchRounds` nu) → quote-winning (`acceptBronQuote`).
  Verrijking nieuw: eerst `entities` raadplegen (bekend venue = adres/website/
  historie gratis) en na afloop de entiteit upserten.
- **Output**: `research.ready` (payload: research-JSON-referentie in run-state,
  factScore, entiteit-id) of `topic.rejected` (entiteitscontrole hard gefaald).
- **Tools**: `tavily`, `anthropic`/`omniroute`.
- **Mandaat-default**: geen zij-effect-domein — alleen budget begrenst hem.
- **Bestaande code**: `stepResearch`/`stepResearchAanvullend`/`verifyEntityFields` in
  `writer.ts`, `lib/tavily.ts`, `lib/researchProfiles.ts`, `lib/relevance.ts`. Fase 3
  knipt deze functies uit `writer.ts` los naar `agents/researcher.ts` (verplaatsen,
  niet herschrijven).

### 5.3 Schrijver

- **Input**: `angle.approved` (zie hieronder: de invalshoek-poort hoort bij de
  Schrijver als eerste stap) — praktisch: `research.ready`.
- **Stappen**: invalshoek-poort (`stepInvalshoek`; afwijzing → herstelronde via
  Researcher, max 1, zoals `invalshoekHerstelRounds`) → schrijven
  (`FAST_WRITE_MODEL`, schema's uit `schemas.ts`) → validatie (`validation.ts`) →
  gerichte reparatie of volledige retry (`rejectViolations`-pad) → WP-draft
  (`createDraft` in `wp.ts`). Lijstartikelen: de ListPhase-machine uit
  `listWriter.ts` wordt de lijst-variant van deze agent (zelfde agent, ander
  stappenpad — zoals `queue.ts` nu al splitst op `topic.type`).
- **Output**: `article.drafted` (payload: postId) of `angle.rejected`/`topic.rejected`.
- **Tools**: `anthropic`/`omniroute`, `wordpress`.
- **Mandaat-default**: `wp-draft: autonoom` (drafts zijn onzichtbaar voor lezers; dit
  is de bestaande situatie).
- **Bestaande code**: `writer.ts` (stepInvalshoek/stepSchrijf/stepSchrijfRetry),
  `listWriter.ts`, `validation.ts`, `schemas.ts`, `wp.ts`.

### 5.4 Stijlcurator

- **Input**: `article.drafted`.
- **Stappen**: curator-beoordeling (bestaande curator-fase, prompt-kind `curator`) →
  goed: door; afgekeurd: terug naar Schrijver met feedback (max 1 ronde,
  `curatorRounds`, daarna fail-open door — bestaand gedrag). Nieuw: elke afkeuring
  wordt een `feedback`-rij (source `curator`), en de curatorprompt krijgt de laatste
  N relevante feedback-rijen mee (stijlgeheugen, laag 4).
- **Output**: `article.curated`.
- **Tools**: `anthropic`/`omniroute`.
- **Mandaat-default**: geen zij-effecten.
- **Bestaande code**: curator-fase in `writer.ts` (`curatorRounds` in `types.ts`),
  prompt-kind in `prompts`.

### 5.5 SEO-agent

- **Input**: `article.curated`.
- **Stappen**: meta/SEO-velden genereren en naar WP schrijven (bestaande seo-fase in
  `writer.ts` + `lib/seoBackfill.ts` voor bestaande artikelen). Uitbreidbaar:
  interne-linksuggesties op basis van `entities`/`wp_posts`.
- **Output**: `article.seo_ready`.
- **Tools**: `anthropic`/`omniroute`, `wordpress`.
- **Mandaat-default**: `seo-mutatie: autonoom` voor nieuwe drafts;
  `goedkeuring` voor backfill-mutaties aan al gepubliceerde artikelen.
- **Bestaande code**: seo-fase in `writer.ts`, `seoBackfill.ts`.

### 5.6 Beeldredacteur

- **Input**: `article.seo_ready` (en handmatig via de bestaande ↻-knoppen).
- **Stappen**: kandidaten zoeken (`imageSearch.ts`, max 48) → scoren
  (`imageScore.ts`, thumbnails) → autofill featured/slider/inline
  (drempel `AUTO_MIN_SCORE`) → lijstartikelen: itemfoto-loop (één item per stap —
  past exact op het één-stap-per-tick-model) → upload + naamgeving
  (`mediaName.ts`/`imageNaming.ts`; type-token straks uit `entities.attributes`).
- **Output**: `images.ready` zodra de klaar-regel gehaald is
  (`REQUIRED_IMAGES`/`listImagesReady` in `types.ts`); anders `approval.requested` c.q.
  melding (bestaand `list.meldingen`-gedrag) zodat de redactie handmatig kiest.
- **Tools**: `openverse/commons/pexels/serper` (image-connectors),
  `anthropic` (vision), `wordpress` (media-upload).
- **Mandaat-default**: `media-upload: autonoom` (bestaande autofill doet dit al);
  het definitieve beeldoordeel blijft de facto bij de redactie via het board.
- **Bestaande code**: `imageSearch.ts`, `imageScore.ts`,
  `/api/articles/[id]/candidates{,/search,/score,/autofill}`, autofill-drivers in
  `Pipeline.tsx`/`ArticleDetail.tsx` (die drivers vervallen in fase 3: de kernel
  loopt de stappen, de UI toont alleen voortgang).

### 5.7 Auditor

- **Input**: `article.ready_for_publish` (pre-publicatie-steekproef, nieuw) en
  `article.published` (bestaande post-hoc audit), plus handmatig vanaf het bord.
- **Stappen**: claimcheck (Serper, onafhankelijke index — `auditSearch.ts`),
  beeldcheck (vision + bestandsnaam-heuristiek), promptlek-check; één artikel per
  stap (bestaand `claimed_post_ids`-patroon).
- **Output**: `audit.finding` per bevinding + `feedback`-rijen. Escalatieregel
  (laag 3): verdict `fout` op een gepubliceerd artikel → altijd `approval.requested`
  richting inbox, ongeacht mandaten elders.
- **Tools**: `serper`, `anthropic` (vision), `wordpress` (lezen).
- **Mandaat-default**: geen — de auditor **wijzigt niets** (hard principe uit
  `docs/auditor-ontwerp.md`; blijft staan). Onafhankelijkheid blijft ook staan:
  `agents/auditor.ts` importeert niets uit `writer.ts`/`validation.ts`.
- **Bestaande code**: `auditor.ts`, `auditSearch.ts`, `auditSchemas.ts`,
  tabellen `audits`/`audit_findings`, `/api/audit/*`.

### 5.8 Publisher

- **Input**: `images.ready` → intern `article.ready_for_publish`; verder tick-gedreven
  op interval (bestaand gedrag `/api/publish/tick`).
- **Stappen**: classificatie (`classifyArticles`, één Haiku-call, `publish_meta`) →
  selectie (`pickNextForPublish`: evergreen/event-tiers + categorie-balans) →
  mandaat-poort → WP-publish (max één per tick).
- **Output**: `article.published`.
- **Tools**: `wordpress`, `anthropic`.
- **Mandaat-default**: `wp-publish: goedkeuring` bij livegang van het mandaatmodel,
  door Martijn per constraint op te schalen naar `autonoom` (bv.
  `{maxPerDay: N, alleenGeclassificeerd: true}` — dan is het bestaande
  auto-publishgedrag exact gereproduceerd, maar nu expliciet gemandateerd).
- **Bestaande code**: `publisher.ts`, `/api/publish/tick`, `/api/publish/settings`,
  `AutoPublishPanel.tsx` (paneel wordt het mandaat+config-paneel van deze agent).

### 5.9 Socials-agent

- **Input**: `article.published` (voorstel-modus: zelf carousel-concept genereren) en
  handmatig (bestaande editor-flow blijft volledig intact).
- **Stappen**: template-keuze (NOW-families uit engine-manifest) → generate
  (`generateCarousel` via engine `POST /api/generate`) → beeldverrijking →
  concept klaarzetten → mandaat-poort → publish (engine, incl. bestaande
  publish-recovery en max-10-slides-guard).
- **Output**: `carousel.drafted`, `carousel.published`.
- **Tools**: `socials-engine` (Bearer server-side, zoals nu), later `x`, `tiktok`,
  `nieuwsbrief` als extra connectors met eigen mandaatdomeinen.
- **Mandaat-default**: `socials-publish: goedkeuring` — een IG-post is publiek en
  onherroepelijker dan een WP-artikel.
- **Bestaande code**: `carousel.ts`, `carouselEngine.ts`, `socialsEngine.ts`,
  `/api/carousel/*`, `CarouselGenerator.tsx` e.v. (UI ongewijzigd; de agent
  automatiseert alleen het voortraject tot concept).

---

## 6. API-oppervlak

Nieuwe routes naast de bestaande (`admin, articles, audit, board, carousel,
constraints, koppelingen, list-articles, model, prompts, publish, queue, sources,
topics, wp, wp-sync`). Alle nieuwe geneste routes → rewrite-regels in `vercel.json`
(valkuil 1), `force-dynamic`, `NextResponse.json`.

| Route | Methoden | Doel |
|---|---|---|
| `/api/kernel/tick` | GET/POST | de kernel-tick (Bearer `CRON_SECRET` of client-poll) |
| `/api/agents` | GET | alle agents + status/kosten-vandaag |
| `/api/agents/[slug]` | GET/PATCH | definitie lezen/wijzigen (enabled, model, budget, config) |
| `/api/agents/[slug]/run` | POST | handmatige start |
| `/api/runs` | GET | filter op `?agent=&status=&topic=` |
| `/api/runs/[id]` | GET | run + trace (`run_steps`) |
| `/api/runs/[id]/retry` | POST | hervatten vanaf laatste geslaagde stap |
| `/api/runs/[id]/cancel` | POST | status → cancelled, lease vrij |
| `/api/events` | GET | query op `?type=&topic=&after=` (Mission Control-feed) |
| `/api/approvals` | GET | inbox (`?status=open` default) |
| `/api/approvals/[id]/approve` | POST | goedkeuren → run hervat |
| `/api/approvals/[id]/reject` | POST | afwijzen met reden → run faalt netjes + `feedback`-rij |
| `/api/mandates` | GET/PUT | matrix agent×domein (PUT = hele rijset per agent) |
| `/api/connectors` | GET | register + health (secrets gemaskeerd, patroon `tavily/route.ts`) |
| `/api/connectors/[slug]` | POST/DELETE | config zetten / override wissen |
| `/api/connectors/[slug]/test` | POST | health-check (hergebruik bestaande `koppelingen/*/test`-logica) |
| `/api/entities` | GET/POST | zoeken (`?q=`, lexicaal + embedding) / upsert |
| `/api/entities/[id]` | GET/PATCH | detail + artikelhistorie |

De bestaande `koppelingen/*`-routes blijven tijdens de migratie als façade over
`/api/connectors` en verdwijnen als de Instellingen-panelen zijn omgehangen. `/api/queue`
en `/api/publish/tick` blijven tot fase 3 resp. 2 en worden dan aliassen van
`/api/kernel/tick`.

---

## 7. Migratiepad in fases

Per fase: zelfstandige waarde, en de PR-brokken (elk brok = één PR volgens de
branch→PR→merge-regel uit `CLAUDE.md`; geen tijdschattingen).

### Fase 0 — Fundament + shadow-events (tool blijft exact zoals hij is)

Waarde: volledige zichtbaarheid op wat de pipeline doet en kost, zonder gedragswijziging.

- **PR 0.1** — tabellen `events`, `agent_runs`, `run_steps`, `usage_log` in beide
  db-inits + seed van de 9 `agents`-rijen (subscriptions nog leeg). Types in `types.ts`.
- **PR 0.2** — event-emissie in bestaande code: `writer.ts`/`listWriter.ts`
  (fase-overgangen), `publisher.ts` (`article.published`), `scanner.ts`
  (`topic.created`), `auditor.ts` (`audit.finding`), carousel-publish
  (`carousel.published`). Alleen emitten, niemand consumeert.
- **PR 0.3** — `usage_log`-insert in `request()` (`claude.ts`) naast de bestaande
  `[claude]`-logregel; Tavily/Serper-adapters loggen per call.
- **PR 0.4** — Mission Control v0 (read-only): `/app/mission-control`, `/api/events`,
  `/api/runs` (nog leeg), kosten-per-dag uit `usage_log`.

### Fase 1 — Kernel-tick + eerste twee agents (Scout, Publisher)

Waarde: de twee cron-vormige processen draaien als echte runs met trace en retry.

- **PR 1.1** — `lib/kernel.ts` (recover/dispatch/claim/step), `event_consumptions`,
  `/api/kernel/tick` + rewrite + poll vanuit `Pipeline.tsx`.
- **PR 1.2** — `agents/scout.ts` als wrapper om `scanner.ts`; `/api/sources/scan`
  blijft werken maar start voortaan een run.
- **PR 1.3** — `agents/publisher.ts` als wrapper om `publisher.ts`;
  `/api/publish/tick` wordt alias van de kernel-tick voor deze agent.
- **PR 1.4** — Observability: `/app/runs` + `/app/runs/[id]` met trace, retry, cancel.

### Fase 2 — Mandaten + goedkeuringen-inbox

Waarde: expliciete controle over publiceren; de basis voor elke verdere autonomie.

- **PR 2.1** — tabellen `mandates` + `approvals`, kernel-poort
  (`waiting_approval`-flow), `/api/mandates`, `/api/approvals/*`.
- **PR 2.2** — Publisher onder mandaat (`wp-publish`), `AutoPublishPanel.tsx` wordt
  agent-paneel met mandaatkeuze + constraints.
- **PR 2.3** — inbox-UI `/app/goedkeuringen` + TopBar-badge + toasts.
- **PR 2.4** — escalatieregels (auditor-`fout`-op-gepubliceerd → inbox) + `expires_at`.

### Fase 3 — Pipeline op de event-graaf (Researcher, Schrijver, Curator, SEO, Beeldredacteur)

Waarde: de vaste ketting wordt een graaf; het bord wordt een view; autofill-drivers
verhuizen van de browser naar de kernel.

- **PR 3.1** — `writer.ts` opknippen naar `agents/researcher.ts` + `agents/schrijver.ts`
  (verplaatsen; `writer.ts` her-exporteert tijdelijk). Run-state vervangt
  `topics.list_state` voor nieuwe topics; oude topics lopen op het oude pad leeg.
- **PR 3.2** — `agents/stijlcurator.ts` + `agents/seo.ts`; `feedback`-tabel + eerste
  stijlgeheugen-injectie in de curatorprompt.
- **PR 3.3** — `agents/beeldredacteur.ts`; itemfoto-loop kernelgedreven; client-drivers
  uit `Pipeline.tsx`/`ArticleDetail.tsx` weg (UI toont run-voortgang).
- **PR 3.4** — `queue.ts`/`/api/queue` afbouwen tot alias; board leest fase uit runs;
  `topics.phase`/`list_state` bevroren (lezen mag, schrijven niet meer).
- **PR 3.5** — lijstpipeline (`listWriter.ts`) op hetzelfde stramien.

### Fase 4 — Geheugen & kennislaag

Waarde: minder dubbele onderwerpen, rijkere research, lerende curator.

- **PR 4.1** — `entities` + `/api/entities`; upsert vanuit Researcher; backfill-route
  uit `wp_posts` (admin-Bearer-patroon zoals `backfill-inline`).
- **PR 4.2** — dedup-verrijking: alias-match vóór de Haiku-judge in `dedup.ts`.
- **PR 4.3** — pgvector-embeddings (alleen Postgres; lexicale fallback) voor
  "al over geschreven?"-zoek en verwante-artikelen voor de SEO-agent.
- **PR 4.4** — feedbackknoppen in `ArticleDetail.tsx` (Martijn-feedback →
  `feedback`-rijen → schrijf-/curatorprompt-context).

### Fase 5 — Connectorregister + budgetten

Waarde: één plek voor keys/health/limieten; harde kostenplafonds; uitbreidbaarheid.

- **PR 5.1** — `connectors`-tabel + migratie van de vier `app_settings`-keys; resolvers
  (`wpConfig.ts`, `tavilyConfig.ts`, `socialsEngine.ts`, `modelConfig.ts`) lezen uit het
  register; `koppelingen/*`-routes als façade.
- **PR 5.2** — health-loop in de kernel-tick + `connector.unhealthy`-events +
  gerichte pauze (vervangt de accountbrede `queue_pause` waar mogelijk).
- **PR 5.3** — budget-afdwinging: kernel checkt `usage_log`-som tegen agent-/
  connector-budget vóór elke stap; `budget.exceeded` → pauze + inbox-melding.
- **PR 5.4** — eerste nieuwe connector als proef van de uitbreidbaarheid
  (nieuwsbrief), met eigen agent-subscription op `article.published` en mandaat-domein.

### Fase 6 — Aparte worker (alleen als de triggers uit §4 zich voordoen)

- **PR 6.1** — `app/worker.ts` + Dockerfile + `LISTEN/NOTIFY`; kernel-code ongewijzigd.
- **PR 6.2** — deploy-doc + launchd-variant als goedkope brug.

---

## 8. Risico's & keuzes (beslispunten)

1. **Postgres-als-bus vs. echte queue**: gekozen voor Postgres — één infra, en het
   volume (tientallen artikelen/dag) rechtvaardigt niets zwaarders. Herzien bij >10
   runs/seconde, wat hier niet realistisch is.
2. **SQLite-pariteit kost dubbel schema-onderhoud**; bewust behouden (lokaal testen
   zonder Supabase, DESIGN-MAP §5), maar pgvector/`SKIP LOCKED` zijn Postgres-only met
   fallbacks — accepteer dat lokaal gedrag daar iets afwijkt.
3. **writer.ts opknippen (fase 3) is de riskantste stap**: verplaatsen zonder
   herschrijven, oude topics op het oude pad laten leeglopen, en pas daarna opruimen.
4. **Client-poll als hoofddriver** betekent: geen browser open = alleen cron-vangnet.
   Bewust geaccepteerd tot fase 6; de Publisher-ervaring laat zien dat dit werkt.
5. **Mandaat-defaults**: publiceren (WP + socials) start op `goedkeuring`, intake en
   drafts op `autonoom` — dat reproduceert het huidige gedrag exact, met de inbox als
   nieuw vangnet; versoepelen is daarna een instelling, geen deploy.
