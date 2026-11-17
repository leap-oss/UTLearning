import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { getEnvConfig, parseApiKeys, DEFAULT_GEMINI_MODEL_CHAIN } from '../config/env.js';

export function maskApiKey(key) {
  if (!key || key.length <= 8) return '***';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

export class GeminiApiKeyPool {
  constructor() {
    this.keys = [];
    this.currentIndex = 0;
    this.clientCache = new Map();
    this.cooldowns = new Map(); // `${model}::${key}` or key -> number (timestamp)
  }

  _cooldownKey(key, model = '*') {
    return `${model || '*'}::${key}`;
  }

  _getCooldownUntil(key, model = '*') {
    const now = Date.now();
    const globalCd = this.cooldowns.get(this._cooldownKey(key, '*')) || this.cooldowns.get(key) || 0;
    const modelCd = model && model !== '*' ? this.cooldowns.get(this._cooldownKey(key, model)) || 0 : 0;
    const maxCd = Math.max(globalCd, modelCd);
    return maxCd > now ? maxCd : 0;
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

  getActiveKeyInfo(model = '*') {
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
      const cooldownUntil = this._getCooldownUntil(key, model);
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
      const cd = this._getCooldownUntil(this.keys[i], model);
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

  markCooldown(key, durationMs = 60000, model = '*') {
    const until = Date.now() + durationMs;
    this.cooldowns.set(this._cooldownKey(key, model), until);
    if (!model || model === '*') {
      this.cooldowns.set(key, until);
    }
    if (this.keys.length > 1) {
      this.currentIndex = (this.currentIndex + 1) % this.keys.length;
    }
  }

  markSuccess(key, model = '*') {
    this.cooldowns.delete(this._cooldownKey(key, model));
    this.cooldowns.delete(this._cooldownKey(key, '*'));
    this.cooldowns.delete(key);
    // Round-robin advance so consecutive calls spread RPM/RPD evenly across all keys
    if (this.keys.length > 1) {
      const idx = this.keys.indexOf(key);
      if (idx !== -1) {
        this.currentIndex = (idx + 1) % this.keys.length;
      }
    }
  }

  areAllKeysOnCooldown(model = '*') {
    this.sync();
    if (this.keys.length === 0) return false;
    const now = Date.now();
    return this.keys.every((key) => this._getCooldownUntil(key, model) > now);
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

function extractResponseTextAndDiagnostics(response) {
  let rawText = typeof response?.text === 'string' ? response.text : '';
  const candidates = Array.isArray(response?.candidates) ? response.candidates : [];
  const firstCandidate = candidates[0] || null;
  const finishReason = firstCandidate?.finishReason || null;
  const blockReason = response?.promptFeedback?.blockReason || null;

  if (!rawText.trim() && Array.isArray(firstCandidate?.content?.parts)) {
    const fallbackText = firstCandidate.content.parts
      .filter((part) => typeof part?.text === 'string' && part.thought !== true)
      .map((part) => part.text)
      .join('');
    if (fallbackText.trim()) {
      rawText = fallbackText;
    }
  }

  const diagnosticParts = [];
  if (blockReason) diagnosticParts.push(`blockReason=${blockReason}`);
  if (finishReason) diagnosticParts.push(`finishReason=${finishReason}`);
  if (candidates.length === 0) diagnosticParts.push('candidates=0');

  return {
    rawText,
    finishReason,
    blockReason,
    diagnosticSuffix: diagnosticParts.length > 0 ? ` (${diagnosticParts.join(', ')})` : '',
  };
}

function classifyGeminiCallFailure(err) {
  const status = Number(err?.status || err?.httpStatus || err?.statusCode || err?.code) || null;
  const errMsg = String(err?.message || '').toLowerCase();

  if (err?.errorCode === 'OUTPUT_SCHEMA_INVALID' || err?.name === 'ZodError') {
    return { kind: 'output_invalid', status };
  }

  if (
    status === 401 ||
    status === 403 ||
    errMsg.includes('api_key_invalid') ||
    errMsg.includes('permission_denied') ||
    errMsg.includes('api key not valid')
  ) {
    return { kind: 'auth_error', status };
  }

  if (
    status === 429 ||
    errMsg.includes('quota') ||
    errMsg.includes('resource_exhausted') ||
    errMsg.includes('rate_limit') ||
    errMsg.includes('rate limit')
  ) {
    const isDaily =
      errMsg.includes('per day') ||
      errMsg.includes('per_day') ||
      errMsg.includes('perday') ||
      errMsg.includes('daily') ||
      errMsg.includes('rpd');
    return { kind: isDaily ? 'daily_quota' : 'rate_limit', status };
  }

  if (status === 404 || errMsg.includes('not found') || errMsg.includes('not supported')) {
    return { kind: 'model_unavailable', status };
  }

  if (
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    errMsg.includes('overloaded') ||
    errMsg.includes('unavailable') ||
    errMsg.includes('internal') ||
    errMsg.includes('deadline_exceeded') ||
    errMsg.includes('timeout') ||
    errMsg.includes('econnreset') ||
    errMsg.includes('fetch failed')
  ) {
    return { kind: 'transient_server', status };
  }

  return { kind: 'fatal', status };
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
  const maxOutputTokens = getMaxOutputTokensForTask(taskType);
  const effectiveThinkingLevel = thinkingLevel || envConfig.geminiThinkingLevel;
  const useSearch = Boolean(enableGoogleSearch && envConfig.aiEnableGoogleSearch);

  const pool = defaultApiKeyPool;
  const keys = pool.getKeys();
  if (keys.length === 0) {
    const err = new Error('GEMINI_API_KEY belum dikonfigurasi di .env');
    err.status = 401;
    throw err;
  }

  const candidateModels = modelOverride
    ? [modelOverride]
    : Array.isArray(envConfig.geminiFallbackModels) && envConfig.geminiFallbackModels.length > 0
      ? envConfig.geminiFallbackModels
      : DEFAULT_GEMINI_MODEL_CHAIN;

  const maxAttemptsPerModel = Math.max(1, keys.length);
  let lastErr = null;

  for (let mIdx = 0; mIdx < candidateModels.length; mIdx++) {
    const model = candidateModels[mIdx];
    const hasMoreModels = mIdx < candidateModels.length - 1;

    // Skip a model whose keys are ALL already on cooldown if a fresher fallback model is available
    if (hasMoreModels && pool.areAllKeysOnCooldown(model)) {
      const hasReadyFallback = candidateModels
        .slice(mIdx + 1)
        .some((candidate) => !pool.areAllKeysOnCooldown(candidate));
      if (hasReadyFallback) {
        continue;
      }
    }

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
    if (useSearch) {
      generationConfig.tools = [{ googleSearch: {} }];
    }

    let shouldFailoverToNextModel = false;

    for (let attempt = 0; attempt < maxAttemptsPerModel; attempt++) {
      const keyInfo = pool.getActiveKeyInfo(model);
      const ai = pool.getClientForKey(keyInfo.key);
      // On final fallback model, allow 1 retry without strict responseSchema if strict schema returned empty/invalid
      const activeConfig =
        !hasMoreModels && attempt > 0 && generationConfig.responseSchema && lastErr?.errorCode === 'OUTPUT_SCHEMA_INVALID'
          ? (() => {
              const relaxed = { ...generationConfig };
              delete relaxed.responseSchema;
              return relaxed;
            })()
          : generationConfig;

      try {
        let response;
        try {
          response = await ai.models.generateContent({
            model,
            contents,
            config: activeConfig,
          });
        } catch (callErr) {
          const callMsg = String(callErr?.message || '').toLowerCase();
          if (
            useSearch &&
            activeConfig.responseSchema &&
            (callMsg.includes('response_schema') ||
              callMsg.includes('response schema') ||
              callMsg.includes('grounding') ||
              callMsg.includes('not supported with'))
          ) {
            const fallbackConfig = { ...activeConfig };
            delete fallbackConfig.responseSchema;
            response = await ai.models.generateContent({
              model,
              contents,
              config: fallbackConfig,
            });
          } else {
            throw callErr;
          }
        }

        const usageMetadata = response?.usageMetadata || null;
        const { rawText, finishReason, blockReason, diagnosticSuffix } =
          extractResponseTextAndDiagnostics(response);

        if (!rawText.trim()) {
          const err = new Error(`Model AI mengembalikan respons kosong${diagnosticSuffix}.`);
          err.errorCode = 'OUTPUT_SCHEMA_INVALID';
          err.isEmptyResponse = true;
          err.finishReason = finishReason;
          err.blockReason = blockReason;
          err.usageMetadata = usageMetadata;
          err.model = model;
          throw err;
        }

        let parsedJson;
        try {
          parsedJson = cleanAndParseJson(rawText);
        } catch (parseErr) {
          const err = new Error(`Output AI bukan JSON valid: ${parseErr.message}`);
          err.errorCode = 'OUTPUT_SCHEMA_INVALID';
          err.usageMetadata = usageMetadata;
          err.model = model;
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
            err.model = model;
            throw err;
          }
        }

        // Only mark key healthy once output is non-empty, valid JSON, and passes Zod validation
        pool.markSuccess(keyInfo.key, model);

        return {
          data: parsedJson,
          usageMetadata,
          model,
          searchGroundingUsed: useSearch,
          activeKeyIndex: keyInfo.index,
          totalKeys: keyInfo.total,
        };
      } catch (attemptErr) {
        if (!attemptErr.model) {
          attemptErr.model = model;
        }
        lastErr = attemptErr;

        const { kind } = classifyGeminiCallFailure(attemptErr);

        if (kind === 'model_unavailable') {
          if (hasMoreModels) {
            shouldFailoverToNextModel = true;
            break;
          }
          throw attemptErr;
        }

        if (kind === 'auth_error' || kind === 'daily_quota' || kind === 'rate_limit') {
          const isAuth = kind === 'auth_error';
          const isDaily = kind === 'daily_quota';
          const cooldownMs = isAuth || isDaily ? 60 * 60 * 1000 : 30 * 1000;
          const reason = isAuth
            ? 'key tidak valid / 403'
            : isDaily
              ? 'kuota harian habis (RPD)'
              : 'rate limit sementara (RPM)';

          pool.markCooldown(keyInfo.key, cooldownMs, isAuth ? '*' : model);

          if (keys.length > 1 && attempt < maxAttemptsPerModel - 1) {
            console.warn(
              `[geminiClient] [${model}] API Key #${keyInfo.index + 1}/${keyInfo.total} (${maskApiKey(keyInfo.key)}) terkena ${reason}. Beralih otomatis ke API key #${((keyInfo.index + 1) % keyInfo.total) + 1}...`
            );
            continue;
          }

          if (hasMoreModels) {
            shouldFailoverToNextModel = true;
            break;
          }
          throw attemptErr;
        }

        if (kind === 'transient_server') {
          pool.markCooldown(keyInfo.key, 15 * 1000, model);
          const maxTransientKeyTries = hasMoreModels ? Math.min(2, maxAttemptsPerModel) : maxAttemptsPerModel;
          if (keys.length > 1 && attempt < maxTransientKeyTries - 1) {
            console.warn(
              `[geminiClient] [${model}] Gangguan sementara pada API Key #${keyInfo.index + 1}/${keyInfo.total}. Mencoba API key berikutnya...`
            );
            continue;
          }
          if (hasMoreModels) {
            shouldFailoverToNextModel = true;
            break;
          }
          throw attemptErr;
        }

        if (kind === 'output_invalid') {
          // Rotate key index without long lockouts, then immediately failover to next model tier
          pool.markCooldown(keyInfo.key, 15 * 1000, model);
          if (hasMoreModels) {
            console.warn(
              `[geminiClient] [${model}] Output kosong / tidak sesuai skema (${attemptErr.message}). Failover otomatis ke model "${candidateModels[mIdx + 1]}"...`
            );
            shouldFailoverToNextModel = true;
            break;
          }
          if (keys.length > 1 && attempt < Math.min(2, maxAttemptsPerModel) - 1) {
            console.warn(
              `[geminiClient] [${model}] Output kosong / tidak sesuai skema pada model terakhir. Mencoba API key berikutnya...`
            );
            continue;
          }
          throw attemptErr;
        }

        throw attemptErr;
      }
    }

    if (shouldFailoverToNextModel && hasMoreModels) {
      const nextModel = candidateModels[mIdx + 1];
      console.warn(
        `[geminiClient] Model "${model}" gagal atau kehabisan kuota. Failover otomatis ke model prioritas berikutnya: "${nextModel}"...`
      );
      continue;
    }
  }

  throw lastErr;
}
