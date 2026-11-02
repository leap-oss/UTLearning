import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { z } from 'zod';
import { getEnvConfig } from './config/env.js';
import { checkDatabaseHealth } from './db/client.js';
import { findJobById, getAiUsageSummary } from './services/aiJobRepository.js';
import { defaultAiQueue } from './services/aiQueue.js';
import { createCourseRouter } from './routes/courseRoutes.js';
import { createLearningRouter } from './routes/learningRoutes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '../public');

const uuidParamSchema = z.string().uuid();

export function createApp({
  aiQueue = defaultAiQueue,
  extractorFn,
  synthesizerFn,
  practiceGeneratorFn,
  remedialGeneratorFn,
  examSimulationGeneratorFn,
} = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  app.use(express.static(publicDir));

  app.get('/', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
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
