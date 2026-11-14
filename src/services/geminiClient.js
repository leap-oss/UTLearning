import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { getEnvConfig, parseApiKeys } from '../config/env.js';

export function maskApiKey(key) {
  if (!key || key.length <= 8) return '***';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

export class GeminiApiKeyPool {
  constructor() {
    this.keys = [];
    this.currentIndex = 0;
    this.clientCache = new Map();
    this.cooldowns = new Map(); // key -> number (timestamp)
  }

  sync() {
    if (process.env.NODE_ENV !== 'test') {
      try {
        dotenv.config({ override: true });
      } catch {
        // Ignore in environments where .env is not readable
      }
    }
    const unique = parseApiKeys(process.env);
    if (unique.length !== this.keys.length || !unique.every((k, i) => k === this.keys[i])) {
      this.keys = unique;
      if (this.currentIndex >= this.keys.length) {
        this.currentIndex = 0;
      }
    }
    return this.keys;
  }

  getKeys() {
    return this.sync();
  }

  getKeyCount() {
    return this.sync().length;
  }

  getActiveKeyInfo() {
    this.sync();
    if (this.keys.length === 0) {
      const err = new Error('GEMINI_API_KEY belum dikonfigurasi di .env');
      err.status = 401;
      throw err;
    }

    const now = Date.now();
    for (let offset = 0; offset < this.keys.length; offset++) {
      const idx = (this.currentIndex + offset) % this.keys.length;
      const key = this.keys[idx];
      const cooldownUntil = this.cooldowns.get(key) || 0;
      if (cooldownUntil <= now) {
        this.currentIndex = idx;
        return {
          key,
          index: idx,
          total: this.keys.length,
          allOnCooldown: false,
        };
      }
    }

    let minCd = Infinity;
    let bestIdx = 0;
    for (let i = 0; i < this.keys.length; i++) {
      const cd = this.cooldowns.get(this.keys[i]) || 0;
      if (cd < minCd) {
        minCd = cd;
        bestIdx = i;
      }
    }
    this.currentIndex = bestIdx;
    return {
      key: this.keys[bestIdx],
      index: bestIdx,
      total: this.keys.length,
      allOnCooldown: true,
      retryAfterMs: Math.max(1000, minCd - now),
    };
  }

  getClientForKey(key) {
    let client = this.clientCache.get(key);
    if (!client) {
      client = new GoogleGenAI({ apiKey: key });
      this.clientCache.set(key, client);
    }
    return client;
  }

  markCooldown(key, durationMs = 60000) {
    this.cooldowns.set(key, Date.now() + durationMs);
    if (this.keys.length > 1) {
      this.currentIndex = (this.currentIndex + 1) % this.keys.length;
    }
  }

  markSuccess(key) {
    this.cooldowns.delete(key);
  }

  reset() {
    this.keys = [];
    this.currentIndex = 0;
    this.clientCache.clear();
    this.cooldowns.clear();
  }
}

export const defaultApiKeyPool = new GeminiApiKeyPool();

export function getGeminiClient() {
  const info = defaultApiKeyPool.getActiveKeyInfo();
  return defaultApiKeyPool.getClientForKey(info.key);
}

export function getMaxOutputTokensForTask(taskType) {
  const config = getEnvConfig();
  switch (taskType) {
    case 'extract_sources':
      return config.aiMaxOutputTokensExtraction;
    case 'generate_study_pack':
    case 'generate_question_set':
      return config.aiMaxOutputTokensStudyPack;
    case 'generate_remedial':
      return config.aiMaxOutputTokensRemedial;
    case 'generate_exam_simulation':
      return config.aiMaxOutputTokensExam;
    default:
      return config.aiMaxOutputTokensStudyPack;
  }
}

export function buildThinkingConfig(modelName, levelInput) {
  const model = String(modelName || '').toLowerCase();
  const level = String(levelInput || 'low').toLowerCase();

  if (model.includes('gemini-2.5')) {
    const budgetMap = {
      none: 0,
      minimal: 0,
      low: 1024,
      medium: 4096,
      high: 8192,
    };
    const budget = budgetMap[level];
    if (typeof budget === 'number') {
      if (model.includes('pro') && budget === 0) {
        return { thinkingBudget: 128 };
      }
      return { thinkingBudget: budget };
    }
  }

  if (model.includes('gemini-3') || model.includes('gemini-4')) {
    const levelMap = {
      minimal: 'MINIMAL',
      low: 'LOW',
      medium: 'MEDIUM',
      high: 'HIGH',
    };
    if (levelMap[level]) {
      return { thinkingLevel: levelMap[level] };
    }
  }

  return undefined;
}

export function repairTruncatedJson(rawText) {
  let s = String(rawText || '').trim();
  let inString = false;
  let escape = false;
  const stack = [];

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
    } else {
      if (ch === '"') {
        inString = true;
      } else if (ch === '{' || ch === '[') {
        stack.push(ch);
      } else if (ch === '}' || ch === ']') {
        if (stack.length > 0) stack.pop();
      }
    }
  }

  if (inString) {
    s += '"';
  }

  // Remove trailing dangling colons or commas
  s = s.replace(/:\s*$/, ': null').replace(/,\s*$/, '');

  while (stack.length > 0) {
    const open = stack.pop();
    if (open === '{') s += '}';
    else if (open === '[') s += ']';
  }

  return s;
}

