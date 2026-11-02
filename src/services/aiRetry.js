import crypto from 'node:crypto';

export function computeSha256(input) {
  const str = typeof input === 'string' ? input : JSON.stringify(input);
  return crypto.createHash('sha256').update(str).digest('hex');
}

export function buildCacheKey({
  operation,
  targetType,
  targetId,
  inputChecksum,
  model,
  promptVersion = 'v1',
  schemaVersion = 1,
}) {
  return computeSha256({
    operation,
    targetType,
    targetId,
    inputChecksum,
    model: model || 'default',
    promptVersion,
    schemaVersion,
  });
}

export function parseRetryAfterMs(error) {
  if (!error) return null;

  if (typeof error.retryAfterMs === 'number' && error.retryAfterMs > 0) {
    return error.retryAfterMs;
  }

  const msg = String(error.message || '');
  const retryInMatch = msg.match(/retry in\s+([0-9.]+)\s*(ms|s|sec|seconds)/i);
  if (retryInMatch) {
    const val = Number.parseFloat(retryInMatch[1]);
    const unit = retryInMatch[2].toLowerCase();
    if (Number.isFinite(val) && val > 0) {
      return unit === 'ms' ? Math.ceil(val) : Math.ceil(val * 1000);
    }
  }

  return null;
}

export function classifyAiError(error) {
  const status =
    Number(error?.status || error?.httpStatus || error?.statusCode || error?.code) || null;
  const rawMessage = String(error?.message || error || 'Unknown AI error');
  const lower = rawMessage.toLowerCase();

  // Check explicit custom code first
  if (error?.errorCode === 'OUTPUT_SCHEMA_INVALID' || error?.name === 'ZodError') {
    return {
      retryable: false,
      httpStatus: status || 422,
      errorCode: 'OUTPUT_SCHEMA_INVALID',
      userMessage: `Output AI tidak sesuai struktur yang diharapkan: ${rawMessage.slice(0, 220)}`,
      retryAfterMs: null,
    };
  }

  if (status === 401 || status === 403 || lower.includes('api_key_invalid') || lower.includes('permission_denied')) {
    return {
      retryable: false,
      httpStatus: status || 403,
      errorCode: 'AUTH_OR_BILLING_ERROR',
      userMessage: 'Konfigurasi API key atau izin project Gemini tidak valid. Periksa GEMINI_API_KEY dan AI Studio.',
      retryAfterMs: null,
    };
  }

  if (status === 400 || lower.includes('invalid_argument')) {
    return {
      retryable: false,
      httpStatus: 400,
      errorCode: 'INVALID_REQUEST',
      userMessage: 'Permintaan ke model AI ditolak karena parameter atau input tidak valid.',
      retryAfterMs: null,
    };
  }

  if (status === 404 || lower.includes('not_found')) {
    return {
      retryable: false,
      httpStatus: 404,
      errorCode: 'MODEL_NOT_FOUND',
      userMessage: 'Model Gemini yang dikonfigurasi tidak ditemukan atau tidak tersedia untuk proyek ini.',
      retryAfterMs: null,
    };
  }

  if (status === 429 || lower.includes('resource_exhausted') || lower.includes('rate limit') || lower.includes('quota')) {
    const isDailyQuota =
      lower.includes('per day') ||
      lower.includes('per_day') ||
      lower.includes('daily') ||
      lower.includes('generaterequestsperday') ||
      lower.includes('rpd');

    if (isDailyQuota) {
      return {
        retryable: false,
        httpStatus: 429,
        errorCode: 'QUOTA_EXHAUSTED_DAILY',
        userMessage:
          'Kuota harian proyek Gemini telah habis (429 RESOURCE_EXHAUSTED). Silakan cek batas kuota di Google AI Studio dan lanjutkan setelah reset.',
        retryAfterMs: null,
      };
    }

    return {
      retryable: true,
      httpStatus: 429,
      errorCode: 'RATE_LIMIT_TEMPORARY',
      userMessage: 'Batas request per menit tercapai sementara (429). Sistem mencoba ulang secara bertahap.',
      retryAfterMs: parseRetryAfterMs(error),
    };
  }

  if (
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    lower.includes('unavailable') ||
    lower.includes('deadline_exceeded') ||
    lower.includes('timeout') ||
    lower.includes('econnreset') ||
    lower.includes('fetch failed')
  ) {
    return {
      retryable: true,
      httpStatus: status || 503,
      errorCode: 'TRANSIENT_UNAVAILABLE',
      userMessage: 'Layanan AI sedang sibuk atau mengalami gangguan jaringan sementara.',
      retryAfterMs: parseRetryAfterMs(error),
    };
  }

  return {
    retryable: false,
    httpStatus: status || 500,
    errorCode: error?.errorCode || 'AI_EXECUTION_ERROR',
    userMessage: rawMessage.slice(0, 300),
    retryAfterMs: null,
  };
}

export function calculateBackoffMs({
  attemptIndex,
  baseMs = 1000,
  maxMs = 30000,
  retryAfterMs = null,
  randomFn = Math.random,
}) {
  if (typeof retryAfterMs === 'number' && retryAfterMs > 0) {
    return Math.min(retryAfterMs, maxMs);
  }
  const exp = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, attemptIndex)));
  const jitter = Math.floor(randomFn() * Math.max(100, Math.floor(exp * 0.25)));
  return Math.min(maxMs, exp + jitter);
}
