process.env.NODE_ENV = 'test';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_GEMINI_MODEL_CHAIN,
  DEFAULT_GEMINI_OCR_MODEL_CHAIN,
  getEnvConfig,
} from '../src/config/env.js';
import {
  normalizeExtractedText,
  extractTranscribedQuestionsFromText,
  resolveOcrThinkingLevel,
  defaultGeminiExtractionCall,
} from '../src/services/extractionService.js';
import {
  GeminiApiKeyPool,
  defaultApiKeyPool,
  generateStructuredContent,
} from '../src/services/geminiClient.js';
import {
  upsertRemoteCooldownBatch,
  loadActiveRemoteCooldowns,
  deleteRemoteCooldowns,
  resetRemoteCooldownCacheState,
} from '../src/services/aiCooldownStore.js';
import { closeDb } from '../src/db/client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

after(async () => {
  await closeDb();
});

test('resolveOcrThinkingLevel uses minimal for reading courses and low for math/algorithm/flowchart modules', () => {
  assert.equal(
    resolveOcrThinkingLevel({
      courseRecord: { code: 'MKWN4101', name: 'Pendidikan Agama Islam' },
      moduleRecord: { title: 'Hakikat, Martabat, dan Tanggung Jawab Manusia' },
    }),
    'minimal'
  );
  assert.equal(
    resolveOcrThinkingLevel({
      courseRecord: { code: 'EMBS4321', name: 'Sistem Informasi Manajemen' },
      moduleRecord: { title: 'Keamanan Informasi' },
    }),
    'minimal'
  );
  assert.equal(
    resolveOcrThinkingLevel({
      courseRecord: { code: 'MATA4101', name: 'Pengantar Matematika' },
      moduleRecord: { title: 'Himpunan dan Operasinya' },
    }),
    'low'
  );
  assert.equal(
    resolveOcrThinkingLevel({
      courseRecord: { code: 'MSIM4203', name: 'Algoritma dan Pemograman' },
      moduleRecord: { title: 'Representasi Algoritma' },
    }),
    'low'
  );
});

test('Model routing: OCR defaults to lightest model first while Study Pack & Quiz keep primary quality chain', () => {
  assert.deepEqual(DEFAULT_GEMINI_MODEL_CHAIN, [
    'gemini-4-hydrogen',
    'gemini-3.6-flash',
    'gemini-3.8-flash',
    'gemini-3.5-flash-lite',
  ]);
  assert.deepEqual(DEFAULT_GEMINI_OCR_MODEL_CHAIN, [
    'gemini-3.5-flash-lite',
    'gemini-3.8-flash',
    'gemini-3.6-flash',
    'gemini-4-hydrogen',
  ]);

  const snapshot = {};
  for (const k of Object.keys(process.env)) {
    if (/gemini/i.test(k)) {
      snapshot[k] = process.env[k];
      delete process.env[k];
    }
  }
  try {
    const cfg = getEnvConfig();
    assert.equal(cfg.geminiModel, 'gemini-4-hydrogen');
    assert.equal(cfg.geminiOcrModel, 'gemini-3.5-flash-lite');
    assert.deepEqual(cfg.geminiOcrFallbackModels, DEFAULT_GEMINI_OCR_MODEL_CHAIN);
  } finally {
    for (const k of Object.keys(process.env)) {
      if (/gemini/i.test(k)) delete process.env[k];
    }
    Object.assign(process.env, snapshot);
  }
});

