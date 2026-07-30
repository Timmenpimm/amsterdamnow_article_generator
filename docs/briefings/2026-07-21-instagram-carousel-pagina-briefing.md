# Design-briefing: Instagram Carousel-pagina in de artikel-tool

_21 juli 2026 — geschreven voorafgaand aan implementatie. Deze briefing
beschrijft alléén de nieuwe pagina in `amsterdamnow-artikel-tool`; er is
niets aan bestaande bestanden gewijzigd voor dit document. Verplichte
leesvolgorde vóór implementatie: `docs/DESIGN-MAP.md` (schermlabels ophalen
en diffen tegen §2 van die tabel) en dit bestand._

---

## 1. Doel & context

De artikel-tool produceert en publiceert al de long-form artikelen voor
amsterdamnow.com (pipeline in `app/components/Pipeline.tsx`, artikel-detail
in `app/components/ArticleDetail.tsx`, publicatie via `lib/wp.ts` en de
auto-publisher in `lib/publisher.ts`). Elk gepubliceerd of publicatie-klaar
artikel is potentieel Instagram-content: titel, body en featured/slider-
beelden liggen al klaar in de tool.

De carousel-generator hergebruikt dat artikel als bron in plaats van een
losse tool te zijn waar iemand een artikel opnieuw moet kopiëren/plakken.
Concreet: een redacteur opent een bestaand artikel in de artikel-tool, kiest
"Maak Instagram-carousel", en krijgt een AI-gegenereerde slide-set die hij
kan bijsturen en publiceren — zonder de tool te verlaten of context te
verliezen (WP-status, beeldmateriaal, categorie zijn al bekend).

De onderliggende engine (AI-analyse → carousel-JSON → gebrandede PNG's via
Satori → Instagram Graph API-publicatie) wordt apart gebouwd in
`amsterdamnow_socials` (zie `CLAUDE.md` aldaar). Deze pagina is de
**presentatielaag** binnen de artikel-tool; de zware AI/render/publish-logica
hoort in de socials-engine (zie §5 voor de architectuurkeuze).

## 2. Plek in de tool

**Route**: `/carousel` als lijst/overzicht (welke artikelen hebben al een
carousel, welke niet) en `/carousel/[articleId]` voor de generator/editor
zelf — analoog aan het bestaande paar `app/artikel/page` (lijst zit in het
bord) / `app/artikel/[id]/page.tsx` (detail). Concreet nieuw aan te maken:

- `app/app/carousel/page.tsx` — overzicht.
- `app/app/carousel/[articleId]/page.tsx` — generator/editor, dun: alleen
  `<TopBar />` + een client-component, zelfde patroon als
  `app/app/artikel/[id]/page.tsx` (6 regels, delegeert direct naar een
  component).
