# SYSTEM.md — amsterdamnow-artikel-tool

> Werkingskaart. Eerst lezen bij elke taak in deze repo, vóór PROGRESS.md en vóór je code opent.
> Verkennen van de codebase alleen als dit bestand de vraag niet beantwoordt — en dan is dat een signaal dat dit bestand moet worden aangevuld.
> Max ±120 regels. Bijwerken in dezelfde PR als elke wijziging aan onderdelen, datastroom, sleutelbestanden, omgevingen, cron of valkuilen.

Laatst bijgewerkt: 2026-09-02 · commit `5758c1b`

## 1. Wat het doet
Redactietool voor de AI-artikelpipeline van amsterdamnow.com: de redactie beheert er de
onderwerpen (wachtrij), volgt de AI-schrijf-/beeldpipeline op een kanban-bord en publiceert
naar WordPress en Instagram. Uitvoer: gepubliceerde artikelen op amsterdamnow.com
(plus drafts, auditrapporten) en Instagram-carousels via een externe socials-engine.

## 2. Onderdelen
| Onderdeel | Pad | Draait op | Doet |
|---|---|---|---|
| Webapp (UI) | `app/components/`, `app/app/*` | Vercel (Next.js 15 App Router) | Kanban (`app/components/Pipeline.tsx`), artikel-detail/beeldwerk, bronnen, carousel, instellingen; pollt /api/board en de ticks |
| Schrijf-pipeline | `app/lib/queue.ts`, `app/lib/writer.ts`, `app/lib/listWriter.ts` | Vercel, per request één stap | Topic → WP-draft: `research → research-aanvullend → invalshoek → schrijf(-retry) → curator → seo` (standaard) resp. lijst-variant in `app/lib/listWriter.ts` |
| Bronnen-scanner | `app/lib/scanner.ts`, `app/app/api/sources/scan` | Vercel cron | Bronnen ophalen (content-hash-dedup), vondsten editorialiseren, WP-dedup, als topics de wachtrij in |
| Beeldredactie | `app/lib/imageSearch.ts`, `app/lib/imageScore.ts`, routes `app/app/api/articles/[id]/candidates*` | Vercel | Kandidaten zoeken (max 48), scoren, autofill featured/slider/inline + itemfoto's |
| Auditor | `app/lib/auditor.ts` | Vercel, on-demand vanaf het bord | Onafhankelijke claim-/beeld-/tekstcheck (Serper + vision); wijzigt niets |
| Auto-publisher | `app/lib/publisher.ts`, `app/app/api/publish/tick` | Vercel, client-poll elke 60 s | Classificatie (`publish_meta`) + selectie → WP-publish van ready-artikelen |
| Socials/carousels | `app/lib/carousel.ts`, `app/lib/carouselEngine.ts`, `app/app/api/carousel/*` | Vercel (proxy) | Status/generate/slide/publish + NOW-templates tegen de externe socials-engine |
| Datalaag | `app/lib/db.ts` | Supabase Postgres (prod) / SQLite (lokaal) | Beide drivers: schema-init, claims/leases, `app_settings`, prompts-seed |

