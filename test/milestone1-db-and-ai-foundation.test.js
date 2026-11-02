import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { getDb, closeDb } from '../src/db/client.js';
import { courses, modules, aiGenerationJobs, aiUsageEvents } from '../src/db/schema.js';
import { AiJobQueue } from '../src/services/aiQueue.js';
import { buildCacheKey, computeSha256 } from '../src/services/aiRetry.js';
import { findJobById } from '../src/services/aiJobRepository.js';
import { createApp } from '../src/app.js';

const createdCourseIds = [];
const createdJobIds = [];

after(async () => {
  const db = getDb();
  if (createdJobIds.length > 0) {
    await db.delete(aiUsageEvents).where(inArray(aiUsageEvents.jobId, createdJobIds));
    await db.delete(aiGenerationJobs).where(inArray(aiGenerationJobs.id, createdJobIds));
  }
  if (createdCourseIds.length > 0) {
    await db.delete(courses).where(inArray(courses.id, createdCourseIds));
  }
  await closeDb();
});

test('Milestone 1: Course and Module records persist and can be queried in Neon Postgres', async () => {
  const db = getDb();
  const [course] = await db
    .insert(courses)
    .values({
      code: 'TEST4101',
      name: 'Mata Kuliah Uji Neon',
      semesterLabel: 'Semester Uji',
      expectedModuleCount: 9,
      status: 'active',
    })
    .returning();

  createdCourseIds.push(course.id);

  await db.insert(modules).values([
    {
      courseId: course.id,
      moduleNumber: 1,
      title: 'Modul 1 Uji',
      status: 'empty',
    },
    {
      courseId: course.id,
      moduleNumber: 2,
      title: 'Modul 2 Uji',
      status: 'in_progress',
    },
  ]);

  const savedModules = await db
    .select()
    .from(modules)
    .where(eq(modules.courseId, course.id));

  assert.equal(savedModules.length, 2);
  assert.equal(savedModules[0].courseId, course.id);
});

test('Milestone 1A: Idempotency deduplication, cache reuse, transient retry, and usage logging', async () => {
  const queue = new AiJobQueue({ sleepFn: async () => {} });
  const targetId = crypto.randomUUID();
  const idempotencyKey1 = `test-idem-${crypto.randomUUID()}`;
  const cacheKey = buildCacheKey({
    operation: 'generate_study_pack',
    targetType: 'module',
    targetId,
    inputChecksum: 'checksum-abc',
    model: 'gemini-2.5-flash',
  });

  let executionCount = 0;

  const executeFn = async ({ attempt }) => {
    executionCount += 1;
    if (attempt === 1) {
      const transientErr = new Error('503 Service Unavailable');
      transientErr.status = 503;
      throw transientErr;
    }
    return {
      model: 'gemini-2.5-flash',
      resultRefs: { studyPackId: 'pack-123', questionSetId: 'qset-456' },
      usageMetadata: {
        promptTokenCount: 420,
        candidatesTokenCount: 310,
        thoughtsTokenCount: 80,
        totalTokenCount: 810,
      },
      searchGroundingUsed: false,
    };
  };

  // Submit first job
  const sub1 = await queue.submitJob({
    idempotencyKey: idempotencyKey1,
    cacheKey,
    operation: 'generate_study_pack',
    targetType: 'module',
    targetId,
    requestHash: computeSha256({ targetId }),
    executeFn,
  });
  createdJobIds.push(sub1.job.id);
  assert.equal(sub1.deduplicated, false);

  // Submit duplicate idempotencyKey immediately
  const subDuplicate = await queue.submitJob({
    idempotencyKey: idempotencyKey1,
    cacheKey,
    operation: 'generate_study_pack',
    targetType: 'module',
    targetId,
    requestHash: computeSha256({ targetId }),
    executeFn,
  });
  assert.equal(subDuplicate.deduplicated, true);
  assert.equal(subDuplicate.job.id, sub1.job.id);

  await queue.waitForIdle();

  // Verify job succeeded on attempt 2
  const finishedJob = await findJobById(sub1.job.id);
  assert.equal(finishedJob.status, 'succeeded');
  assert.equal(finishedJob.attemptCount, 2);
  assert.equal(executionCount, 2);
  assert.equal(finishedJob.resultRefsJson.studyPackId, 'pack-123');

  // Verify cache reuse with a new idempotencyKey and identical cacheKey
  const idempotencyKey2 = `test-idem-${crypto.randomUUID()}`;
  const subCached = await queue.submitJob({
    idempotencyKey: idempotencyKey2,
    cacheKey,
    operation: 'generate_study_pack',
    targetType: 'module',
    targetId,
    requestHash: computeSha256({ targetId }),
    regenerate: false,
    executeFn: async () => {
      executionCount += 1;
      return {};
    },
  });
  createdJobIds.push(subCached.job.id);
  assert.equal(subCached.reusedCache, true);
  assert.equal(subCached.job.status, 'succeeded');
  assert.equal(subCached.job.resultRefsJson.reusedFromJobId, sub1.job.id);
  assert.equal(executionCount, 2, 'Cached job must not invoke executeFn');

  // Verify non-retryable daily quota stops immediately on attempt 1
  const idempotencyKeyQuota = `test-idem-${crypto.randomUUID()}`;
  let quotaAttempts = 0;
  const subQuota = await queue.submitJob({
    idempotencyKey: idempotencyKeyQuota,
    cacheKey: `cache-quota-${crypto.randomUUID()}`,
    operation: 'extract_sources',
    targetType: 'module',
    targetId,
    requestHash: 'hash-quota',
    executeFn: async () => {
      quotaAttempts += 1;
      const err = new Error('Quota exceeded for metric: GenerateRequestsPerDay');
      err.status = 429;
      throw err;
    },
  });
  createdJobIds.push(subQuota.job.id);

  await queue.waitForIdle();

  const failedQuotaJob = await findJobById(subQuota.job.id);
  assert.equal(failedQuotaJob.status, 'failed');
  assert.equal(failedQuotaJob.lastErrorCode, 'QUOTA_EXHAUSTED_DAILY');
  assert.equal(quotaAttempts, 1, 'Daily quota exhaustion must not be retried');

  // Verify API endpoints /api/ai/jobs/:jobId and /api/ai/usage/summary
  const app = createApp({ aiQueue: queue });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const jobRes = await fetch(`${baseUrl}/api/ai/jobs/${sub1.job.id}`);
    assert.equal(jobRes.status, 200);
    const jobBody = await jobRes.json();
    assert.equal(jobBody.status, 'succeeded');
    assert.equal(jobBody.attemptCount, 2);

    const summaryRes = await fetch(`${baseUrl}/api/ai/usage/summary`);
    assert.equal(summaryRes.status, 200);
    const summaryBody = await summaryRes.json();
    assert.ok(summaryBody.disclaimer.includes('app-recorded usage'));
    assert.equal(summaryBody.aiStudioRateLimitUrl, 'https://aistudio.google.com/rate-limit');
    assert.ok(summaryBody.allTime.requestCount >= 3);
    assert.ok(summaryBody.allTime.totalTokens >= 810);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