- Nieuwe component(en) in `app/components/` (bijv. `CarouselGenerator.tsx`,
  eventueel gesplitst in `CarouselSlideEditor.tsx` voor de per-slide editor —
  richtlijn in `CLAUDE.md` van de tool zelf is "geen state/actie-bestanden
  >300 regels", en `ArticleDetail.tsx` (1066 regels) is al een voorbeeld van
  waar dat misging; niet herhalen voor de carousel-component.

**Navigatie**: nieuw item in `app/components/TopBar.tsx`, in de bestaande
`<nav>` naast Pipeline / Archief / Bronnen / Prompt & instellingen (regel
74-81). Zelfde `Link` + `usePathname()`-actief-patroon:

```tsx
<Link href="/carousel" className={`navlink${pathname.startsWith('/carousel') ? ' active' : ''}`}>
  Carousel
</Link>
```

Plaatsing: na "Archief" — het is net als Archief een post-productie-stap op
bestaande artikelen, geen onderdeel van de schrijf-pipeline zelf. Verder geen
wijzigingen nodig aan `TopBar.tsx` (geen quick-add/mode-indicator relevant
voor dit scherm).

**Instap vanuit artikel-detail**: in `app/components/ArticleDetail.tsx` een
knop "Maak Instagram-carousel" toevoegen bij gepubliceerde/publicatie-klare
artikelen (`article.status === 'publish'` of `articlePhase(article) ===
'ready'`, zie `lib/types.ts` regel 162-167), die naar
`/carousel/[articleId]` linkt. Exact waar in de layout van `ArticleDetail.tsx`
is een detail voor de bouw-fase, niet voor deze briefing.

## 3. Paginaflow (UX)

### 3.1 Overzicht (`/carousel`)

- Lijst van artikelen die in aanmerking komen (gepubliceerd, of
  `articlePhase === 'ready'`), met per rij: featured-thumbnail, titel,
  WP-status, en carousel-status (nog geen carousel / concept / klaargezet /
  gepubliceerd op Instagram).
- **Lege staat**: geen enkel artikel is nog klaar/gepubliceerd → melding in
  de stijl van de bestaande lege-staten in `Pipeline.tsx` (§2, rij **1d** in
  de DESIGN-MAP) — rustige tekst + verwijzing naar de pipeline.
- Filter/sortering is optioneel voor v1; niet blokkerend voor scope.

### 3.2 Generator/editor (`/carousel/[articleId]`)

Stappen, elk met eigen laad- en foutafhandeling:

1. **Artikel-context laden**: titel, intro, contentHtml, featured/slider-
   beelden van het gekozen artikel (dezelfde data die `ArticleDetail.tsx` al
   toont). Faalt het artikel op te halen → foutmelding in de stijl van
   `ArticleDetail.tsx` regel 57-58 (`setError(e.message)`, tonen als
   tekstblok, geen crash van de pagina).
2. **Template kiezen**: drie opties — modern-news, minimal-business,
   magazine (namen uit de socials-productspec, `templates/modern-news.tsx`
   etc.). UI: pill-tabs, zelfde patroon als de tab-groepen in
   `app/app/instellingen/page.tsx` (regel 63-76: actieve tab = `background:
   var(--ink)`, `color: #fff`, inactief = outline-pill). Geen keuze nog
   gemaakt → generatie-knop disabled (`.btn-primary:disabled`, al gedefinieerd
   in `globals.css`).
3. **AI genereert slides**: knop "Genereer carousel" → POST naar de
   integratielaag (zie §5). **Laadstaat**: spinner-patroon zoals
   `.spin`/`.progress-pulse` in `globals.css` (al gebruikt in
   `ArticleDetail.tsx` voor de beeld-autofill-voortgang, regel 74-90) +
   statustekst ("Claude analyseert het artikel…"). Gezien de **60s-
   serverless-limiet** (DESIGN-MAP §4, valkuil 2) mag dit geen synchrone
   single-call worden als renderen van 5+ PNG's meegenomen wordt — zie §5
   voor de aanbevolen opsplitsing (analyse-call apart van beeldrender).
   **Foutafhandeling**: mislukte generatie → `toast(...)` met `kind: 'error'`
   (patroon uit `app/components/toast.tsx`, gebruikt in `TopBar.tsx` regel
   51) + mogelijkheid tot opnieuw proberen, geen halve state achterlaten.
4. **Preview als swipebare carousel**: horizontale, swipebare/scrollbare
   rij van slide-PNG's (of live Satori-preview vóór rendering, als de engine
   dat ondersteunt) met paginadots. Geen bestaand swipe-component in de tool
   — dit is de belangrijkste net-te-bouwen UI, maar wel met de bestaande
   `.card`-look (witte kaart, `--border-light`) per slide en dezelfde
   afgeronde hoeken (`8px`, zie `.card` in `globals.css`).
5. **Per-slide bewerken + regenereren**: klik op een slide → inline
   tekst-editor (headline/body) in het `.card`-patroon, met een
   "Regenereer deze slide"-knop (`.btn-small`) die alleen die ene slide
   opnieuw naar de AI stuurt (analoog aan hoe `CandidateCard` in
   `ArticleDetail.tsx` per losse kandidaat een actie aanbiedt, niet de hele
   set herlaadt).
6. **Caption/hashtags bewerken**: tekstveld + tag-editor. Voor de tag-
   editor het inline-patroon van `CriteriaEditor.tsx` hergebruiken (DESIGN-MAP
   §3 noemt dit expliciet als het bestaande, niet-utility-class tag-editor-
   patroon) in plaats van een nieuw component te verzinnen.