test('normalizeExtractedText preserves Rangkuman paragraphs while collapsing extra blank lines inside MCQ options A..D', () => {
  const rawPaiText = [
    'Rangkuman',
    '',
    'Iman merupakan asas yang menentukan ragam kepribadian manusia.',
    '',
    'Ada tiga aspek iman yaitu pengetahuan, kemauan dan kemampuan.',
    '',
    'Tes Formatif 1',
    '',
    '9) Salah satu usaha yang paling pokok dalam menumbuhkembangkan konsep Ketuhanan Yang Maha Esa di Indonesia adalah ....',
    '',
    'A. meyakinkan adanya Tuhan',
    '',
    'B. meyakinkan Allah sebagai Tuhan',
    '',
    'C. mempelajari ketentuan Tuhan',
    '',
    'D. mempelajari perbuatan Tuhan',
    '',
    '10) Di antara sikap yang tidak perlu dilakukan oleh umat Islam Indonesia, adalah mengajak umat Islam untuk ....',
    '',
    'A. memusuhi pendukung aliran-aliran Islam yang dilarang pemerintah',
    '',
    'B. mempelajari ajaran agama lain',
    '',
    "C. menerapkan Al-Qur'an",
    '',
    'D. mematuhi ajaran Allah',
  ].join('\n');

  const normalized = normalizeExtractedText(rawPaiText);

  // Rangkuman paragraphs keep \n\n
  assert.ok(
    normalized.includes('kepribadian manusia.\n\nAda tiga aspek iman'),
    'Narrative paragraphs must retain blank line separation'
  );
  // Question 9 options stay compact with single \n
  assert.ok(
    normalized.includes(
      'adalah ....\nA. meyakinkan adanya Tuhan\nB. meyakinkan Allah sebagai Tuhan\nC. mempelajari ketentuan Tuhan\nD. mempelajari perbuatan Tuhan'
    ),
    'MCQ stem and options A..D must use single newline without blank gaps'
  );
  // Blank line preserved between Question 9 D. and Question 10)
  assert.ok(
    normalized.includes('D. mempelajari perbuatan Tuhan\n\n10) Di antara sikap'),
    'Blank line between question 9 and question 10 must be preserved'
  );

  // Deterministic question parser populates transcribedQuestions without needing duplicate AI JSON
  const parsedQs = extractTranscribedQuestionsFromText(normalized);
  assert.equal(parsedQs.length, 2);
  assert.equal(parsedQs[0].options.length, 4);
  assert.equal(parsedQs[0].options[0].key, 'A');
  assert.equal(parsedQs[0].options[3].text, 'mempelajari perbuatan Tuhan');
  assert.equal(parsedQs[1].options.length, 4);
});

test('defaultGeminiExtractionCall routes straight to gemini-3.5-flash-lite with MINIMAL thinking and recovers from RECITATION once', async () => {
  const snapshot = {};
  for (const k of Object.keys(process.env)) {
    if (/gemini/i.test(k)) {
      snapshot[k] = process.env[k];
      delete process.env[k];
    }
  }

  const origGetClient = defaultApiKeyPool.getClientForKey.bind(defaultApiKeyPool);
  try {
    process.env.Gemini_API_1 = 'ocr-key-1-alpha';
    process.env.Gemini_API_2 = 'ocr-key-2-bravo';
    defaultApiKeyPool.reset();

    const seenCalls = [];
    defaultApiKeyPool.getClientForKey = (key) => ({
      models: {
        generateContent: async ({ model, config, contents }) => {
          const promptText = (contents || [])
            .map((c) => (typeof c?.text === 'string' ? c.text : ''))
            .join('\n');
          const isAntiRecitation = /bahasa sendiri|catatan belajar terstruktur/i.test(promptText);
          seenCalls.push({ model, key, thinkingLevel: config?.thinkingConfig?.thinkingLevel, isAntiRecitation });

          // Simulate RECITATION on initial verbatim prompt across models, succeeding on anti-recitation retry
          if (!isAntiRecitation) {
            return {
              text: '',
              candidates: [{ finishReason: 'RECITATION', content: { parts: [] } }],
              usageMetadata: { promptTokenCount: 200, totalTokenCount: 200 },
            };
          }

          return {
            text: JSON.stringify({
              schemaVersion: 1,
              pages: [
                {
                  sourceImageId: 'src-pai-1',
                  pageOrder: 1,
                  pageType: 'tes_formatif',
                  pageTitle: 'Tes Formatif 1',
                  extractedText: '1) Contoh soal?\nA. Satu\nB. Dua',
                  sections: [],
                  keyTerms: [],
                  formulasOrTables: [],
                  transcribedQuestions: [],
                  ambiguousParts: [],
                  needsReview: false,
                },
              ],
            }),
            usageMetadata: { promptTokenCount: 180, candidatesTokenCount: 90, totalTokenCount: 270 },
          };
        },
      },
    });

    const result = await defaultGeminiExtractionCall({
      moduleRecord: { moduleNumber: 2, title: 'Hakikat Manusia' },
      sourceRecordsWithBuffers: [
        {
          source: {
            id: 'src-pai-1',
            pageOrder: 1,
            label: 'materi',
            fileName: 'pai-m2-1.png',
            mimeType: 'image/png',
          },
          buffer: Buffer.from([1, 2, 3]),
        },
      ],
    });

    assert.equal(seenCalls[0].model, 'gemini-3.5-flash-lite', 'OCR must try lightest model first');
    assert.equal(seenCalls[0].thinkingLevel, 'MINIMAL', 'OCR must use MINIMAL thinking level');
    assert.equal(seenCalls.length, 2, 'RECITATION must fail-fast straight into anti-RECITATION study-notes mode in 2 total calls');
    assert.equal(result.model, 'gemini-3.5-flash-lite');
    assert.equal(result.data.pages.length, 1);
    assert.ok(seenCalls.some((c) => c.isAntiRecitation), 'Must recover via anti-RECITATION study-notes mode');
  } finally {
    defaultApiKeyPool.getClientForKey = origGetClient;
    for (const k of Object.keys(process.env)) {
      if (/gemini/i.test(k)) delete process.env[k];
    }
    Object.assign(process.env, snapshot);
    defaultApiKeyPool.reset();
  }
});

