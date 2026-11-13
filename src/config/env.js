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

export function parseApiKeys(env = process.env) {
  if (typeof env === 'string' || (arguments.length > 1 && typeof arguments[1] === 'string')) {
    const combined = Array.from(arguments)
      .filter(Boolean)
      .join(',')
      .split(/[\n,;\s]+/)
      .map((k) => k.trim())
      .filter((k) => k.length > 0);
    return Array.from(new Set(combined));
  }

  const envObj = env || process.env;
  const collected = [];
  const numberedEntries = [];
  const regex = /^gemini[-_]api(?:[-_]key)?(?:[-_](\d+))?$/i;

  for (const [key, value] of Object.entries(envObj)) {
    if (!value || typeof value !== 'string') continue;
    const match = key.match(regex);
    if (match) {
      const num = match[1] ? Number.parseInt(match[1], 10) : 0;
      numberedEntries.push({ key, num, value });
    }
  }

  numberedEntries.sort((a, b) => a.num - b.num);
  for (const entry of numberedEntries) {
    collected.push(entry.value);
  }

  if (envObj.GEMINI_API_KEYS) {
    collected.push(envObj.GEMINI_API_KEYS);
  }

  const flattened = collected
    .join(',')
    .split(/[\n,;\s]+/)
    .map((k) => k.trim())
    .filter((k) => k.length > 0);

  return Array.from(new Set(flattened));
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
  const apiKeys = parseApiKeys(process.env);

  return {
    port: parsePositiveInt(process.env.PORT, 3000),
    host: (process.env.HOST || '127.0.0.1').trim(),
    databaseUrlConfigured: Boolean(effectiveDbUrl),
    pooledUrlConfigured: Boolean(rawDbUrl),
    directUrlConfigured: Boolean(rawDirectUrl),
    geminiApiKeyConfigured: apiKeys.length > 0,
    geminiApiKeyCount: apiKeys.length,
    geminiModel: (process.env.GEMINI_MODEL || '').trim() || 'gemini-4-hydrogen',
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
    aiMaxOutputTokensExtraction: parsePositiveInt(process.env.AI_MAX_OUTPUT_TOKENS_EXTRACTION, 32000),
    aiMaxOutputTokensStudyPack: parsePositiveInt(process.env.AI_MAX_OUTPUT_TOKENS_STUDY_PACK, 32000),
    aiMaxOutputTokensRemedial: parsePositiveInt(process.env.AI_MAX_OUTPUT_TOKENS_REMEDIAL, 8000),
    aiMaxOutputTokensExam: parsePositiveInt(process.env.AI_MAX_OUTPUT_TOKENS_EXAM, 12000),
    aiSoftDailyRequestBudget: parseOptionalPositiveInt(process.env.AI_SOFT_DAILY_REQUEST_BUDGET),
    aiSoftDailyTokenBudget: parseOptionalPositiveInt(process.env.AI_SOFT_DAILY_TOKEN_BUDGET),
  };
}
