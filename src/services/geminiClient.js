import { GoogleGenAI } from '@google/genai';
import { getEnvConfig } from '../config/env.js';

let clientInstance = null;
let cachedApiKey = null;

export function getGeminiClient() {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    const err = new Error('GEMINI_API_KEY belum dikonfigurasi di .env');
    err.status = 401;
    throw err;
  }

  if (!clientInstance || cachedApiKey !== apiKey) {
    cachedApiKey = apiKey;
    clientInstance = new GoogleGenAI({ apiKey });
  }

  return clientInstance;
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

  if (model.includes('gemini-3')) {
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

export function cleanAndParseJson(rawText) {
  let cleaned = String(rawText || '').trim();

  // Strip markdown ```json ... ``` fences if present
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }

  try {
    return JSON.parse(cleaned);
  } catch (firstErr) {
    // Fallback: extract outermost JSON object {...}
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    }
    throw firstErr;
  }
}

export async function countTokensSelectively({ model, contents }) {
  const ai = getGeminiClient();
  const config = getEnvConfig();
  const targetModel = model || config.geminiModel || 'gemini-3.5-flash';
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
}) {
  const ai = getGeminiClient();
  const envConfig = getEnvConfig();
  const model = envConfig.geminiModel || 'gemini-3.5-flash';
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

  let response;
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
  };
}
