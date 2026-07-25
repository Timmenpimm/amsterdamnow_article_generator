# Auditor: onafhankelijke steekproefcontrole op te publiceren artikelen

Aanleiding: twee handmatige audits (25-07-2026) vonden in 5 van de 5 gecontroleerde
artikelen fouten die de pipeline zelf niet zag — verzonnen ruimtedetails, een
superlatief zonder onderbouwing, een fout stoelenaantal, een beeld van een ander
festival, en twee keer dezelfde voorbeeldzin uit de prompt midden in een artikel
over technoacts. De generatie kan dit niet zelf vangen: ze controleert haar output
tegen dezelfde research die de fout veroorzaakte.

De auditor is daarom een **tweede paar ogen met eigen bronnen**, handmatig aan te
roepen vanaf het bord.

## Kernprincipe: onafhankelijkheid

Wat de auditor controleert mag nergens leunen op wat de generatie heeft aangenomen.

| | Generatie | Auditor |
|---|---|---|
| Zoekmachine | Tavily (`tavily.ts`) | **Serper/Google** (`auditSearch.ts`) — andere index, andere snippets |
| Feitenbasis | `s.research` (eigen research-JSON) | de **artikeltekst uit WordPress**, zoals de lezer die ziet |
| Prompt | `research` + `schrijf` | eigen kinds `audit-claims` en `audit-beeld`, eigen versiebeheer |
| Code | `writer.ts` | `auditor.ts` — importeert niets uit `writer.ts` of `validation.ts` |
| Route | `/api/topics/process` | `/api/audit/*` |
| Opslag | `topics.list_state` | eigen tabellen `audits` + `audit_findings` |

Wat wél gedeeld is: het lezen van de artikelen uit WordPress (`wp.ts listArticles`)
en de fase-indeling (`articlePhase`). Dat moet ook — het gaat om exact dezelfde
artikelen. Onafhankelijk moeten de **bronnen en het oordeel** zijn, niet de vraag
welk artikel je bekijkt.

De auditor **wijzigt niets**: geen WordPress-writes, geen aanraking van de
auto-publisher. Hij rapporteert. Wat er met een bevinding gebeurt, blijft
redactioneel werk.

## Drie controles per artikel

### 1. Claimcheck (model + Serper)
Haal de harde, controleerbare beweringen uit de artikeltekst: getallen, jaartallen,
adres, openingstijden, prijzen, capaciteit, superlatieven ("grootste ter wereld"),
persoonsnamen en rollen, event-datums, line-up-namen. Zoek elke claim op via Serper
en beoordeel: `ok` (bevestigd), `twijfel` (niet te verifiëren), `fout` (bron zegt
iets anders). Altijd met bron-URL.

Superlatieven en getallen krijgen voorrang: dat is waar de audits de fouten vonden.

### 2. Beeldcheck (vision + heuristiek)
Per beeld één vision-beoordeling op de echte bytes: hoort dit beeld aantoonbaar bij
dit onderwerp, deze locatie en dit type ruimte? Plus twee deterministische signalen
die geen model nodig hebben:
- **Bestandsnaam wijst naar een ander onderwerp.** `awakenings-in-spaarnwoude` bij
  een Dekmantel-artikel is een harde fout die je zonder model ziet.
- **Alt-tekst gelijk aan de bestandsnaam** (of leeg) — alle 12 beelden uit de
  eerste audit hadden dit.

### 3. Tekstintegriteit (deterministisch, geen model)
Twee checks die geen bron nodig hebben:
- **Dubbele zin binnen het artikel.** De wijnkaart-zin stond twee keer in 87322.
- **Zin die letterlijk in een ander artikel op het bord voorkomt.** Dit vangt de
  promptvoorbeeld-lek zonder de promptlijst te kennen, én vangt toekomstige
  contaminatie die niet uit de prompt komt. Bewust breder dan de bestaande
  `findPromptExampleLeak` in de generatie — en losgekoppeld daarvan.

## Verloop

`POST /api/audit/run` maakt een run en trekt de steekproef (default 3 artikelen,
scope `drafts` = alles wat nog gepubliceerd moet worden, of `ready` = alleen
publicatieklaar). Artikelen die de afgelopen 14 dagen al geauditeerd zijn vallen
buiten de trekking, zodat een tweede run nieuwe artikelen pakt.

Daarna pollt de UI `POST /api/audit/tick`: **één artikel per aanroep**, zoals de
wachtrij. Dat houdt elke aanroep binnen de 60s-functielimiet (per artikel: 1
claim-extractie, 1-3 Serper-calls, 1 vision-call).

## Uitkomst

Per artikel een eindoordeel = het zwaarste bevinding-verdict (`fout` > `twijfel` >
`ok`), met de losse bevindingen eronder. Op het bord een knop in de kolomkop
"Klaar voor publicatie" en een paneel met de laatste runs.
