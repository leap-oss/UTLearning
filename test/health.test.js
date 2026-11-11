process.env.NODE_ENV = 'test';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { closeDb } from '../src/db/client.js';

after(async () => {
  await closeDb();
});

async function withServer(run) {
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

function snapshotGeminiEnv() {
  const snapshot = {};
  for (const k of Object.keys(process.env)) {
    if (/gemini/i.test(k)) {
      snapshot[k] = process.env[k];
      delete process.env[k];
    }
  }
  return () => {
    for (const k of Object.keys(process.env)) {
      if (/gemini/i.test(k)) {
        delete process.env[k];
      }
    }
    Object.assign(process.env, snapshot);
  };
}

test('GET /api/health returns status without leaking secrets', async () => {
  const restoreEnv = snapshotGeminiEnv();

  process.env.GEMINI_API_KEY = 'AIzaSySecretTestKey123456789';
  process.env.GEMINI_MODEL = 'gemini-2.5-flash';

  try {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/health`);
      assert.equal(res.status, 200);

      const rawText = await res.text();
      assert.equal(rawText.includes('AIzaSySecretTestKey123456789'), false, 'Must not leak Gemini API key');

      const body = JSON.parse(rawText);
      assert.equal(body.status, 'ok');
      assert.equal(body.database.configured, true);
      assert.equal(body.database.connected, true);
      assert.equal(body.ai.apiKeyConfigured, true);
      assert.equal(body.ai.apiKeyCount, 1);
      assert.equal(body.ai.model, 'gemini-2.5-flash');
      assert.equal(body.ai.limits.maxConcurrentJobs, 1);
    });
  } finally {
    restoreEnv();
  }
});

test('Multi-API Key Pool: parses and rotates multiple keys with failover', async () => {
  const { GeminiApiKeyPool } = await import('../src/services/geminiClient.js');
  const restoreEnv = snapshotGeminiEnv();

  try {
    process.env.GEMINI_API_KEY = 'key-alpha, key-beta\nkey-gamma';
    process.env.GEMINI_API_KEYS = 'key-delta; key-alpha'; // key-alpha is duplicate

    const pool = new GeminiApiKeyPool();
    const keys = pool.getKeys();
    assert.equal(keys.length, 4);
    assert.deepEqual(keys, ['key-alpha', 'key-beta', 'key-gamma', 'key-delta']);

    const first = pool.getActiveKeyInfo();
    assert.equal(first.key, 'key-alpha');
    assert.equal(first.index, 0);

    // Simulate rate-limit on key-alpha -> should rotate to key-beta
    pool.markCooldown('key-alpha', 60000);
    const second = pool.getActiveKeyInfo();
    assert.equal(second.key, 'key-beta');
    assert.equal(second.index, 1);

    // Simulate rate-limit on key-beta -> should rotate to key-gamma
    pool.markCooldown('key-beta', 60000);
    const third = pool.getActiveKeyInfo();
    assert.equal(third.key, 'key-gamma');
    assert.equal(third.index, 2);
    // Test Gemini_API-1, Gemini_API-2 numbered format
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEYS;
    process.env['Gemini_API-1'] = 'key-dash-1';
    process.env['Gemini_API-2'] = 'key-dash-2';
    process.env['GEMINI_API_3'] = 'key-underscore-3';

    const poolNumbered = new GeminiApiKeyPool();
    const numberedKeys = poolNumbered.getKeys();
    assert.equal(numberedKeys.length, 3);
    assert.deepEqual(numberedKeys, ['key-dash-1', 'key-dash-2', 'key-underscore-3']);
  } finally {
    restoreEnv();
  }
});

test('GET / serves index.html with Alpine.js and Tailwind CSS', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /UT AI Learning Companion/);
    assert.match(html, /alpinejs/);
    assert.match(html, /tailwind\.css/);
    assert.match(html, /katex\.min\.css/);
    assert.match(html, /katex\.min\.js/);
    assert.match(html, /math-toolbar/);
    assert.match(html, /formulas-procedures/);
  });
});

test('GET /js/app.js serves Alpine shell script', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/js/app.js`);
    assert.equal(res.status, 200);
    const js = await res.text();
    assert.match(js, /Alpine\.data\('appShell'/);
    assert.match(js, /renderMath\(/);
    assert.match(js, /renderFormula\(/);
    assert.match(js, /mathToolbarGroups/);
    assert.match(js, /insertMathSnippet\(/);
  });
});