7. **Goedkeuren & publiceren / klaarzetten**: twee acties —
   "Klaarzetten" (concept bewaren, niet publiceren) en "Publiceren op
   Instagram" (`.btn-primary`, met bevestiging — dit is een onomkeerbare
   publicatie-actie, dus een confirm-stap, vergelijkbaar met hoe
   publicatie in de auto-publisher pas gebeurt na de ready-check in
   `lib/publisher.ts`). Publiceren faalt (bijv. Graph API-token verlopen)
   → foutmelding + concept blijft bewaard, geen dataverlies.

## 4. Designrichtlijnen — concreet hergebruiken

- **Design-tokens**: `app/app/globals.css` `:root`. Gebruik uitsluitend
  bestaande variabelen (`--ink`, `--card`, `--border`/`--border-light`,
  `--soft`, `--gray`, `--muted`, `--green`/`--green-dark`/`--green-bg` voor
  "gepubliceerd"-status, `--amber`/`--amber-dark`/`--amber-bg` voor
  "concept/wacht"-status, `--red`/`--red-dark` voor foutstaten). **Niet**
  nieuwe kleuren toevoegen — de tool draait op de warme paper-look
  (`--bg: #e9e8e4`) en dat moet ook voor dit scherm gelden.
- **Font**: Archivo, al geladen via Google Fonts `<link>` in
  `app/app/layout.tsx`; geen actie nodig, gewoon meeliften.
- **Stijl-aanpak**: géén Tailwind, géén CSS-modules toevoegen (de tool
  gebruikt bewust geen van beide — zie DESIGN-MAP §3). Volg het bestaande
  patroon: een klein aantal utility-classes uit `globals.css` (`.btn`,
  `.btn-primary`, `.btn-small`, `.card`, `.colhead`, `.chip-amber`,
  `.chip-green`, `.navlink`, `.dot`, `.spin`, `.modal-backdrop`,
  `.desktop-only`/`.mobile-only`) + inline `style={{ ...,
  color: 'var(--token)' }}` per element. Nieuwe classes alleen toevoegen aan
  `globals.css` als een patroon zich herhaalt (bijv. een `.carousel-track`
  voor de swipebare rij) — niet per-component losse CSS-bestanden.
- **Component-patronen om te kopiëren**:
  - Tab-selectie (template kiezen) → pill-tab patroon uit
    `app/app/instellingen/page.tsx` (regels 63-76).
  - Statuschips (concept/klaargezet/gepubliceerd) → `.chip-amber` /
    `.chip-green` zoals gebruikt in de kanban-kolommen van `Pipeline.tsx`.
  - Modals (indien een bevestigingsmodal nodig is bij "Publiceren") →
    `.modal-backdrop` + het patroon in `app/components/BulkModal.tsx` of
    `ReviewModal.tsx`.
  - Meldingen/fouten → `toast()` uit `app/components/toast.tsx` (al globaal
    gemount via `<ToastHost />` in `app/app/layout.tsx`), niet een eigen
    alert-component bouwen.
  - Kaarten (slide-previews, artikel-rijen) → `.card`-class, dezelfde
    `border-radius: 8px` en `border: 1px solid var(--border-light)` als
    overal elders.
  - Voortgang/laadstaten → `.spin` / `.progress-pulse` keyframes, zoals in
    de beeld-autofill van `ArticleDetail.tsx`.
- **TopBar altijd bovenaan**: elke nieuwe pagina rendert `<TopBar />` als
  eerste element, exact zoals `app/app/instellingen/page.tsx` regel 55 en
  `app/app/archief/page.tsx` doen — geen eigen headerbalk verzinnen.

## 5. Integratie-architectuur — twee opties

**Optie A — aparte service, API-koppeling.** De socials-engine
(`amsterdamnow_socials`) draait als eigen Next.js-deployment met eigen
Supabase/Prisma/NextAuth/OpenAI-stack (zoals in die repo's `CLAUDE.md`
gespecificeerd). De artikel-tool-pagina praat via HTTP met die service
(bijv. `POST https://socials.amsterdamnow.com/api/generate` met
artikel-payload, terug een `CarouselContent`-JSON + PNG-URLs).

