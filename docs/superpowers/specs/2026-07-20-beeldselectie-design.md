# Beeldselectie — voorselectie van rechtenvrije beelden per artikel

**Datum:** 20 juli 2026 · **Status:** gebouwd in dezelfde sessie als deze spec

## Doel

Het beeldwerk-scherm (1c) had een "BINNENKORT"-placeholder voor een image-agent.
Deze feature vult die in: per artikel zoekt de tool rechtenvrije kandidaat-
beelden (beide zijden ≥ 1000 px), laat Claude ze scoren op de AmsterdamNOW-
beeldstijl, en toont ze als aanklikbare voorselectie. Eén klik zet een
kandidaat als featured/slider-/itembeeld via de bestaande media-endpoints.

## Beeldstijl (vastgesteld door screening van amsterdamnow.com, juli 2026)

Referentiebeelden bekeken: Choux (interieur, rode trap, warm licht), V12
(oesters close-up, ondiepe scherptediepte), Papaverhoek (avondinterieur met
kaarslicht), Bols Spritz Garden (zonnig terras), Techlab (persfoto event),
Yayoi Kusama (museumbeeld). Conclusies:

- **Fotografisch en realistisch** — nooit illustraties, renders, posters,
  logo's of collages.
- **Warm en levendig**: natuurlijk licht of sfeervol interieurlicht;
  het "avondje uit"-gevoel. Rood/amber-accenten komen opvallend vaak terug.
- **Onderwerpen**: interieur van de zaak, terras/gevel, gerecht close-up,
  mensen die de plek echt gebruiken (niet poserend), event-/expo-beeld,
  straatbeeld van de buurt.
- **Specifiek wint van generiek**: het venue zelf > de buurt > generiek
  Amsterdam > generiek thema. Een andere herkenbare stad is diskwalificerend.
- **Formaat**: origineel meestal liggend (4:3/3:2/16:9), maar WordPress
  crop't ook naar 300×300 en 600×425 → onderwerp moet centraal staan zodat
  een vierkante crop werkt.
- Site levert 1024–1600 px breed; eis voor kandidaten: **breedte ≥ 1000 én
  hoogte ≥ 1000** (harde eis van de redactie).

## Bronnen (rechtenvrij, commercieel bruikbaar)

| Bron | Key nodig | Licentiefilter |
|---|---|---|
| Openverse API | nee | `license_type=commercial` (CC0/CC-BY/BY-SA) |
| Wikimedia Commons API | nee | extmetadata: alleen CC0/CC-BY(-SA)/PD |
| Pexels API | `PEXELS_API_KEY` (optioneel) | Pexels-licentie (vrij, ook commercieel) |
| Google Beeldzoeken (via Serper.dev) | `SERPER_API_KEY` (optioneel) | Googles CC-beeldfilter `tbs=il:cl` — vast aan |

Zonder enige key werkt de tool dus al (Openverse + Commons). Auteur +
licentie worden per kandidaat bewaard; bij gebruik wordt het fotograaf-veld
automatisch gevuld met "auteur · bron (licentie)" als het nog leeg is
(naamsvermelding CC-BY).

Over Google: de redactie zocht vroeger handmatig via Google Images, maar
zonder rechtenfilter is vrijwel alles daar auteursrechtelijk beschermd —
vandaar dat het filter hard aan staat en niet uitzetbaar is. Googles
licentie-info komt uit paginamarkup en is indicatief; de kandidaat-kaart
linkt daarom naar de bronpagina zodat de redactie het kan verifiëren.

Waarom via Serper.dev en niet Googles eigen API: Google heeft op 20-1-2026
de "Search the entire web"-optie voor nieuwe Programmable Search Engines
geschrapt en de Custom Search JSON API gesloten voor nieuwe aanmeldingen;
bestaande whole-web-engines stoppen 1-1-2027 en de enterprise-opvolger
begint bij $30.000/maand. Serper.dev levert dezelfde Google
Images-resultaten via een officieel images-endpoint.
Setup: account op serper.dev → API-key = `SERPER_API_KEY` op Vercel.
2.500 gratis credits; daarna vanaf ~$0,30 per 1.000 zoekopdrachten
(de tool doet er 4 per artikel).

