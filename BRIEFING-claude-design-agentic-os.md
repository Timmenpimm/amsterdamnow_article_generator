# Designbriefing — NOW OS (agentic OS, vervolg op de artikel-tool)

**Voor:** Claude Design
**Van:** Martijn Harpe (AmsterdamNOW / i2o)
**Datum:** 11 augustus 2026
**Type:** Interne webtool (dashboard), desktop-first — uitbreiding van de bestaande AmsterdamNOW artikel-tool
**Vervolg op:** `BRIEFING-claude-design.md` (19 juli 2026) + addenda. Deze briefing bouwt daarop voort; alles wat daar staat blijft gelden.

---

## 1. Context

De artikel-tool is uitgegroeid tot het hart van de AmsterdamNOW-redactie: onderwerpen invoeren, de AI-pipeline volgen op het kanban, beelden toevoegen, publiceren, Instagram-carousels maken. Dat werkt — maar de "pipeline" is inmiddels geen rechte lijn meer. Er draaien de facto al meerdere autonome processen naast elkaar: de bronscanner, de schrijver, de beeldselectie-autofill, de stijlcurator, de auditor, de auto-publisher, de SEO-subworkflow, de socials-engine.

**Het probleem:** al die automatisering is nu onzichtbaar of verstopt. Je ziet op het kanban *dat* een kaart beweegt, maar niet *wie* eraan werkt, wat het kost, waarom iets misging, of wat er straks vanzelf gaat gebeuren. Instellingen zitten verspreid, goedkeuringsmomenten zijn impliciet (een kolomkopje "auto: aan"), en er is geen plek waar je in één blik ziet: draait alles, en mag het doorlopen?

**De oplossing:** de tool wordt **NOW OS** — een agentic besturingslaag over dezelfde redactiepipeline. Dit concept staat vast (niet herontwerpen, wel goed vormgeven):

- **9 benoemde agents:** Scout, Researcher, Schrijver, Beeldredacteur, Stijlcurator, Auditor, Publisher, Socials-agent, SEO-agent.
- **Een event-bus** als ruggengraat; het bestaande kanban (scherm 1a) blijft bestaan als *view* op diezelfde events.
- **Een mandaatmodel per agent, per domein**, met drie standen: **Stelt voor** / **Na goedkeuring** / **Autonoom** — plus een **goedkeuringen-inbox** waar voorstellen landen.
- **Een geheugen-/kennislaag:** entiteiten (venues, events, buurten) en stijlgeheugen, gekoppeld aan artikelen en beelden.
- **Een connectorregister:** WordPress, Instagram (socials-engine), Tavily, modelproviders — met gezondheid en status.
- **Een control plane:** budgetten, runs, traces, observability.

De redactie blijft klein (1–3 personen, Martijn voorop) en niet-technisch. Het OS-jargon blijft dus **onder de motorkap**: de UI praat over "agents", "voorstellen", "runs" en "geheugen" in gewoon Nederlands, niet over event-bussen en control planes.

## 2. Doel van deze ontwerpronde

Zes nieuwe schermen (6a t/m 6f), één mobiele variant (6g) en een set aanpassingen aan bestaande schermen (6h). Kernvraag die het geheel moet beantwoorden, in oplopende diepte:

1. **Wat doet het OS nu?** → Mission Control (6a)
2. **Wat wil het OS van mij?** → Goedkeuringen-inbox (6b)
3. **Wie zijn de agents en wat mogen ze?** → Agents-overzicht (6c) + Agent-detail (6d)
4. **Wat is er precies gebeurd (en waarom ging het mis)?** → Run-trace (6e)
5. **Wat weet het OS over de stad?** → Geheugen-verkenner (6f)

## 3. Stijlkaders (bindend)

De nieuwe schermen moeten er niet uitzien als een aangeplakt admin-paneel maar als **dezelfde tool, een verdieping dieper**. Concreet:

