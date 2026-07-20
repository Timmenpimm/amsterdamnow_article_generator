# Bronnen-scanner (agenda's uitlezen) — design

## Doel

Een aparte pagina **"Bronnen"** waar de redactie URL's van agenda-/
programmapagina's beheert (poppodia, theaters, musea, horecanieuws,
buurtblogs). De tool leest die pagina's uit, laat Claude de voor
AmsterdamNOW relevante items extraheren (events, openingen, nieuwe
cafés/restaurants/winkels), ontdubbelt tegen eerdere vondsten en zet
nieuwe items **direct als topic in de wachtrij** van de Pipeline.

## Al genomen beslissingen

- **Geen controlestap**: vondsten gaan direct de wachtrij in; het bord is
  de controle (bewerken/verwijderen zoals elk topic).
- **Automatisch dagelijks** (Vercel Cron; Hobby-plan staat max 1×/dag toe)
  **plus** een handmatige "Alle bronnen nu scannen"-knop.
- **Dedup-geheugen per bron**: een volgende scan levert alleen nieuwe items
  op, ook als een event nog weken op de bronpagina staat.
- **Tavily Extract** haalt de pagina's op (zelfde `TAVILY_API_KEY`,
  endpoint `api.tavily.com/extract` — lost ook JS-gerenderde agenda's op);
  **Claude** filtert (op `FAST_WRITE_MODEL`).
- **Filterprompt bewerkbaar in Instellingen** als nieuw PromptKind, zelfde
  versiebeheer/rollback als de bestaande prompts.
- UI volgens `BRIEFING-claude-design-addendum-bronnen.md` (drie zones,
  vier states).

## Datamodel

Twee nieuwe tabellen, zelfde dual-driver patroon (sqlite + postgres) als de
bestaande tabellen in `app/lib/db.ts`:

```sql
CREATE TABLE sources (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,             -- weergavenaam (uit de pagina of door redactie gezet)
  url TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,   -- gepauzeerd = 0
  created_at TEXT NOT NULL,
  last_scan_at TEXT,
  last_scan_status TEXT,          -- 'ok' | 'error' | NULL (nog nooit gescand)
  last_scan_error TEXT,           -- korte reden bij 'error'
  last_scan_new INTEGER NOT NULL DEFAULT 0  -- nieuwe topics bij laatste scan
);

CREATE TABLE source_finds (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL,
  dedup_key TEXT NOT NULL,        -- genormaliseerde sleutel, uniek binnen de bron
  title TEXT NOT NULL,            -- de topic-titel zoals toegevoegd
  topic_id INTEGER,               -- NULL als het topic later is verwijderd
  found_at TEXT NOT NULL
);
```

`dedup_key` wordt door Claude bepaald (bv. `"melkweg|sombr|2026-09-12"` of
`"cafe de nieuwe anita heropening"` — lowercase, stabiel voor hetzelfde
event/dezelfde zaak). Vondsten blijven bewaard, ook als het topic van het
bord wordt verwijderd: verwijderen door de redactie betekent "niet
interessant", en dan mag hetzelfde event niet de volgende dag terugkomen.

## Scan-flow (tick-gebaseerd, binnen de 60s-functielimiet)

`POST /api/sources/scan` verwerkt actieve bronnen **oudste
`last_scan_at` eerst**, met een tijdbudget (~40s, dan stoppen en
teruggeven wat nog resteert). Per bron:

1. **Tavily Extract** van de URL → markdown (getrimd tot een vast maximum,
   analoog aan `VERIFY_SOURCE_CHARS`).
2. **Eén Claude-call** (`FAST_WRITE_MODEL`) met de bron-filterprompt, de
   pagina-inhoud en de bestaande `dedup_key`s van deze bron → JSON
   `{ items: [{ titel, dedup_key }] }` met uitsluitend nieuwe, relevante
   items.
3. Dubbelcheck in code tegen `source_finds` (Claude's dedup is een hint,
   de database is de waarheid), daarna: topics toevoegen via het bestaande
   `addTopics`-pad + `source_finds`-rijen wegschrijven.
4. Bronstatus bijwerken (`last_scan_*`).

Fouten per bron (onbereikbaar, geen geldige JSON) zetten alleen díe bron op
`error` en breken de run niet af.

**Triggers:**
- De frontend-knop "Alle bronnen nu scannen" blijft de route aanroepen tot
  alles gescand is (zelfde lus-patroon als `startWriting` op het bord).
- Vercel Cron (`vercel.json` → `crons`, dagelijks 07:00, GET op dezelfde
  route) doet één aanroep per dag. **Bekende beperking:** één aanroep dekt
  ~3-4 bronnen; bij meer bronnen zorgt de oudste-eerst-volgorde voor
  roulatie over meerdere dagen, en blijft de handmatige knop het middel
  voor een volledige scan. Volledige dagelijkse dekking van veel bronnen
  vraagt om Vercel Pro (frequentere cron) — bewust buiten scope.

## API

- `GET /api/sources` — lijst incl. status; `POST` — toevoegen `{ url, name? }`
  (zonder `name` haalt de eerste scan de paginatitel op als naam).
- `PATCH /api/sources/[id]` — naam wijzigen, `active` togglen;
  `DELETE` — bron én bijbehorende finds verwijderen.
- `POST /api/sources/scan` — tijdgebudgetteerde scan (alle actieve bronnen);
  ook `GET` (voor de cron); optioneel `?id=` voor één bron ("Nu scannen"
  op een kaart).
- `GET /api/sources/[id]/finds` — recente vondsten voor de uitklap-historie,
  met per vondst de afgeleide status (in wachtrij / geschreven / verwijderd,
  via join op `topics`).

## Prompt

Nieuw PromptKind **`bron-filter`** + seed in `app/lib/prompt-seeds.ts`.
Instructie-kern: relevant = events, openingen en nieuwe horeca/winkels/
cultuur **in Amsterdam**; negeer items buiten Amsterdam, verlopen data en
alles wat al in de meegeleverde dedup-lijst staat; titel in de stijl van
bestaande onderwerpen (bv. "Sombr in de Melkweg: bedroom pop voor een
uitverkochte zaal"); output strikt JSON. Bewerkbaar in Instellingen onder
een nieuwe tabgroep "Bronnen".

## UI

- Nieuwe pagina `/bronnen` volgens het designaddendum: bron toevoegen
  bovenaan, bron-kaarten met status/toggle/verwijderen/"Nu scannen"/
  uitklapbare vondsten-historie, scan-overzicht met cron-info en de
  primaire scan-knop.
- Nav-item "Bronnen" in `TopBar` tussen Archief en Prompt & instellingen.
- Tijdens een handmatige scan is per kaart zichtbaar welke bron bezig/klaar
  is (zelfde voortgangsstijl als "Wordt geschreven" op het bord).

## Niet in scope

- Geen aparte review-wachtrij (bewuste keuze).
- Geen per-bron eigen prompts; één gedeelde filterprompt.
- Geen RSS/iCal-parsing; alles via Extract + Claude.
- Scanner maakt uitsluitend `standaard`-topics, geen lijstartikelen.
- Geen automatische frequentie hoger dan dagelijks (Hobby-plan).
