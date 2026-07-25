// JSON-schema's voor de structured outputs van de auditor-calls.
//
// Eigen bestand, los van lib/schemas.ts: die schema's horen bij de generatie
// (research, schrijven, SEO, beeldscoring) en de auditor mag daar niet aan
// vastzitten — verandert de generatie haar research-schema, dan moet de
// controle daarop niet meebewegen.
//
// Dezelfde harde eisen van de Messages API gelden hier: elk object (ook
// genest) heeft "additionalProperties": false en een "required"-array met ALLE
// property-keys. NIET toegestaan: minItems/maxItems/minLength/maximum en
// recursieve schema's. Bovengrenzen op lijstlengtes staan daarom in de
// description én worden in lib/auditor.ts in code afgekapt — het schema kan ze
// niet afdwingen.

// Soorten claims die de auditor natrekt. Superlatief en getal/jaartal staan
// bewust vooraan: dat is waar de handmatige audits van 25-07-2026 de fouten
// vonden (een "grootste van Nederland" zonder onderbouwing, een fout
// stoelenaantal). lib/auditor.ts gebruikt dezelfde volgorde om te bepalen
// welke drie claims de zoekbudget krijgen.
export const AUDIT_CLAIM_SOORTEN = [
  'superlatief', 'getal', 'jaartal', 'adres', 'prijs',
  'openingstijden', 'capaciteit', 'persoon', 'datum', 'overig',
] as const;

// Extractiestap van de claimcheck: welke harde, controleerbare beweringen
// staan er in de artikeltekst? Het model verzint hier geen oordeel, het wijst
// alleen aan wat natrekbaar is — inclusief de zoekopdracht waarmee je dat zou
// doen. Dat laatste veld scheelt een tweede call: de auditor kan de zoekterm
// direct aan Serper geven.
export const AUDIT_CLAIMS_EXTRACT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['claims'],
  properties: {
    claims: {
      type: 'array',
      description: 'Maximaal 8 harde, controleerbare beweringen uit de artikeltekst, de belangrijkste eerst. Superlatieven ("grootste van Nederland") en getallen/jaartallen hebben voorrang: daar zitten de fouten. Neem geen meningen, sfeerbeschrijvingen of vage kwalificaties op — alleen wat je met een bron kunt bevestigen of ontkrachten. Staat er niets controleerbaars in het artikel, geef dan een lege lijst.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['tekst', 'soort', 'zoekterm'],
        properties: {
          tekst: { type: 'string', description: 'De bewering zoals die in het artikel staat, kort en woordelijk genoeg om te herkennen (één zin of zinsdeel).' },
          soort: { type: 'string', enum: [...AUDIT_CLAIM_SOORTEN], description: 'Het type bewering. "superlatief" voor elke vorm van grootste/oudste/eerste/enige/beste.' },
          zoekterm: { type: 'string', description: 'De zoekopdracht waarmee je deze claim zou natrekken op Google: naam van de zaak of het event plus het te controleren feit, zonder aanhalingstekens en zonder operatoren. Nederlands, kort en concreet.' },
        },
      },
    },
  },
};

// Verdict-stap van de claimcheck: het model krijgt de claims mét de
// zoekresultaten terug en oordeelt per claim. Verdict-waarden zijn identiek
// aan AuditVerdict in lib/types.ts, zodat het antwoord één-op-één een
// AuditFindingInput wordt.
export const AUDIT_CLAIMS_VERDICT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['bevindingen'],
  properties: {
    bevindingen: {
      type: 'array',
      description: 'Eén bevinding per beoordeelde claim, in dezelfde volgorde als de claims. Beoordeel uitsluitend op de meegegeven zoekresultaten; wat daar niet in staat weet je niet.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['onderwerp', 'verdict', 'bevinding', 'bron'],
        properties: {
          onderwerp: { type: 'string', description: 'Waar de bevinding over gaat, in maximaal een halve regel: de claim in eigen woorden ("aantal zitplaatsen", "grootste zaal van Nederland").' },
          verdict: {
            type: 'string',
            enum: ['ok', 'twijfel', 'fout'],
            description: '"ok" alleen als een meegegeven bron de claim expliciet bevestigt. "fout" als een bron iets anders zegt. "twijfel" in alle andere gevallen, inclusief: geen bruikbare bron, bron zegt er niets over, of de bron is te vaag om de claim te dragen.',
          },
          bevinding: { type: 'string', description: 'Wat je hebt vastgesteld, in maximaal twee zinnen. Bij "fout": wat het artikel zegt én wat de bron zegt. Nederlands, zakelijk, geen advies.' },
          bron: { type: 'string', description: 'De volledige URL van het meegegeven zoekresultaat waarop je oordeel rust, letterlijk overgenomen. Verzin nooit een URL en gebruik nooit een URL die niet in de meegegeven resultaten staat. Heb je geen bron, geef dan een lege string — dan kan het verdict per definitie niet "ok" zijn.' },
        },
      },
    },
  },
};

// Beeldcheck: één beoordeling per meegestuurd beeld, op de echte bytes.
// De deterministische signalen (bestandsnaam wijst naar een ander onderwerp,
// alt-tekst leeg of gelijk aan de bestandsnaam) doet lib/auditor.ts zelf in
// code — die hebben geen model nodig en mogen niet van promptgehoorzaamheid
// afhangen.
export const AUDIT_IMAGE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['beelden'],
  properties: {
    beelden: {
      type: 'array',
      description: 'Eén beoordeling per beeld, in dezelfde volgorde als de genummerde beelden hierboven.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rol', 'verdict', 'bevinding'],
        properties: {
          rol: { type: 'string', description: 'De rol van het beeld zoals die bij het beeld is meegegeven ("featured", "slider 2", "inline").' },
          verdict: {
            type: 'string',
            enum: ['ok', 'twijfel', 'fout'],
            description: '"ok" als het beeld aantoonbaar bij dit onderwerp, deze locatie en dit type ruimte hoort. "fout" als het zichtbaar iets anders toont (ander event, andere stad, ander type zaak, logo/poster/screenshot in plaats van een foto). "twijfel" als het beeld generiek is of je het niet kunt vaststellen.',
          },
          bevinding: { type: 'string', description: 'Wat je op het beeld ziet en waarom dat wel of niet bij het artikel past, in maximaal twee zinnen. Nederlands, zakelijk.' },
        },
      },
    },
  },
};
