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
  const startOfDayUtc = new Date();
  startOfDayUtc.setUTCHours(0, 0, 0, 0);

  const result = await db.execute(sql`
    WITH totals AS (
      SELECT
        count(*) filter (where ${aiUsageEvents.createdAt} >= ${startOfDayUtc})::int AS today_request_count,
        count(*) filter (where ${aiUsageEvents.createdAt} >= ${startOfDayUtc} and ${aiUsageEvents.status} = 'succeeded')::int AS today_succeeded_count,
        count(*) filter (where ${aiUsageEvents.createdAt} >= ${startOfDayUtc} and ${aiUsageEvents.status} = 'failed')::int AS today_failed_count,
        coalesce(sum(${aiUsageEvents.promptTokens}) filter (where ${aiUsageEvents.createdAt} >= ${startOfDayUtc}), 0)::int AS today_prompt_tokens,
        coalesce(sum(${aiUsageEvents.outputTokens}) filter (where ${aiUsageEvents.createdAt} >= ${startOfDayUtc}), 0)::int AS today_output_tokens,
        coalesce(sum(${aiUsageEvents.thinkingTokens}) filter (where ${aiUsageEvents.createdAt} >= ${startOfDayUtc}), 0)::int AS today_thinking_tokens,
        coalesce(sum(${aiUsageEvents.totalTokens}) filter (where ${aiUsageEvents.createdAt} >= ${startOfDayUtc}), 0)::int AS today_total_tokens,
        count(*)::int AS all_request_count,
        count(*) filter (where ${aiUsageEvents.status} = 'succeeded')::int AS all_succeeded_count,
        count(*) filter (where ${aiUsageEvents.status} = 'failed')::int AS all_failed_count,
        coalesce(sum(${aiUsageEvents.promptTokens}), 0)::int AS all_prompt_tokens,
        coalesce(sum(${aiUsageEvents.outputTokens}), 0)::int AS all_output_tokens,
        coalesce(sum(${aiUsageEvents.thinkingTokens}), 0)::int AS all_thinking_tokens,
        coalesce(sum(${aiUsageEvents.totalTokens}), 0)::int AS all_total_tokens,
        count(*) filter (where ${aiUsageEvents.searchGroundingUsed} = true)::int AS all_search_grounding_count
      FROM ${aiUsageEvents}
    ),
    by_task AS (
      SELECT
        ${aiUsageEvents.taskType} AS "taskType",
        ${aiUsageEvents.model} AS "model",
        count(*)::int AS "requestCount",
        count(*) filter (where ${aiUsageEvents.status} = 'succeeded')::int AS "succeededCount",
        count(*) filter (where ${aiUsageEvents.status} = 'failed')::int AS "failedCount",
        coalesce(sum(${aiUsageEvents.totalTokens}), 0)::int AS "totalTokens"
      FROM ${aiUsageEvents}
      GROUP BY ${aiUsageEvents.taskType}, ${aiUsageEvents.model}
    ),
    recent_failures AS (
      SELECT
        ${aiUsageEvents.id} AS "id",
        ${aiUsageEvents.jobId} AS "jobId",
        ${aiUsageEvents.model} AS "model",
        ${aiUsageEvents.taskType} AS "taskType",
        ${aiUsageEvents.httpStatus} AS "httpStatus",
        ${aiUsageEvents.errorCode} AS "errorCode",
        ${aiUsageEvents.errorMessage} AS "errorMessage",
        ${aiUsageEvents.createdAt} AS "createdAt"
      FROM ${aiUsageEvents}
      WHERE ${aiUsageEvents.status} = 'failed'
      ORDER BY ${aiUsageEvents.createdAt} DESC
      LIMIT 10
    )
    SELECT
      (SELECT row_to_json(t) FROM totals t) AS totals,
      coalesce((SELECT json_agg(row_to_json(b)) FROM by_task b), '[]'::json) AS by_task,
      coalesce((SELECT json_agg(row_to_json(r)) FROM recent_failures r), '[]'::json) AS recent_failures
  `);

  const row = result.rows?.[0] || {};
  const t = row.totals || {};

  return {
    disclaimer:
      'Data di bawah hanya mencatat pemakaian dari aplikasi ini (app-recorded usage), BUKAN sisa kuota resmi Google. Lihat kuota aktual proyek di Google AI Studio.',
    aiStudioRateLimitUrl: 'https://aistudio.google.com/rate-limit',
    todayUtc: {
      requestCount: t.today_request_count ?? 0,
      succeededCount: t.today_succeeded_count ?? 0,
      failedCount: t.today_failed_count ?? 0,
      promptTokens: t.today_prompt_tokens ?? 0,
      outputTokens: t.today_output_tokens ?? 0,
      thinkingTokens: t.today_thinking_tokens ?? 0,
      totalTokens: t.today_total_tokens ?? 0,
    },
    allTime: {
      requestCount: t.all_request_count ?? 0,
      succeededCount: t.all_succeeded_count ?? 0,
      failedCount: t.all_failed_count ?? 0,
      promptTokens: t.all_prompt_tokens ?? 0,
      outputTokens: t.all_output_tokens ?? 0,
      thinkingTokens: t.all_thinking_tokens ?? 0,
      totalTokens: t.all_total_tokens ?? 0,
      searchGroundingCount: t.all_search_grounding_count ?? 0,
    },
    softBudgets: {
      dailyRequestBudget: config.aiSoftDailyRequestBudget,
      dailyTokenBudget: config.aiSoftDailyTokenBudget,
    },
    byTask: row.by_task || [],
    recentFailures: row.recent_failures || [],
  };
}
