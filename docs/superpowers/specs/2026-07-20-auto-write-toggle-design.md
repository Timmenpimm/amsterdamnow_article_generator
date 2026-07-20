# Automatisch schrijven — play/pause toggle

_20 juli 2026_

## Doel

De knop "Schrijf volgend artikel met Claude" in de kolom **Wordt geschreven**
(desktop kanban, `Pipeline.tsx`) en de gelijknamige knop in de mobiele weergave
worden vervangen door één toggle-knop die de schrijfflow continu laat draaien:
aan = elke 5 minuten automatisch een schrijfronde starten, uit = stoppen.

## Gedrag

- **Aanzetten**: start meteen één schrijfronde (`startWriting()`, ongewijzigd)
  én zet een herhalende timer van 5 minuten die daarna telkens opnieuw
  `startWriting()` aanroept. Dit werkt ook als de wachtrij op dat moment leeg
  is — dan doet die ronde niets (geen toast), en pakt de flow vanzelf op
  zodra er een onderwerp wordt toegevoegd.
- **Uitzetten**: stopt alleen de timer voor de vólgende ronde. Een schrijfactie
  die al bezig is (de bestaande tick-loop, tot 40 stappen) maakt gewoon af
  waar hij mee bezig is; er wordt niets halverwege geannuleerd.
- **Geen overlap**: de interval-callback slaat een ronde over als er al een
  schrijfactie bezig is (`writingNow`), zodat er nooit twee gelijktijdig
  draaien.
- **Geen persistentie**: de aan/uit-status leeft alleen in React state, niet
  in localStorage. Bij een page-refresh staat de toggle weer op uit — de
  automatische flow draait toch alleen zolang het tabblad open is (Vercel
  Hobby-cron kan geen 5-minuten-interval, zie `docs/DESIGN-MAP.md` §4
  valkuil 3).
- **Toegepast op desktop én mobiel**, beide via dezelfde `startWriting()`
  in `Pipeline.tsx` — geen apart mobiel pad.

## UI

Eén knop op de plek van de huidige schrijfknop:

- Uit, niets bezig: `▶ Automatisch schrijven`
- Aan, wacht op volgende ronde: `⏸ Automatisch schrijven (aan)`
- Bezig met schrijven (aan of uit maakt niet uit voor de lopende ronde):
  bestaande tekst `Claude schrijft…` blijft behouden, knop blijft klikbaar
  om de vólgende ronde te pauzeren.

Geen live countdown-timer in de UI (YAGNI) — alleen de aan/uit-status.

## Implementatie

Alles in `app/components/Pipeline.tsx`:

- Nieuwe state `autoOn: boolean` (default `false`).
- `useRef` voor de interval-id, zodat de effect-cleanup 'm kan wegvegen.
- `useEffect` op `autoOn`: bij `true` → direct `startWriting()` + `setInterval`
  elke 5 min (`300000` ms) die `startWriting()` aanroept (met een guard op
  `writingNow` om overlap te voorkomen); bij `false` of unmount →
  `clearInterval`.
- `startWriting()` krijgt een optioneel `silent`-flag (of: de interval-callback
  onderdrukt zelf de "wachtrij is leeg"-toast) zodat een automatische ronde
  met lege wachtrij niet elke 5 minuten een toast toont.
- De knop-JSX (desktop `Pipeline.tsx` regel ~378-385 en mobiel `MobileHome`
  regel ~676-683) wordt vervangen door de toggle: `onClick={() =>
  setAutoOn(v => !v)}`, label afhankelijk van `autoOn`/`writingNow`.
- `disabled`-conditie op de knop vervalt grotendeels — je mag 'm aanzetten met
  een lege wachtrij (dat is juist het punt); alleen tijdens het klikken zelf
  is er geen debounce nodig want het is een simpele state-toggle.

## Niet in scope

- Geen live countdown tot de volgende ronde.
- Geen server-side cron-variant.
- Geen wijziging aan de bestaande annuleerknop (✕) op een "wordt
  geschreven"-kaart — die blijft de lopende Claude-generatie direct afbreken,
  los van deze toggle.
