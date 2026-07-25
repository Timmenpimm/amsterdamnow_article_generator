#!/usr/bin/env node
// publish-prompts.mjs — publiceert prompts uit docs/prompts/ naar een draaiende
// instantie van de artikel-tool.
//
// ============================ WAARSCHUWING ============================
// Dit script WIJZIGT DE LIVE ACTIEVE PROMPT. POST /api/prompts maakt een
// nieuwe promptversie EN activeert die meteen (savePromptVersion zet alle
// oudere versies van dezelfde kind op active = 0). Vanaf dat moment schrijft
// de pipeline met de nieuwe tekst. Er is geen bevestigingsstap in de API.
//
// Draai dus ALTIJD eerst met --dry-run, en terugrollen doe je door de vorige
// versie opnieuw te activeren via de Instellingen-pagina of via
// POST /api/prompts/<id>/activate.
// ======================================================================
//
// Gebruik:
//   node app/scripts/publish-prompts.mjs --dry-run
//   node app/scripts/publish-prompts.mjs --base-url https://... --kind schrijf
//   ARTIKELTOOL_BASE_URL=... ARTIKELTOOL_AUTH=... node app/scripts/publish-prompts.mjs
//
// Opties:
//   --dry-run            Toont alleen wat er zou gebeuren. Doet geen enkele POST.
//   --base-url <url>     Basis-URL van de instantie (default: env
//                        ARTIKELTOOL_BASE_URL, anders http://localhost:3400).
//   --auth <waarde>      Waarde voor de Authorization-header (bijv.
//                        "Bearer xyz"). Default: env ARTIKELTOOL_AUTH.
//                        Optioneel; laat weg als de instantie geen auth heeft.
//   --kind <kind>        Alleen deze prompt-kind publiceren. Herhaalbaar.
//                        Default: alle kinds uit de mapping hieronder.
//   --note <tekst>       Notitie bij de nieuwe versie (default: bestandsnaam).
//   --dir <pad>          Map met de promptbestanden (default: docs/prompts).

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Welk bestand hoort bij welke prompt-kind. Nieuwe versies: pas hier het
// bestand aan, niet de kind-naam (die moet matchen met PROMPT_KINDS in
// lib/types.ts, anders weigert de API met 400).
const FILE_BY_KIND = {
  schrijf: 'schrijf-v4.md',
  research: 'research-v2.md',
};

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    baseUrl: process.env.ARTIKELTOOL_BASE_URL || 'http://localhost:3400',
    auth: process.env.ARTIKELTOOL_AUTH || '',
    kinds: [],
    note: '',
    dir: path.join(REPO_ROOT, 'docs', 'prompts'),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Optie ${arg} verwacht een waarde.`);
      return value;
    };
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--base-url') opts.baseUrl = next();
    else if (arg === '--auth') opts.auth = next();
    else if (arg === '--kind') opts.kinds.push(next());
    else if (arg === '--note') opts.note = next();
    else if (arg === '--dir') opts.dir = path.resolve(next());
    else if (arg === '--help' || arg === '-h') {
      console.log(HELP);
      process.exit(0);
    } else throw new Error(`Onbekende optie: ${arg}`);
  }
  if (opts.kinds.length === 0) opts.kinds = Object.keys(FILE_BY_KIND);
  for (const kind of opts.kinds) {
    if (!FILE_BY_KIND[kind]) {
      throw new Error(`Onbekende kind "${kind}". Bekend: ${Object.keys(FILE_BY_KIND).join(', ')}`);
    }
  }
  opts.baseUrl = opts.baseUrl.replace(/\/+$/, '');
  return opts;
}

const HELP = `publish-prompts.mjs — publiceert docs/prompts/ als nieuwe, ACTIEVE promptversie.

LET OP: zonder --dry-run wijzigt dit script de live actieve prompt.

  --dry-run          alleen tonen wat er zou gebeuren
  --base-url <url>   instantie (env ARTIKELTOOL_BASE_URL, default http://localhost:3400)
  --auth <waarde>    Authorization-header (env ARTIKELTOOL_AUTH), optioneel
  --kind <kind>      alleen deze kind publiceren, herhaalbaar (${Object.keys(FILE_BY_KIND).join(', ')})
  --note <tekst>     notitie bij de versie
  --dir <pad>        map met promptbestanden (default docs/prompts)`;

function preview(content) {
  const firstLine = content.split('\n', 1)[0];
  return firstLine.length > 72 ? `${firstLine.slice(0, 69)}...` : firstLine;
}

async function publish({ baseUrl, auth, kind, content, note, dryRun }) {
  const url = `${baseUrl}/api/prompts`;
  if (dryRun) {
    console.log(`  [dry-run] POST ${url}`);
    console.log(`  [dry-run] body: { kind: "${kind}", note: "${note}", content: ${content.length} tekens }`);
    console.log('  [dry-run] gevolg: nieuwe versie wordt aangemaakt EN direct actief gezet.');
    return null;
  }
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = auth;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind, content, note }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${url} gaf ${res.status}: ${text.slice(0, 300)}`);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Onverwacht antwoord van ${url}: ${text.slice(0, 300)}`);
  }
  return parsed.version;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.dryRun) {
    console.log('DRY RUN: er wordt niets verstuurd.\n');
  } else {
    console.log('!! LIVE: dit maakt nieuwe promptversies aan en ACTIVEERT ze meteen op');
    console.log(`!! ${opts.baseUrl}. Vanaf dat moment draait de pipeline op de nieuwe tekst.\n`);
  }

  const jobs = [];
  for (const kind of opts.kinds) {
    const file = path.join(opts.dir, FILE_BY_KIND[kind]);
    if (!existsSync(file)) throw new Error(`Bestand ontbreekt: ${file}`);
    const content = await readFile(file, 'utf8');
    if (!content.trim()) throw new Error(`Bestand is leeg: ${file}`);
    jobs.push({ kind, file, content, note: opts.note || FILE_BY_KIND[kind] });
  }

  for (const job of jobs) {
    console.log(`${job.kind}: ${path.relative(REPO_ROOT, job.file)} (${job.content.length} tekens)`);
    console.log(`  eerste regel: ${preview(job.content)}`);
    const version = await publish({ ...job, baseUrl: opts.baseUrl, auth: opts.auth, dryRun: opts.dryRun });
    if (version) {
      console.log(`  gepubliceerd als versie ${version.version} (id ${version.id}), nu actief.`);
    }
    console.log('');
  }

  console.log(opts.dryRun ? 'Dry run klaar. Niets gewijzigd.' : 'Klaar. Controleer de Instellingen-pagina.');
}

main().catch((err) => {
  console.error(`Fout: ${err.message}`);
  process.exit(1);
});