- **Zelfde topbar, zelfde shell.** Nieuwe schermen leven onder de bestaande topbar-navigatie (zie 6h).
- **Warme paper-look** (`#e9e8e4`-achtergrond), font **Archivo**, kaarten op `--card`, dunne borders, de bestaande chips (**amber** = wacht op mens, **groen** = klaar/gezond), status-**dots**, **hatch**-patronen voor lege/placeholder-vlakken.
- **Nuchtere redactionele toon.** Nederlands, direct, geen jargon: "Wacht op jouw akkoord", niet "Pending approval". Geen dashboards-met-gradients, geen glow, geen donkere "ops-console"-esthetiek, geen ronde meters. Cijfers zijn tekst in mono (`--mono`) op een kaart, geen gauges.
- **Informatiedichtheid mag hoog**, hiërarchie moet kloppen. Dit is zit-werk voor een redacteur, geen NOC-videowall.
- Technisch (ter info, niet leidend): implementatie volgt het bestaande patroon — inline styles met CSS-variabelen uit `globals.css`, géén Tailwind.

## 4. De agents (vaste cast, overal dezelfde volgorde en naamgeving)

| Agent | Doet | Bestaat nu al als |
|---|---|---|
| **Scout** | vindt onderwerpen in bronnen, stelt ze voor | bronscanner (3a–3c) |
| **Researcher** | verzamelt feiten en bronnen per onderwerp | Tavily-researchstap |
| **Schrijver** | schrijft het artikel (standaard + lijst) | writer/listWriter |
| **Beeldredacteur** | zoekt, scoort en plaatst beelden | beeldselectie + autofill |
| **Stijlcurator** | bewaakt toon en huisstijl van de tekst | stijlcurator-stap |
| **Auditor** | controleert feiten, links, velden | auditor |
| **Publisher** | zet klaar → live, kiest volgorde/timing | auto-publisher |
| **Socials-agent** | maakt en publiceert Instagram-carousels | carousel-flow (4a–4d) |
| **SEO-agent** | SEO-titel, meta, focus keyword, slug | SEO-subworkflow |

Elke agent krijgt **geen mascotte of avatar-illustratie** — een sober monogram/initiaal in een vierkantje (in de kaartstijl) is genoeg. Herkenbaarheid komt uit naam + vaste positie, niet uit kleurcodering per agent (kleur blijft gereserveerd voor status).

---

## 5. Scherm 6a — Mission Control

### Doel
Het nieuwe openingsscherm naast het kanban. Eén blik moet antwoord geven op: **draait alles, wat gebeurt er nu, wat kost het vandaag, en waar word ik verwacht?** Daarna klik je door — dit scherm doet zelf weinig, het verwijst goed.

### Layout (desktop)
Drie zones, van urgent naar achtergrond:

1. **Bovenrij — "Nu":** links een brede kaart **Actieve agents** (wie draait op dit moment, waaraan), rechts twee smalle kaarten: **Goedkeuringen** (teller + knop) en **Vandaag** (kosten/tokens/artikelen).
2. **Middenzone — "Zojuist":** een verticale lijst **Recente runs** (laatste ~15), elk één regel.
3. **Onderrij — "Systeem":** één platte kaart **Koppelingen** met de gezondheid van de connectors.

Geen grafieken in v1. Geen wereldkaart, geen activity-feed die eindeloos scrollt.

### Key-elementen & microcopy

**Actieve agents** (kaart, kop "Nu bezig"):
- Per actieve agent één regel: dot (pulserend groen) · agentnaam · wat hij doet met het onderwerp erbij · looptijd. Bijv.:
  - `● Schrijver — "Nieuwe ramenbar in de Pijp" · 2 min bezig`
  - `● Beeldredacteur — itemfoto's voor "7 beste terrassen Oost" · item 3 van 7`
- Niets actief: rustige regel `Alle agents zijn klaar. Volgende geplande run: Scout, 14:00.`

**Goedkeuringen** (kaart):
- Groot getal + label: `4 voorstellen wachten op je` — het getal in amber als > 0, grijs bij 0.
- Knop `Naar goedkeuringen →` (primair als > 0). Bij 0: `Niets te keuren 👍` mag zónder emoji — gewoon `Geen open voorstellen`.

**Vandaag** (kaart, mono-cijfers):
- `Kosten vandaag: $1,84` · `Tokens: 412k` · `Artikelen af: 3` · `Gepubliceerd: 2`
- Subtiele vergelijking eronder: `gisteren $2,10`. Geen sparkline nodig, tekst volstaat.

