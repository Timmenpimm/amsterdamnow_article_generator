# Designbriefing — AmsterdamNOW Artikel-tool

**Voor:** Claude Design
**Van:** Martijn Harpe (AmsterdamNOW / i2o)
**Datum:** 19 juli 2026
**Type:** Interne webtool (dashboard), desktop-first

---

## 1. Context

AmsterdamNOW (amsterdamnow.com) is een online stadsmagazine over Amsterdam: restaurants, cultuur, uitgaan, winkels, lifestyle, buurten. Artikelen worden grotendeels automatisch geschreven door een AI-pipeline in n8n:

1. Een redacteur zet een **onderwerp/titel** in een Google Sheet.
2. n8n pakt elke 10 minuten het bovenste onderwerp, doet research (Tavily + Claude), schrijft het artikel en post het als **draft** naar WordPress, inclusief categorie, district, tags en ACF-velden.
3. Direct daarna draait automatisch een **SEO-subworkflow**: een AI-agent genereert per artikel de RankMath SEO-titel, meta description en focus keyword, en optimaliseert de slug/permalink. Ook dit gebeurt volledig zonder handwerk.
4. De redacteur voegt daarna handmatig beelden toe in WordPress en publiceert.

**Het probleem:** stap 1 en 4 zijn omslachtig. De Google Sheet is onhandig voor bulk-invoer, en het beeldwerk gebeurt nu in de WordPress-admin — traag, foutgevoelig, en er is geen overzicht van wat er in de wachtrij staat en wat nog beelden mist.

**De oplossing:** één webtool die de Google Sheet vervangt én de beeldselectie/publicatie-wachtrij beheert.

## 2. Doel van de tool

Eén dashboard waarin de redactie:

1. **Onderwerpen invoert** — één tegelijk, maar vooral ook véél tegelijk (bulk).
2. **De pipeline volgt** — welk onderwerp is in behandeling, welk artikel staat als draft klaar.
3. **Beelden toevoegt** aan artikelen die klaar zijn — elk artikel heeft **minimaal 3 afbeeldingen** nodig voordat het live mag.
4. **Publiceert** zodra een artikel compleet is.

## 3. Gebruikers

- Kleine redactie (1–3 personen), onder wie Martijn zelf. Geen technische gebruikers.
- Dagelijks gebruik, sessies van 10–30 minuten waarin veel items achter elkaar verwerkt worden. Snelheid en weinig klikken zijn belangrijker dan uitgebreide opties.
- Nederlands als voertaal van de UI.

## 4. Kernfunctionaliteit

### A. Onderwerpen toevoegen (vervangt de Google Sheet)

- **Snel één item toevoegen:** een invoerveld dat altijd binnen handbereik is (bovenaan of via sneltoets). Onderwerp = een titel/omschrijving in vrije tekst, bv. "Techlab Marineterrein: robots bouwen voor kids".
- **Bulk toevoegen:** een plak-veld waar je tientallen regels tegelijk in kunt plakken (één onderwerp per regel), met preview en de mogelijkheid regels te schrappen vóór bevestiging. Denk ook aan CSV-plak vanuit Excel.
- **Wachtrijbeheer:** volgorde aanpassen (drag & drop of prioriteit), items bewerken en verwijderen zolang ze nog niet opgepakt zijn.
- **Invoer = alleen de titel/het onderwerp.** Categorie, district, tags en alle overige metadata worden volledig automatisch door de AI bepaald — precies zoals in de huidige n8n-flow. De tool vraagt hier niets voor.

### B. Pipeline-overzicht (statusboard)

Elk item doorloopt deze statussen. De UI moet die reis in één oogopslag tonen — denk aan een kanban- of lijstweergave met statusfilters:

| Status | Betekenis |
|---|---|
| **In wachtrij** | Onderwerp ingevoerd, wacht op de AI |
| **Wordt geschreven** | n8n is bezig (research + schrijven + automatische SEO-optimalisatie) |
| **Klaar — beelden nodig** | Artikel staat als draft in WordPress, heeft nog geen 3 beelden |
| **Klaar voor publicatie** | Beelden compleet (≥3), wacht op akkoord |
| **Gepubliceerd** | Live op amsterdamnow.com |
| **Mislukt** | Pipeline gaf een fout; opnieuw proberen mogelijk |

### C. Beelden toevoegen (het hart van de tool)

Dit is de belangrijkste en meest ontwerp-gevoelige flow. Per artikel in status "Klaar — beelden nodig":

- **Artikel-preview:** titel, subregel, intro en de artikeltekst (HTML) leesbaar naast het beeldwerk, zodat de redacteur weet waar het over gaat en passende beelden kiest.
- **Drie beeld-slots, met duidelijke rollen:**
  1. **Featured image** (hero, verplicht) — dit wordt de hoofdfoto op de site.
  2. **Slider-beelden** (minimaal 2, verplicht) — extra foto's in de fotoslider van het artikel (ACF-veld `slider`).
  3. Optioneel: **inline beeld(en)** in de artikeltekst zelf.
