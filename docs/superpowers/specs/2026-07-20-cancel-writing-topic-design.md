# Annuleren van een 'writing'-topic op het statusbord

_20 juli 2026_

## Doel

In de kolom **"Wordt geschreven"** op het statusbord (`app/components/
Pipeline.tsx`, scherm **1a**) kun je een onderwerp dat actief door Claude
geschreven wordt (topic-status `writing`) nu niet verwijderen. Andere
kolommen ("In wachtrij", "Klaar — beelden nodig") hebben die optie al. Deze
wijziging voegt dezelfde mogelijkheid toe voor `writing`-kaarten.

## Scope

- **Wel**: een verwijderoptie op `writing`-kaarten (topics die Claude nu
  actief onderzoekt/schrijft).
- **Niet**: de amber `review`-kaarten in dezelfde kolom (lijstartikelen die
  wachten op jouw itemcontrole) — die blijven ongewijzigd; ze hebben al
  "Items controleren →".
- **Geen backend-wijziging.** `DELETE /api/topics/[id]` →
  `deleteTopic(id)` in `app/lib/db.ts` verwijdert een topic-rij nu al
  onvoorwaardelijk, ongeacht status. Dit endpoint bestaat en wordt
  hergebruikt.

## Implementatie

**Bestand:** `app/components/Pipeline.tsx` — geen andere bestanden.

1. Nieuwe handler `cancelWriting(t: Topic)`, naast de bestaande
   `removeTopic`/`deleteArticle`:
   - `confirm('"${t.title}" annuleren? Dit stopt de lopende
     Claude-generatie.')` — bij annuleren van de dialoog: niets doen.
   - Bij bevestigen: `fetch(\`/api/topics/${t.id}\`, { method: 'DELETE' })`
     (zelfde call als `removeTopic` gebruikt).
   - Bij een niet-ok response: `toast(body.error || 'Annuleren mislukt',
     { kind: 'error' })`.
   - Bij succes: `toast('Onderwerp geannuleerd')`.
   - `load()` aanroepen om het bord te verversen.

2. In het `writing.map(...)`-blok (huidige regels ~396-414): een kleine
   `✕`-knop toevoegen in de kaart-header, visueel/positioneel gelijk aan de
   bestaande ✕ op de kaarten in "In wachtrij" (`title="Annuleren"`,
   `cursor: pointer`, `onClick={() => cancelWriting(t)}`).

## Edge cases

- **Race met voltooiing**: als het schrijven afrondt tussen het openen van
  de confirm-dialoog en het vuren van de DELETE-fetch, is de DELETE nog
  steeds veilig — hij verwijdert alleen de topic-rij. Een inmiddels
  aangemaakt artikel leeft in de aparte `articles`-tabel en wordt niet
  geraakt.
- **Geen echte cancel van de lopende Claude-call**: dit is een "best
  effort" verwijdering van de wachtrij-entry, geen harde abort van een
  eventueel in-flight API-verzoek naar Claude. Consistent met hoe
  `removeTopic` nu al werkt voor `queued`-topics.
- Geen loading/disabled-state nodig — zelfde lichte patroon als de
  bestaande ✕-knoppen elders op het bord.

## Niet gedaan (bewust)

- Geen undo-toast (zoals `removeTopic` die wel heeft) — een `writing`-topic
  opnieuw in de wachtrij zetten na annuleren is niet vanzelfsprekend het
  gewenste "undo"-gedrag, dus weggelaten (YAGNI).
- Geen wijziging aan de `review`-kaarten (zie Scope hierboven).