## Architectuur

- **`lib/imageSearch.ts`** — zoektermen uit artikel (naam_locatie, titel,
  buurt/district, tags), parallel zoeken bij de providers, normaliseren,
  filteren (≥1000×1000, licentie, geen SVG), dedupliceren.
- **`lib/claude.ts`** — nieuwe `askClaudeJsonWithImages(...)`: één
  vision-call (FAST_WRITE_MODEL, Sonnet 5) met max 12 thumbnails als
  URL-image-blocks; zelfde JSON-herkansingslogica als `askClaudeJson`.
- **db**: tabel `image_candidates` (post_id, url, thumb_url, width, height,
  source, license, author, score, reason, role, status …) in beide drivers.
  Status: `new → scored → used | dismissed`. Afgewezen kandidaten blijven
  staan (dedup: komen bij vernieuwen niet terug).
- **API** (met vercel.json-rewrites vóór de artikel-catch-all):
  - `GET  /api/articles/[id]/candidates` — lijst
  - `POST /api/articles/[id]/candidates/search` — zoeken + opslaan (geen Claude)
  - `POST /api/articles/[id]/candidates/score` — max 12 per tik scoren (één
    Claude-call per request, i.v.m. 60s-limiet; client herhaalt tot alles
    gescoord is)
  - `PATCH /api/articles/[id]/candidates` — status (used/dismissed)
- **UI**: het BINNENKORT-blok in `ArticleDetail.tsx` wordt de sectie
  "Voorgestelde beelden": zoekknop, voortgang, kaart-grid met scorebadge,
  motivatie, bron/licentie, acties ★ featured / + slider / item-kiezer / ✕.

## Foutafhandeling

- Providers falen onafhankelijk (Promise.allSettled); één dode bron breekt
  de zoekronde niet.
- Vision-call die faalt op onbereikbare thumbnails: herkansing met kleinere
  batch (6), daarna nette foutmelding.
- Scoren zonder resultaten of zonder ANTHROPIC_API_KEY geeft een duidelijke
  Nederlandse melding; de gevonden (ongescoorde) kandidaten blijven bruikbaar.

## Autofill (toegevoegd op verzoek van de redactie, zelfde dag)

Voor een **vers** artikel (draft, 0 beelden, geen enkele kandidaat door de
redactie gebruikt of afgewezen) vult de tool de beste 3 beelden alvast in:
featured (het rol-advies van de beoordelaar, anders de hoogste score) + de
twee beste daarna voor de slider. Alleen kandidaten met score ≥ 55
(`AUTO_MIN_SCORE`) komen in aanmerking; scoort niets zo hoog, dan blijft
het artikel leeg en staan de kandidaten klaar in de grid.

- Route `POST /api/articles/[id]/candidates/autofill` — één stap per tik
  (zoeken → per tik één scorebatch → plaatsen), zelfde 60s-patroon.
- **Aanjagers**: het Pipeline-bord draait autofill op de achtergrond voor
  het eerste verse artikel (met toast als er geplaatst is), en het
  beeldwerk-scherm start hem bij openen als het bord er nog niet aan
  toegekomen is. De server bewaakt idempotentie: aangeraakt werk geeft
  `eligible: false`.
- De knop in het beeldwerk-scherm heet daarna "↻ Meer alternatieven":
  handmatig zoeken blijft de route naar extra keuze.
- Scoringslogica gedeeld in `lib/imageScore.ts` (gebruikt door /score en
  /autofill).

## Bewuste beperkingen (YAGNI)

- Geen aparte pagina; alles in het bestaande beeldwerk-scherm.
- Automatische plaatsing alleen voor onaangeraakte artikelen; zodra de
  redactie iets deed blijft de machine eraf.
- Geen achtergrond-cron; het bord en het beeldwerk-scherm jagen de tikken aan.