test('Timeout on final fallback model marks timed-out API key and immediately skips to next healthy API key', async () => {
  const snapshot = {};
  for (const k of Object.keys(process.env)) {
    if (/gemini/i.test(k)) {
      snapshot[k] = process.env[k];
      delete process.env[k];
    }
  }
  const origGetClient = defaultApiKeyPool.getClientForKey.bind(defaultApiKeyPool);
  try {
    process.env.Gemini_API_1 = 'key-timeout-one';
    process.env.Gemini_API_2 = 'key-healthy-two';
    defaultApiKeyPool.reset();

    const calls = [];
    defaultApiKeyPool.getClientForKey = (key) => ({
      models: {
        generateContent: async ({ model }) => {
          calls.push({ model, key });
          if (key === 'key-timeout-one') {
            const err = new Error('The operation was aborted due to timeout');
            err.name = 'TimeoutError';
            err.code = 20;
            throw err;
          }
          return {
            text: JSON.stringify({ ok: true, key }),
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 },
          };
        },
      },
    });

    const res1 = await generateStructuredContent({
      taskType: 'extract_sources',
      contents: 'Timeout skip test',
      model: 'gemini-3.5-flash-lite',
    });
    assert.equal(res1.data.key, 'key-healthy-two');
    assert.deepEqual(
      calls.map((c) => c.key),
      ['key-timeout-one', 'key-healthy-two']
    );

    // Next call must skip marked key-timeout-one completely
    const res2 = await generateStructuredContent({
      taskType: 'extract_sources',
      contents: 'Second call skips timed-out key',
      model: 'gemini-3.5-flash-lite',
    });
    assert.equal(res2.data.key, 'key-healthy-two');
    assert.equal(
      calls.filter((c) => c.key === 'key-timeout-one').length,
      1,
      'Marked timed-out API key must be skipped on subsequent requests'
    );
  } finally {
    defaultApiKeyPool.getClientForKey = origGetClient;
    for (const k of Object.keys(process.env)) {
      if (/gemini/i.test(k)) delete process.env[k];
    }
    Object.assign(process.env, snapshot);
    defaultApiKeyPool.reset();
  }
});