**Optie B — modules direct in de artikel-tool integreren.** De
`lib/`-modules (AI-generator, Satori-renderer, templates) en
`lib/instagram.ts` uit de socials-spec worden overgezet naar
`app/lib/carousel*.ts` binnen deze repo, draaiend op de bestaande
`db.ts`-driver (Postgres/SQLite) i.p.v. Prisma/Supabase.

**Trade-offs, gegeven de bestaande stack van de artikel-tool:**

| | Optie A (aparte service) | Optie B (in-repo) |
|---|---|---|
| Stack-mismatch | Geen — engine houdt zijn eigen Tailwind/shadcn/Prisma/NextAuth/OpenAI-stack, artikel-tool blijft ongewijzigd (plain CSS, eigen `db.ts`, `lib/claude.ts`) | Groot — engine-spec gaat uit van Tailwind + shadcn/ui + Prisma + NextAuth + OpenAI SDK; artikel-tool heeft géén van die vier. Alles zou herschreven moeten worden naar het bestaande patroon (inline styles, `db.ts`-driver, `lib/claude.ts`/`schemas.ts`) |
| 60s-serverless-limiet | Render/publish-werk zit in de andere deployment, dus geen extra druk op de bestaande `vercel.json`-routes/limiet van de artikel-tool | Renderen van meerdere PNG's (Satori) + AI-call binnen één request botst direct met de bestaande 60s-regel (DESIGN-MAP §4) — vereist client-side tick-loop zoals `publish/tick` al doet |
| `vercel.json`-routing valkuil | Alleen simpele proxy-routes nodig in de artikel-tool (`/api/carousel/*` → externe service), geen nieuwe geneste `[id]`-routes met rewrite-volgorde-risico | Elke nieuwe geneste route (`/api/carousel/[id]/regenerate-slide` etc.) heeft een eigen rewrite nodig vóór de catch-all (DESIGN-MAP §4, valkuil 1) — meer plekken om dat te vergeten |
| Auth/credentials | Instagram Graph API-tokens en OpenAI-key leven in de andere deployment, niet in dit repo's env | Extra env-variabelen (`INSTAGRAM_ACCESS_TOKEN`, `OPENAI_API_KEY` naast de bestaande `ANTHROPIC`-sleutel) in dezelfde `.env`, twee AI-providers naast elkaar (`lib/claude.ts` gebruikt Claude, de socials-spec schrijft OpenAI voor) |
| Onderhoud/consistentie | Twee codebases, twee deploys, twee keer monitoren | Eén codebase — maar dan moet de socials-spec zijn eigen stackkeuzes (Prisma/Supabase/NextAuth/OpenAI) alsnog laten vallen ten gunste van de tool-conventies, wat het "apart gebouwd" uitgangspunt van de opdracht tegenspreekt |
| Iteratiesnelheid engine | Socials-repo kan onafhankelijk itereren/deployen zonder de artikel-tool-pipeline te raken | Wijzigingen aan de engine vereisen deploy van de hele artikel-tool mee |

**Aanbeveling: optie A.** De socials-engine is expliciet "apart gebouwd" met
een eigen, moderne stack die structureel niet overeenkomt met de artikel-
tool (Tailwind/shadcn/Prisma/NextAuth/OpenAI vs. plain-CSS/eigen
SQL-driver/Claude). Een API-koppeling houdt beide codebases bij hun eigen
sterke punten, voorkomt een dubbele AI-provider-stack in één repo, en
respecteert de bestaande 60s-serverless-grens van de artikel-tool (het zware
werk verhuist naar de andere deployment). De artikel-tool-pagina wordt dan
vooral een dunne cliënt: artikel-data ophalen (heeft ze al), naar de
socials-service posten, resultaat tonen/bewerken, en terug posten om te
publiceren.

## 6. Datamodel-raakvlak

**Wat de pagina naar de engine stuurt** (uit het bestaande `Article`-type,
`app/lib/types.ts` regel 100-134):

