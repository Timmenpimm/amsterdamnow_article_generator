# Designbriefing addendum — Beeldselectie (voorgestelde beelden in het beeldwerk-scherm)

**Voor:** Claude Design
**Van:** Martijn Harpe (AmsterdamNOW / i2o)
**Datum:** 20 juli 2026
**Type:** Addendum bij `BRIEFING-claude-design.md` — uitbreiding van het
bestaande scherm **1c Artikel-detail / beeldwerk**. Geen nieuw kernscherm.

---

## 1. Context

Het beeldwerk-scherm had onderin het rechterpaneel een "BINNENKORT"-blok
voor de image-agent. Dat blok is nu een werkende functie: **Voorgestelde
beelden**. De tool zoekt per artikel rechtenvrije kandidaat-beelden (beide
zijden minimaal 1000 px) bij Openverse, Wikimedia Commons, Pexels en Google
Beeldzoeken (met vaststaand rechtenfilter: publiek domein/CC), en laat
Claude elke vondst beoordelen op de AmsterdamNOW-beeldstijl: warm,
fotografisch, on location — interieurs, terrassen, gerechten in close-up,
mensen die de plek echt gebruiken. De redactie kiest; de tool selecteert voor.

Elke kandidaat draagt een **score (0–100)** met een korte motivatie in één
zin, plus bron, maker en licentie (naamsvermelding hoort bij CC BY — bij
gebruik vult de tool het fotograaf-veld automatisch met "maker · bron ·
licentie" als dat veld nog leeg is).

## 2. Wat moet ontworpen worden

De sectie **"Voorgestelde beelden"** in het rechterpaneel van scherm 1c,
onder Featured/Slider (en bij lijstartikelen onder Itemfoto's; de sectie
nummert mee: 3 bij standaard, 4 bij lijst). Zelfde tokens, zelfde toon.

### A. Sectiekop
- Titel in de bestaande sectiekop-stijl ("3 · Voorgestelde beelden") met
  ernaast klein en grijs: "rechtenvrij · minimaal 1000×1000".
- Rechts een secundaire knop: **"Zoek kandidaten"** (eerste keer) of
  **"↻ Vernieuwen"** (als er al kandidaten staan).

### B. Bezig-state (twee fasen, tekstueel)
1. "Zoeken bij Openverse, Wikimedia Commons, Pexels en Google…"
2. "Claude beoordeelt de beelden… nog 14 te gaan" — de teller loopt in
   tikken van 12 terug (serverless-limiet), dus de voortgang is stapsgewijs.
   Dun voortgangsbalkje in `--blue`, zoals "Wordt geschreven" op het bord.

### C. Kandidaten-grid (het hart)
Grid van 2 kolommen met kandidaat-kaarten. Per kaart:
- **Thumbnail** (~128 px hoog, cover-crop), klikbaar naar de bronpagina.
- **Score** prominent linksboven in de metaregel, kleurgecodeerd:
  ≥75 `--green-dark` ("kan zo op de site"), 50–74 `--amber-dark`,
  <50 `--gray`. Ongescoord: "…".
- Bij het beste beeld een chip **"tip: featured"** (`chip-green`).
- **Motivatie**: één korte zin (11px, grijs), bv. "Warm interieur met
  kaarslicht, past bij de sfeer van het artikel."
- **Herkomstregel** (10.5px, muted, één regel met ellipsis):
  "Wikimedia Commons · Jan Jansen · CC BY 4.0".
- Afmetingen klein rechtsboven: "1600×1067".
- **Acties**: `★ Featured`, `+ Slider`, bij lijstartikelen `item…`
  (klapt een lijstje met de itemnamen uit), en rechts `✕` afwijzen.
  Gebruikte en afgewezen kandidaten verdwijnen uit de grid; afgewezen
  beelden komen bij Vernieuwen niet terug.

### D. Lege state
Gestippeld kader (zelfde stijl als het oude BINNENKORT-blok) met één zin
uitleg: wat de knop doorzoekt en dat Claude beoordeelt op de huisstijl.

## 3. States die uitgewerkt moeten worden

1. **Leeg** — nog geen kandidaten, alleen kop + uitlegkader + knop.
2. **Zoeken/scoren bezig** — fase-tekst + balkje; grid al deels gevuld met
   ongescoorde kaarten ("…" als score).
3. **Gevuld** — 6-8 kaarten, gemengde scores (één 80+, een paar amber, één
   laag), één met "tip: featured"-chip, verschillende bronnen/licenties.
4. **Lijstartikel** — zelfde grid maar met de `item…`-actie uitgeklapt op
   één kaart (lijstje itemnamen).

## 4. Stijl — blijf binnen het bestaande systeem

- Tokens uit `app/app/globals.css`; kaarten `--card` op `--sidebar`,
  `--border-light`, radius 10 — identiek aan de bestaande beeld-slots.
- Knoppen: bestaande `btn-small`; geen nieuwe knopstijlen.
- Toon: Nederlands, direct. "Claude kon de beelden niet beoordelen" in
  plaats van API-jargon; licentienamen wél letterlijk (CC BY 4.0).
- Informatiedicht mag: dit is een werkscherm voor de redactie.

## 5. Gevraagde deliverable

Eén bijgewerkt scherm 1c in gevulde staat (standaardartikel, 6+ kandidaten,
gemengde scores) + de lege en bezig-states als kleinere varianten van alleen
de sectie. Bij voorkeur ook één lijstartikel-variant met uitgeklapte
item-kiezer.
