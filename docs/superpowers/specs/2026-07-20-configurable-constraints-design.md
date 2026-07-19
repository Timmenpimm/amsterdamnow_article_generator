# Instelbare artikel-constraints — design

## Doel

Alle redactionele checks en constraints die nu hardcoded in `lib/validation.ts`
staan (woordaantallen, verboden woorden, quote-bronnen blacklist, quote-norm,
etc.) worden bewerkbaar via het instellingen-menu, op dezelfde manier als de
Claude-prompts dat nu al zijn: met versiegeschiedenis en rollback.

## Datamodel

Nieuwe tabel `constraints`, zelfde vorm als de bestaande `prompts`-tabel:

```sql
CREATE TABLE constraints (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,        -- 'standaard' | 'lijst'
  version INTEGER NOT NULL,
  content TEXT NOT NULL,     -- JSON-blob, zie schema hieronder
  note TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT 'Martijn',
  created_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0
)
```

Twee `kind`-waarden, analoog aan de bestaande scheiding tussen standaard- en
lijstartikelen: `standaard` en `lijst`. Bij eerste gebruik wordt de tabel
geseed met v1 = de huidige hardcoded waarden uit `validation.ts` (inline
defaults in code, niet vanuit een seed-bestand, want het is geen platte
tekst).

Db-functies (in `lib/db.ts`), naar analogie van de prompt-functies:

- `listConstraints(kind): Promise<ConstraintVersion[]>`
- `activeConstraints(kind): Promise<StandaardConstraints | ListConstraints>`
- `saveConstraintVersion(kind, content, note): Promise<ConstraintVersion>`
- `activateConstraintVersion(id): Promise<ConstraintVersion | undefined>`

## Config-schema

Alle checks krijgen een instelbaar veld — inclusief de checks die de
betrouwbaarheid van het artikel bewaken (bv. "quote moet letterlijk in de
tekst staan"). Standaardwaarden staan op het huidige (strenge) gedrag, dus
niets verandert totdat iemand bewust een instelling aanpast.

### `standaard` (los artikel)

```ts
interface StandaardConstraints {
  titleWords: { min: number; max: number };       // 8-12
  subregelWords: { min: number; max: number };     // 10-15
  introWords: { min: number; max: number };        // 40-60
  contentWords: { min: number; max: number };      // 400-450
  quoteWords: { min: number; max: number };        // 15-25
  minParagraphs: number;                           // 5

  titleMustContainTopic: boolean;                  // true
  quoteMustBeVerbatimInContent: boolean;            // true
  noDashInText: boolean;                            // true
  noAmsterdamRepeatInTitleSubregelIntro: boolean;   // true
}
```

### `lijst` (lijstartikel)

```ts
interface ListConstraints {
  titleMaxChars: number;                    // 75
  introSentences: { min: number; max: number };   // 2-3
  minItems: number;                         // 3
  itemSentences: { min: number; max: number };    // 3-5
  quoteNormPerItems: number;                // 3  (1 quote verwacht per N items)
  minNamedItemsInClosing: number;           // 2

  forbiddenWords: string[];                 // huidige lijst uit validation.ts
  quoteSourceBlacklist: string[];           // huidige lijst uit validation.ts

  titleNoCount: boolean;                            // true — geen "De 10 beste..."
  subregelNoVanTotFormula: boolean;                 // true
  subregelNoAmsterdamRepeat: boolean;                // true
  noDashInText: boolean;                             // true
  noBulletsInItem: boolean;                          // true
  addressNotInDescription: boolean;                  // true
  itemRequiresAddress: boolean;                      // true
  itemRequiresBuurt: boolean;                        // true
  noConsecutiveQuotes: boolean;                      // true
}
```

## validation.ts

`validateArticle(article, topic, config: StandaardConstraints)` en
`validateListArticle(article, config: ListConstraints)` krijgen de config als
parameter. Elke hardcoded waarde/lijst/voorwaarde in de huidige functies wordt
vervangen door de bijbehorende `config.*`-waarde; een uitgeschakelde
boolean-check slaat de bijbehorende `throw` gewoon over.

`writer.ts` en `listWriter.ts` halen de actieve config op via
`activeConstraints('standaard')` resp. `activeConstraints('lijst')`, op
dezelfde plek waar ze nu al `activePrompt(...)` ophalen, en geven die door aan
de validatiefunctie.

## API

- `app/api/constraints/route.ts` — `GET ?kind=` (lijst versies + actieve),
  `POST` (nieuwe versie opslaan). Kopie van `app/api/prompts/route.ts`.
- `app/api/constraints/[id]/activate/route.ts` — `POST`, kopie van
  `app/api/prompts/[id]/activate/route.ts`.

## UI

De instellingen-pagina (`app/instellingen/page.tsx`) krijgt een derde
tab-groep **"Criteria"** naast "Standaard" en "Lijstartikelen", met twee tabs:
"Standaard artikel" en "Lijstartikel".

Voor deze tabs toont het middenpaneel geen tekstarea maar een **structured
form**, gegroepeerd in secties:

1. **Lengtes/aantallen** — number-inputs per min/max-paar of los getal.
2. **Woordenlijsten** (alleen bij `lijst`) — een tag-editor (chips + invoerveld
   met toevoegen/verwijderen) voor `forbiddenWords` en `quoteSourceBlacklist`.
3. **Redactionele regels** — toggles met korte uitleg per regel, gegroepeerd
   onder een sectiekop.

De rechterkant (versiegeschiedenis, "opslaan als nieuwe versie", bekijken,
terugzetten) blijft functioneel identiek aan het bestaande prompt-gedrag;
alleen de weergave van een versie in de geschiedenis toont een korte
samenvatting in plaats van ruwe tekst (bv. "Titel 8-12 woorden, quote-norm 1/3,
12 verboden woorden").

## Niet in scope

- Geen generieke/dynamische form-builder — het formulier is hardcoded per
  kind, gebaseerd op de twee interfaces hierboven.
- Geen wijziging aan de bestaande prompts-tabel of -pagina; die blijft zoals
  hij is, naast de nieuwe Criteria-tabs.