**Recente runs** (lijst, kop "Zojuist gebeurd"):
- Per regel: status-dot (groen = gelukt, rood = mislukt, amber = wacht op akkoord) · tijd · agent · korte omschrijving · rechts kosten in mono.
  - `● 13:42 · Auditor — "Nieuwe ramenbar in de Pijp" gecontroleerd, 2 punten aangepast · $0,03`
  - `● 13:31 · Publisher — wil "Techlab Marineterrein" publiceren → wacht op akkoord`
  - `● 13:12 · Scout — 6 nieuwe onderwerpen gevonden bij 3 bronnen · $0,02`
- Klik op een regel → run-trace (6e). Mislukte run toont de foutzin ingekort: `● 12:58 · Schrijver — mislukt: WordPress gaf 502 · opnieuw geprobeerd (2×)`.
- Onderaan: link `Alle runs →`.

**Koppelingen** (platte kaart, kop "Koppelingen"):
- Eén regel per connector: dot · naam · status: `WordPress ● verbonden` · `Instagram ● token verloopt over 43 dagen` (amber) · `Tavily ● 81% van maandquotum gebruikt` (amber) · `Model: Claude (Sonnet) ● ok`.
- Klik → het betreffende Instellingen-paneel (bestaande 5a-rail).

### States
- **Leeg (eerste gebruik / nacht):** geen runs vandaag → hatch-vlak in de runslijst met `Nog geen activiteit vandaag. De eerste geplande run is Scout om 07:00.`
- **Bezig:** zie boven; pulserende dot alleen bij echt actieve runs.
- **Fout:** een mislukte run kleurt zijn eigen regel, niet het hele scherm. Alleen als een **connector** plat ligt komt er een banner bovenaan (bestaande bannerstijl): `WordPress is onbereikbaar sinds 13:20. Agents die WordPress nodig hebben zijn gepauzeerd. → Controleer koppeling`.

### Interacties
- Alles is doorklikken: agentregel → agent-detail (6d), runregel → run-trace (6e), goedkeuringen → 6b, connectorregel → instellingen.
- Verversing: stil pollen (zoals het kanban al doet), geen refresh-knop nodig.

### Niet nodig
- Geen instelbare widgets/drag-and-drop-dashboard, geen datumbereik-kiezer, geen grafieken, geen realtime-log-stream, geen dark mode.

---

## 6. Scherm 6b — Goedkeuringen-inbox

### Doel
Alle voorstellen van agents op één plek, snel af te handelen. Dit is een **werklijst** in de geest van de bulk-flows die de tool al heeft: veel items, weinig klikken, duidelijke uitkomst per item. Dit scherm is de plek waar "Na goedkeuring"-mandaten hun mens ontmoeten.

### Layout (desktop)
- Lijst met voorstel-kaarten, nieuwste bovenaan, gegroepeerd per agent-type als er veel zijn (`Scout (6)`, `Publisher (2)`).
- Bovenaan een filterrij (pills, bestaande chipstijl): `Alles (8)` · `Onderwerpen` · `Publicaties` · `Beelden` · `Socials` · `Overig`.
- Rechtsboven bulk-acties, pas actief bij selectie.

### Key-elementen & microcopy

**Voorstel-kaart**, drie soorten dichtheid:

1. **Bundelvoorstel** (bijv. Scout): één kaart met kop `Scout stelt 6 onderwerpen voor · 13:12` en daaronder de zes onderwerpen als afvinkbare regels (standaard alles aangevinkt). Per regel de titel + herkomst: `Nieuwe vegan bakkerij Jordaan — via Het Parool`. Kaartknoppen: `Aangevinkte toevoegen (6)` (primair, groen) · `Alles afwijzen`. Regels los uitvinken past het getal in de knop live aan.
2. **Enkelvoudig voorstel met voorbeeld** (bijv. Publisher): kop `Publisher wil "Techlab Marineterrein" publiceren`, daaronder de reden in één zin (`Evergreen, 3 beelden compleet, categorie Cultuur is ondervertegenwoordigd deze week`) en een compacte artikel-preview-regel (thumbnail featured image + titel + link `Bekijk artikel`). Knoppen: `Publiceren` (groen) · `Afwijzen` · `Aanpassen…`.
3. **Beeldvoorstel** (Beeldredacteur): kop + de voorgestelde beelden als rij thumbnails (groot genoeg om te beoordelen — zie de bestaande regel: geen postzegels). Knoppen: `Beelden overnemen` · `Afwijzen` · `Zelf kiezen →` (gaat naar artikel-detail 1c).

