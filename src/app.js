import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { z } from 'zod';
import { getEnvConfig } from './config/env.js';
import {
  bumpDbMutationVersion,
  checkDatabaseHealth,
  dbTimingStorage,
  getDbMutationVersion,
} from './db/client.js';
import { findJobById, getAiUsageSummary } from './services/aiJobRepository.js';
import { defaultAiQueue } from './services/aiQueue.js';
import { createCourseRouter } from './routes/courseRoutes.js';
import { createLearningRouter } from './routes/learningRoutes.js';
import { renderModularHtml, renderModularJs } from './services/htmlRenderer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '../public');

const uuidParamSchema = z.string().uuid();
const CACHE_TTL_MS = 15_000;
const CACHEABLE_API_RE = /^\/api\/(courses|modules|ai\/usage\/summary)(\/|$|\?)/;

export function createApp({
  aiQueue = defaultAiQueue,
  extractorFn,
  synthesizerFn,
  practiceGeneratorFn,
  remedialGeneratorFn,
  examSimulationGeneratorFn,
} = {}) {
  const app = express();
  const responseCache = new Map();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  // Render modular HTML shell (assembles public/partials/*.html into index.html)
  app.get(['/', '/index.html'], (_req, res) => {
    try {
      const html = renderModularHtml(publicDir);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(html);
    } catch (_err) {
      return res.status(500).send('Error rendering modular HTML.');
    }
  });

  // Render modular frontend JS bundle (assembles public/js/modules/*.js + public/js/app.js)
  app.get('/js/app.js', (_req, res) => {
    try {
      const js = renderModularJs(publicDir);
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      return res.status(200).send(js);
    } catch (_err) {
      return res.status(500).send('// Error rendering modular JS.');
    }
  });

  app.use(express.static(publicDir, { index: false }));

  app.use('/api', (req, res, next) => {
    const reqStart = performance.now();
    const timingStore = {
      dbQueryCount: 0,
      dbDurationMs: 0,
      queryDurationsMs: [],
    };

    const method = req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      bumpDbMutationVersion();
      responseCache.clear();
    }

    const cacheKey = req.originalUrl;
    const isCacheableGet = method === 'GET' && CACHEABLE_API_RE.test(cacheKey);
    const queueStats = aiQueue.getStats();
    const stateTag = `${getDbMutationVersion()}:${queueStats.activeCount}:${queueStats.queuedCount}`;

    if (isCacheableGet) {
      const entry = responseCache.get(cacheKey);
      if (entry && entry.stateTag === stateTag && Date.now() - entry.cachedAt < CACHE_TTL_MS) {
        const ifNoneMatch = req.headers['if-none-match'];
        const totalMs = performance.now() - reqStart;
        res.setHeader(
          'Server-Timing',
          `db;dur=0.00;desc="0 queries (cache-hit)", app;dur=${totalMs.toFixed(2)}, total;dur=${totalMs.toFixed(2)}`
        );
        res.setHeader('X-Db-Query-Count', '0');
        if (entry.etag) {
          res.setHeader('ETag', entry.etag);
        }
        if (ifNoneMatch && entry.etag && ifNoneMatch === entry.etag) {
          return res.status(304).end();
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.status(200).end(entry.body);
      }
    }

    const originalSend = res.send.bind(res);
    res.send = function timedSend(body) {
      if (!res.headersSent) {
        const totalMs = performance.now() - reqStart;
        const dbMs = timingStore.dbDurationMs;
        const appMs = Math.max(0, totalMs - dbMs);
        res.setHeader(
          'Server-Timing',
          `db;dur=${dbMs.toFixed(2)};desc="${timingStore.dbQueryCount} queries", app;dur=${appMs.toFixed(2)}, total;dur=${totalMs.toFixed(2)}`
        );
        res.setHeader('X-Db-Query-Count', String(timingStore.dbQueryCount));
      }

      const result = originalSend(body);

      if (isCacheableGet && (res.statusCode === 200 || res.statusCode === 304)) {
        const etag = res.getHeader('ETag');
        const currentQueue = aiQueue.getStats();
        const currentStateTag = `${getDbMutationVersion()}:${currentQueue.activeCount}:${currentQueue.queuedCount}`;
        if (typeof body === 'string' || Buffer.isBuffer(body)) {
          responseCache.set(cacheKey, {
            etag: typeof etag === 'string' ? etag : null,
            body,
            stateTag: currentStateTag,
            cachedAt: Date.now(),
          });
        }
      }

      return result;
    };

    dbTimingStorage.run(timingStore, () => next());
  });

  app.get('/api/health', async (_req, res) => {
    const config = getEnvConfig();
    const dbHealth = await checkDatabaseHealth();

    res.status(200).json({
      status: 'ok',
      milestone: 'Milestone 7 — Complete MVP Learning Loop',
      timestamp: new Date().toISOString(),
      server: {
        uptimeSeconds: Math.floor(process.uptime()),
        nodeVersion: process.version,
      },
      database: {
        configured: config.databaseUrlConfigured,
        pooledUrlConfigured: config.pooledUrlConfigured,
        directUrlConfigured: config.directUrlConfigured,
        connected: dbHealth.connected,
        latencyMs: dbHealth.latencyMs ?? null,
        status: dbHealth.connected
          ? 'connected'
          : config.databaseUrlConfigured
            ? `error:${dbHealth.reason}`
            : 'not_configured',
      },
      ai: {
        apiKeyConfigured: config.geminiApiKeyConfigured,
        apiKeyCount: config.geminiApiKeyCount || 0,
        model: config.geminiModel,
        thinkingLevel: config.geminiThinkingLevel,
        googleSearchEnabled: config.aiEnableGoogleSearch,
        queue: aiQueue.getStats(),
        limits: {
          maxConcurrentJobs: config.aiMaxConcurrentJobs,
          maxQueuedJobs: config.aiMaxQueuedJobs,
          maxRetries: config.aiMaxRetries,
          maxImagesPerBatch: config.aiMaxImagesPerBatch,
          maxImageBytes: config.aiMaxImageBytes,
          maxBatchBytes: config.aiMaxBatchBytes,
          maxOutputTokens: {
            extraction: config.aiMaxOutputTokensExtraction,
            studyPack: config.aiMaxOutputTokensStudyPack,
            remedial: config.aiMaxOutputTokensRemedial,
            exam: config.aiMaxOutputTokensExam,
          },
          softDailyRequestBudget: config.aiSoftDailyRequestBudget,
          softDailyTokenBudget: config.aiSoftDailyTokenBudget,
        },
      },
    });
  });

  app.use('/api', createCourseRouter());
  app.use(
    '/api',
    createLearningRouter({
      aiQueue,
      extractorFn,
      synthesizerFn,
      practiceGeneratorFn,
      remedialGeneratorFn,
      examSimulationGeneratorFn,
    })
  );

  app.get('/api/ai/jobs/:jobId', async (req, res) => {
    const parsed = uuidParamSchema.safeParse(req.params.jobId);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'INVALID_JOB_ID',
        message: 'Format jobId tidak valid.',
      });
    }

    try {
      const job = await findJobById(parsed.data);
      if (!job) {
        return res.status(404).json({
          error: 'JOB_NOT_FOUND',
          message: 'Job AI tidak ditemukan.',
        });
      }

      return res.status(200).json({
        jobId: job.id,
        operation: job.operation,
        targetType: job.targetType,
        targetId: job.targetId,
        status: job.status,
        attemptCount: job.attemptCount,
        maxAttempts: job.maxAttempts,
        resultRefs: job.resultRefsJson || null,
        lastErrorCode: job.lastErrorCode || null,
        lastErrorMessage: job.lastErrorMessage || null,
        retryAfter: job.retryAfter || null,
        queuedAt: job.queuedAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
      });
    } catch (err) {
      return res.status(500).json({
        error: 'DB_ERROR',
        message: 'Gagal membaca status job AI.',
      });
    }
  });

  app.get('/api/ai/usage/summary', async (_req, res) => {
    try {
      const summary = await getAiUsageSummary();
      return res.status(200).json({
        ...summary,
        queue: aiQueue.getStats(),
      });
    } catch (err) {
      return res.status(500).json({
        error: 'DB_ERROR',
        message: 'Gagal memuat ringkasan penggunaan AI.',
      });
    }
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({
      error: 'NOT_FOUND',
      message: 'API endpoint not found.',
    });
  });

  return app;
}

export const app = createApp();
export default app;
