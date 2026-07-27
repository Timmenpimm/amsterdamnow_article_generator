// Categorie-specifieke researchprofielen voor de verdiepingsronde
// (writer.ts stepResearchAanvullend).
//
// De kalibratie van 25-07-2026 liet zien dat nietszeggende artikelen vrijwel
// altijd onderwerpen zijn waar ronde 1 alleen homepage-marketingcopy vond: een
// festival zonder line-up (Circoloco), een restaurant zonder één concreet
// gerecht (Veganees). Wat een artikel inhoud geeft verschilt per categorie —
// bij een festival is dat de line-up en de organisatie, bij een restaurant de
// kaart en de chef, bij een winkel wat 'm anders maakt. Dit bestand vertaalt
// de categorie/tag/rubriek uit ronde 1 naar gerichte zoekopdrachten en een
// focusinstructie voor de extractie van ronde 2.
//
// Puur en zonder I/O gehouden zodat het los testbaar is
// (scripts/researchprofiles.test.mjs).

export type ProfielKey =
  | 'festival' | 'voorstelling' | 'tentoonstelling' | 'restaurant'
  | 'winkel' | 'lifestyle' | 'evenement' | 'locatie';

function optionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

// Profiel afleiden uit wat ronde 1 al klasseerde: tag en categorieën zijn het
// specifiekst, rubriek (Locatie/Evenement) is het vangnet. Contains-match op
// kleine letters: "Festivals", "festival", "Tentoonstellingen" enz. tellen
// allemaal. De volgorde is bewust: specifieke termen eerst, en de
// festivalcheck vóór de horecacheck omdat festivalpagina's ook vol food-
// en barvermeldingen staan.
export function detectProfiel(research: Record<string, unknown> | null | undefined): ProfielKey {
  const r = research ?? {};
  const rubriek = optionalString(r.rubriek);
  const tekst = [optionalString(r.tag), ...stringList(r.categories)].join(' ').toLocaleLowerCase('nl-NL');
  if (/festival/.test(tekst)) return 'festival';
  if (/tentoonstell|expositie|galerie|musea|museum/.test(tekst)) return 'tentoonstelling';
  if (/theater|voorstelling|toneel|cabaret|comedy|dans|concert/.test(tekst)) return 'voorstelling';
  if (/restaurant|eten|drinken|food|caf|koffie|bar|brunch|lunch/.test(tekst)) return 'restaurant';
  if (/winkel|shop|store|markt|boetiek/.test(tekst)) return 'winkel';
  if (/lifestyle|wellness|spa|beauty|sport|fitness/.test(tekst)) return 'lifestyle';
  // "Uitgaan" zonder festivaltag: een clubnacht of feest gedraagt zich als
  // evenement, een club of bar als horecazaak.
  if (/uitgaan|nachtleven|club/.test(tekst)) return rubriek === 'Evenement' ? 'evenement' : 'restaurant';
  return rubriek === 'Evenement' ? 'evenement' : 'locatie';
}

// Gerichte zoekopdrachten per profiel. Het jaartal hoeft hier niet bij:
// researchWithTavily plakt dat al achter élke query. `plaats` (adres of stad)
// alleen bij vaste zaken; bij events/voorstellingen is de naam zelf
// onderscheidend genoeg en vervuilt een adres de treffers.
//
// De naam staat tussen aanhalingstekens: zonder die binding matchen de
// generieke termen ("line-up programma") net zo hard als de naam zelf, en
// haalt de query pagina's van vréémde festivals of zaken binnen — zo kwam er
// bij een ADE-onderwerp een DGTL-pagina mee die de invalshoek-poort vervolgens
// als "tegenspraak" las. Het relevantiefilter (lib/relevance.ts) is het vangnet
// daarachter; deze quotes verkleinen de instroom aan de bron.
export function profielQueries(profiel: ProfielKey, naam: string, plaats: string): string[] {
  const n = `"${naam.replace(/"/g, '')}"`;
  switch (profiel) {
    case 'festival': return [`${n} line-up programma`, `${n} organisatie interview`];
    case 'voorstelling': return [`${n} regisseur gezelschap`, `${n} recensie interview`];
    case 'tentoonstelling': return [`${n} kunstenaar curator`, `${n} recensie`];
    case 'restaurant': return [`${n} ${plaats} chef menukaart`, `${n} interview eigenaar interieur`];
    case 'winkel': return [`${n} ${plaats} assortiment concept`, `${n} interview oprichter`];
    case 'lifestyle': return [`${n} trend achtergrond`, `${n} interview oprichter`];
    case 'evenement': return [`${n} programma editie`, `${n} organisatie interview`];
    case 'locatie': return [`${n} ${plaats} openingstijden`, `${n} interview eigenaar`];
  }
}

// Extra focusregel voor de extractie-call van de verdiepingsronde: wat moet
// dit soort artikel ophangen, en waar mag dat vandaan komen. `officialHost`
// (hostname van de officiële site, indien bekend) maakt de festivalregel
// concreet: line-ups van verzamelsites zijn structureel die van de vórige
// editie (draft 87452, NO ART), dus artiesten tellen alleen met dekking op
// het eigen domein.
export function profielFocus(profiel: ProfielKey, officialHost?: string): string {
  const eigenDomein = officialHost ? `het officiële domein (${officialHost})` : 'het officiële domein van de organisatie';
  switch (profiel) {
    case 'festival':
      return `Dit is een festival: focus op de volledige line-up van de HUIDIGE editie, de organisatie erachter en de locatie. Neem artiesten ALLEEN over uit bronnen op ${eigenDomein}; line-ups op verzamelsites zijn vaak van een eerdere editie. Twijfel je of een line-up bij de huidige editie hoort, laat hem weg en zet "line-up huidige editie" in missing_facts.`;
    case 'voorstelling':
      return 'Dit is een voorstelling: focus op de regisseur, het gezelschap, eerdere producties en de speellocatie.';
    case 'tentoonstelling':
      return 'Dit is een tentoonstelling: focus op de kunstenaar (achtergrond, eerder werk), de curator en wat er concreet te zien is.';
    case 'restaurant':
      return 'Dit is een horecazaak: focus op de chef of eigenaar (waar die eerder werkte), concrete gerechten of dranken van de kaart, het interieur en het pand.';
    case 'winkel':
      return 'Dit is een winkel: focus op wat de winkel anders maakt dan vergelijkbare winkels, wie erachter zit en wat er concreet in de schappen ligt.';
    case 'lifestyle':
      return 'Dit is een lifestyle-onderwerp: focus op de trend erachter, waar die vandaan komt en wie er in de stad mee bezig zijn.';
    case 'evenement':
      return 'Dit is een evenement: focus op het programma van de huidige editie, de organisatie erachter en de locatie.';
    case 'locatie':
      return 'Dit is een vaste plek: focus op wie erachter zit, wat de plek onderscheidt en concrete details over ruimte en aanbod.';
  }
}
