// JSON-schema's voor de structured outputs van de Messages API
// (output_config.format). De API garandeert dan geldige JSON conform het
// schema, waardoor het corrigerende-herkansingspad in lib/claude.ts vervalt.
//
// Schema-eisen van de API (hard): elk object (ook genest) heeft
// "additionalProperties": false en een "required"-array met ALLE property-keys.
// Toegestaan: basistypen, enum, const, anyOf, arrays. NIET toegestaan:
// minLength/maxLength/minimum/maximum/multipleOf en recursieve schema's.
// Een leeg tekstveld is toegestaan (het blijft type string); nullable velden
// worden als anyOf met een null-variant gemodelleerd.
//
// Let op: de eerste call met een nieuw schema kent een eenmalige
// compilatie-latency; daarna geldt een schema-cache van ~24u. Dit is relevant
// i.v.m. de 60s-serverless-limiet die overal in deze codebase speelt — de
// eerste call na een deploy (of na 24u inactiviteit) is iets trager.

// Herbruikbaar: een array van strings.
const STRING_ARRAY = { type: 'array', items: { type: 'string' } };

// research-seed (prompt-seeds.ts) → parsing in writer.ts stepResearch/stepSeo.
// Alle velden verplicht; lege string of lege lijst is toegestaan wanneer een
// betrouwbaar gegeven ontbreekt.
export const RESEARCH_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'samenvatting', 'key_people', 'distinctive_features', 'product_or_menu_highlights',
    'company_facts', 'space_and_building', 'concept_description', 'categories',
    'district', 'tags', 'rubriek', 'naam_locatie', 'adres', 'stad', 'website',
    'start_datum', 'eind_datum',
  ],
  properties: {
    samenvatting: { type: 'string' },
    key_people: STRING_ARRAY,
    distinctive_features: STRING_ARRAY,
    product_or_menu_highlights: STRING_ARRAY,
    company_facts: STRING_ARRAY,
    space_and_building: STRING_ARRAY,
    concept_description: { type: 'string' },
    categories: STRING_ARRAY,
    district: { type: 'string' },
    tags: STRING_ARRAY,
    rubriek: { type: 'string' },
    naam_locatie: { type: 'string' },
    adres: { type: 'string' },
    stad: { type: 'string' },
    website: { type: 'string' },
    // Event-datums → WordPress ACF-velden start_datum/eind_datum (groep "Event").
    // Leeg laten (lege string) als het onderwerp geen event met een concrete
    // datum is (vaste zaak, doorlopende expositie, opening zonder datum). Bij een
    // eendaags event is eind_datum gelijk aan start_datum. Formaat JJJJ-MM-DD;
    // createDraft (wp.ts) zet dit om naar het ACF-formaat Ymd.
    start_datum: { type: 'string', description: 'Startdatum van het event als JJJJ-MM-DD, of "" als er geen concrete eventdatum in de bronnen staat.' },
    eind_datum: { type: 'string', description: 'Einddatum van het event als JJJJ-MM-DD (gelijk aan start_datum bij een eendaags event), of "" als er geen concrete eventdatum is.' },
  },
};

// schrijf-seed → writer.ts stepSchrijf/stepSchrijfRetry (buildCandidate).
// De veld-descriptions doen er hier toe: structured outputs (constrained
// decoding) laat het model sterk op het schema leunen, dus zonder deze
// beschrijvingen viel juist het creatiefste veld (de titel) plat. Ze zijn
// overgenomen uit de oorspronkelijke n8n-workflow, waar de titels punchier
// waren. De titel wordt daarnaast nog eens los, vrij (ongeconstrained)
// gegenereerd in writer.ts (polishTitle) — dit schema is het vangnet.
export const ARTICLE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'subregel', 'introductie_tekst', 'content', 'quote'],
  properties: {
    title: {
      type: 'string',
      description: 'Prikkelende, pakkende kop van 8-12 woorden. De naam van het onderwerp staat erin, bij voorkeur in de eerste helft (essentieel voor SEO). Gebruik een dubbele punt voor spanning. Vermijd saaie constructies als "Nieuw restaurant X opent zijn deuren". Geen em dash of en dash. Het woord "Amsterdam" mag er niet in.',
    },
    subregel: {
      type: 'string',
      description: 'Uitbreiding op de titel met NIEUWE informatie, 10-15 woorden. Geen herhaling van wat al in de titel staat. Het woord "Amsterdam" mag er niet in.',
    },
    introductie_tekst: {
      type: 'string',
      description: 'De essentie in drie zinnen, 40-60 woorden. Geen herhaling van titel of subregel. Niet openen met een jaartal. Het woord "Amsterdam" mag er niet in.',
    },
    content: {
      type: 'string',
      description: 'Hoofdtekst van 400-450 woorden (minimaal 400), verdeeld over minimaal vijf alinea\'s gescheiden door dubbele newlines. Concreet, informeel, Amsterdamse nuchterheid, geen corporate speak en geen em dashes. De quote-zin moet hier letterlijk in voorkomen.',
    },
    quote: {
      type: 'string',
      description: 'Pull-quote van 15-25 woorden die LETTERLIJK in de content voorkomt. Een krachtige zin met een concreet feit, geen vraag en geen meta-taal.',
    },
  },
};

