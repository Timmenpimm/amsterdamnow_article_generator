// Minimale JSON-schema shape-check voor de schemaloze provider-pad (Omniroute).
// Structured outputs (Anthropic) garanderen zelf dat het antwoord conform het
// schema is; de Omniroute-gateway ondersteunt dat niet, dus daar wordt de
// geparste JSON nooit tegen het schema gevalideerd. Gevolg (2026-08-03): het
// kleine lokale model gaf bv. `categories` terug als string of [""], wat
// downstream pas bij de seo-fase ontplofte ("Claude gaf geen geldige categories
// terug"). Deze checker laat de corrigerende herkansing in claude.ts al bij de
// research-fase triggeren met een gerichte formatfout-melding.
//
// Ondersteunt alleen wat app/lib/schemas.ts gebruikt: basistypen (object,
// string, boolean, integer, number, array, null), `type` als array, items,
// required/properties, enum, const en anyOf. De schema-eisen in schemas.ts
// verbieden min/max-length/numeric constraints en recursieve schema's, dus die
// horen hier ook niet thuis.
//
// Retourneert null als het schema klopt, anders een korte NL-melding met het
// pad waar het misgaat. `additionalProperties: false` wordt bewust NIET
// afgedwongen: extra keys storen de downstream validators niet, en een retry
// puur voor een overbodige key is zonde van een LLM-call.
export function conformsToSchema(value: unknown, schema: Record<string, unknown>, path = '$'): string | null {
  const anyOf = schema.anyOf as Array<Record<string, unknown>> | undefined;
  if (anyOf) {
    if (anyOf.some((alt) => conformsToSchema(value, alt, path) === null)) return null;
    return `${path} voldoet aan geen enkele variant`;
  }
  const enumValues = schema.enum as unknown[] | undefined;
  if (enumValues !== undefined) {
    return enumValues.includes(value) ? null : `${path} moet een van ${JSON.stringify(enumValues)} zijn`;
  }
  const constVal = schema.const;
  if (constVal !== undefined) {
    return Object.is(value, constVal) ? null : `${path} moet gelijk zijn aan ${JSON.stringify(constVal)}`;
  }
  const typeSpec = schema.type;
  if (typeSpec === undefined) return null;
  const types = Array.isArray(typeSpec) ? typeSpec : [typeSpec];
  if (!matchesAny(value, types)) {
    return `${path} moet ${types.join(' of ')} zijn (kreeg ${typeOf(value)})`;
  }
  if (types.includes('array')) {
    const items = schema.items as Record<string, unknown> | undefined;
    if (items) {
      for (let i = 0; i < (value as unknown[]).length; i++) {
        const err = conformsToSchema((value as unknown[])[i], items, `${path}[${i}]`);
        if (err) return err;
      }
    }
  }
  if (types.includes('object')) {
    // Bewust GEEN `required`-afdwinging: een ontbrekend veld wordt door de
    // downstream validators netjes behandeld. Gezien op productie (2026-08-03):
    // het kleine lokale model liet bv. `tag` weg als er geen tag pastte —
    // singleTag() in wp.ts vangt dat op met '[]' (geen tag). Een harde
    // required-check keurde zo'n leeg veld ten onrechte af, verspilde de
    // corrigerende herkansing (die het model niet haalde) en liet het topic
    // falen. De check richt zich op VORM: aanwezige velden moeten het juiste
    // type hebben (bv. categories als string i.p.v. array — de fout die dit
    // vangnet introduceerde). Wat écht verplicht is, bepalen de validators in
    // writer.ts (string(), nonEmptyStrings(), validateArticle()).
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(props)) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        const err = conformsToSchema(obj[key], props[key], `${path}.${key}`);
        if (err) return err;
      }
    }
  }
  return null;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesAny(value: unknown, types: string[]): boolean {
  const t = typeOf(value);
  return types.some((spec) => {
    switch (spec) {
      case 'integer': return t === 'number' && Number.isInteger(value);
      case 'number': return t === 'number';
      case 'array': return t === 'array';
      case 'object': return t === 'object';
      case 'string': return t === 'string';
      case 'boolean': return t === 'boolean';
      case 'null': return t === 'null';
      default: return false;
    }
  });
}
