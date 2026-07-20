# Tags matchen op bestaande WordPress-tags

## Probleem

Bij het genereren van een artikel (zowel losse artikelen als lijstartikelen)
mag de AI vandaag vrij nieuwe tags verzinnen. `app/lib/prompt-seeds.ts`
instrueert expliciet "bestaande of duidelijke nieuwe tags", en
`app/lib/wp.ts` (`tagIdsForNames`, regel 115-127) maakt automatisch een
nieuwe WordPress-tag aan zodra er geen bestaande tag met die naam gevonden
wordt. In tegenstelling tot categorieën en district — die al beperkt worden
tot de lijst die de gebruiker/WordPress aanlevert — ziet de AI de bestaande
tag-lijst nooit.

Gewenst gedrag: bij het maken van een artikel worden nooit nieuwe tags
aangemaakt. Tags moeten matchen op de huidige (bestaande) WordPress-tags; als
er echt geen passende bestaande tag is, blijft het tags-veld leeg.

## Aanpak

Zelfde patroon als categorieën/district: de bestaande tag-lijst wordt aan de
AI meegegeven, met de instructie er uitsluitend uit te kiezen. Daarnaast een
hard vangnet in `wp.ts` dat sowieso nooit een tag aanmaakt, ook niet als de
AI zich een keer niet aan de instructie houdt.

### 1. `app/lib/wp.ts` — bestaande tags ophalen

- `loadTaxonomies()` haalt naast categorieën en district ook de bestaande
  WordPress-tags op via `GET /wp/v2/tags?per_page=30`. **Cap: de eerste 30
  tags** (één pagina, geen paginering) — bewust klein gehouden op verzoek
  van de gebruiker, geen prompt-bloat.
- `taxonomyChoices()` retourneert er `tags: string[]` bij. In niet-live
  (demo) modus komt er een kleine demo-tag-lijst bij de bestaande
  demo-categorieën/districten.
- `tagIdsForNames()` verliest de `else { … POST … }`-tak: als er geen
  bestaande tag matcht (genormaliseerde naam-vergelijking, zoals nu al
  gebeurt vóór de create-fallback), wordt die tag-naam overgeslagen in
  plaats van aangemaakt. Er wordt dus nooit meer naar `POST /wp/v2/tags`
  geschreven vanuit dit pad.

### 2. `app/lib/prompt-seeds.ts` — research-prompt

- `<classification>`-blok: "Tags zijn alleen relevante, concrete labels;
  maximaal vijf." wordt "Kies tags uitsluitend uit de meegegeven lijst
  bestaande WordPress-tags; verzin nooit nieuwe tags. Kies maximaal vijf
  tags die echt relevant zijn; past geen enkele bestaande tag goed, geef dan
  een lege lijst terug."
- Output-schema: `"tags": ["maximaal vijf bestaande of duidelijke nieuwe
  tags"]` wordt `"tags": ["uitsluitend bestaande tags uit de meegegeven
  lijst, leeg als er geen passen"]`.

### 3. `app/lib/writer.ts`

- De prompt-tekst rond regel 126 (die nu `Beschikbare
  WordPress-categorieën: …` en `Beschikbare WordPress-districten: …`
  toevoegt) krijgt er een regel `Beschikbare WordPress-tags: …` bij, gevuld
  uit `taxonomies.tags`.

### 4. `app/lib/listWriter.ts`

- De compose-stap (rond regel 307-313) krijgt `beschikbare_tags:
  taxonomies.tags` toegevoegd aan de JSON-payload, naast
  `beschikbare_categorieen`/`beschikbare_districten`.
- De instructietekst ("voeg 3-6 tags … toe") wordt aangepast naar "kies 3-6
  tags uitsluitend uit `beschikbare_tags` (nooit nieuwe verzinnen; leeg als
  er geen passen)".

## Scope

Dit raakt alleen het aanmaak-pad: `createDraft` → `tagIdsForNames`. Er is
geen aparte tag-editor in de UI — tags worden alleen getoond
(`ArticleDetail.tsx`), niet handmatig bewerkt — dus dat pad hoeft niet
aangepast te worden.

`schemas.ts` blijft ongewijzigd: het `tags`-veld blijft een `STRING_ARRAY`,
alleen de prompt-instructie en de afdwinging in `wp.ts` veranderen.

## Niet in scope

- Paginering voorbij de eerste 30 tags.
- Wijzigingen aan hoe categorieën/district werken (die zijn al correct).
- Enige UI-wijziging.

## Testen

Er is geen testframework in deze repo. Verificatie:

- `tsc --noEmit` moet schoon blijven (baseline is al gecontroleerd).
- Handmatige/unit-achtige check van de genormaliseerde matching-logica in
  `tagIdsForNames` met een fake tag-lijst (bijv. via een tijdelijk script),
  om te bevestigen dat: exacte match → bestaand ID; near-match
  (hoofdletters/spaties) → bestaand ID; geen match → tag wordt overgeslagen,
  geen `POST` call.
