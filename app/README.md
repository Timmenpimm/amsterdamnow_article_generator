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
- **Prompt & instellingen** — de Tavily-research-, Claude-schrijf- en SEO-prompt bewerken met
  versiegeschiedenis en terugzetten.

## Starten

```bash
npm install
npm run dev   # http://localhost:3400
```

Zonder `.env` draait de tool in **demo-modus** (badge rechtsboven): demo-artikelen en
-wachtrij, uploads worden als data-URL bewaard. Kopieer `.env.example` naar `.env`
en vul `WP_USER` + `WP_APP_PASSWORD` (WordPress Application Password), `TAVILY_API_KEY` en
`ANTHROPIC_API_KEY` in voor live-modus. Start vervolgens vanuit de wachtrij één run;
Tavily doet bronnenonderzoek, Claude schrijft het artikel, vult SEO in en maakt een WordPress-draft.

Voor autonome wachtrijverwerking is `/api/queue/worker` beschikbaar voor een scheduler.
Zet hiervoor `CRON_SECRET` als omgevingsvariabele in Vercel; de scheduler moet deze
waarde als Bearer-token meesturen. De huidige Vercel-tier ondersteunt geen minutely
Cron Job, dus koppel hiervoor een externe scheduler zoals QStash of upgrade het plan.

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
| `ANTHROPIC_API_KEY` | API-sleutel uit de Anthropic Console voor Claude |
| `ANTHROPIC_MODEL` | optioneel, standaard `claude-sonnet-4-20250514` |
| `TAVILY_API_KEY` | API-sleutel voor de verplichte Tavily-researchfase |

## Koppelingen

### WordPress (live-modus)

Server-side via de REST API met een Application Password:

- drafts + gepubliceerde posts lezen (incl. ACF en RankMath-meta)
- media uploaden (`/wp/v2/media`) en koppelen: `featured_media` + `acf.slider` + `acf.fotograaf`
- publiceren (`status: publish`)

### Research- en Claude-workflow

Via **Schrijf volgend artikel met Claude** verwerkt de app
het bovenste onderwerp in de wachtrij: Tavily zoekt en extraheert bronnen, Claude zet deze met
de actieve research-prompt om naar controleerbare research en WordPress-metadata, en schrijft
daarna het artikel met de actieve schrijf-prompt. De app valideert hard op woordlimieten,
onderwerp in de titel, quote in de content, vijf alinea's en verboden dashes. Daarna genereert
Claude RankMath-SEO en maakt de app een WordPress-draft met categorieën, tags, district en
locatievelden. Mislukte stappen komen met een foutmelding in de kolom **Mislukt**.

Tavily-research wordt via je Tavily-account gefactureerd. De app voert per artikel één
uitgebreide zoekopdracht uit met maximaal vijf resultaten.

## Structuur

- `app/` — Next.js App Router: pagina's + API-routes
- `components/` — Pipeline (kanban + mobiel), ArticleDetail (beeldwerk), TopBar, BulkModal
- `lib/` — SQLite (wachtrij, promptversies, demo-store), WordPress-client (live/demo)
- `seeds/` — de oorspronkelijke Claude-prompts (seed voor versie 1)
- `../design/` — het geïmporteerde Claude Design-bestand (referentie)
- `../BRIEFING-claude-design.md` — de oorspronkelijke designbriefing