export function cleanAndParseJson(rawText) {
  let cleaned = String(rawText || '').trim();

  // Strip markdown ```json ... ``` fences if present
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }

  // Protect single-backslash LaTeX commands that collide with JSON escape sequences (\n, \t, \f, \b, \r)
  cleaned = cleaned.replace(
    /(?<!\\)\\(neg|neq|notin|ni(?![a-zA-Z])|nabla|natural|times|theta|tau|tan(?![a-zA-Z])|text|tfrac|triangle|therefore|to(?![a-zA-Z])|top(?![a-zA-Z])|frac|forall|binom|begin|beta|bar(?![a-zA-Z])|bigcup|bigcap|big(?![a-zA-Z])|bot(?![a-zA-Z])|bullet|rightarrow|leftrightarrow|right|rangle|rceil|rfloor|rho)/g,
    '\\\\$1'
  );
  // Protect any other single-backslash LaTeX commands (\cup, \cap, \in, \subset, \land, \lor, \Rightarrow, \sqrt, \{, \}, etc.) that are invalid JSON escapes
  cleaned = cleaned.replace(/(?<!\\)\\(?![/\\"bfnrt]|u[0-9a-fA-F]{4})/g, '\\\\');

  try {
    return JSON.parse(cleaned);
  } catch (firstErr) {
    // Fallback 1: extract outermost JSON object {...}
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      } catch {
        // Continue to truncation repair
      }
    }

    // Fallback 2: attempt repairing truncated JSON
    try {
      const repaired = repairTruncatedJson(cleaned);
      return JSON.parse(repaired);
    } catch {
      throw firstErr;
    }
  }
}

export async function countTokensSelectively({ model, contents }) {
  const ai = getGeminiClient();
  const config = getEnvConfig();
  const targetModel = model || config.geminiModel || 'gemini-4-hydrogen';
  const result = await ai.models.countTokens({
    model: targetModel,
    contents,
  });
  return result?.totalTokens ?? null;
}

