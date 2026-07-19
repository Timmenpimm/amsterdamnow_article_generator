# AmsterdamNOW Artikel-tool

Redactietool voor de AI-artikelpipeline van amsterdamnow.com. Implementatie van het
Claude Design-project "AmsterdamNOW artikel-tool" (`Artikel-tool.dc.html`).

## Wat het doet

- **Pipeline (kanban)** — onderwerpen invoeren (snel-invoer met `N`-sneltoets, bulk-plakken
  met preview en dedupe), en de reis volgen: in wachtrij → wordt geschreven → beelden nodig →
  klaar voor publicatie → gepubliceerd, plus mislukt met opnieuw-proberen.
- **Beeldwerk** — per draft-artikel: preview van de AI-tekst en alle AI-gevulde velden
  (alleen-lezen), featured image + slider vullen via drag & drop, bestandsupload of
  afbeeldings-URL, fotograaf-credit (ACF), en publiceren — geblokkeerd tot 3 beelden.
- **Prompt & instellingen** — de schrijf- en SEO-prompt van de pipeline bewerken met
  versiegeschiedenis en terugzetten. Geseed met de échte prompts uit de n8n-workflows.

## Starten

```bash
npm install
npm run dev   # http://localhost:3400
```

Zonder `.env` draait de tool in **demo-modus** (badge rechtsboven): demo-artikelen en
-wachtrij, uploads worden als data-URL bewaard. Kopieer `.env.example` naar `.env`
en vul `WP_USER` + `WP_APP_PASSWORD` (WordPress Application Password) in voor live-modus.

## Opslag: SQLite lokaal, Supabase op Vercel

De opslaglaag ([lib/db.ts](lib/db.ts)) kiest automatisch een driver:

- **`DATABASE_URL` gezet** → Postgres (Supabase). Tabellen worden bij de eerste request
  automatisch aangemaakt en de prompts geseed. Gebruik de **pooler-connectiestring** van
  Supabase (Project Settings → Database → Connection string → "Transaction" pooler,
  poort 6543) omdat Vercel serverless is.
- **geen `DATABASE_URL`** → SQLite in `data/` (lokaal) of `/tmp` (Vercel, niet
  persistent — de app toont dan een waarschuwingsbanner).

Vereiste env-variabelen op Vercel voor volledige werking:

| Variabele | Waarde |
|---|---|
| `DATABASE_URL` | Supabase pooler-connectiestring (`postgresql://postgres.xxx:…@…pooler.supabase.com:6543/postgres`) |
| `WP_USER` / `WP_APP_PASSWORD` | WordPress-gebruiker + Application Password (live-modus) |
| `N8N_TOKEN` | zelfgekozen secret; n8n stuurt hem mee als `x-api-key` op `/api/n8n/*` |

## Koppelingen

### WordPress (live-modus)

Server-side via de REST API met een Application Password:

- drafts + gepubliceerde posts lezen (incl. ACF en RankMath-meta)
- media uploaden (`/wp/v2/media`) en koppelen: `featured_media` + `acf.slider` + `acf.fotograaf`
- publiceren (`status: publish`)

### n8n (wachtrij vervangt de Google Sheet)

De schrijf-workflow (`claude-wordpress-ai-content-generator`) wisselt drie Google
Sheets-nodes in voor drie HTTP-calls naar deze tool (header `x-api-key: $N8N_TOKEN`):

| Vervangt node | Endpoint | Werking |
|---|---|---|
| Get row(s) in sheet | `POST /api/n8n/claim` | pakt het bovenste onderwerp, zet status op `writing`; `{ topic: null }` = wachtrij leeg |
| Delete rows | `POST /api/n8n/complete` `{ topicId, postId }` | markeert klaar, artikel verschijnt als draft in "Beelden nodig" |
| (error-branch) | `POST /api/n8n/failed` `{ topicId, error, step }` | zet het onderwerp in "Mislukt" met foutmelding |

De actieve prompts zijn op te halen voor n8n: `GET /api/prompts?kind=schrijf` /
`?kind=seo` (veld `content` van de versie met `active: 1`).

## Structuur

- `app/` — Next.js App Router: pagina's + API-routes
- `components/` — Pipeline (kanban + mobiel), ArticleDetail (beeldwerk), TopBar, BulkModal
- `lib/` — SQLite (wachtrij, promptversies, demo-store), WordPress-client (live/demo)
- `seeds/` — de originele n8n-prompts (seed voor versie 1)
- `../design/` — het geïmporteerde Claude Design-bestand (referentie)
- `../BRIEFING-claude-design.md` — de oorspronkelijke designbriefing
