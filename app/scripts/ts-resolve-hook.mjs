// Minimaal resolve-hook, uitsluitend voor scripts/dedup.test.mjs: Node's
// eigen ESM-resolver eist een expliciete extensie bij relatieve imports,
// terwijl de rest van deze codebase (Next.js/TS-bundler-resolutie) overal
// extensieloze relatieve imports gebruikt (bv. `from './htmlEntities'` in
// lib/dedup.ts). In plaats van die conventie overal aan te passen voor één
// testscript, vangt dit hook alleen de ERR_MODULE_NOT_FOUND op een
// extensieloze relatieve specifier af en probeert het opnieuw met `.ts`.
// Geen nieuwe dependency: dit gebruikt uitsluitend Node's ingebouwde
// module-customization-hooks API (node:module `register`).
import { extname } from 'node:path';

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
    if (isRelative && !extname(specifier) && err?.code === 'ERR_MODULE_NOT_FOUND') {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw err;
  }
}