**Per kaart altijd:**
- Agentnaam + tijd + het mandaat waaronder dit valt, klein: `Mandaat: publiceren — na goedkeuring`.
- **Mandaat-shortcut** als rustige tekstlink onderaan de kaart: `Voortaan autonoom voor dit type →`. Klik opent een kleine bevestiging (inline, geen modal): `Publisher mag voortaan zelf evergreen-artikelen publiceren. Je kunt dit terugdraaien bij de agent-instellingen. [Bevestigen] [Annuleren]`. Alleen tonen op voorsteltypes waar autonoom bestaat.
- `Afwijzen` vraagt optioneel (niet verplicht) een reden in één invoerveld: `Waarom niet? (helpt de agent leren — mag leeg)`.

**Bulk-acties:** checkbox per kaart, daarna rechtsboven `Goedkeuren (3)` · `Afwijzen (3)`. Bulk werkt alleen binnen hetzelfde type (de knop legt dat uit als het niet kan).

**`Aanpassen…`** opent geen nieuwe editor: het springt naar de bestaande plek waar dat kan (artikel-detail, carousel-editor) met een terugweg-broodkruimel `← Terug naar goedkeuringen`.

### States
- **Leeg:** hatch-vlak, `Geen open voorstellen. Agents met mandaat "na goedkeuring" melden zich hier.` + link `Bekijk mandaten →` (6c).
- **Bezig:** na goedkeuren blijft de kaart even staan met een groene bevestigingsregel (`Toegevoegd aan de wachtrij` / `Gepubliceerd → bekijk live`) en verdwijnt dan; geen abrupt weghappen.
- **Fout:** goedkeuren mislukt (bv. WP 502) → kaart blijft, rode regel `Publiceren mislukte: WordPress gaf een fout. [Opnieuw proberen]`.
- **Verouderd voorstel:** als de situatie intussen veranderd is (artikel al handmatig gepubliceerd): kaart gedimd met `Achterhaald — dit artikel is inmiddels gepubliceerd. [Weghalen]`.

### Interacties
- Sneltoetsen mogen (j/k door de lijst, a = goedkeuren, x = afwijzen) maar zijn een extraatje, geen vereiste voor het ontwerp.
- Teller in de topbar (zie 6h) telt live mee.

### Niet nodig
- Geen threads/discussie per voorstel, geen toewijzen-aan-collega (redactie van 1–3), geen snooze/uitstel-mechaniek, geen archiefweergave van oude beslissingen (dat leeft in de runs-historie).

---

## 7. Scherm 6c — Agents-overzicht

### Doel
De cast in beeld: alle 9 agents als kaarten, met per agent in één oogopslag status, mandaat-samenvatting en kosten. Dit is de ingang naar agent-detail (6d) én de plek waar je snel ziet welke agent "strak" staat en welke los.

### Layout (desktop)
- Grid van 9 kaarten (3×3 op breed, 2-koloms op smaller), vaste volgorde volgens de pipeline: Scout, Researcher, Schrijver, Beeldredacteur, Stijlcurator, Auditor, SEO-agent, Publisher, Socials-agent.
- Geen zoekbalk (9 items), wel bovenaan één samenvattingsregel: `6 agents autonoom · 2 na goedkeuring · 1 alleen voorstellen · alles gezond`.

### Key-elementen & microcopy

