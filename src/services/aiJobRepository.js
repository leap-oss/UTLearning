import { eq, and, desc, inArray, gte, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { aiGenerationJobs, aiUsageEvents } from '../db/schema.js';
import { getEnvConfig } from '../config/env.js';

export function normalizeUsageMetadata(rawUsage) {
  if (!rawUsage || typeof rawUsage !== 'object') {
    return {
      promptTokens: null,
      outputTokens: null,
      thinkingTokens: null,
      toolUsePromptTokens: null,
      cachedTokens: null,
      totalTokens: null,
      usageMetadataJson: null,
    };
  }

  const toIntOrNull = (val) => (typeof val === 'number' && Number.isFinite(val) ? val : null);

  return {
    promptTokens: toIntOrNull(rawUsage.promptTokenCount ?? rawUsage.inputTokens),
    outputTokens: toIntOrNull(rawUsage.candidatesTokenCount ?? rawUsage.outputTokens),
    thinkingTokens: toIntOrNull(rawUsage.thoughtsTokenCount ?? rawUsage.thinkingTokens),
    toolUsePromptTokens: toIntOrNull(rawUsage.toolUsePromptTokenCount),
    cachedTokens: toIntOrNull(rawUsage.cachedContentTokenCount ?? rawUsage.cachedTokens),
    totalTokens: toIntOrNull(rawUsage.totalTokenCount ?? rawUsage.totalTokens),
    usageMetadataJson: rawUsage,
  };
}

export async function findJobById(jobId) {
  const db = getDb();
  const rows = await db
    .select()
    .from(aiGenerationJobs)
    .where(eq(aiGenerationJobs.id, jobId))
    .limit(1);
  return rows[0] || null;
}

export async function findJobByIdempotencyKey(idempotencyKey) {
  const db = getDb();
  const rows = await db
    .select()
    .from(aiGenerationJobs)
    .where(eq(aiGenerationJobs.idempotencyKey, idempotencyKey))
    .limit(1);
  return rows[0] || null;
}

export async function findLatestSucceededJobByCacheKey(cacheKey) {
  const db = getDb();
  const rows = await db
    .select()
    .from(aiGenerationJobs)
    .where(and(eq(aiGenerationJobs.cacheKey, cacheKey), eq(aiGenerationJobs.status, 'succeeded')))
    .orderBy(desc(aiGenerationJobs.completedAt))
    .limit(1);
  return rows[0] || null;
}

export async function createJobRecord({
  idempotencyKey,
  cacheKey,
  operation,
  targetType,
  targetId,
  requestHash,
  maxAttempts = 3,
  status = 'queued',
  resultRefsJson = null,
}) {
  const db = getDb();
  const now = new Date();
  const [inserted] = await db
    .insert(aiGenerationJobs)
    .values({
      idempotencyKey,
      cacheKey,
      operation,
      targetType,
      targetId,
      status,
      attemptCount: 0,
      maxAttempts,
      requestHash,
      resultRefsJson,
      queuedAt: now,
      completedAt: status === 'succeeded' ? now : null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: aiGenerationJobs.idempotencyKey })
    .returning();

  if (inserted) {
    return { job: inserted, created: true };
  }

  const existing = await findJobByIdempotencyKey(idempotencyKey);
  return { job: existing, created: false };
}

export async function markJobRunning(jobId, attemptCount) {
  const db = getDb();
  const now = new Date();
  const [updated] = await db
    .update(aiGenerationJobs)
    .set({
      status: 'running',
      attemptCount,
      startedAt: now,
      updatedAt: now,
    })
    .where(eq(aiGenerationJobs.id, jobId))
    .returning();
  return updated;
}

export async function updateJobRetryState(jobId, { attemptCount, lastErrorCode, lastErrorMessage, retryAfter }) {
  const db = getDb();
  const now = new Date();
  const [updated] = await db
    .update(aiGenerationJobs)
    .set({
      attemptCount,
      lastErrorCode,
      lastErrorMessage,
      retryAfter: retryAfter ? new Date(retryAfter) : null,
      updatedAt: now,
    })
    .where(eq(aiGenerationJobs.id, jobId))
    .returning();
  return updated;
}

export async function markJobSucceeded(jobId, { attemptCount, resultRefsJson }) {
  const db = getDb();
  const now = new Date();
  const [updated] = await db
    .update(aiGenerationJobs)
    .set({
      status: 'succeeded',
      attemptCount,
      resultRefsJson,
      lastErrorCode: null,
      lastErrorMessage: null,
      retryAfter: null,
      completedAt: now,
      updatedAt: now,
    })
    .where(eq(aiGenerationJobs.id, jobId))
    .returning();
  return updated;
}

export async function markJobFailed(jobId, { attemptCount, errorCode, errorMessage, retryAfter = null }) {
  const db = getDb();
  const now = new Date();
  const [updated] = await db
    .update(aiGenerationJobs)
    .set({
      status: 'failed',
      attemptCount,
      lastErrorCode: errorCode,
      lastErrorMessage: errorMessage,
      retryAfter: retryAfter ? new Date(retryAfter) : null,
      completedAt: now,
      updatedAt: now,
    })
    .where(eq(aiGenerationJobs.id, jobId))
    .returning();
  return updated;
}

export async function recoverInterruptedJobs() {
  const db = getDb();
  const now = new Date();
  const updated = await db
    .update(aiGenerationJobs)
    .set({
      status: 'interrupted',
      lastErrorCode: 'SERVER_RESTART_INTERRUPTED',
      lastErrorMessage: 'Job terhenti karena server di-restart sebelum proses selesai. Silakan ulangi bila diperlukan.',
      completedAt: now,
      updatedAt: now,
    })
    .where(inArray(aiGenerationJobs.status, ['queued', 'running']))
    .returning({ id: aiGenerationJobs.id });

  return updated.length;
}

export async function recordAiUsageEvent({
  jobId = null,
  courseId = null,
  moduleId = null,
  model,
  taskType,
  status,
  httpStatus = null,
  errorCode = null,
  errorMessage = null,
  retryCount = 0,
  durationMs = 0,
  usageMetadata = null,
  searchGroundingUsed = false,
}) {
  const db = getDb();
  const normalized = normalizeUsageMetadata(usageMetadata);

  const [event] = await db
    .insert(aiUsageEvents)
    .values({
      jobId,
      courseId,
      moduleId,
      model: model || 'unknown',
      taskType,
      status,
      httpStatus,
      errorCode,
      errorMessage: errorMessage ? String(errorMessage).slice(0, 500) : null,
      retryCount,
      durationMs: Math.max(0, Math.round(durationMs)),
      promptTokens: normalized.promptTokens,
      outputTokens: normalized.outputTokens,
      thinkingTokens: normalized.thinkingTokens,
      toolUsePromptTokens: normalized.toolUsePromptTokens,
      cachedTokens: normalized.cachedTokens,
      totalTokens: normalized.totalTokens,
      usageMetadataJson: normalized.usageMetadataJson,
      searchGroundingUsed: Boolean(searchGroundingUsed),
    })
    .returning();

  return event;
}

export async function getTodayUsageTotals() {
  const db = getDb();
  const startOfDayUtc = new Date();
  startOfDayUtc.setUTCHours(0, 0, 0, 0);

  const [row] = await db
    .select({
      requestCount: sql`count(*)::int`,
      succeededCount: sql`count(*) filter (where ${aiUsageEvents.status} = 'succeeded')::int`,
      failedCount: sql`count(*) filter (where ${aiUsageEvents.status} = 'failed')::int`,
      promptTokens: sql`coalesce(sum(${aiUsageEvents.promptTokens}), 0)::int`,
      outputTokens: sql`coalesce(sum(${aiUsageEvents.outputTokens}), 0)::int`,
      thinkingTokens: sql`coalesce(sum(${aiUsageEvents.thinkingTokens}), 0)::int`,
      totalTokens: sql`coalesce(sum(${aiUsageEvents.totalTokens}), 0)::int`,
    })
    .from(aiUsageEvents)
    .where(gte(aiUsageEvents.createdAt, startOfDayUtc));

  return (
    row || {
      requestCount: 0,
      succeededCount: 0,
      failedCount: 0,
      promptTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      totalTokens: 0,
    }
  );
}

export async function checkSoftDailyBudget() {
  const config = getEnvConfig();
  const today = await getTodayUsageTotals();

  const requestExceeded =
    config.aiSoftDailyRequestBudget !== null &&
    today.requestCount >= config.aiSoftDailyRequestBudget;
  const tokenExceeded =
    config.aiSoftDailyTokenBudget !== null &&
    today.totalTokens >= config.aiSoftDailyTokenBudget;

  return {
    exceeded: requestExceeded || tokenExceeded,
    requestExceeded,
    tokenExceeded,
    today,
    budgets: {
      softDailyRequestBudget: config.aiSoftDailyRequestBudget,
      softDailyTokenBudget: config.aiSoftDailyTokenBudget,
    },
  };
}

export async function getAiUsageSummary() {
  const db = getDb();
  const config = getEnvConfig();
  const today = await getTodayUsageTotals();

  const [allTime] = await db
    .select({
      requestCount: sql`count(*)::int`,
      succeededCount: sql`count(*) filter (where ${aiUsageEvents.status} = 'succeeded')::int`,
      failedCount: sql`count(*) filter (where ${aiUsageEvents.status} = 'failed')::int`,
      promptTokens: sql`coalesce(sum(${aiUsageEvents.promptTokens}), 0)::int`,
      outputTokens: sql`coalesce(sum(${aiUsageEvents.outputTokens}), 0)::int`,
      thinkingTokens: sql`coalesce(sum(${aiUsageEvents.thinkingTokens}), 0)::int`,
      totalTokens: sql`coalesce(sum(${aiUsageEvents.totalTokens}), 0)::int`,
      searchGroundingCount: sql`count(*) filter (where ${aiUsageEvents.searchGroundingUsed} = true)::int`,
    })
    .from(aiUsageEvents);

  const byTask = await db
    .select({
      taskType: aiUsageEvents.taskType,
      model: aiUsageEvents.model,
      requestCount: sql`count(*)::int`,
      succeededCount: sql`count(*) filter (where ${aiUsageEvents.status} = 'succeeded')::int`,
      failedCount: sql`count(*) filter (where ${aiUsageEvents.status} = 'failed')::int`,
      totalTokens: sql`coalesce(sum(${aiUsageEvents.totalTokens}), 0)::int`,
    })
    .from(aiUsageEvents)
    .groupBy(aiUsageEvents.taskType, aiUsageEvents.model);

  const recentFailures = await db
    .select({
      id: aiUsageEvents.id,
      jobId: aiUsageEvents.jobId,
      model: aiUsageEvents.model,
      taskType: aiUsageEvents.taskType,
      httpStatus: aiUsageEvents.httpStatus,
      errorCode: aiUsageEvents.errorCode,
      errorMessage: aiUsageEvents.errorMessage,
      createdAt: aiUsageEvents.createdAt,
    })
    .from(aiUsageEvents)
    .where(eq(aiUsageEvents.status, 'failed'))
    .orderBy(desc(aiUsageEvents.createdAt))
    .limit(10);

  return {
    disclaimer:
      'Data di bawah hanya mencatat pemakaian dari aplikasi ini (app-recorded usage), BUKAN sisa kuota resmi Google. Lihat kuota aktual proyek di Google AI Studio.',
    aiStudioRateLimitUrl: 'https://aistudio.google.com/rate-limit',
    todayUtc: today,
    allTime: allTime || {
      requestCount: 0,
      succeededCount: 0,
      failedCount: 0,
      promptTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      totalTokens: 0,
      searchGroundingCount: 0,
    },
    softBudgets: {
      dailyRequestBudget: config.aiSoftDailyRequestBudget,
      dailyTokenBudget: config.aiSoftDailyTokenBudget,
    },
    byTask,
    recentFailures,
  };
}