test('Remote Neon DB cooldown store syncs timeout marks across fresh cold-start pool instances', async () => {
  const snapshot = {};
  for (const k of Object.keys(process.env)) {
    if (/gemini/i.test(k)) {
      snapshot[k] = process.env[k];
      delete process.env[k];
    }
  }
  const testKeys = [];
  try {
    process.env.Gemini_API_1 = 'coldstart-key-1-alpha';
    process.env.Gemini_API_2 = 'coldstart-key-2-bravo';

    const poolA = new GeminiApiKeyPool({ persistPath: null, enableRemoteSync: true });
    poolA.getKeys();
    const cooldownKey = poolA._cooldownKey('coldstart-key-1-alpha', 'gemini-4-hydrogen');
    testKeys.push(cooldownKey);

    const saved = await upsertRemoteCooldownBatch([
      { cooldownKey, expiresAtMs: Date.now() + 15 * 60 * 1000, reason: 'timeout' },
    ]);
    assert.equal(saved, true);

    // Simulate brand-new Vercel serverless container with empty memory & empty /tmp
    resetRemoteCooldownCacheState();
    const loaded = await loadActiveRemoteCooldowns({ force: true });
    assert.ok(loaded && loaded.has(cooldownKey), 'Neon DB must return persisted timeout marker');

    const poolB = new GeminiApiKeyPool({ persistPath: null, enableRemoteSync: true });
    poolB.getKeys();
    resetRemoteCooldownCacheState();
    await poolB.syncRemoteCooldowns({ force: true });

    const active = poolB.getActiveKeyInfo('gemini-4-hydrogen');
    assert.equal(
      active.key,
      'coldstart-key-2-bravo',
      'Fresh cold-start instance must immediately skip timed-out API key #1 from Neon DB'
    );
  } finally {
    if (testKeys.length > 0) {
      await deleteRemoteCooldowns(testKeys);
    }
    for (const k of Object.keys(process.env)) {
      if (/gemini/i.test(k)) delete process.env[k];
    }
    Object.assign(process.env, snapshot);
  }
});

test('Frontend buildExtractionBatches keeps up to 15 small images in 1 request and only splits on >15 or >3.8MB, and waitForAiJobCompletion clears activeAiJob', async () => {
  const win = { AppModules: {} };
  const srcCode = fs.readFileSync(
    path.join(projectRoot, 'public/js/modules/sourcesAndExtraction.js'),
    'utf8'
  );
  const apiCode = fs.readFileSync(
    path.join(projectRoot, 'public/js/modules/apiAndJobs.js'),
    'utf8'
  );
  new Function('window', srcCode)(win);
  new Function('window', apiCode)(win);
  const mod = win.AppModules.sourcesAndExtraction;

  // 14 small images of 200KB each (total 2.8MB <= 3.8MB) -> stays 1 single request!
  const fourteenSmall = Array.from({ length: 14 }, (_, i) => ({
    id: `img-${i + 1}`,
    pageOrder: i + 1,
    file: { size: 200_000, name: `p-${i + 1}.png` },
  }));
  assert.deepEqual(
    mod.buildExtractionBatches(fourteenSmall).map((b) => b.length),
    [14]
  );

  // 20 small images of 150KB each -> splits into [15, 5]
  const twentySmall = Array.from({ length: 20 }, (_, i) => ({
    id: `img20-${i + 1}`,
    pageOrder: i + 1,
    file: { size: 150_000, name: `p20-${i + 1}.png` },
  }));
  assert.deepEqual(
    mod.buildExtractionBatches(twentySmall).map((b) => b.length),
    [15, 5]
  );

  // 5 heavy images of 2MB each -> split by 3.8MB payload limit into [1, 1, 1, 1, 1]
  const heavyImages = Array.from({ length: 5 }, (_, i) => ({
    id: `heavy-${i + 1}`,
    pageOrder: i + 1,
    file: { size: 2_000_000, name: `h-${i + 1}.png` },
  }));
  assert.deepEqual(
    mod.buildExtractionBatches(heavyImages).map((b) => b.length),
    [1, 1, 1, 1, 1]
  );

  // Verify waitForAiJobCompletion clears activeAiJob upon succeeded status so floating card disappears
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ id: 'job-123', status: 'succeeded', attemptCount: 1, maxAttempts: 3 }),
  });
  try {
    const ctx = {
      ...win.AppModules.apiAndJobs,
      activeAiJob: null,
      pollingTimer: null,
      _pollSessionId: 0,
    };
    const job = await ctx.waitForAiJobCompletion('job-123', 'Ekstraksi 6 halaman');
    assert.equal(job.status, 'succeeded');
    assert.equal(ctx.activeAiJob, null, 'Floating card activeAiJob must be cleared immediately on succeeded');
  } finally {
    globalThis.fetch = origFetch;
  }
});
