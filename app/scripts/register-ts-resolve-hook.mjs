// Preload-script (via `node --import`) dat het extensie-resolve-hook
// registreert vóórdat scripts/dedup.test.mjs zijn imports laadt.
import { register } from 'node:module';

register('./ts-resolve-hook.mjs', import.meta.url);