- `id`, `title`, `contentHtml` (of een schone tekstextractie daarvan),
  `intro`/`subregel` als extra context, `featured` (`MediaRef { id, url }`),
  `slider` (`MediaRef[]`), `category`/`rubriek`/`tags` als optionele context
  voor toon/hashtags.

**Wat de engine teruggeeft** (`CarouselContent`, zoals gespecificeerd in
`amsterdamnow_socials/CLAUDE.md`):

```json
{
  "title": "string",
  "slides": [
    { "index": 0, "layout": "hero", "headline": "string", "body": "string", "imagePrompt": "string" }
  ],
  "caption": "string",
  "hashtags": ["string"]
}
```

Plus, na rendering: per slide een PNG-URL/asset-referentie (`slide-01.png`
etc., zie "Carousel Rendering Engine" in de socials-spec) en na publicatie
een Instagram-media-ID (`instagramId`, analoog aan het `Carousel`-Prisma-
model in de socials-spec).

**Wat de artikel-tool zelf moet bijhouden** (nieuw, minimaal): een koppeling
artikel-id ↔ carousel-status (nog geen / concept / klaargezet /
gepubliceerd) zodat het overzicht in §3.1 dat kan tonen. Bij optie A (§5)
volstaat een lichte cache/statusveld in de bestaande `db.ts` (nieuwe kleine
tabel, zelfde patroon als `publish_meta` — DESIGN-MAP §4); de volledige
carousel-JSON en renders blijven bij de socials-engine, niet dubbel opslaan.

## 7. Buiten scope

- WordPress-connectiebeheer (URL/credentials instellen) — dat hoort bij de
  socials-engine of bij de bestaande WP-sync in `app/lib/wp.ts`/`wpSync.ts`,
  niet bij deze pagina.
- Multi-tenant/meerdere Instagram-accounts of meerdere WordPress-sites
  beheren — de artikel-tool is single-tenant (amsterdamnow.com); deze pagina
  volgt dat.
- Template-editor (nieuwe carousel-templates bouwen/aanpassen) — templates
  (`modern-news`/`minimal-business`/`magazine`) worden in de socials-engine
  onderhouden, hier alleen gekozen.
- Automatische/geplande publicatie (cron-achtig, zoals de auto-publisher
  voor artikelen) — v1 is expliciet handmatig goedkeuren & publiceren.
  Automatisering is een latere fase, geen onderdeel van dit ontwerp.
- Andere kanalen uit de "Product Vision" van de socials-spec (LinkedIn,
  Pinterest, TikTok-scripts, newsletter-samenvattingen) — deze briefing gaat
  uitsluitend over de Instagram-carouselpagina.
- Login/gebruikersbeheer voor de socials-engine zelf (NextAuth-laag) — dat
  leeft in die andere deployment, niet in de artikel-tool.

## 8. Open vragen voor Martijn

1. **Hosting van de socials-engine**: draait die straks op een eigen
   Vercel-project/domein (bijv. `socials.amsterdamnow.com`), en is die er al
   of moet de artikel-tool-pagina tijdelijk tegen een lokale/dev-instantie
   praten tijdens de bouw?
2. **Authenticatie tussen de twee apps**: hoe beveiligt de artikel-tool zijn
   calls naar de socials-service — een gedeeld API-secret (zelfde patroon
   als `CRON_SECRET` in deze repo) of iets anders?
3. **Wie beheert de Instagram Graph API-koppeling** (tokens, business
   account-ID) — leeft dat helemaal in de socials-engine, of moet de
   artikel-tool ook iets weten (bijv. voor de publicatie-statuschip in het
   overzicht)?
4. **Scope van "klaarzetten"**: is dat puur een lokaal concept (in de
   socials-engine, artikel-tool toont alleen status), of moet de artikel-tool
   zelf een wachtrij/planning bijhouden zoals bij artikelpublicatie?
5. **Welke artikelen komen in aanmerking** voor een carousel — alleen
   `standaard`-artikelen, of ook lijstartikelen (die al een net andere
   beeld-/structuurlogica hebben, zie `ListArticleStructure` in
   `lib/types.ts`)? Dat bepaalt of het overzicht in §3.1 filtert op
   `TopicType`.
