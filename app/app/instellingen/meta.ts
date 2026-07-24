import type { ConstraintKind, PromptKind } from '@/lib/types';

// Interne selectie-key voor de rail: prompts, criteria, publiceren en de twee
// placeholder-schermen (variabelen, model).
export type RailKey = PromptKind | ConstraintKind | 'publiceren' | 'variabelen' | 'model';

export interface RailItem {
  key: RailKey;
  label: string;
}
export interface RailGroup {
  label: string;
  items: RailItem[];
}

// Rail-structuur exact zoals het redesign (schermen 5a/5b), in pipeline-volgorde.
export const RAIL_GROUPS: RailGroup[] = [
  {
    label: 'Standaard artikel',
    items: [
      { key: 'research', label: 'Research-prompt' },
      { key: 'schrijf', label: 'Schrijf-prompt' },
      { key: 'seo', label: 'SEO-prompt' },
      { key: 'standaard', label: 'Criteria' },
    ],
  },
  {
    label: 'Lijstartikel',
    items: [
      { key: 'lijst-selectie', label: 'Selectie-prompt' },
      { key: 'lijst-research', label: 'Verificatie-prompt' },
      { key: 'lijst-schrijf', label: 'Schrijf-prompt' },
      { key: 'lijst-seo', label: 'SEO-prompt' },
      { key: 'lijst', label: 'Criteria' },
    ],
  },
  {
    label: 'Algemeen',
    items: [
      { key: 'variabelen', label: 'Variabelen & context' },
      { key: 'publiceren', label: 'Publiceren' },
      { key: 'model', label: 'Model & koppelingen' },
    ],
  },
];

// Prompt-volgorde per groep — bepaalt de "stap X van Y"-eyebrow.
const STANDAARD_PROMPTS: PromptKind[] = ['research', 'schrijf', 'seo'];
const LIJST_PROMPTS: PromptKind[] = ['lijst-selectie', 'lijst-research', 'lijst-schrijf', 'lijst-seo'];

const TITLES: Record<RailKey, string> = {
  research: 'Research-prompt',
  schrijf: 'Schrijf-prompt',
  seo: 'SEO-prompt',
  'lijst-selectie': 'Selectie-prompt',
  'lijst-research': 'Verificatie-prompt',
  'lijst-schrijf': 'Schrijf-prompt',
  'lijst-seo': 'SEO-prompt',
  standaard: 'Criteria',
  lijst: 'Criteria',
  publiceren: 'Publiceren',
  variabelen: 'Variabelen & context',
  model: 'Model & koppelingen',
};

const DESCRIPTIONS: Record<RailKey, string> = {
  research: 'Zet de Tavily-bronnen om in controleerbare feiten en WordPress-metadata. Geldt voor élk volgend standaard artikel.',
  schrijf: 'Zet de research om in een volledig artikel met ACF-velden. Geldt voor élk volgend standaard artikel.',
  seo: 'Bepaalt RankMath-titel, meta description, focus keyword en slug. Geldt voor élk volgend standaard artikel.',
  'lijst-selectie': 'Kiest uit de research welke items in het lijstartikel terechtkomen.',
  'lijst-research': 'Verifieert per item adres, buurt en bronnen vóór het schrijven begint.',
  'lijst-schrijf': 'Zet de geverifieerde items om in een volledig lijstartikel met ACF-velden.',
  'lijst-seo': 'Bepaalt de RankMath-velden (titel, meta description, focus keyword, slug) voor het lijstartikel.',
  standaard: 'Vaste regels die Claude bovenop de standaard-prompt krijgt. Losse velden i.p.v. vrije tekst, zodat je niets per ongeluk sloopt.',
  lijst: 'Vaste regels die Claude bovenop de prompt krijgt. Losse velden i.p.v. vrije tekst, zodat je niets per ongeluk sloopt.',
  publiceren: 'Publiceert zelf artikelen uit "Klaar voor publicatie" op een instelbaar interval — één artikel per keer.',
  variabelen: 'Beheer de {{variabelen}} die n8n elke run bij de prompts invult.',
  model: 'Kies het Claude-model en beheer de koppelingen (WordPress, n8n).',
};

export interface PanelMeta {
  eyebrow: string;
  title: string;
  description: string;
}

function eyebrowFor(key: RailKey): string {
  const list = STANDAARD_PROMPTS as string[];
  const listL = LIJST_PROMPTS as string[];
  if (list.includes(key)) return `Standaard artikel · stap ${list.indexOf(key) + 1} van ${list.length}`;
  if (listL.includes(key)) return `Lijstartikel · stap ${listL.indexOf(key) + 1} van ${listL.length}`;
  if (key === 'standaard') return 'Standaardartikel · redactionele criteria';
  if (key === 'lijst') return 'Lijstartikel · redactionele criteria';
  if (key === 'publiceren') return 'Algemeen · publiceren';
  return 'Algemeen'; // variabelen, model
}

export function panelMeta(key: RailKey): PanelMeta {
  return { eyebrow: eyebrowFor(key), title: TITLES[key], description: DESCRIPTIONS[key] };
}

// Placeholder-tekst voor de "Binnenkort"-kaart (variabelen, model).
export const PLACEHOLDER_CARD: Record<'variabelen' | 'model', string> = {
  variabelen: 'Hier beheer je straks de variabelen die n8n bij elke prompt-run invult, met een overzicht van waar elke variabele vandaan komt.',
  model: 'Hier kies je straks het Claude-model per pipeline-stap en beheer je de koppelingen met WordPress en n8n.',
};
