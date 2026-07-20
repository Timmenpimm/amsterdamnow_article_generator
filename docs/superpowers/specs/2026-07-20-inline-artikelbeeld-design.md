# Inline-artikelbeeld + slider naar 1 — design

_Datum: 20 juli 2026. Branch: `feat/inline-article-image`._

## Aanleiding

De beeldverdeling van een artikel verandert. Nu plaatst de tool 3 beelden als
**featured + 2 slider**. Gewenst:

- **featured**: 1 beeld — blijft ongewijzigd.
- **slider**: nog maar **1** beeld (was minimaal 2 / auto-fill 2).
- **inline**: **1** beeld ín de artikeltekst, **tussen alinea 2 en 3**.

Totaal blijft dus 3 beelden (`REQUIRED_IMAGES = 3`), maar de derde verhuist van
een tweede sliderbeeld naar een inline-beeld in de content.

## Kernbeslissing: waar leeft het inline-beeld?

WordPress heeft geen ACF-veld voor een inline-beeld, en dat kan deze tool niet
aanmaken. Er is wél een precedent: bij **lijstartikelen** staan itemfoto's al
als `<p><img></p>` ín de content-HTML (`lib/listHtml.ts`). We volgen dezelfde
route.

**Gekozen aanpak:** het inline-beeld leeft ín de content-HTML, herkenbaar
gemarkeerd:

```html
<figure class="an-inline"><img class="wp-image-<mediaId>" src="<url>" alt="" /></figure>
```

- WordPress-content blijft de bron van waarheid; geen WP/ACF-config nodig.
- Bij inlezen (`mapPost`) leiden we `article.inline` weer af uit deze markup
  (`mediaId` uit `wp-image-<id>`, `url` uit `src`).
- Consistent met hoe lijstartikel-itemfoto's al werken.

Afgewezen alternatief: los ACF-veld `inline` — netter datamodel, maar vereist
WordPress/ACF-aanpassingen buiten deze tool.

## Datamodel (`app/lib/types.ts`)

- `Article` krijgt `inline: MediaRef | null`.
- `imageCount()` telt het inline-beeld mee:
  `(a.featured ? 1 : 0) + a.slider.length + (a.inline ? 1 : 0) + itemImages`.
- `REQUIRED_IMAGES` blijft **3**.

## Content-splicing (`app/lib/wp.ts`)

Nieuw geïsoleerd helpertje, los testbaar:

```
spliceInlineImage(contentHtml: string, media: MediaRef | null): string
```

- Verwijdert eerst een eventuele bestaande `<figure class="an-inline">`.
- Met `media`: voegt de figure toe **na het 2e top-level blok**. Blokken zijn
  `<p>`, `<h1-6>`, `<blockquote>`, `<ul>`, `<ol>`, `<figure>`, … — niet alleen
  `<p>`: de lede-alinea staat als `<h2>` in de content en de pull-quote als
  `<blockquote>`, dus louter `</p>` tellen plaatst het beeld een blok te laat.
  Heeft het artikel < 3 blokken, dan **achter het laatste blok** (gekozen gedrag).
- Met `null`: laat de content zonder inline-figure achter (verwijderen).

Uitbreiding van `updateImages()`:

- Krijgt optioneel `inlineId?: number | null`.
- Bij een waarde ≠ undefined: resolve de `MediaRef` uit de meegegeven `known`-lijst
  (of huidige `article.inline`), splice via `spliceInlineImage`, en POST in
  LIVE-modus óók `content` mee (naast `featured_media` / `acf.slider`).
- In demo-modus: pas `a.inline` en `a.contentHtml` aan en sla op.
- `mapPost()` vult `article.inline` vanuit de content.

## Auto-fill (`app/app/api/articles/[id]/candidates/autofill/route.ts`)