- **Aanleveren van beelden:** drag & drop upload vanaf de computer (meerdere tegelijk), plus plakken van een afbeeldings-URL. Uploads gaan naar de WordPress-mediabibliotheek.
- **Visuele voortgang:** per artikel direct zichtbaar hoeveel van de 3 verplichte beelden gevuld zijn (bv. "1/3"). Publiceren is geblokkeerd tot ≥3 beelden aanwezig zijn — de tool bewaakt deze regel, niet de gebruiker.
- **Handige extra's:** beelden herschikken (welke wordt featured, volgorde slider), vervangen, en een veld voor fotograaf-credit (ACF-veld `fotograaf` bestaat al).

### D. Publiceren

- Vanuit de detailweergave of de lijst: één actie "Publiceren" (WordPress-status draft → publish). Met een lichte bevestiging, want dit is publiek zichtbaar.
- Na publicatie: link naar het live artikel.

## 5. Datamodel (uit de bestaande WordPress-site)

Ter referentie voor het ontwerp — dit zijn de velden die een definitief artikel heeft (geverifieerd via de REST API van amsterdamnow.com):

- **title** — kop
- **content** — HTML: opent met een dikgedrukte intro (h2), daarna paragrafen, vaak een inline afbeelding en een blockquote-citaat
- **featured_media** — hoofdfoto (ID uit mediabibliotheek)
- **acf.slider** — array van media-ID's (de extra beelden)
- **acf.introductie_tekst** — korte intro (los van de content)
- **acf.subregel** — onderkop/tagline
- **acf.rubriek** — bv. "Locatie"
- **acf.naam_locatie / adres / stad / website / telefoon_nummer** — locatiegegevens
- **acf.cord_A / cord_B** — lengte-/breedtegraad (kaartweergave op de site)
- **acf.fotograaf** — fotocredit
- **acf-vlaggen** — new_in_town, featured_item, beste_van_amsterdam, homepage_carousel (booleans)
- **categories** — extra, lifestyle, buurten, nieuws, restaurants, cultuur, uitgaan, winkels, smaakmakers
- **district** — amsterdam-centrum, -oost, -zuid, -noord, -west, -omgeving
- **tags** — vrij
- **SEO (RankMath, via de SEO-subworkflow):** rank_math_title, rank_math_description, rank_math_focus_keyword, plus een geoptimaliseerde **slug/permalink**

**Belangrijk:** al deze velden worden door de AI-pipeline ingevuld. In de tool zijn ze **alleen-lezen context** bij het artikel (zodat de redacteur ziet wat er gebeurt) — er is géén handmatige invoer of bewerking van categorieën, tags, district of tekstvelden. Wie iets wil corrigeren, doet dat in WordPress zelf. De enige handmatige invoer in de hele tool is: onderwerpen toevoegen, beelden toevoegen (+ fotograaf-credit) en publiceren.

## 6. Gevoel & richting

- **Redactietool, geen consumentenapp.** Efficiënt, kalm, overzichtelijk. Informatiedichtheid mag hoog zijn, maar met duidelijke hiërarchie.
- Beeldwerk is visueel werk: **de foto's moeten groot en goed te beoordelen zijn**, geen postzegel-thumbnails.
- De merkwereld van AmsterdamNOW (stads, cultureel, fotografie-gedreven) mag doorschemeren, maar functie gaat voor vorm.
- Desktop-first (dit is zit-werk), maar onderwerpen toevoegen moet ook op mobiel prettig kunnen — ideeën voor artikelen ontstaan onderweg in de stad.
- Toon in de UI: Nederlands, direct, zonder jargon ("Beelden nodig", niet "Assets pending").

## 7. Technische kaders (voor context, niet leidend voor het design)

- Backend praat met de **WordPress REST API** (posts, media, ACF, RankMath SEO-meta) en met **n8n** (de schrijf-pipeline én de SEO-subworkflow blijven bestaan; de tool vervangt de Google Sheet als bron van onderwerpen).
- Authenticatie: simpele login voor de redactie (geen publiek gedeelte).
- Verwachte schaal: tientallen artikelen per week, honderden in het archief.

## 8. Buiten scope (v1)

- Het bewerken van de artikeltekst zelf (dat blijft in WordPress mogelijk; de tool linkt ernaar door).
- AI-beeldgeneratie of automatische beeldselectie (er loopt een apart traject "image-agent" dat later kandidaat-beelden kan aanleveren — houd in het ontwerp rekening met een toekomstige rij "voorgestelde beelden" per artikel).
- Social media-distributie, statistieken/analytics.

## 9. Gevraagde deliverables

1. Ontwerp van de drie kernschermen: **(a)** onderwerpen invoeren incl. bulk-flow, **(b)** pipeline-overzicht/statusboard, **(c)** artikel-detail met beeldwerk-flow.
2. De lege, gevulde en fout-states van de wachtrij.
3. Mobiele variant van in elk geval het onderwerpen-invoerscherm.
