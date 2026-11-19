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

export const DEFAULT_GEMINI_MODEL_CHAIN = [
  'gemini-4-hydrogen',
  'gemini-3.6-flash',
  'gemini-3.8-flash',
  'gemini-3.5-flash-lite',
];

export const DEFAULT_GEMINI_OCR_MODEL_CHAIN = [
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-4-hydrogen',
];

export function parseFallbackModels(env = process.env) {
  const raw = (env?.GEMINI_FALLBACK_MODELS || '').trim();
  const primary = (env?.GEMINI_MODEL || '').trim() || DEFAULT_GEMINI_MODEL_CHAIN[0];
  const list = raw
    ? raw
        .split(/[\n,;]+/)
        .map((m) => m.trim())
        .filter(Boolean)
    : DEFAULT_GEMINI_MODEL_CHAIN;
  return Array.from(new Set([primary, ...list]));
}

export function parseOcrFallbackModels(env = process.env) {
  const raw = (env?.GEMINI_OCR_FALLBACK_MODELS || '').trim();
  const primary = (env?.GEMINI_OCR_MODEL || '').trim() || DEFAULT_GEMINI_OCR_MODEL_CHAIN[0];
  const list = raw
    ? raw
        .split(/[\n,;]+/)
        .map((m) => m.trim())
        .filter(Boolean)
    : DEFAULT_GEMINI_OCR_MODEL_CHAIN;
  return Array.from(new Set([primary, ...list]));
}

export function getEnvConfig() {
  const rawDbUrl = (process.env.DATABASE_URL || '').trim();
  const rawDirectUrl = (process.env.DIRECT_URL || '').trim();
  const effectiveDbUrl = rawDbUrl || rawDirectUrl;
  const apiKeys = parseApiKeys(process.env);
  const geminiModel = (process.env.GEMINI_MODEL || '').trim() || DEFAULT_GEMINI_MODEL_CHAIN[0];
  const geminiFallbackModels = parseFallbackModels(process.env);
  const geminiOcrModel = (process.env.GEMINI_OCR_MODEL || '').trim() || DEFAULT_GEMINI_OCR_MODEL_CHAIN[0];
  const geminiOcrFallbackModels = parseOcrFallbackModels(process.env);

  return {
    port: parsePositiveInt(process.env.PORT, 3000),
    host: (process.env.HOST || '127.0.0.1').trim(),
    databaseUrlConfigured: Boolean(effectiveDbUrl),
    pooledUrlConfigured: Boolean(rawDbUrl),
    directUrlConfigured: Boolean(rawDirectUrl),
    geminiApiKeyConfigured: apiKeys.length > 0,
    geminiApiKeyCount: apiKeys.length,
    geminiModel,
    geminiFallbackModels,
    geminiOcrModel,
    geminiOcrFallbackModels,
    geminiThinkingLevel: (process.env.GEMINI_THINKING_LEVEL || 'low').trim(),
    aiMaxConcurrentJobs: parsePositiveInt(process.env.AI_MAX_CONCURRENT_JOBS, 1),
    aiMaxQueuedJobs: parsePositiveInt(process.env.AI_MAX_QUEUED_JOBS, 3),
    aiMaxRetries: parsePositiveInt(process.env.AI_MAX_RETRIES, 2),
    aiRetryBaseMs: parsePositiveInt(process.env.AI_RETRY_BASE_MS, 1000),
    aiRetryMaxMs: parsePositiveInt(process.env.AI_RETRY_MAX_MS, 30000),
    aiEnableGoogleSearch: String(process.env.AI_ENABLE_GOOGLE_SEARCH || 'false').toLowerCase() === 'true',
    aiMaxImagesPerBatch: parsePositiveInt(process.env.AI_MAX_IMAGES_PER_BATCH, 15),
    aiMaxImageBytes: parsePositiveInt(process.env.AI_MAX_IMAGE_BYTES, 8_000_000),
    aiMaxBatchBytes: parsePositiveInt(process.env.AI_MAX_BATCH_BYTES, 50_000_000),
    aiMaxOutputTokensExtraction: parsePositiveInt(process.env.AI_MAX_OUTPUT_TOKENS_EXTRACTION, 65536),
    aiMaxOutputTokensStudyPack: parsePositiveInt(process.env.AI_MAX_OUTPUT_TOKENS_STUDY_PACK, 65536),
    aiMaxOutputTokensRemedial: parsePositiveInt(process.env.AI_MAX_OUTPUT_TOKENS_REMEDIAL, 16000),
    aiMaxOutputTokensExam: parsePositiveInt(process.env.AI_MAX_OUTPUT_TOKENS_EXAM, 32000),
    aiSoftDailyRequestBudget: parseOptionalPositiveInt(process.env.AI_SOFT_DAILY_REQUEST_BUDGET),
    aiSoftDailyTokenBudget: parseOptionalPositiveInt(process.env.AI_SOFT_DAILY_TOKEN_BUDGET),
  };
}
