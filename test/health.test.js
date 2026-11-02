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

test('GET /api/health returns status without leaking secrets', async () => {
  const prevKey = process.env.GEMINI_API_KEY;
  const prevModel = process.env.GEMINI_MODEL;

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
      assert.equal(body.ai.model, 'gemini-2.5-flash');
      assert.equal(body.ai.limits.maxConcurrentJobs, 1);
    });
  } finally {
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;

    if (prevModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = prevModel;
  }
});

test('GET / serves index.html with Alpine.js and Tailwind CSS', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /UT AI Learning Companion/);
    assert.match(html, /alpinejs/);
    assert.match(html, /tailwindcss/);
  });
});

test('GET /js/app.js serves Alpine shell script', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/js/app.js`);
    assert.equal(res.status, 200);
    const js = await res.text();
    assert.match(js, /Alpine\.data\('appShell'/);
  });
});
