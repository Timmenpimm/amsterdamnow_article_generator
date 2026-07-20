# Designbriefing addendum — Nieuwe pagina "Bronnen" (agenda-scanner)

**Voor:** Claude Design
**Van:** Martijn Harpe (AmsterdamNOW / i2o)
**Datum:** 20 juli 2026
**Type:** Addendum bij `BRIEFING-claude-design.md` — een nieuw, vierde
kernscherm naast Pipeline, Archief en Prompt & instellingen.

---

## 1. Context

De tool krijgt een agenda-scanner: de redactie geeft URL's op van
agenda-/programmapagina's (poppodia, theaters, musea, horeca-nieuwssites,
buurtblogs). De tool leest die pagina's periodiek uit, laat Claude de voor
AmsterdamNOW relevante items eruit halen (events, nieuwe cafés/restaurants/
winkels, openingen) en zet die **direct als topic in de wachtrij** van de
Pipeline. Er is dus géén aparte controlestap: wat de scanner vindt, staat
gewoon tussen de andere onderwerpen op het bord en is daar te bewerken of te
verwijderen zoals elk ander topic.

De scanner onthoudt per bron wat er al eerder gevonden is: een volgende scan
levert alleen níeuwe items op, ook als hetzelfde event nog weken op de
bronpagina blijft staan.

Scannen gebeurt automatisch (dagelijks; het Vercel-plan staat niet meer toe)
én handmatig via een "Nu scannen"-knop, voor wie niet wil wachten.

## 2. Wat moet ontworpen worden

Eén nieuw scherm: **"Bronnen"**, als vierde item in de bestaande topbar-
navigatie (Pipeline · Archief · **Bronnen** · Prompt & instellingen). Zelfde
topbar, zelfde tokens, zelfde toon als de rest van de tool.

Het scherm heeft drie zones:

### A. Bron toevoegen (bovenaan, altijd binnen handbereik)
Eén invoerveld voor een URL + toevoegen-knop, in de geest van het
"Nieuw onderwerp"-veld op het Pipeline-bord. Na toevoegen verschijnt de bron
direct in de lijst eronder; een optioneel naamveld mag, maar de tool mag de
naam ook zelf uit de pagina halen — houd de invoer zo licht mogelijk.

### B. Bronnenlijst (het hart van het scherm)
Een verticale lijst van bron-kaarten. Per kaart:

- **Naam + URL** (URL secundair, monospace, ingekort).
- **Status laatste scan:** geslaagd (wanneer + hoeveel nieuwe topics),
  bezig (subtiele voortgang), of mislukt (rood, met korte reden — bv.
  "pagina niet bereikbaar"). Gebruik de bestaande statuskleuren
  (`--green-dark`, `--red`/`--red-bg`, `--blue`).
- **Teller:** totaal gevonden topics via deze bron sinds toevoeging.
- **Acties:** aan/uit-toggle (bron pauzeren zonder verwijderen — zelfde
  toggle-stijl als de Criteria-tab), verwijderen, en "Nu scannen" per bron.
- **Uitklapbaar (of secundair):** de recentste vondsten van deze bron, als
  compacte regels met datum + titel, met per regel een indicator "in
  wachtrij" / "al geschreven" / "verwijderd door redactie". Dit is de
  dedup-historie: het antwoord op "waarom komt dit event niet meer omhoog?".

### C. Scan-overzicht (rechterkolom of kopregel)
- Wanneer de volgende automatische scan draait ("elke ochtend om 07:00")
  en wanneer de laatste liep.
- Eén primaire knop **"Alle bronnen nu scannen"** (zelfde `btn-primary`
  stijl als "Opslaan").
- Resultaat van de laatste run: "8 nieuwe onderwerpen toegevoegd uit 5
  bronnen · 2 al bekend, overgeslagen" — met een link "bekijk op het bord"
  naar de Pipeline.

## 3. States die uitgewerkt moeten worden

1. **Leeg:** nog geen bronnen — korte uitleg + het toevoegveld prominent,
   in de stijl van de bestaande lege-wachtrij-state op het bord.
2. **Gevuld:** 5-8 bronnen met gemengde statussen (geslaagd, bezig, één
   mislukt, één gepauzeerd).
3. **Scan bezig:** hoe de lijst eruitziet terwijl bronnen één voor één
   verwerkt worden (denk aan de bestaande voortgangsstijl van
   "Wordt geschreven": dun voortgangsbalkje, `--blue`).
4. **Fout-state van een bron** (onbereikbaar/geblokkeerd) met de
   "Opnieuw proberen"-afhandeling zoals bij mislukte topics op het bord.

## 4. Stijl — blijf binnen het bestaande systeem

- Tokens uit `app/app/globals.css`; geen nieuwe kleuren of stijlen.
- Kaarten: `--card` op `--soft`/`--sidebar` achtergronden, `--border-light`
  randen, radius 8-10 — identiek aan de topic-kaarten op het bord.
- Toon: Nederlands, direct, geen jargon ("Bron niet bereikbaar", niet
  "Fetch error 503").
- Informatiedicht mag; dit is beheer-werk, geen consumentenapp.
- Desktop-first; mobiel hoeft alleen het toevoegen van een URL prettig te
  werken (idee onderweg → bron erbij).

## 5. Gevraagde deliverable

Eén schermontwerp van de Bronnen-pagina in gevulde staat (zone A+B+C
zichtbaar, gemengde bron-statussen, één kaart uitgeklapt met
vondsten-historie), plus de lege state als kleiner tweede beeld. De
fout- en bezig-states mogen als varianten van één bron-kaart getoond
worden, hoeven geen volledig scherm.