- Van "featured + 2 slider" → **featured + 1 slider + 1 inline**.
- Voorrang bij te weinig bruikbare beelden (score ≥ 55):
  **Featured → Slider → Inline** (gekozen). Bij 2 bruikbare beelden dus
  featured + slider, geen inline.
- De 3 uploads worden: `[0]` featured, `[1]` slider, `[2]` inline. Aanroep van
  `updateImages` met `featuredId`, `sliderIds: [uploaded[1]]`, `inlineId: uploaded[2]`.

## Beeldwerk-UI (`app/components/ArticleDetail.tsx`) + media-route

- Nieuw enkel slot **"3 · Inline in tekst"** naast Featured (1) en Slider (2),
  in dezelfde slot-stijl: drag/drop, bestand-upload, URL-upload,
  kandidaat-plaatsing, vervangen, verwijderen, en wissel-knoppen tussen de slots
  (featured ↔ slider ↔ inline).
- Slider: label/telling "minimaal 2" → **1**;
  `sliderMissing = Math.max(0, 1 - article.slider.length)`.
- Sectienummering schuift op: kandidaten-sectie wordt **4** bij standaard-
  artikelen (mee-tellend bij lijstartikelen, zie beeldselectie-addendum).
- `UploadTarget` krijgt `'inline'`; `patch()`-body krijgt `inlineId`;
  media-route `/api/articles/[id]/media?role=inline` en de PATCH-route
  `/api/articles/[id]` verwerken `inlineId`.

## Backfill bestaande concepten

Eenmalige, idempotente omzetting van **nog niet-gepubliceerde artikelen in de
tool** (status concept, `status !== 'publish'` — niks wat al live op
amsterdamnow.com staat).

- **Endpoint** `POST /api/admin/backfill-inline`, beveiligd met
  `Bearer CRON_SECRET` (zoals de worker/scan-routes).
- Enumereert via `listArticles()`, filtert: niet-gepubliceerd **én**
  `slider.length ≥ 2` **én** `inline == null`.
- Per artikel: **laatste sliderbeeld → inline** (via `spliceInlineImage`),
  overige slider blijft. Idempotent: al-een-inline wordt overgeslagen.
- 60s-limiet: max ~8 artikelen per tik, retourneert `{ done, changed, remaining }`;
  een korte lus roept aan tot `done`. Levert een **samenvatting** achteraf
  (omgezette artikelen + overgeslagen aantal). Geen dry-run (gekozen: direct
  toepassen).
- Gepubliceerde artikelen: **ongemoeid**.
- Nieuwe geneste route → `vercel.json`-rewrite vóór de catch-all (valkuil §4.1
  van DESIGN-MAP).

## Raakvlakken / overig

- `app/lib/demo-seed.ts` en `createDraft()` in `wp.ts`: `inline: null` toevoegen.
- Eventuele demo-seed: één seed met een inline-beeld ter illustratie (optioneel).
- `docs/DESIGN-MAP.md` §2 bijwerken (inline-slot bij scherm 1c).

## Verificatie

Lokaal op SQLite/demo (§5 DESIGN-MAP), preview op poort 3400:

1. Vers concept → auto-fill plaatst featured + 1 slider + 1 inline; inline-beeld
   staat tussen alinea 2 en 3 in de content-preview.
2. Beeldwerk-scherm: inline-slot handmatig te vullen, vervangen, verwijderen, en
   te wisselen met featured/slider; slider vraagt nog om 1 beeld.
3. Backfill-endpoint tegen demo-data: gereed-concepten met 2 slider → 1 slider +
   1 inline; gepubliceerde ongemoeid; her-uitvoeren wijzigt niets meer.
4. Bouwcheck: `cd app && npx tsc --noEmit && npx next build`.

## Niet in scope (YAGNI)

- Geen ACF-veldwijzigingen in WordPress.
- Geen meerdere inline-beelden of vrij positioneerbare inline-beelden.
- Geen aanpassing aan reeds gepubliceerde live-artikelen.