**Agent-kaart:**
- Kop: monogram-vierkantje + naam + status-dot (groen = ok/idle, pulserend = bezig, rood = laatste run mislukt, grijs = uitgeschakeld).
- Eén regel wat hij is: `Vindt onderwerpen in je bronnen.`
- **Mandaat-samenvatting** als chips: het strengste én meest voorkomende niveau, bv. `autonoom` (groen chip) of `2 van 4 domeinen na goedkeuring` (amber chip). Geen volledige mandaattabel op de kaart.
- Onderregel in mono: `Vandaag: 4 runs · $0,12` en `Laatste: 13:12 ✓` (of `13:12 ✕ mislukt`).
- Uitgeschakelde agent: kaart gedimd, chip `uit`, regel `Deze agent staat uit. Inschakelen kan bij de instellingen.`

### States
- **Leeg** bestaat hier eigenlijk niet (agents bestaan altijd); wel een **eerste-gebruik-variant** waarin agents nog nooit gedraaid hebben: onderregel `Nog niet gedraaid`.
- **Fout:** rode dot + `Laatste run mislukt · bekijk waarom →`.

### Interacties
- Klik op de kaart → agent-detail (6d). Geen quick-actions op de kaart zelf (geen aan/uit-toggle op het overzicht — te makkelijk mis te klikken; dat zit in 6d).

### Niet nodig
- Geen drag-to-reorder, geen "voeg agent toe" (de cast is vast in v1), geen per-agent grafiekjes.

---

## 8. Scherm 6d — Agent-detail

### Doel
Alles over één agent: wat hij mag (mandaten per domein), waarmee hij werkt (prompt/criteria), wat hij deed (runs) en wat hij kost (budget). Dit is het scherm waar vertrouwen wordt op- en afgeschaald.

### Layout (desktop)
Volgt het bestaande Instellingen-patroon (5a): kop met naam + status, daaronder secties onder elkaar in één kolom (geen tabs):

1. **Mandaten** (bovenaan — dit is de kern)
2. **Prompt & criteria** (verwijzingen, geen editor)
3. **Laatste runs**
4. **Budget**

### Key-elementen & microcopy

**Kop:** monogram + `Schrijver` + statusregel `Bezig met "Nieuwe ramenbar in de Pijp" · gestart 13:40` (of `Klaar. Laatste run 13:42 ✓`). Rechts één beheerste actie: toggle `Agent actief` (bestaand toggle-patroon uit Bronnen).

**Mandaten** (sectie, kop "Wat mag deze agent?"):
- Per **domein** één rij met een **3-standen-keuze** (segmented control in kaartstijl, geen dropdown):
  `Stelt voor` · `Na goedkeuring` · `Autonoom`
- Domeinen zijn per agent verschillend en concreet geformuleerd. Voorbeelden:
  - Scout: `Onderwerpen aandragen`, `Bronnen toevoegen`
  - Schrijver: `Artikel schrijven`, `Herschrijven na feedback`
  - Publisher: `Evergreen publiceren`, `Event-artikelen publiceren`, `Publicatievolgorde bepalen`
  - Socials-agent: `Carousel maken`, `Carousel publiceren op Instagram`
- Onder elke rij één toelichtende zin die meebeweegt met de keuze: `Autonoom: de Publisher publiceert evergreen-artikelen zelf zodra ze compleet zijn.` / `Na goedkeuring: voorstellen verschijnen in je goedkeuringen-inbox.`
- Wijziging = direct opgeslagen + toast (`Mandaat aangepast`), geen aparte save-knop (consistent met bestaande instellingen).

**Prompt & criteria** (sectie):
- Geen editor hier. Kaartregels met links naar de bestaande panelen: `Schrijfprompt (standaard) — versie 12 · Bekijk in Instellingen →`, `Criteria (standaard) →`. Zo blijft er één bron van waarheid (5a/5b).

**Laatste runs** (sectie):
- Zelfde regelopbouw als Mission Control, maar alleen van deze agent, met per regel een uitklap-chevron die een **mini-trace** toont: stappen als compacte tijdlijnregels (`13:40 gestart → 13:41 research opgehaald → 13:42 concept geschreven (2.104 woorden) → 13:42 klaar · $0,04`). Voor de volledige trace: `Volledige trace →` (6e).
- Mislukte run: rode stap met de fout + `2× opnieuw geprobeerd` + knop `Opnieuw uitvoeren`.