// seo-seed én lijst-seo-seed → writer.ts stepSeo, listWriter.ts stepFinalize.
export const SEO_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['rank_math_focus_keyword', 'rank_math_title', 'rank_math_description', 'slug'],
  properties: {
    rank_math_focus_keyword: { type: 'string' },
    rank_math_title: { type: 'string' },
    rank_math_description: { type: 'string' },
    slug: { type: 'string' },
  },
};

// lijst-selectie-seed → listWriter.ts stepSelect.
export const LIST_SELECT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['kandidaten'],
  properties: {
    kandidaten: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['naam', 'reden', 'aanwijzing'],
        properties: {
          naam: { type: 'string' },
          reden: { type: 'string' },
          aanwijzing: { type: 'string' },
        },
      },
    },
  },
};

// lijst-research-seed → listWriter.ts stepVerify. "quote" is nullable: een
// object {tekst, bron, herkomst} of null (zie de quote_regels in de seed).
export const LIST_VERIFY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'reden', 'adres', 'buurt', 'extra_info', 'bron', 'feiten', 'quote'],
  properties: {
    status: { type: 'string', enum: ['verified', 'rejected'] },
    reden: { type: 'string' },
    adres: { type: 'string' },
    buurt: { type: 'string' },
    extra_info: { type: 'string' },
    bron: { type: 'string' },
    feiten: { type: 'string' },
    quote: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['tekst', 'bron', 'herkomst'],
          properties: {
            tekst: { type: 'string' },
            bron: { type: 'string' },
            herkomst: { type: 'string' },
          },
        },
        { type: 'null' },
      ],
    },
  },
};

// lijst-schrijf-seed PLUS de extra velden die stepCompose in de user-prompt
// vraagt (categories, district, tags, rubriek) → listWriter.ts stepCompose
// firstBatch.
export const LIST_COMPOSE_FIRST_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'title', 'subregel', 'introcontent', 'inleiding', 'afsluiting',
    'items', 'categories', 'district', 'tags', 'rubriek',
  ],
  properties: {
    title: { type: 'string' },
    subregel: { type: 'string' },
    introcontent: { type: 'string' },
    inleiding: { type: 'string' },
    afsluiting: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['naam', 'beschrijving', 'plaats_quote'],
        properties: {
          naam: { type: 'string' },
          beschrijving: { type: 'string' },
          plaats_quote: { type: 'boolean' },
        },
      },
    },
    categories: STRING_ARRAY,
    district: { type: 'string' },
    tags: STRING_ARRAY,
    rubriek: { type: 'string' },
  },
};

// ITEM_COMPOSE_PROMPT (listWriter.ts) → stepCompose vervolg-batches: alleen
// itemteksten, geen artikelstructuur of taxonomieën.
export const LIST_COMPOSE_ITEMS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['naam', 'beschrijving', 'plaats_quote'],
        properties: {
          naam: { type: 'string' },
          beschrijving: { type: 'string' },
          plaats_quote: { type: 'boolean' },
        },
      },
    },
  },
};

// SCAN_SYSTEM (scanner.ts) → runScan. "datum" is nullable: JJJJ-MM-DD als de
// brontekst een concrete eventdatum noemt, anders null (opening, doorlopende
// expositie, geen vaste datum) — runScan gebruikt 'm om al voorbije events
// eruit te filteren vóór ze de wachtrij bereiken.
export const SCAN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['titel', 'datum'],
        properties: {
          titel: { type: 'string' },
          datum: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
      },
    },
  },
};

// EDITORIALIZE_SYSTEM (scanner.ts) → editorializeTitles. Eén object per
// gescande bronkop, in dezelfde volgorde als de invoer: "bron" echoot de
// aangeleverde titel (ter controle van de koppeling), "topic" is het eigen
// input-topic dat de wachtrij ingaat.
export const SCAN_EDITORIALIZE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['topics'],
  properties: {
    topics: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['bron', 'topic'],
        properties: {
          bron: { type: 'string' },
          topic: { type: 'string' },
        },
      },
    },
  },
};

// DEDUP_SYSTEM (dedup.ts) → judgeDuplicate. "wp_id" is nullable: het wp_id van
// het bestaande artikel als "duplicate" true is, anders null.
export const DEDUP_JUDGE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['duplicate', 'wp_id', 'reason'],
  properties: {
    duplicate: { type: 'boolean' },
    wp_id: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    reason: { type: 'string' },
  },
};

// CLASSIFY_SYSTEM (publisher.ts) → classifyArticles. "event_date" is
// nullable: "YYYY-MM-DD" als het artikel over een specifieke aankomende
// gebeurtenis/datum gaat, anders null (evergreen content, of gewoon geen
// vaste datum).
export const AUTOPUBLISH_CLASSIFY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['classifications'],
  properties: {
    classifications: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'evergreen', 'event_date'],
        properties: {
          id: { type: 'integer' },
          evergreen: { type: 'boolean' },
          event_date: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
      },
    },
  },
};

// buildPrompt (imageScore.ts) → scoreOneBatch via askClaudeJsonWithImages.
export const IMAGE_SCORES_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['scores'],
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['beeld', 'score', 'reden', 'rol'],
        properties: {
          beeld: { type: 'integer' },
          score: { type: 'number' },
          reden: { type: 'string' },
          rol: { type: 'string', enum: ['featured', 'slider', 'geen'] },
        },
      },
    },
  },
};
