# Plan — Bronnen (agenda-scanner)

**Datum:** 20 juli 2026
**Bron:** `BRIEFING-claude-design-addendum-bronnen.md` + design `design/Artikel-tool.dc.html` (schermen 3a/3b/3c)
**Beslissing (met Martijn):** volledige feature, scannen **in de tool zelf**.

## Doel
Een vierde kernscherm **Bronnen**: de redactie geeft agenda-/programma-URL's op;
de tool leest ze uit (Tavily-extract → Claude haalt relevante items eruf),
ontdubbelt per bron, en zet nieuwe items **direct als onderwerp in de wachtrij**
(zelfde `topics`-tabel als handmatige invoer). Geen aparte controlestap.

## Datamodel (lib/db.ts, beide drivers)
- **sources**: `id, name, url, label, active, created_at, last_scan_at,
  last_scan_status ('ok'|'error'|null), last_scan_error, last_new_count`.
- **source_findings**: `id, source_id, title, dedup_key, found_at, topic_id`.
  Weergavestatus wordt bij het lezen bepaald via LEFT JOIN op `topics`:
  topic bestaat & `done` → "al geschreven"; topic bestaat (queued/…) →
  "in wachtrij"; `topic_id` gezet maar geen topic-rij → "verwijderd door redactie".
  `dedup_key = normalized(title)`; de finding-rij blijft bestaan ook na verwijderen
  → dat is precies de dedup-historie ("waarom komt dit event niet meer omhoog").

## Scannen (lib/scanner.ts)
`scanSource(id)`: markeer bezig → haal pagina (Tavily `/extract`, fallback plain
fetch + strip) → `askClaudeJson` met een extractie-systeemprompt → filter tegen
bestaande finding-keys → `addTopics(nieuwe titels)` (dedupt ook tegen de globale
wachtrij) → `recordFindings` met `topic_id` → update bron-scanstatus.
`scanAllActiveSources()` voor de cron (sequentieel, best-effort).
Per bron = 1 extract + 1 Claude-call → past ruim binnen de 60s function-limiet.

## API (Next, force-dynamic)
- `GET/POST /api/sources` — lijst / toevoegen (via catch-all).
- `PATCH/DELETE /api/sources/[id]` — pauzeren/hernoemen / verwijderen.
- `POST /api/sources/[id]/scan` — één bron scannen.
- `GET /api/sources/scan` — cron (Bearer `CRON_SECRET`, zoals queue/worker);
  `POST` idem voor "Alle bronnen nu scannen" (server-side variant).
- **vercel.json**: order-gevoelige `routes`-rewrites vóór de catch-all
  (`/scan` vóór `[id]`), plus één `crons`-entry `0 5 * * *` (≈07:00 CEST).

## Frontend
- **TopBar**: nav-link "Bronnen" toevoegen (Pipeline · Archief · Bronnen · Prompt
  & instellingen).
- **app/bronnen/page.tsx** (client): zone A (URL toevoegen), zone B
  (bron-kaarten met states ok/bezig/fout/gepauzeerd + uitklapbare vondsten-
  historie), zone C (scan-overzicht + "Alle bronnen nu scannen" die client-side
  per bron loopt voor live per-kaart voortgang), lege state. Bestaande tokens/
  utility-classes uit globals.css.

## Verificatie
`next build` (typecheck) + dev-server op lokale SQLite; alle Bronnen-states
renderen, toevoegen werkt, en één scan loopt end-to-end door (indien API-keys
aanwezig). Geen testrunner in de repo — bewust niet toegevoegd.
