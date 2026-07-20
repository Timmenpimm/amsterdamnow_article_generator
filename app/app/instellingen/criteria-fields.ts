import type { ListConstraints, StandaardConstraints } from '@/lib/types';

export interface RangeFieldDef<C> { type: 'range'; key: keyof C; label: string; unit: string; }
export interface NumberFieldDef<C> { type: 'number'; key: keyof C; label: string; unit: string; }
export interface TagsFieldDef<C> { type: 'tags'; key: keyof C; label: string; hint: string; placeholder: string; }
export interface ToggleFieldDef<C> { type: 'toggle'; key: keyof C; label: string; hint: string; }

export type FieldDef<C> = RangeFieldDef<C> | NumberFieldDef<C> | TagsFieldDef<C> | ToggleFieldDef<C>;

export const STANDAARD_FIELDS: { section: string; fields: FieldDef<StandaardConstraints>[] }[] = [
  {
    section: 'Lengtes / aantallen',
    fields: [
      { type: 'range', key: 'titleWords', label: 'Titel', unit: 'woorden' },
      { type: 'number', key: 'titleMaxChars', label: 'Titel — max. lengte', unit: 'tekens' },
      { type: 'range', key: 'subregelWords', label: 'Subregel', unit: 'woorden' },
      { type: 'range', key: 'introWords', label: 'Introductie', unit: 'woorden' },
      { type: 'range', key: 'contentWords', label: 'Artikeltekst', unit: 'woorden' },
      { type: 'range', key: 'quoteWords', label: 'Quote', unit: 'woorden' },
      { type: 'number', key: 'minParagraphs', label: "Minimum aantal alinea's", unit: "alinea's" },
    ],
  },
  {
    section: 'Redactionele regels',
    fields: [
      { type: 'toggle', key: 'titleMustContainTopic', label: 'Titel moet het onderwerp bevatten', hint: 'Voorkomt een titel die niets met het onderwerp te maken heeft.' },
      { type: 'toggle', key: 'quoteMustBeVerbatimInContent', label: 'Quote moet letterlijk in de artikeltekst voorkomen', hint: 'Voorkomt dat Claude een quote verzint die niet matcht met de lopende tekst.' },
      { type: 'toggle', key: 'noDashInText', label: 'Geen em-/en-dash toegestaan', hint: 'Houdt de schrijfstijl consistent met de rest van de site.' },
      { type: 'toggle', key: 'noAmsterdamRepeatInTitleSubregelIntro', label: '"Amsterdam" niet in titel, subregel of introductie', hint: 'Voorkomt overbodige herhaling; de site heet al Amsterdam Now.' },
    ],
  },
];

export const LIST_FIELDS: { section: string; fields: FieldDef<ListConstraints>[] }[] = [
  {
    section: 'Lengtes / aantallen',
    fields: [
      { type: 'number', key: 'titleMaxChars', label: 'Titel — max. lengte', unit: 'tekens' },
      { type: 'range', key: 'introSentences', label: 'Introcontent', unit: 'zinnen' },
      { type: 'number', key: 'minItems', label: 'Minimum aantal items', unit: 'items' },
      { type: 'range', key: 'itemSentences', label: 'Itembeschrijving', unit: 'zinnen' },
      { type: 'number', key: 'quoteNormPerItems', label: 'Quote-norm — 1 quote per', unit: 'items' },
      { type: 'toggle', key: 'quoteNormMandatory', label: 'Blockquote is verplicht', hint: 'Artikel wordt afgekeurd en automatisch herschreven als de quote-norm niet gehaald wordt, in plaats van alleen een melding voor de redactie.' },
      { type: 'number', key: 'minNamedItemsInClosing', label: 'Min. genoemde items in afsluiting', unit: 'items' },
    ],
  },
  {
    section: 'Verboden woorden',
    fields: [
      { type: 'tags', key: 'forbiddenWords', label: 'Verboden woorden', hint: 'Claude vermijdt deze woorden en uitdrukkingen volledig in lijstartikelen.', placeholder: '+ woord toevoegen & Enter' },
    ],
  },
  {
    section: 'Quote-bronnen blacklist',
    fields: [
      { type: 'tags', key: 'quoteSourceBlacklist', label: 'Quote-bronnen blacklist', hint: 'Quotes afkomstig van deze domeinen/bronnen worden niet overgenomen.', placeholder: '+ domein & Enter' },
    ],
  },
  {
    section: 'Redactionele regels',
    fields: [
      { type: 'toggle', key: 'titleNoCount', label: 'Titel mag geen aantal bevatten ("De 10 beste…")', hint: 'De lijst kan later aangevuld worden, dus geen vast getal in de kop.' },
      { type: 'toggle', key: 'subregelNoVanTotFormula', label: 'Subregel: geen vaste formule "van X tot Y"', hint: 'Voorkomt een sjabloon-achtige subregel.' },
      { type: 'toggle', key: 'subregelNoAmsterdamRepeat', label: 'Subregel herhaalt "Amsterdam" niet als dat al in de titel staat', hint: 'Voorkomt overbodige herhaling.' },
      { type: 'toggle', key: 'noDashInText', label: 'Geen em-/en-dash in lopende tekst', hint: 'Houdt de schrijfstijl consistent met de rest van de site.' },
      { type: 'toggle', key: 'noBulletsInItem', label: 'Item mag geen opsomming bevatten', hint: 'Itembeschrijvingen moeten lopende tekst zijn, geen bullet-lijst.' },
      { type: 'toggle', key: 'addressNotInDescription', label: 'Adres mag niet in de itembeschrijving staan', hint: 'Het adres wordt apart getoond; herhaling in de tekst oogt raar.' },
      { type: 'toggle', key: 'itemRequiresAddress', label: 'Item moet een adres hebben', hint: 'Item wordt overgeslagen als het adres ontbreekt in de research.' },
      { type: 'toggle', key: 'itemRequiresBuurt', label: 'Item moet een buurt hebben', hint: 'Item wordt overgeslagen als de buurt ontbreekt in de research.' },
      { type: 'toggle', key: 'noConsecutiveQuotes', label: 'Niet twee quotes bij opeenvolgende items', hint: 'Spreidt quotes door het artikel in plaats van ze te clusteren.' },
    ],
  },
];
