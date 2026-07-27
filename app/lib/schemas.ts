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
    'district', 'tag', 'rubriek', 'naam_locatie', 'adres', 'stad', 'website',
    'start_datum', 'eind_datum', 'missing_facts', 'quote',
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
    // Eén tag, geen lijst. "Max 1 tag" stond eerder alleen als zin in de prompt
    // en was dus een verzoek, geen garantie: het veld was een ongelimiteerde
    // array. Als string is meer dan één tag structureel onmogelijk (constrained
    // decoding), zonder dat we op promptgehoorzaamheid hoeven te leunen.
    tag: { type: 'string', description: 'Exact één bestaande WordPress-tag uit de meegegeven lijst: de best passende. Past geen enkele tag echt, geef dan "" terug.' },
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
    // Sufficiëntie-poort: het model moet zélf benoemen wat het NIET heeft
    // gevonden. Zonder dit veld vult de schrijfronde de gaten met verzonnen
    // details; mét dit veld kan de pipeline gericht een tweede researchronde
    // draaien op precies die ontbrekende punten.
    missing_facts: {
      ...STRING_ARRAY,
      description: 'Feiten die je NIET in de bronnen kon vinden, in korte termen die direct als zoekopdracht bruikbaar zijn ("openingstijden", "naam van de eigenaar", "aantal zitplaatsen"). Lege array als je alles hebt gevonden. Verzin hier niets: dit veld bestaat juist om gaten zichtbaar te maken.',
      // Het schema staat geen extra keys toe binnen items; de description hoort
      // op het array-niveau (zie de schema-eisen bovenaan dit bestand).
    },
    // Echte-quote-pad: één LETTERLIJKE uitspraak uit de bronnen, of null.
    // Nullable via anyOf met een null-variant, exact zoals LIST_VERIFY_SCHEMA
    // dat doet — zo blijft het parsepad voor beide artikeltypes hetzelfde.
    quote: {
      description: 'Alleen een LETTERLIJKE uitspraak van een betrokkene die woord-voor-woord in de bronnen staat. Nooit parafraseren, nooit zelf formuleren, en nooit iets overnemen uit een concurrerende stadsgids. Geen echte quote gevonden? Geef null.',
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['tekst', 'bron', 'herkomst'],
          properties: {
            tekst: { type: 'string', description: 'De uitspraak, woord voor woord zoals die in de bron staat, zonder aanhalingstekens eromheen.' },
            bron: { type: 'string', description: 'De URL van de bron waarin de uitspraak letterlijk staat.' },
            herkomst: { type: 'string', description: 'Wie het zei en waar, bv. "eigenaar Lasse Jensen in Het Parool".' },
          },
        },
        { type: 'null' },
      ],
    },
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
      description: 'Pull-quote van 25-40 woorden die LETTERLIJK in de content voorkomt. Een krachtige zin met een concreet feit, geen vraag en geen meta-taal.',
    },
  },
};

// entiteitsverificatie → writer.ts stepResearch (verifyEntity). Controleert dat
// naam_locatie, adres en website bij één en dezelfde echte entiteit horen,
// gegeven de gecrawlde officiële homepage. Alle velden verplicht; lege string is
// toegestaan (bv. geen waarschuwing).
export const ENTITY_VERIFY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['canonical_naam_locatie', 'entiteit_consistent', 'waarschuwing'],
  properties: {
    canonical_naam_locatie: { type: 'string', description: 'De echte, beknopte merk-/organisatienaam. Strip Google-Maps-achtige toevoegingen (keukentype, gerecht, plaatsnaam, "Museum"). Leeg laten als je de naam niet betrouwbaar kunt bepalen.' },
    entiteit_consistent: { type: 'boolean', description: 'True als naam, adres en website aantoonbaar bij dezelfde zaak horen.' },
    waarschuwing: { type: 'string', description: 'Korte NL-zin als er een probleem is (bv. adres en website horen niet bij elkaar), anders lege string.' },
  },
};