## 3. Datastroom
```
intake (handmatig /api/topics | bronscanner) -> topics-wachtrij -> schrijf-pipeline -> WP-draft
-> beeldwerk -> klaar-voor-publicatie -> WP-publish -> amsterdamnow.com
                                                   \-> carousel (engine) -> Instagram
```
- Handmatige intake valideert tegen concurrenten/aggregators (`app/lib/topicValidation.ts`); bronscanner slaat validatie over maar draait WP-dedup.
- WP-dedup-poort (`app/lib/dedup.ts`, index `wp_posts` uit `app/lib/wpSync.ts`) checkt bij intake én vlak vóór `createDraft`; duplicaat → `failed`.
- Schrijver gebruikt research van Tavily (`app/lib/tavily.ts`), schrijft met Claude (schema's uit `app/lib/schemas.ts`, `FAST_WRITE_MODEL`), valideert (`app/lib/validation.ts`) en maakt de draft met ACF-metadata (`createDraft` in `app/lib/wp.ts`).
- Beelden: upload met naamconventie `{venue-slug}-{type}-{plaats}_{n}` (`app/lib/mediaName.ts`); klaar-regel = 3 beelden (standaard) / featured + slider + elke itemfoto (lijst).
- Publicatie: handmatig of auto-publisher; daarna optioneel carousel via de socials-engine (satori- of Amsterdam NOW-templates).
- De queue doet één topic per tik (60 s-serverless); langere trajecten zijn client-loops of `MAX_*`-guards.

## 4. Sleutelbestanden (max 10)
| Bestand | Waarom je hier moet zijn |
|---|---|
| `app/lib/db.ts` | Schema's voor beide drivers, claims/leases (`claimNextQueued`), `app_settings`, migraties inline — nieuwe tabel hier in beide init-functies |
| `app/lib/queue.ts` | Tick-loop en schakelpunt standaard/lijst; één taak per aanroep |
| `app/lib/writer.ts` | Fase-machine standaard-artikelen: alle Claude-stappen + schema-gebruik + `createDraft` |
| `app/lib/listWriter.ts` | Fase-machine lijstartikelen (lijst-selectie → lijst-research → lijst-schrijf → lijst-seo), itemfoto-vereisten |
| `app/lib/scanner.ts` | Bronscan-logica: content-hash, `editorializeTitles()`, dedup-cap |
| `app/lib/wp.ts` | WordPress REST live/demo, `createDraft`, media-upload, inline-beeld-splice; `getWpUrl()`/`isLive()` |
| `app/lib/dedup.ts` | Harde WP-dedup-poort vóór intake en vóór `createDraft` (lexicaal + Haiku-judge) |
| `app/lib/publisher.ts` | Auto-publish: settings, `classifyArticles`, `pickNextForPublish` |
| `app/lib/carouselEngine.ts` | Engine↔tool-mapping (status/slides/template-ids) en proxy-koppeling |
| `app/lib/prompt-seeds.ts` | Seed van bewerkbare prompts/constraints (versiebeheer via de routes /api/prompts en /api/constraints) |

## 5. Omgevingen en koppelingen
- Live: https://amsterdamnow-article-generator.vercel.app (uit `COWORK-GUIDE.md`/`HANDOFF.md`) · Demo: zonder WP-env draait de app in demo-modus (badge, data-URL's).
- Database: Supabase Postgres zodra `DATABASE_URL`/`SUPABASE_DB_URL`/`POSTGRES_URL` is gezet (pooler, poort 6543); anders SQLite lokaal in de map data/ (runtime-bestand, niet gecommit), op Vercel /tmp (niet-persistent). Migraties: inline in `app/lib/db.ts`, geen migratiemap.
- Cron: root `vercel.json` → `"crons"`: /api/sources/scan elke dag `0 5 * * *` (UTC); Vercel stuurt dan `Authorization: Bearer $CRON_SECRET` mee. Meerdere keren per dag kan niet op de huidige tier → externe scheduler voor /api/queue/worker.
- Externe koppelingen:
  - WordPress → https://www.amsterdamnow.com (default `WP_URL`): posts/drafts lezen+schrijven, media, ACF + RankMath; live vs demo bepaald in `app/lib/wp.ts`.
  - Tavily → research-zoek + paginatext; key beheerbaar via Instellingen (app_settings) i.p.v. env.
  - Claude (Anthropic) → schrijven/curator/SEO/audit/beeld-score; provider-switch naar Omniroute via `app/lib/modelConfig.ts` + Instellingen.
  - Socials-engine (Instagram) → carousel-status/generate/publish + NOW-templates; default https://amsterdamnow-socials.vercel.app, apart project (`amsterdamnow_socials`). IG-Graph-publicatie doet de engine.
  - Beeldzoek: Openverse/Wikimedia Commons (altijd); Pexels (`PEXELS_API_KEY`) en Google-beeld via Serper (`SERPER_API_KEY`) optioneel. Auditor gebruikt Serper als onafhankelijke index.
- Secrets: alleen namen — Vercel-project-env + evt. overrides in de koppelings-UI (app_settings, gemaskeerd): `CRON_SECRET`, `DATABASE_URL`, `WP_USER`, `WP_APP_PASSWORD`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `TAVILY_API_KEY`, `PEXELS_API_KEY`, `SERPER_API_KEY`, `SOCIALS_ENGINE_API_KEY`. Waar die env-exact beheerd wordt: onbekend (niet uit repo af te leiden).

## 6. Verifiëren dat het werkt
```
curl -s https://amsterdamnow-article-generator.vercel.app/api/board   # verwacht: JSON-onderwerpen/kolommen
npm run dev  # in app/, poort 3400 — zonder .env: demo-modus op SQLite
cd app && npx tsc --noEmit                                            # verwacht: geen typefouten
bash scripts/check-system-md.sh                                       # verwacht: "OK: docs/SYSTEM.md …"
```
Lokale dev in `.claude/launch.json` (config `artikel-tool`, `cwd: app`).

## 7. Valkuilen (max 5)
- Elke nieuwe geneste/dynamische API-route heeft een rewrite nodig in root `vercel.json` vóór de catch-all `/(.*)` (statische segmenten vóór `[id]`); vergeet je 't → 404 op productie, terwijl het lokaal wél werkt.
- 60 s-serverless-limiet: maximaal één modelcall/zij-effect per request/tik; lange bewerkingen opknippen (client-loop of per-tik met guard).
- Lokaal draait de app op SQLite, tenzij er een env-bestand app/.env (gitignored) ligt met een (kapotte) Supabase-`DATABASE_URL` — `mv app/.env app/.env.disabled` voor een SQLite-run; ruim de runtime-db op in data/ voor een schone start.
- Nieuwe tabellen/kolommen moeten in beide init-functies + ALTER-blokken van `app/lib/db.ts` (Postgres én SQLite), anders productie↔lokaal-drift.
- Geen testrunner in de repo (bewust): scripts in `app/scripts/*.test.mjs` draaien via `npm run test:*` in `app/`.

## 8. Waar meer staat
- Scherm→code-mapping + backendpatronen + design-tokens: `docs/DESIGN-MAP.md`
- Architectuur & faseringsplan richting agentic OS ("NOW OS"): `docs/ARCHITECTUUR-AGENTIC-OS.md`
- Componentdocumenten: `docs/auditor-ontwerp.md`, `docs/topic-validation.md`, `docs/briefings/2026-07-21-instagram-carousel-pagina-briefing.md`, specs in `docs/superpowers/specs/`
- Bestaande promptversies en -ontwerp: `docs/prompts/` · Regels & branch/PR-workflow: `CLAUDE.md` · Checklist-poort: `scripts/check-system-md.sh`
