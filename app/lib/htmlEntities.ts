// WordPress stuurt "rendered" tekstvelden (o.a. title.rendered) altijd met
// HTML-entities voor tekens als & ' " en de curly-quotes/dashes van
// wptexturize (bv. "Morgan &#038; Mees" i.p.v. "Morgan & Mees"). Zulke
// velden worden hier als platte tekst getoond (React text node, geen
// dangerouslySetInnerHTML), dus de entities moeten eerst gedecodeerd worden
// — anders verschijnen ze letterlijk in de UI.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  copy: '©', reg: '®', trade: '™',
};

export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X'
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}
