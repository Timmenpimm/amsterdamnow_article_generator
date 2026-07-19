# Designbriefing addendum — Instellingen: tab "Criteria"

**Voor:** Claude Design
**Van:** Martijn Harpe (AmsterdamNOW / i2o)
**Datum:** 20 juli 2026
**Type:** Addendum bij `BRIEFING-claude-design.md` — vult géén nieuw kernscherm
maar een nieuw onderdeel van de bestaande Instellingen-pagina aan.

---

## 1. Context

De Instellingen-pagina bestaat al: links een editor, rechts een
versiegeschiedenis-paneel met rollback. Tot nu toe bewerkt die editor alleen
**prompts** (vrije tekst voor Claude) via een tekstarea. Zie
`app/instellingen/page.tsx` voor de huidige, werkende layout — die blijft
grotendeels intact.

Er komt een derde tab-groep **"Criteria"** bij, naast de bestaande "Standaard"
en "Lijstartikelen"-groepen. Deze tabs bewerken geen vrije tekst maar
**gestructureerde redactionele regels**: woordaantallen, verboden woorden,
quote-bronnen blacklist, aan/uit-regels. Zie
`docs/superpowers/specs/2026-07-20-configurable-constraints-design.md` voor
het volledige datamodel — deze briefing gaat alleen over hoe dat er **visueel**
uit moet zien.

## 2. Wat moet ontworpen worden

Het middenpaneel van de bestaande Instellingen-layout (waar nu de tekstarea
staat) krijgt voor de Criteria-tabs een **formulier in secties** in plaats van
een tekstarea. Rechterpaneel (versiegeschiedenis) en de knoppenbalk onderaan
("Wijzigingen verwerpen" / "Opslaan als vX") blijven zoals ze zijn.

Vier bouwstenen, herbruikbaar over beide Criteria-tabs ("Standaard artikel" en
"Lijstartikel"):

### A. Number-paar (min/max)
Twee kleine number-inputs naast elkaar met een scheidingsteken ("t/m" of "–"),
met het label ervóór. Bijvoorbeeld: `Titel  [8]  t/m  [12]  woorden`.
Compact — er komen zo'n 5–6 van deze rijen onder elkaar per tab.

### B. Los getal
Eén number-input met label en eenheid erachter, bv.
`Titel max. lengte  [75]  tekens` of `Quote-norm: 1 per  [3]  items`.

### C. Tag-editor (alleen bij "Lijstartikel")
Voor `forbiddenWords` en `quoteSourceBlacklist`: een veld met bestaande waarden
als verwijderbare chips (met een kruisje) en een invoerregel eronder/ernaast om
een nieuwe waarde toe te voegen (Enter = toevoegen). Twee van deze editors op
de pagina, elk met een eigen sectiekop en een zin uitleg erboven. Kan aardig
wat items bevatten (nu 9 verboden woorden/uitdrukkingen, 11 blacklist-domeinen)
— moet prettig blijven ogen ook als de lijst groeit.

### D. Toggle-rij
Een rij per redactionele regel: een switch/checkbox, een korte titel, en een
klein stukje grijze uitleg-tekst ernaast of eronder (bv. "Quote moet letterlijk
in de artikeltekst voorkomen — voorkomt dat Claude een quote verzint die niet
matcht met de tekst."). Circa 4 van deze rijen bij "Standaard artikel", circa 9
bij "Lijstartikel" — gegroepeerd onder een sectiekop "Redactionele regels".

## 3. Indeling per tab (volgorde van boven naar beneden)

**Standaard artikel:**
1. Sectiekop "Lengtes" — 5 number-paren (titel, subregel, introductie,
   artikeltekst, quote) + 1 los getal (min. aantal alinea's)
2. Sectiekop "Redactionele regels" — 4 toggle-rijen

**Lijstartikel:**
1. Sectiekop "Lengtes/aantallen" — titel max. tekens (los getal),
   introcontent-zinnen (number-paar), min. items (los getal), itembeschrijving-
   zinnen (number-paar), quote-norm (los getal), min. genoemde items in
   afsluiting (los getal)
2. Sectiekop "Verboden woorden" — tag-editor
3. Sectiekop "Quote-bronnen blacklist" — tag-editor
4. Sectiekop "Redactionele regels" — 9 toggle-rijen

## 4. Stijl — blijf binnen het bestaande systeem

Gebruik de bestaande tokens uit `app/globals.css`, geen nieuwe kleuren of
stijlen:

- Achtergrond editor: `--card`; secties gescheiden met dunne `--border-light`
  lijnen, geen zware kaarten-in-kaarten.
- Sectiekoppen: zelfde stijl als de bestaande labels in de sidebar
  ("Versiegeschiedenis") — 11.5px, bold, uppercase, letterspacing, `--gray`.
- Tag-chips: zelfde afronding/schaal als de bestaande `--soft` achtergrond-chips
  bij "Variabelen" onderaan de huidige prompt-editor (`border-radius: 5px`,
  monospace-achtige of gewone tekst, klein kruisje-icoon in `--muted`).
- Toggle: eenvoudige aan/uit-switch in `--ink` (aan) / `--border` (uit) — geen
  kleurrijke iOS-achtige switch, dit is een redactietool.
- Uitleg-tekstjes: 12–12.5px, `--gray`, zoals de bestaande hint-tekst onderaan
  de huidige pagina.
- Amber-waarschuwingsblokje ("Let op: ...") mag hergebruikt worden als een
  toggle een risicovolle regel uitzet — geen nieuwe status nodig, puur de
  bestaande `--amber-bg`/`--amber-border` stijl.

## 5. Gevoel & richting

Zelfde als de hoofdbriefing: **redactietool, geen consumentenapp.** Dit scherm
wordt zelden bewerkt (in tegenstelling tot de dagelijkse workflow-schermen) —
rustig, dicht, geen onboarding-achtige uitleg-ballonnen. Eén blik moet
voldoende zijn om te zien welke regels aan staan en welke getallen gelden.

## 6. Gevraagde deliverable

Eén scherm-ontwerp van de "Lijstartikel"-tab (de rijkste variant: alle vier
bouwstenen komen erin voor) in de bestaande Instellingen-layout — inclusief
het bestaande rechterpaneel ernaast, zodat duidelijk is hoe het past in het
geheel. De "Standaard artikel"-tab volgt hetzelfde patroon en hoeft niet apart
uitgewerkt te worden.
