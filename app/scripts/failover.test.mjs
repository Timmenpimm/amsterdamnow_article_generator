// Hermetische tests voor de automatische infra-failover Omniroute -> directe
// Anthropic-provider in lib/claude.ts (isOmnirouteInfraError + withFailover).
// Mockt fetch (geen echt netwerkverkeer) en draait tegen een throwaway
// temp-SQLite-bestand — zelfde aanpak als scripts/wpsync.db.test.mjs, geen
// aanraking van de echte lokale data/tool.db.
// Draaien met: npm run test:failover
//
// Waarom deze test: Omniroute draait lokaal achter een Cloudflare quick-
// tunnel die geregeld sterft ("Omniroute onbereikbaar op https://....
// trycloudflare.com/v1/messages (fetch failed)"). Zonder failover valt de
// hele pipeline dan stil, ook al is Omniroute alleen een kostenbesparing en
// is het directe Anthropic-pad altijd beschikbaar zodra er een API-key is.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Moet vóór de (dynamische) import van lib/db.ts (via lib/modelConfig.ts)
// gebeuren: db.ts leest DATABASE_URL/SUPABASE_DB_URL/POSTGRES_URL op
// module-niveau. Een statische top-level import zou hier al zijn uitgevoerd
// vóórdat onderstaande env-vars gezet zijn — vandaar de dynamische import
// verderop (zie scripts/wpsync.db.test.mjs voor dezelfde reden).
delete process.env.DATABASE_URL;
delete process.env.SUPABASE_DB_URL;
delete process.env.POSTGRES_URL;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'failover-test-'));
process.env.SQLITE_DB_FILE = path.join(tmpDir, 'test.db');

const { askClaudeJson, isOmnirouteInfraError } = await import('../lib/claude.ts');
const { saveModelSettings } = await import('../lib/modelConfig.ts');

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`NOT OK - ${name}`);
    console.log(`  ${err.stack || err.message}`);
  }
}

const OMNIROUTE_BASE = 'http://omniroute.invalid.test';
const OMNIROUTE_URL = `${OMNIROUTE_BASE}/v1/messages`;
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function withOmnirouteActive(fn, settings = {}) {
  await saveModelSettings({
    provider: 'omniroute',
    omniroute: { baseUrl: OMNIROUTE_BASE, apiKey: '', model: 'test/model', visionModel: 'test/vision' },
    failover: true,
    ...settings,
  });
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const originalKey = process.env.ANTHROPIC_API_KEY;
  const warnCalls = [];
  console.warn = (...args) => warnCalls.push(args.join(' '));
  try {
    await fn({ warnCalls, setFetch: (impl) => { globalThis.fetch = impl; } });
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  }
}

// ---------- isOmnirouteInfraError (pure detectie) ----------

await test('netwerkfout (geen status) is een infra-fout', () => {
  assert.equal(isOmnirouteInfraError(new Error('Omniroute onbereikbaar op http://x/v1/messages. Draait de gateway? (fetch failed)')), true);
});

await test('gateway-statussen (502/503/522/530) zijn infra-fouten', () => {
  for (const status of [502, 503, 522, 530]) {
    assert.equal(isOmnirouteInfraError({ status, message: 'boom' }), true, `status ${status}`);
  }
});

await test('4xx van Omniroute zelf is GEEN infra-fout (auth/validatie/quota)', () => {
  for (const status of [400, 401, 403, 404, 422, 429]) {
    assert.equal(isOmnirouteInfraError({ status, message: 'boom' }), false, `status ${status}`);
  }
});

await test('overige 5xx (bv. 500) is GEEN infra-fout — alleen de gateway-set telt', () => {
  assert.equal(isOmnirouteInfraError({ status: 500, message: 'boom' }), false);
});

await test('willekeurige fout zonder status/herkenbare boodschap is geen infra-fout', () => {
  assert.equal(isOmnirouteInfraError(new Error('iets anders ging mis')), false);
});

// ---------- end-to-end failover via withFailover ----------

await test('infra-fout op Omniroute + ANTHROPIC_API_KEY -> retry via direct Anthropic-pad', async () => {
  await withOmnirouteActive(async ({ warnCalls, setFetch }) => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    let calls = 0;
    setFetch(async (url) => {
      calls += 1;
      if (url === OMNIROUTE_URL) throw new TypeError('fetch failed');
      if (url === ANTHROPIC_URL) {
        return jsonResponse(200, {
          content: [{ type: 'text', text: '{"ok":true,"via":"anthropic"}' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 5 },
        });
      }
      throw new Error(`onverwachte URL in test: ${url}`);
    });

    const result = await askClaudeJson('systeem', 'vraag', 'test-model', 100);
    assert.deepEqual(result, { ok: true, via: 'anthropic' });
    assert.equal(calls, 2, 'eerst Omniroute (mislukt), dan Anthropic (lukt)');
    assert.ok(
      warnCalls.some((line) => line.includes('Omniroute') && line.includes('Anthropic')),
      `verwacht een console.warn met provider-namen, kreeg: ${JSON.stringify(warnCalls)}`,
    );
  });
});

await test('4xx van Omniroute zelf -> GEEN failover, fout propageert ongewijzigd', async () => {
  await withOmnirouteActive(async ({ setFetch }) => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    let calls = 0;
    setFetch(async (url) => {
      calls += 1;
      if (url === OMNIROUTE_URL) return jsonResponse(401, { error: { message: 'invalid api key' } });
      throw new Error(`onverwachte URL in test: ${url}`);
    });

    await assert.rejects(
      () => askClaudeJson('systeem', 'vraag', 'test-model', 100),
      (err) => {
        assert.equal(err.status, 401);
        assert.equal(err.providerId, 'omniroute');
        return true;
      },
    );
    assert.equal(calls, 1, 'geen retry naar Anthropic bij een 4xx van Omniroute zelf');
  });
});

await test('infra-fout op Omniroute zonder ANTHROPIC_API_KEY -> huidig foutgedrag (geen failover)', async () => {
  await withOmnirouteActive(async ({ setFetch }) => {
    delete process.env.ANTHROPIC_API_KEY;
    let calls = 0;
    setFetch(async (url) => {
      calls += 1;
      if (url === OMNIROUTE_URL) throw new TypeError('fetch failed');
      throw new Error(`onverwachte URL in test: ${url}`);
    });

    await assert.rejects(
      () => askClaudeJson('systeem', 'vraag', 'test-model', 100),
      /Omniroute onbereikbaar/,
    );
    assert.equal(calls, 1, 'geen retry naar Anthropic zonder API-key');
  });
});

await test('infra-fout op Omniroute + failover UIT (wel API-key) -> geen failover, fout propageert', async () => {
  await withOmnirouteActive(async ({ setFetch }) => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    let calls = 0;
    setFetch(async (url) => {
      calls += 1;
      if (url === OMNIROUTE_URL) throw new TypeError('fetch failed');
      throw new Error(`onverwachte URL in test: ${url}`);
    });

    await assert.rejects(
      () => askClaudeJson('systeem', 'vraag', 'test-model', 100),
      /Omniroute onbereikbaar/,
    );
    assert.equal(calls, 1, 'geen retry naar Anthropic wanneer failover uit staat');
  }, { failover: false });
});

// ---------- samenvatting ----------

console.log(`\n${passed} geslaagd, ${failures.length} mislukt`);
if (failures.length) {
  for (const f of failures) console.error(`\n${f.name}:\n${f.err.stack}`);
  process.exit(1);
}
