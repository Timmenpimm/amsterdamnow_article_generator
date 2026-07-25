// Tokenkosten van één Claude-call omrekenen naar dollars, en de logregel die
// lib/claude.ts na elke call wegschrijft. Losgetrokken van claude.ts zodat het
// pure rekenwerk testbaar is zonder db/provider-import (zie
// scripts/tokenlog.test.mjs).
//
// Waarom: de kosteninschatting van de tool was tot nu toe een schatting op
// promptgroottes. Eén regel per call in de Vercel-logs maakt de werkelijke
// kosten per fase en per onderwerp na te rekenen.

// `usage` komt terug bij elke geslaagde call; de cache-velden alleen als er een
// cacheerbaar blok in de request zat (zie systemBlocks in claude.ts).
export type ClaudeUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

// Prijzen in dollar per miljoen tokens (Anthropic-lijstprijs, peildatum
// 2026-07-25). Sonnet 5 kent t/m 31-08-2026 een introprijs van 2/10; we rekenen
// bewust met de lijstprijs, zodat de gelogde kosten na die datum niet ineens
// hoger uitvallen dan wat we hier hebben gezien. Nieuw model in de pipeline =
// hier een regel bij, anders blijft de kostenkolom 0 (de tokens zie je wél).
export const PRICES: Record<string, { in: number; out: number }> = {
  'claude-opus-5': { in: 5, out: 25 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

// Cache-reads kosten ~0,1× de invoerprijs, cache-writes ~1,25× (5-minuten-TTL,
// wat de systeem-promptcache in claude.ts gebruikt).
const CACHE_READ_FACTOR = 0.1;
const CACHE_WRITE_FACTOR = 1.25;

export function priceFor(model: string): { in: number; out: number } {
  // Datumsuffix (claude-haiku-4-5-20251001) valt terug op de alias-prijs.
  const key = Object.keys(PRICES).find(k => model === k || model.startsWith(`${k}-`));
  return key ? PRICES[key] : { in: 0, out: 0 };
}

// Geschatte dollarkosten van één call op basis van het usage-blok.
export function costOf(model: string, usage: ClaudeUsage): number {
  const p = priceFor(model);
  const fresh = usage.input_tokens || 0;
  const write = usage.cache_creation_input_tokens || 0;
  const read = usage.cache_read_input_tokens || 0;
  const out = usage.output_tokens || 0;
  return (
    (fresh * p.in + write * p.in * CACHE_WRITE_FACTOR + read * p.in * CACHE_READ_FACTOR + out * p.out) / 1_000_000
  );
}

// De logregel, grep-baar op `[claude]` en key=value zodat
// `grep '\[claude\]' | awk` volstaat om te sommeren:
//   [claude] label=schrijf#1234 model=claude-sonnet-5 in=812 cache_write=6431
//            cache_read=0 out=1108 cost=0.0281 ms=8123 stop=end_turn
// `label` is `<fase>#<topic- of artikel-id>` waar de aanroeper dat id kent (zie
// de call-sites in writer.ts/listWriter.ts); zonder id blijft alleen de fase
// over. `cost` is een schatting op PRICES, geen factuur.
export function usageLine(label: string, model: string, usage: ClaudeUsage, ms: number, stop?: string): string {
  const parts = [
    `label=${label || 'onbekend'}`,
    `model=${model}`,
    `in=${usage.input_tokens || 0}`,
    `cache_write=${usage.cache_creation_input_tokens || 0}`,
    `cache_read=${usage.cache_read_input_tokens || 0}`,
    `out=${usage.output_tokens || 0}`,
    `cost=${costOf(model, usage).toFixed(4)}`,
    `ms=${ms}`,
    `stop=${stop || 'onbekend'}`,
  ];
  return `[claude] ${parts.join(' ')}`;
}