export async function generateStructuredContent({
  taskType,
  contents,
  systemInstruction,
  responseSchema,
  zodSchema,
  thinkingLevel = null,
  enableGoogleSearch = false,
  model: modelOverride = null,
}) {
  const envConfig = getEnvConfig();
  const model = modelOverride || envConfig.geminiModel || 'gemini-4-hydrogen';
  const maxOutputTokens = getMaxOutputTokensForTask(taskType);
  const effectiveThinkingLevel = thinkingLevel || envConfig.geminiThinkingLevel;
  const thinkingConfig = buildThinkingConfig(model, effectiveThinkingLevel);

  const generationConfig = {
    maxOutputTokens,
    responseMimeType: 'application/json',
  };

  if (responseSchema) {
    generationConfig.responseSchema = responseSchema;
  }

  if (systemInstruction) {
    generationConfig.systemInstruction = systemInstruction;
  }

  if (thinkingConfig) {
    generationConfig.thinkingConfig = thinkingConfig;
  }

  const useSearch = Boolean(enableGoogleSearch && envConfig.aiEnableGoogleSearch);
  if (useSearch) {
    generationConfig.tools = [{ googleSearch: {} }];
  }

  const pool = defaultApiKeyPool;
  const keys = pool.getKeys();
  if (keys.length === 0) {
    const err = new Error('GEMINI_API_KEY belum dikonfigurasi di .env');
    err.status = 401;
    throw err;
  }

  const maxAttempts = Math.max(1, keys.length);
  let lastErr = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const keyInfo = pool.getActiveKeyInfo();
    const ai = pool.getClientForKey(keyInfo.key);

    let response;
    try {
      try {
        response = await ai.models.generateContent({
          model,
          contents,
          config: generationConfig,
        });
      } catch (err) {
        const errMsg = String(err?.message || '').toLowerCase();
        if (
          useSearch &&
          generationConfig.responseSchema &&
          (errMsg.includes('response_schema') ||
            errMsg.includes('response schema') ||
            errMsg.includes('grounding') ||
            errMsg.includes('not supported with'))
        ) {
          const fallbackConfig = { ...generationConfig };
          delete fallbackConfig.responseSchema;
          response = await ai.models.generateContent({
            model,
            contents,
            config: fallbackConfig,
          });
        } else {
          throw err;
        }
      }
    } catch (apiErr) {
      lastErr = apiErr;
      const status =
        Number(apiErr?.status || apiErr?.httpStatus || apiErr?.statusCode || apiErr?.code) || null;
      const errMsg = String(apiErr?.message || '').toLowerCase();
      const isQuotaOrRateLimit =
        status === 429 ||
        errMsg.includes('quota') ||
        errMsg.includes('resource_exhausted') ||
        errMsg.includes('rate_limit') ||
        errMsg.includes('rate limit');
      const isAuthOrKeyError =
        status === 401 ||
        status === 403 ||
        errMsg.includes('api_key_invalid') ||
        errMsg.includes('permission_denied') ||
        errMsg.includes('api key not valid');

      if ((isQuotaOrRateLimit || isAuthOrKeyError) && keys.length > 1 && attempt < maxAttempts - 1) {
        const isDaily =
          errMsg.includes('per day') || errMsg.includes('daily') || errMsg.includes('rpd');
        const cooldownMs = isAuthOrKeyError || isDaily ? 60 * 60 * 1000 : 30 * 1000;
        const reason = isAuthOrKeyError
          ? 'key tidak valid / 403'
          : isDaily
            ? 'kuota harian habis (RPD)'
            : 'rate limit sementara (RPM)';
        console.warn(
          `[geminiClient] API Key #${keyInfo.index + 1}/${keyInfo.total} (${maskApiKey(keyInfo.key)}) terkena ${reason}. Beralih otomatis ke API key #${((keyInfo.index + 1) % keyInfo.total) + 1}...`
        );
        pool.markCooldown(keyInfo.key, cooldownMs);
        continue;
      }

      // If all keys exhausted quota on gemini-3-flash-preview, fallback to gemini-2.5-flash (separate RPD bucket per key)
      if (isQuotaOrRateLimit && !modelOverride && model !== 'gemini-2.5-flash') {
        console.warn(
          `[geminiClient] Seluruh API key kehabisan kuota pada model ${model}. Beralih otomatis ke model cadangan gemini-2.5-flash...`
        );
        pool.cooldowns.clear();
        return generateStructuredContent({
          taskType,
          contents,
          systemInstruction,
          responseSchema,
          zodSchema,
          thinkingLevel,
          enableGoogleSearch,
          model: 'gemini-2.5-flash',
        });
      }

      throw apiErr;
    }

    pool.markSuccess(keyInfo.key);

    const usageMetadata = response?.usageMetadata || null;
    const rawText = typeof response?.text === 'string' ? response.text : '';

    if (!rawText.trim()) {
      const err = new Error('Model AI mengembalikan respons kosong.');
      err.errorCode = 'OUTPUT_SCHEMA_INVALID';
      err.usageMetadata = usageMetadata;
      throw err;
    }

    let parsedJson;
    try {
      parsedJson = cleanAndParseJson(rawText);
    } catch (parseErr) {
      const err = new Error(`Output AI bukan JSON valid: ${parseErr.message}`);
      err.errorCode = 'OUTPUT_SCHEMA_INVALID';
      err.usageMetadata = usageMetadata;
      throw err;
    }

    if (zodSchema) {
      try {
        parsedJson = zodSchema.parse(parsedJson);
      } catch (zodErr) {
        const issuesSummary = Array.isArray(zodErr?.issues)
          ? zodErr.issues.map((i) => `${(i.path || []).join('.')}: ${i.message}`).join('; ')
          : zodErr.message;
        const err = new Error(`Validasi skema gagal: ${issuesSummary}`);
        err.errorCode = 'OUTPUT_SCHEMA_INVALID';
        err.usageMetadata = usageMetadata;
        throw err;
      }
    }

    return {
      data: parsedJson,
      usageMetadata,
      model,
      searchGroundingUsed: useSearch,
      activeKeyIndex: keyInfo.index,
      totalKeys: keyInfo.total,
    };
  }

  throw lastErr;
}
