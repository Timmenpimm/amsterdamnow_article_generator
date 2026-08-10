# Briefing: visualisatie "NOW OS" — agentic OS voor Amsterdam NOW

Deze briefing is bedoeld om letterlijk in een beeldmodel (ChatGPT/Gemini) te plakken. Volg de specificatie exact; verzin geen extra lagen, agents of labels.

## 1. Context (één alinea)

De AmsterdamNOW artikel-tool is nu een redactionele pipeline-app: onderwerpen komen binnen, worden onderzocht, geschreven, van beeld voorzien en gepubliceerd naar WordPress en Instagram, zichtbaar op een kanban-bord. De volgende stap is **NOW OS**: dezelfde redactie, maar als agentic besturingssysteem — negen gespecialiseerde AI-agents die via een event-bus samenwerken, met per agent een instelbaar autonomieniveau, een gedeeld geheugen van de stad, een register van koppelingen en één Mission Control-dashboard erboven. De visual moet die evolutie van "tool" naar "OS" in één oogopslag overbrengen, in de nuchtere krantenhuisstijl van Amsterdam NOW.

## 2. Hoofdvisual: gelaagd architectuurdiagram

Eén liggend diagram (16:9) van zes horizontale lagen, gestapeld van onder (fundament) naar boven (bediening). Elke laag is een volle-breedte band met linksboven een klein laagnummer + laagnaam in kapitalen. Tussen de lagen dunne scheidingslijnen, krantachtig. Titel bovenaan: **"NOW OS"** groot, met eronder klein: *"Het agentic besturingssysteem van Amsterdam NOW"*.

Volgorde van onder naar boven (teken ze precies zo, met deze letterlijke Nederlandse labels):

**Laag 1 — KERNEL / AGENT-RUNTIME** (onderste, breedste band)
Negen gelijkvormige blokjes op een rij, elk met naam + minimaal lijn-icoon:
`Scout` · `Researcher` · `Schrijver` · `Beeldredacteur` · `Stijlcurator` · `Auditor` · `Publisher` · `Socials-agent` · `SEO-agent`

**Laag 2 — EVENT-BUS & WERKGRAAF**
Eén horizontale dikke lijn ("de bus") waarop vijf event-labels als kleine kaartjes staan, verbonden met pijlen van links naar rechts:
`topic.created` → `article.drafted` → `images.ready` → `published` → `social.published`
Rechts in deze band een klein kanban-icoontje met het label `Kanban blijft als view`. Verticale dunne pijlen omlaag naar de agents in laag 1 (agents abonneren zich op events) — teken er 3 à 4, niet allemaal.

**Laag 3 — MANDAATMODEL**
Drie stappen als oplopende schuifjes/segmenten met labels: `Voorstellen` → `Na goedkeuring` → `Autonoom`. Rechts ernaast een inbox-icoon met label `Goedkeuringen-inbox`. Onderschrift in de band: *"Per agent instelbaar autonomieniveau"*.

**Laag 4 — GEHEUGEN & KENNISLAAG**
Drie blokken: `Entiteiten (venues · events · buurten)` · `Stijlgeheugen` · `Dedup`. Teken dit als een lade/archief-metafoor (kaartenbak), passend bij print.

**Laag 5 — CONNECTORREGISTER**
Vier stekker-blokjes op een rij: `WordPress` · `Instagram / socials-engine` · `Tavily (research)` · `Modelproviders (Claude · Omniroute)`. Rechts een leeg gestippeld blokje met een `+` en het label `Uitbreidbaar`.

**Laag 6 — CONTROL PLANE** (bovenste band)
Vier blokken: `Mission Control` (dashboard-icoon) · `Agent-instellingen` · `Observability` · `Scheduler` (klok-icoon). Deze band mag iets donkerder/inkt-gevuld zijn dan de rest, als "cockpit".

**Pijlen/stromen over lagen heen (exact deze drie, meer niet):**
1. Eén doorlopende verticale pijl links langs het hele diagram, van laag 6 omlaag naar laag 1, label: `stuurt & bewaakt`.
2. Eén verticale pijl van laag 1 omhoog naar laag 2, label: `agents publiceren events`.
3. Eén pijl van laag 5 zijwaarts de rand van het beeld uit (naar rechts), label: `naar buitenwereld`.

## 3. Tweede visual (optioneel): de reis van één onderwerp

Horizontaal journey-diagram, zelfde stijl, zes stations op één lijn van links naar rechts, elk station = agent-blokje boven de lijn + event-label onder de lijn:

1. `Scout` vindt onderwerp → event `topic.created`
2. `Researcher` verrijkt met bronnen (klein Tavily-tandwiel)
3. `Schrijver` + `Stijlcurator` maken het artikel → `article.drafted`
4. `Beeldredacteur` levert beeld → `images.ready`
5. `Auditor` keurt; hier een klein pauze-symbool met label `Goedkeuring (mandaat)` — de enige onderbreking op de lijn
6. `Publisher` → WordPress (`published`), gevolgd door `Socials-agent` → Instagram (`social.published`)

Eindpunt rechts: een klein krantje + Instagram-post naast elkaar. Titel: *"Van signaal tot post — één onderwerp door NOW OS"*.

## 4. Stijlrichtlijnen (huisstijl, verplicht)

1. Achtergrond: warm papier `#e9e8e4`, vlak, eventueel héél subtiele papierstructuur.
2. Inkt: bijna-zwart `#1a1a1a` voor lijnen, tekst en iconen.
3. Accenten spáárzaam: rood (events/bus mag rood), groen (goedkeuring/`Autonoom`), amber (wacht-op-goedkeuring). Nergens meer dan ±10% van het beeld gekleurd.
4. Typografie: **Archivo** of vergelijkbare grotesque; laagnamen in kapitalen, labels letterlijk overnemen in het Nederlands.
5. Vormtaal: platte vlakken, dunne lijnen (1–2 pt), rechte hoeken of minimale afronding, lijn-iconen. Denk krantenkatern/printontwerp, redactioneel en nuchter.
6. Verboden: 3D, gradients, schaduwen, glow, stockfoto-stijl, robotjes/mascottes, Engelse laagnamen, glassmorphism.

## 5. Formaat

- Liggend **16:9** (bv. 1920×1080).
- Kleinste tekst nog leesbaar op laptopscherm; labels niet afbreken.
- Ruime marges rondom; het diagram vult het beeld, geen decoratieve opvulling.

## 6. Kant-en-klaar prompt-blok (plak dit in het beeldmodel)

```
Create a flat, editorial, newspaper-style layered architecture infographic, landscape 16:9.

Title top: "NOW OS", subtitle "Het agentic besturingssysteem van Amsterdam NOW".

STYLE: warm paper background #e9e8e4; near-black ink #1a1a1a for all lines, text and icons; sparse accent colors only (red for the event bus, green for approval/autonomy, amber for pending approval), max ~10% of the image colored. Typeface: Archivo or a similar grotesque sans; layer names in caps. Flat shapes, thin 1-2pt lines, line icons, square corners. Dutch newspaper print design: sober, editorial. NO 3D, NO gradients, NO shadows, NO glow, NO stock-photo look, NO robots or mascots.

DIAGRAM: six full-width horizontal layers stacked bottom (foundation) to top (control), thin rules between them, each with a small layer number + name top-left. Keep ALL labels exactly in Dutch as written:

Layer 1 (bottom) "KERNEL / AGENT-RUNTIME": nine equal blocks in a row, each with a small line icon: Scout, Researcher, Schrijver, Beeldredacteur, Stijlcurator, Auditor, Publisher, Socials-agent, SEO-agent.

Layer 2 "EVENT-BUS & WERKGRAAF": one thick horizontal bus line (red accent) with five small event cards connected left-to-right by arrows: topic.created -> article.drafted -> images.ready -> published -> social.published. At the right a small kanban icon labeled "Kanban blijft als view". Three or four thin vertical arrows down to the agents.

Layer 3 "MANDAATMODEL": three ascending segments labeled Voorstellen -> Na goedkeuring -> Autonoom (green on "Autonoom"), plus an inbox icon labeled "Goedkeuringen-inbox". Caption: "Per agent instelbaar autonomieniveau".

Layer 4 "GEHEUGEN & KENNISLAAG": three blocks drawn as a card-index/archive drawer: "Entiteiten (venues · events · buurten)", "Stijlgeheugen", "Dedup".

Layer 5 "CONNECTORREGISTER": four plug-style blocks: WordPress, Instagram / socials-engine, Tavily (research), Modelproviders (Claude · Omniroute); plus one dotted empty block with "+" labeled "Uitbreidbaar".

Layer 6 (top) "CONTROL PLANE", slightly ink-filled/darker band: Mission Control (dashboard icon), Agent-instellingen, Observability, Scheduler (clock icon).

Exactly three cross-layer arrows, no more: (1) one vertical arrow on the far left from layer 6 down to layer 1 labeled "stuurt & bewaakt"; (2) one vertical arrow from layer 1 up to layer 2 labeled "agents publiceren events"; (3) one arrow from layer 5 exiting the right edge labeled "naar buitenwereld".

All text large enough to stay readable on a laptop screen; generous margins; no decorative filler.
```

*(Voor de optionele tweede visual: zelfde stijlblok hergebruiken en het diagram uit §3 beschrijven als "horizontal journey diagram with six stations".)*
