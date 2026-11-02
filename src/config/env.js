import dotenv from 'dotenv';

dotenv.config();

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalPositiveInt(value) {
  if (!value || String(value).trim() === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function getDatabaseConnectionString() {
  const pooled = (process.env.DATABASE_URL || '').trim();
  const direct = (process.env.DIRECT_URL || '').trim();
  return pooled || direct || '';
}

export function getDirectDatabaseConnectionString() {
  const direct = (process.env.DIRECT_URL || '').trim();
  const pooled = (process.env.DATABASE_URL || '').trim();
  return direct || pooled || '';
}

export function getEnvConfig() {
  const rawDbUrl = (process.env.DATABASE_URL || '').trim();
  const rawDirectUrl = (process.env.DIRECT_URL || '').trim();
  const effectiveDbUrl = rawDbUrl || rawDirectUrl;

  return {
    port: parsePositiveInt(process.env.PORT, 3000),
    host: (process.env.HOST || '127.0.0.1').trim(),
    databaseUrlConfigured: Boolean(effectiveDbUrl),
    pooledUrlConfigured: Boolean(rawDbUrl),
    directUrlConfigured: Boolean(rawDirectUrl),
    geminiApiKeyConfigured: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()),
    geminiModel: (process.env.GEMINI_MODEL || '').trim() || null,
    geminiThinkingLevel: (process.env.GEMINI_THINKING_LEVEL || 'low').trim(),
    aiMaxConcurrentJobs: parsePositiveInt(process.env.AI_MAX_CONCURRENT_JOBS, 1),
    aiMaxQueuedJobs: parsePositiveInt(process.env.AI_MAX_QUEUED_JOBS, 3),
    aiMaxRetries: parsePositiveInt(process.env.AI_MAX_RETRIES, 2),
    aiRetryBaseMs: parsePositiveInt(process.env.AI_RETRY_BASE_MS, 1000),
    aiRetryMaxMs: parsePositiveInt(process.env.AI_RETRY_MAX_MS, 30000),
    aiEnableGoogleSearch: String(process.env.AI_ENABLE_GOOGLE_SEARCH || 'false').toLowerCase() === 'true',
    aiMaxImagesPerBatch: parsePositiveInt(process.env.AI_MAX_IMAGES_PER_BATCH, 8),
    aiMaxImageBytes: parsePositiveInt(process.env.AI_MAX_IMAGE_BYTES, 8_000_000),
    aiMaxBatchBytes: parsePositiveInt(process.env.AI_MAX_BATCH_BYTES, 25_000_000),
    aiMaxOutputTokensExtraction: parsePositiveInt(process.env.AI_MAX_OUTPUT_TOKENS_EXTRACTION, 12000),
    aiMaxOutputTokensStudyPack: parsePositiveInt(process.env.AI_MAX_OUTPUT_TOKENS_STUDY_PACK, 12000),
    aiMaxOutputTokensRemedial: parsePositiveInt(process.env.AI_MAX_OUTPUT_TOKENS_REMEDIAL, 6000),
    aiMaxOutputTokensExam: parsePositiveInt(process.env.AI_MAX_OUTPUT_TOKENS_EXAM, 8000),
    aiSoftDailyRequestBudget: parseOptionalPositiveInt(process.env.AI_SOFT_DAILY_REQUEST_BUDGET),
    aiSoftDailyTokenBudget: parseOptionalPositiveInt(process.env.AI_SOFT_DAILY_TOKEN_BUDGET),
  };
}
