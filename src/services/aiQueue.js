import { getEnvConfig } from '../config/env.js';
import {
  findJobByIdempotencyKey,
  findLatestSucceededJobByCacheKey,
  createJobRecord,
  markJobRunning,
  updateJobRetryState,
  markJobSucceeded,
  markJobFailed,
  recordAiUsageEvent,
  checkSoftDailyBudget,
} from './aiJobRepository.js';
import { classifyAiError, calculateBackoffMs } from './aiRetry.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AiJobQueue {
  constructor(options = {}) {
    this.waiting = [];
    this.activeCount = 0;
    this.idleWaiters = [];
    this.sleepFn = options.sleepFn || sleep;
  }

  getStats() {
    const config = getEnvConfig();
    return {
      activeCount: this.activeCount,
      queuedCount: this.waiting.length,
      maxConcurrentJobs: config.aiMaxConcurrentJobs,
      maxQueuedJobs: config.aiMaxQueuedJobs,
    };
  }

  async waitForIdle() {
    if (this.activeCount === 0 && this.waiting.length === 0) {
      return;
    }
    await new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  _notifyIdleIfDone() {
    if (this.activeCount === 0 && this.waiting.length === 0) {
      const waiters = this.idleWaiters.splice(0, this.idleWaiters.length);
      for (const resolve of waiters) {
        resolve();
      }
    }
  }

  async submitJob({
    idempotencyKey,
    cacheKey,
    operation,
    targetType,
    targetId,
    courseId = null,
    moduleId = null,
    requestHash,
    regenerate = false,
    overrideBudget = false,
    model = null,
    executeFn,
    cleanupFn = null,
  }) {
    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      const err = new Error('Idempotency-Key wajib disertakan untuk operasi AI.');
      err.statusCode = 400;
      err.errorCode = 'MISSING_IDEMPOTENCY_KEY';
      throw err;
    }

    // 1. Check idempotency key first
    const existingByIdempotency = await findJobByIdempotencyKey(idempotencyKey);
    if (existingByIdempotency) {
      if (cleanupFn) {
        await Promise.resolve(cleanupFn()).catch(() => {});
      }
      return {
        job: existingByIdempotency,
        deduplicated: true,
        reusedCache: false,
      };
    }

    // 2. Check cache if not explicitly regenerating
    if (!regenerate && cacheKey) {
      const cachedJob = await findLatestSucceededJobByCacheKey(cacheKey);
      if (cachedJob && cachedJob.resultRefsJson) {
        const reusedRefs = {
          ...cachedJob.resultRefsJson,
          reusedFromJobId: cachedJob.id,
        };
        const { job } = await createJobRecord({
          idempotencyKey,
          cacheKey,
          operation,
          targetType,
          targetId,
          requestHash,
          maxAttempts: 1,
          status: 'succeeded',
          resultRefsJson: reusedRefs,
        });
        if (cleanupFn) {
          await Promise.resolve(cleanupFn()).catch(() => {});
        }
        return {
          job,
          deduplicated: false,
          reusedCache: true,
        };
      }
    }

    // 3. Check soft daily budgets
    if (!overrideBudget) {
      const budgetStatus = await checkSoftDailyBudget();
      if (budgetStatus.exceeded) {
        if (cleanupFn) {
          await Promise.resolve(cleanupFn()).catch(() => {});
        }
        const err = new Error(
          'Batas soft budget harian aplikasi telah tercapai. Konfirmasi override atau sesuaikan AI_SOFT_DAILY_*_BUDGET jika ingin melanjutkan.'
        );
        err.statusCode = 429;
        err.errorCode = 'SOFT_DAILY_BUDGET_EXCEEDED';
        err.details = budgetStatus;
        throw err;
      }
    }

    // 4. Enforce bounded waiting queue
    const config = getEnvConfig();
    if (this.waiting.length >= config.aiMaxQueuedJobs) {
      if (cleanupFn) {
        await Promise.resolve(cleanupFn()).catch(() => {});
      }
      const err = new Error(
        `Antrean AI penuh (maksimal ${config.aiMaxQueuedJobs} job menunggu). Tunggu proses saat ini selesai sebelum mengirim job baru.`
      );
      err.statusCode = 429;
      err.errorCode = 'AI_QUEUE_FULL';
      throw err;
    }

    const maxAttempts = 1 + Math.max(0, config.aiMaxRetries);

    // 5. Persist job record in Neon before queuing
    const { job, created } = await createJobRecord({
      idempotencyKey,
      cacheKey,
      operation,
      targetType,
      targetId,
      requestHash,
      maxAttempts,
      status: 'queued',
    });

    if (!created) {
      if (cleanupFn) {
        await Promise.resolve(cleanupFn()).catch(() => {});
      }
      return {
        job,
        deduplicated: true,
        reusedCache: false,
      };
    }

    // 6. Enqueue task
    this.waiting.push({
      job,
      operation,
      courseId,
      moduleId,
      model: model || config.geminiModel || 'gemini-3.5-flash',
      maxAttempts,
      executeFn,
      cleanupFn,
    });

    this._pump();

    if (process.env.VERCEL || process.env.AI_WAIT_FOR_COMPLETION === 'true') {
      await this.waitForIdle();
    }

    return {
      job,
      deduplicated: false,
      reusedCache: false,
    };
  }

  _pump() {
    const config = getEnvConfig();
    while (
      this.activeCount < config.aiMaxConcurrentJobs &&
      this.waiting.length > 0
    ) {
      const item = this.waiting.shift();
      this.activeCount += 1;
      this._runItem(item)
        .catch((err) => {
          console.error('[aiQueue] Unexpected worker error:', err?.message || err);
        })
        .finally(() => {
          this.activeCount -= 1;
          this._pump();
          this._notifyIdleIfDone();
        });
    }
  }

  async _runItem(item) {
    const { job, operation, courseId, moduleId, model, maxAttempts, executeFn, cleanupFn } = item;
    const config = getEnvConfig();

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        await markJobRunning(job.id, attempt);
        const startMs = Date.now();

        try {
          const outcome = await executeFn({ job, attempt });
          const durationMs = Date.now() - startMs;

          await recordAiUsageEvent({
            jobId: job.id,
            courseId,
            moduleId,
            model: outcome?.model || model,
            taskType: operation,
            status: 'succeeded',
            httpStatus: 200,
            retryCount: attempt - 1,
            durationMs,
            usageMetadata: outcome?.usageMetadata || null,
            searchGroundingUsed: Boolean(outcome?.searchGroundingUsed),
          });

          await markJobSucceeded(job.id, {
            attemptCount: attempt,
            resultRefsJson: outcome?.resultRefs || {},
          });

          return;
        } catch (err) {
          const durationMs = Date.now() - startMs;
          const classified = classifyAiError(err);

          await recordAiUsageEvent({
            jobId: job.id,
            courseId,
            moduleId,
            model,
            taskType: operation,
            status: 'failed',
            httpStatus: classified.httpStatus,
            errorCode: classified.errorCode,
            errorMessage: classified.userMessage,
            retryCount: attempt - 1,
            durationMs,
            usageMetadata: err?.usageMetadata || null,
            searchGroundingUsed: false,
          });

          // Schema validation failure gets at most 1 controlled retry (max 2 total attempts)
          const allowSchemaRetry =
            classified.errorCode === 'OUTPUT_SCHEMA_INVALID' &&
            attempt < Math.min(2, maxAttempts);

          const canRetry =
            (classified.retryable && attempt < maxAttempts) || allowSchemaRetry;

          if (canRetry) {
            const delayMs = calculateBackoffMs({
              attemptIndex: attempt - 1,
              baseMs: config.aiRetryBaseMs,
              maxMs: config.aiRetryMaxMs,
              retryAfterMs: classified.retryAfterMs,
            });
            const retryAfterDate = new Date(Date.now() + delayMs);

            await updateJobRetryState(job.id, {
              attemptCount: attempt,
              lastErrorCode: classified.errorCode,
              lastErrorMessage: classified.userMessage,
              retryAfter: retryAfterDate,
            });

            await this.sleepFn(delayMs);
            continue;
          }

          await markJobFailed(job.id, {
            attemptCount: attempt,
            errorCode: classified.errorCode,
            errorMessage: classified.userMessage,
          });
          return;
        }
      }
    } finally {
      if (cleanupFn) {
        await Promise.resolve(cleanupFn()).catch(() => {});
      }
    }
  }
}

export const defaultAiQueue = new AiJobQueue();