**Budget** (sectie, kop "Budget"):
- Twee instelbare waarden in kaartstijl: `Maximaal per dag: $2,00` en `Maximaal per run: $0,25`, met daaronder het werkelijke verbruik in mono: `Vandaag: $0,12 van $2,00`.
- Budget bereikt: agent pauzeert zichzelf; dat is een amber status op alle schermen: `Dagbudget bereikt · hervat morgen 00:00` met knop `Vandaag éénmalig verhogen…`.

### States
- **Leeg:** nieuwe/nooit-gedraaide agent → runs-sectie met hatch en `Nog geen runs.`
- **Bezig:** kop toont de lopende run; de runs-lijst toont hem bovenaan met pulserende dot.
- **Fout:** rode statusregel in de kop met de laatste fout in één zin + link naar de trace.

### Niet nodig
- Geen prompt-editing op dit scherm, geen versiegeschiedenis (leeft al in 5a's versielade), geen per-agent notificatie-instellingen, geen "kloon agent".

---

## 9. Scherm 6e — Run-trace / observability-detail

### Doel
Eén run volledig uitgeklapt: wat gebeurde er stap voor stap, wat ging erin en eruit, wat kostte het, en waar ging het mis. Voor de redacteur is dit het "waarom deed hij dat?"-scherm; voor Martijn het debug-scherm. Eén ontwerp moet beide dienen: leesbare tijdlijn eerst, techniek uitklapbaar.

### Layout (desktop)
- **Kopkaart:** agent + onderwerp + uitkomst + totalen.
- Daaronder een **verticale tijdlijn** van stappen, volledige breedte. Geen tweede kolom; input/output klapt ín de tijdlijn open.

### Key-elementen & microcopy

**Kopkaart:**
- `Schrijver — "Nieuwe ramenbar in de Pijp"` · uitkomstchip (`gelukt` groen / `mislukt` rood / `wacht op akkoord` amber)
- Mono-totalen: `13:40–13:42 (1m 54s) · 3 stappen · 41k tokens · $0,04 · model: Sonnet`
- Rechts: `Opnieuw uitvoeren` (secundair; primair alléén als de run mislukt is). Bij een run die tot een voorstel leidde: link `Bekijk voorstel →` (6b).

**Tijdlijnstap** (per stap één blok):
- Tijd · stapnaam in gewone taal · duur · status-dot. Voorbeelden: `13:40 · Research opgehaald (Tavily) · 12s ●`, `13:41 · Artikel geschreven · 1m 20s ●`, `13:42 · Concept naar WordPress · 4s ●`.
- **Toolcalls** binnen een stap als ingesprongen regels in mono: `tavily.search "ramenbar de pijp opening" → 8 resultaten`.
- **Input/output-snippets:** uitklapregel `Bekijk in- en uitvoer ▾` → mono-blok met de eerste ~15 regels + `Toon alles`. Lange JSON wordt niet mooi-geprint tot poster; gewoon scrollbaar mono-vlak in een kaart.
- **Kosten per stap** rechts in mono (`$0,03`), zodat je ziet welke stap duur was.
- **Fouten en retries:** een mislukte poging blijft in de tijdlijn staan, rood, met daaronder `Opnieuw geprobeerd (poging 2 van 3) ▸` en dan de geslaagde poging. De foutmelding in gewone taal eerst (`WordPress gaf een serverfout (502)`), technische details uitklapbaar.

### States
- **Bezig (live):** tijdlijn groeit onderaan aan met een pulserende laatste stap `● Bezig: artikel schrijven… (43s)`. Geen voortgangsbalk-fictie.
- **Mislukt:** kopkaart rood-gechipt; de fatale stap gemarkeerd; primaire knop `Opnieuw uitvoeren`. Erbij: `Opnieuw uitvoeren start de run vanaf het begin.` (geen stap-resume beloven die er niet is).
- **Leeg** bestaat niet (je komt hier altijd vanaf een bestaande run).

### Interacties
- Broodkruimel terug naar waar je vandaan kwam (`← Mission Control` / `← Schrijver`).
- Snippet-blokken hebben een kopieerknop (voor Martijn).

### Niet nodig
- Geen flamegraphs/waterfall-visualisaties, geen live-logstream, geen diff-weergave tussen runs, geen delen/exporteren.

---

## 10. Scherm 6f — Geheugen / entiteiten-verkenner

### Doel
Bladeren en zoeken door wat het OS over de stad weet: **venues, events, buurten** — en per entiteit zien welke artikelen en beelden eraan hangen. Dit maakt de kennislaag zichtbaar (en corrigeerbaar): "wat weten we al over dit adres, hebben we hier al eens over geschreven?"

### Layout (desktop)
- **Kop:** zoekveld over alles (`Zoek een venue, event of buurt…`), daarnaast type-filterpills `Alles` · `Venues` · `Events` · `Buurten`.
- **Lijst links (smal), detail rechts (breed)** — master-detail, vergelijkbaar met de Instellingen-rail maar met inhoud.

### Key-elementen & microcopy

**Lijstitem:** naam + type-label + één kernfeit: `Ramen-Ya · venue · De Pijp · 2 artikelen`. Sorteer op recentst-geraakt.

**Entiteit-detail (venue):**
- Kop: naam + type + buurt-link (`De Pijp →` opent de buurt-entiteit).
- **Feitenkaart** (alleen-lezen, zoals het datamodel-principe uit de eerste briefing): adres, website, telefoon, coördinaten, rubriek — met bronregel `Uit: "Nieuwe ramenbar in de Pijp" (12 aug)`.
- **Gekoppelde artikelen:** compacte lijst met status-dot (concept/gepubliceerd) + datum; klik → artikel-detail (1c) of live artikel.
- **Beelden:** thumbnail-grid van beelden die aan deze entiteit hangen (uit de media-bibliotheek, met de bestaande naamconventie). Groot genoeg om te herkennen.
- **Stijlgeheugen** (aparte kaart onder aan, alleen bij relevante entiteiten): korte genoteerde voorkeuren, bv. `Schrijf "de Pijp", niet "De Pijp", midden in een zin.` — alleen-lezen in v1, met regel `Beheer stijlregels in Instellingen →`.

**Entiteit-detail (event):** zelfde opbouw + datumregel (`begint 14 sep · eindigt 16 sep`) en een amber chip `verlopen` na afloop.

**Entiteit-detail (buurt):** zelfde opbouw + teller `23 artikelen · 8 venues` en de gekoppelde venues als sublijst.

### States
- **Leeg (geen resultaten):** `Niets gevonden voor "…". Entiteiten ontstaan automatisch uit artikelen — schrijf ergens over en het verschijnt hier.`
- **Leeg (kale start):** hatch + zelfde uitleg.
- **Detail zonder beelden/artikelen:** sectie met rustige regel `Nog geen beelden gekoppeld.`

### Interacties
- Zoeken filtert live. Entiteit-links binnen detail (buurt ↔ venue) navigeren binnen het scherm, met broodkruimel.
- **Geen** bewerken van feiten in v1 (correcties gaan via WordPress/artikel, zoals de eerste briefing dicteert); wel één actie `Meld onjuist gegeven` die een notitie voor de Auditor maakt.

### Niet nodig
- Geen grafische kaart/plattegrond, geen graafvisualisatie van relaties, geen handmatig entiteiten aanmaken, geen merge/dedup-UI (v2).

---

## 11. Scherm 6g — Mobiel: Mission Control + goedkeuringen

### Doel
Martijn keurt onderweg goed. Mobiel hoeft maar twee dingen perfect te doen: **zien of alles ok is** en **voorstellen afhandelen**. Volg de bestaande MobileHome-aanpak (1e): één schermbrede kolom, grote tap-doelen, geen zijbalken.

### Layout & elementen
- **Mobiel Mission Control:** gestapelde volgorde — (1) goedkeuringen-teller als grote tapbare kaart (`4 voorstellen wachten →`), (2) "Nu bezig"-regels, (3) vandaag-cijfers als één compacte regel, (4) koppelingen alléén als er iets amber/rood is (gezond = onzichtbaar op mobiel).
- **Mobiele goedkeuringen:** dezelfde voorstel-kaarten als 6b maar volledig gestapeld; knoppen onderaan de kaart over de volle breedte (`Publiceren` boven, `Afwijzen` eronder als tekstknop). Bundelvoorstellen: afvinkregels met ruime tap-hoogte. Beeldvoorstellen: thumbnails horizontaal swipebaar.
- **Geen swipe-om-goed-te-keuren** als enige weg (te foutgevoelig); knoppen zijn de primaire interactie, swipe mag als extraatje.
- Run-traces en agent-instellingen zijn op mobiel **leesbaar maar niet prioritair** — mandaten wijzig je op desktop. Mobiel toont bij mandaat-shortcuts een verwijzing: `Mandaten pas je aan op desktop.` (of gewoon dezelfde inline-bevestiging als het simpel kan — ontwerpkeuze aan jullie, licht toe).

### States
- Leeg: `Niets te keuren. Alles draait.` met de vandaag-cijfers eronder — het "alles is goed"-moment mag rustgevend zijn.
- Fout/offline connector: amber/rode kaart bovenaan, tapbaar.

---

## 12. 6h — Aanpassingen aan bestaande schermen

Geen nieuwe schermen, wel delta's. Ontwerp deze als kleine, precieze ingrepen in de bestaande vormen:

### Topbar (overal)
- Navigatie wordt: **Mission Control** (nieuw, eerste item) · **Bord** (het bestaande kanban 1a) · **Bronnen** · **Carousel** · **Archief** · **Geheugen** (nieuw, 6f) · **Instellingen**. Overleg gerust over inkorten/groeperen als dit te druk wordt — maar Mission Control en het Bord zijn beide primair.
- **Goedkeuringen-teller** in de topbar: een klein amber badge-getal op een vast icoon/woord `Goedkeuringen`, altijd zichtbaar, ook op het kanban. 0 = geen badge.
- De bestaande snelle-invoer en modus-indicator blijven onaangetast.

### Kanban (1a)
- Op kaarten waar een agent actief is: één regel onderin de kaart, agentnaam + dot: `● Schrijver bezig · 2 min`. Bij wachten op mens: amber `● Wacht op jouw akkoord` (tapbaar → goedkeuringen-item).
- Kolomkopjes die nu "auto: aan/uit" tonen (Klaar voor publicatie) verwijzen voortaan naar het mandaat: `Publisher: autonoom · volgende 14:00` — zelfde plek, rijkere betekenis.
- Verder niets: het bord blijft het bord.

### Instellingen-rail (5a)
- Nieuwe railgroep **"Agents"** boven "Algemeen", met de 9 agents als rail-items (klik → agent-detail 6d, gerenderd als paneel in de bestaande shell — 6c en 6d mogen ook als eigen route bestaan; kies één patroon en licht toe).
- Bestaande groepen (Standaard/Lijst/Algemeen) blijven; prompts en criteria blijven waar ze zijn — agent-detail linkt ernaar, verhuist ze niet.
- Connector-panelen (WordPress/Instagram/Tavily/Model) krijgen elk een status-dot in de rail, zodat de rail zelf al gezondheid toont.

---

## 13. Buiten scope (v1)

- Nieuwe agents toevoegen of agents configureren voorbij mandaten/budget.
- Entiteiten bewerken, mergen of handmatig aanmaken; graaf-/kaartvisualisaties.
- Notificaties buiten de tool (push/mail/WhatsApp) — de badge en de inbox zijn het kanaal.
- Historische analytics, kostengrafieken over weken, rapporten.
- Meerdere gebruikers met verschillende rechten (iedereen ziet en mag hetzelfde).

## 14. Gevraagde deliverables

1. Ontwerp van de zes schermen **6a–6f**, elk met de beschreven states (leeg/bezig/fout).
2. **6g**: mobiele variant van Mission Control + goedkeuringen.
3. **6h**: de topbar-navigatie, de kanban-kaart met agentregel, en de Instellingen-rail met Agents-groep — als delta-schetsen op de bestaande schermen.
4. Labels in het designbestand volgens de bestaande conventie: `data-screen-label="6a Mission Control"` enz., in hetzelfde canvas-bestand (`Artikel-tool.dc.html`) als de rest.