// invalshoek-fase → writer.ts stepInvalshoek. Bepaalt de local-tip-hoek van
// het artikel vóór de schrijffase, en fungeert als poort: research zonder
// bruikbare hoek levert geen artikel op. Een tegenspraak is bewust GEKOPPELD
// aan publicabel: alleen als de tegenspraak het artikel echt onmogelijk maakt
// hoort publicabel op false — een losse tegenspraak-zin is voor de pipeline
// slechts een waarschuwing aan de schrijffase (zie stepInvalshoek). Het veld
// is required (structured output), dus het model wordt geprikkeld om íets in
// te vullen; daarom mag een gevulde tegenspraak op zichzelf nooit fataal zijn.
export const INVALSHOEK_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['publicabel', 'hoek', 'beats', 'tegenspraak', 'reden'],
  properties: {
    publicabel: { type: 'boolean', description: 'True als er uit de research een concrete local-tip-hoek te halen is. False als de feiten te dun of te generiek zijn voor een artikel met inhoud, of als een tegenspraak over een kernfeit van het onderwerp zelf een kloppend artikel onmogelijk maakt.' },
    hoek: { type: 'string', description: 'De invalshoek in één zin: waaróm tipt de ene Amsterdammer de andere dit? Leeg als publicabel false is.' },
    beats: { type: 'array', items: { type: 'string' }, description: 'Twee à drie concrete story beats (elk één zin) uit de research die de hoek dragen. Alleen feiten die letterlijk in de research of bronnen staan.' },
    tegenspraak: { type: 'string', description: 'Korte NL-zin ALLEEN als de research zichzelf tegenspreekt op een kernfeit van het onderwerp zelf: de naam, wie erachter zit, of het event überhaupt bestaat. GEEN tegenspraak: capaciteit, openingstijden, prijzen, datumverschillen tussen bronnen, of bronnen die over een ander onderwerp gaan (negeer die volledig). Twijfel of niets aan de hand: lege string.' },
    reden: { type: 'string', description: 'Alleen bij publicabel false: één leesbare NL-zin waarom dit onderwerp (nu) geen artikel oplevert. Noem daarin concreet welk feit of gegeven ontbreekt.' },
  },
};

// stijlcurator-fase → writer.ts stepCurator. Keurt het geschreven artikel op
// inhoud en toon (local-to-local, geen marketingcopy) en levert bij afkeuring
// een concrete herschrijfinstructie voor de bestaande schrijf-retry-fase.
export const CURATOR_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['oordeel', 'problemen', 'herschrijfinstructie'],
  properties: {
    oordeel: { type: 'string', enum: ['goed', 'herschrijven'], description: '"goed" als het artikel concreet en local-to-local is; "herschrijven" bij vulzinnen, marketingtaal of alinea\'s zonder inhoud.' },
    problemen: { type: 'array', items: { type: 'string' }, description: 'Per gevonden probleem één korte NL-zin met het letterlijke tekstfragment erbij. Leeg bij oordeel "goed".' },
    herschrijfinstructie: { type: 'string', description: 'Alleen bij "herschrijven": concrete instructie wat er anders moet, gericht op de gevonden problemen. Leeg bij "goed".' },
  },
};

// quote-herschrijf-backfill → writer.ts rewriteQuote (backfill-quote-length-
// route). Herschrijft een te korte pull-quote (< 25 woorden, uit oudere
// "Klaar"-drafts van vóór de quoteWords-regel) naar 25-40 woorden, en levert
// meteen de aangepaste bronparagraaf zodat de nieuwe quote daar ook woord
// voor woord letterlijk in blijft staan (quoteMustBeVerbatimInContent-eis).
export const QUOTE_REWRITE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['quote', 'herschreven_paragraaf'],
  properties: {
    quote: { type: 'string', description: 'Herschreven pull-quote van 25-40 woorden: een krachtige zin met een concreet feit uit de paragraaf. Geen em dash of en dash, geen vraag, geen meta-taal.' },
    herschreven_paragraaf: { type: 'string', description: 'De volledige, aangepaste bronparagraaf (lopende tekst, geen opsomming) waarin de nieuwe quote woord voor woord letterlijk voorkomt.' },
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
    'items', 'categories', 'district', 'tag', 'rubriek',
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
    // Eén tag, geen lijst — zie de toelichting bij RESEARCH_SCHEMA.tag.
    tag: { type: 'string', description: 'Exact één bestaande WordPress-tag uit "beschikbare_tags": de best passende. Past geen enkele tag echt, geef dan "" terug.' },
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

// SCAN_SYSTEM (scanner.ts) → runScan. "startdatum"/"einddatum" zijn nullable:
// JJJJ-MM-DD als de brontekst een concrete eventdatum noemt, anders null
// (opening, doorlopende expositie, geen vaste datum). runScan gebruikt de
// einddatum om al voorbije events eruit te filteren vóór ze de wachtrij
// bereiken, én seedt ze op het topic zodat ze in WordPress terechtkomen
// (ACF start_datum/eind_datum) — de bronpagina is de betrouwbaarste datumbron.
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
        required: ['titel', 'startdatum', 'einddatum'],
        properties: {
          titel: { type: 'string' },
          startdatum: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          einddatum: { anyOf: [{ type: 'string' }, { type: 'null' }] },
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
