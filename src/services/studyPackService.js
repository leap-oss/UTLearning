import { eq, asc, desc, and, ne } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import {
  courses,
  modules,
  sourceAssets,
  studyPacks,
  questionSets,
  questions,
} from '../db/schema.js';
import { getEnvConfig } from '../config/env.js';
import { buildCacheKey, computeSha256 } from './aiRetry.js';
import { generateStructuredContent } from './geminiClient.js';

function normalizeOptionKey(rawKey, indexFallback = 0) {
  const cleaned = String(rawKey || '')
    .trim()
    .toUpperCase()
    .replace(/^OPSI\s+/i, '')
    .replace(/^PILIHAN\s+/i, '')
    .replace(/[^A-Z0-9]/g, '');

  if (cleaned.length > 0) {
    return cleaned[0];
  }
  return ['A', 'B', 'C', 'D', 'E'][indexFallback] || 'A';
}

function normalizeDifficulty(val) {
  const v = String(val || 'medium').trim().toLowerCase();
  if (v.includes('easy') || v.includes('mudah') || v.includes('rendah') || v.includes('dasar')) {
    return 'easy';
  }
  if (
    v.includes('hard') ||
    v.includes('sulit') ||
    v.includes('sukar') ||
    v.includes('tinggi') ||
    v.includes('lanjut')
  ) {
    return 'hard';
  }
  return 'medium';
}

const sourceRefsSchema = z
  .array(z.string())
  .optional()
  .default([])
  .transform((arr) => {
    const cleaned = (arr || []).map((s) => String(s || '').trim()).filter(Boolean);
    return cleaned.length > 0 ? cleaned : ['Sumber Modul BMP'];
  });

export const mcqQuestionSchema = z
  .object({
    topicLabel: z
      .string()
      .optional()
      .default('Konsep Utama Modul')
      .transform((s) => (s && s.trim() ? s.trim() : 'Konsep Utama Modul')),
    learningObjective: z
      .string()
      .optional()
      .default('Memahami konsep utama modul')
      .transform((s) => (s && s.trim() ? s.trim() : 'Memahami konsep utama modul')),
    questionType: z
      .string()
      .optional()
      .default('single_choice')
      .transform((s) => {
        const val = String(s || '').toLowerCase().trim();
        if (['single_choice', 'multiple_choice', 'true_false', 'conceptual_application', 'scenario_based'].includes(val)) {
          return val;
        }
        return 'single_choice';
      }),
    prompt: z.string().trim().min(3, 'Pertanyaan terlalu pendek.'),
    options: z
      .array(
        z.union([
          z.object({
            key: z.string().optional().default(''),
            text: z.string().trim().min(1),
          }),
          z.string(),
        ])
      )
      .min(2)
      .max(6),
    correctOption: z.string().trim().min(1),
    explanation: z
      .string()
      .optional()
      .default('Berdasarkan materi sumber BMP pada modul ini.')
      .transform((s) =>
        s && s.trim().length >= 3
          ? s.trim()
          : 'Berdasarkan materi sumber BMP pada modul ini.'
      ),
    difficulty: z.string().optional().default('medium').transform(normalizeDifficulty),
    sourceRefs: sourceRefsSchema,
  })
  .transform((q) => {
    const normalizedOptions = [];
    const seenKeys = new Set();

    q.options.forEach((opt, idx) => {
      let key;
      let text;
      if (typeof opt === 'string') {
        const match = opt.trim().match(/^([A-Ea-e])[.)\s:-]+(.*)$/);
        key = match ? match[1].toUpperCase() : ['A', 'B', 'C', 'D', 'E'][idx] || 'A';
        text = match ? match[2].trim() : opt.trim();
      } else {
        key = normalizeOptionKey(opt.key, idx);
        text = String(opt.text || '').trim();
      }
      if (seenKeys.has(key)) {
        key = ['A', 'B', 'C', 'D', 'E'][idx] || String(idx + 1);
      }
      seenKeys.add(key);
      normalizedOptions.push({ key, text: text || `Pilihan ${key}` });
    });

    let normCorrect = normalizeOptionKey(q.correctOption, 0);
    if (!seenKeys.has(normCorrect)) {
      // Try matching by option text if AI returned the option text instead of the letter
      const rawCorrectLower = String(q.correctOption || '').trim().toLowerCase();
      const matchedOpt = normalizedOptions.find(
        (o) =>
          o.text.toLowerCase() === rawCorrectLower ||
          rawCorrectLower.startsWith(`${o.key.toLowerCase()}.`) ||
          rawCorrectLower.startsWith(`${o.key.toLowerCase()})`)
      );
      normCorrect = matchedOpt ? matchedOpt.key : normalizedOptions[0].key;
    }

    return {
      ...q,
      options: normalizedOptions,
      correctOption: normCorrect,
    };
  });

export const topicLearningMaterialSchema = z
  .object({
    topicLabel: z
      .string()
      .optional()
      .default('Topik Utama')
      .transform((s) => (s && s.trim() ? s.trim() : 'Topik Utama')),
    title: z.string().trim().optional(),
    learningObjectives: z.array(z.string().trim()).optional().default([]),
    sourceRefs: sourceRefsSchema,
    coreConcepts: z.array(z.string().trim()).optional().default([]),
    bmpSummary: z
      .string()
      .optional()
      .default('')
      .transform((s) => (s && s.trim() ? s.trim() : '')),
    detailedExplanation: z
      .string()
      .optional()
      .default('')
      .transform((s) => (s && s.trim() ? s.trim() : '')),
    conceptRelationships: z
      .array(
        z.object({
          conceptA: z.string().trim().min(1),
          conceptB: z.string().trim().min(1),
          relationship: z.string().trim().min(1),
        })
      )
      .optional()
      .default([]),
    comparisons: z
      .array(
        z.object({
          itemA: z.string().trim().min(1),
          itemB: z.string().trim().min(1),
          distinction: z.string().trim().min(1),
        })
      )
      .optional()
      .default([]),
    processesOrStages: z
      .array(
        z.object({
          stepNumber: z.number().int().optional().default(1),
          name: z.string().trim().min(1),
          description: z.string().trim().min(1),
        })
      )
      .optional()
      .default([]),
    examples: z
      .array(
        z.object({
          context: z.string().trim().min(1),
          illustration: z.string().trim().min(1),
          isAiGenerated: z.boolean().optional().default(false),
        })
      )
      .optional()
      .default([]),
    commonMisconceptions: z
      .array(
        z.object({
          misconception: z.string().trim().min(1),
          correction: z.string().trim().min(1),
        })
      )
      .optional()
      .default([]),
    keyTakeaways: z.array(z.string().trim()).optional().default([]),
    aiExplanation: z.string().trim().optional().default(''),
  })
  .transform((t) => {
    const detailed =
      t.detailedExplanation || t.bmpSummary || 'Uraian materi konsep dari sumber BMP.';
    const summary =
      t.bmpSummary || t.detailedExplanation || 'Intisari konsep dari sumber BMP.';
    return {
      ...t,
      topicLabel: t.topicLabel || t.title || 'Topik Utama',
      title: t.title || t.topicLabel || 'Topik Utama',
      bmpSummary: summary,
      detailedExplanation: detailed,
    };
  });

export const studyPackSynthesisSchema = z.object({
  schemaVersion: z.number().int().optional().default(2),
  title: z
    .string()
    .optional()
    .default('Materi Belajar Modul')
    .transform((s) => (s && s.trim().length >= 2 ? s.trim() : 'Materi Belajar Modul')),
  overview: z
    .string()
    .optional()
    .default('Ringkasan materi modul BMP.')
    .transform((s) => (s && s.trim().length > 0 ? s.trim() : 'Ringkasan materi modul BMP.')),
  moduleLearningObjectives: z.array(z.string().trim()).optional().default([]),
  topics: z.array(topicLearningMaterialSchema).min(1),
  glossary: z
    .array(
      z.object({
        term: z.string().trim().min(1),
        bmpDefinition: z
          .string()
          .optional()
          .default('')
          .transform((s) => (s && s.trim() ? s.trim() : 'Definisi berdasarkan sumber BMP.')),
        simpleAnalogy: z.string().trim().optional().default(''),
        sourceRefs: sourceRefsSchema,
      })
    )
    .optional()
    .default([]),
  formulasOrProcedures: z
    .array(
      z.object({
        title: z.string().trim().min(1),
        content: z.string().trim().min(1),
        sourceRefs: sourceRefsSchema,
      })
    )
    .optional()
    .default([]),
  coverageNotes: z.array(z.string()).optional().default([]),
  initialQuestions: z.array(mcqQuestionSchema).min(1).max(30),
});

export const practiceQuestionSetOutputSchema = z.object({
  schemaVersion: z.number().int().optional().default(1),
  title: z
    .string()
    .optional()
    .default('Latihan Tambahan Modul')
    .transform((s) => (s && s.trim().length >= 2 ? s.trim() : 'Latihan Tambahan Modul')),
  questions: z.array(mcqQuestionSchema).min(1).max(30),
});

export const STUDY_PACK_SYNTHESIS_JSON_SCHEMA = {
  type: 'OBJECT',
  required: ['title', 'overview', 'topics', 'glossary', 'coverageNotes', 'initialQuestions'],
  properties: {
    schemaVersion: { type: 'INTEGER' },
    title: { type: 'STRING' },
    overview: { type: 'STRING' },
    moduleLearningObjectives: { type: 'ARRAY', items: { type: 'STRING' } },
    topics: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        required: [
          'topicLabel',
          'bmpSummary',
          'detailedExplanation',
          'coreConcepts',
          'keyTakeaways',
          'sourceRefs',
        ],
        properties: {
          topicLabel: { type: 'STRING' },
          learningObjectives: { type: 'ARRAY', items: { type: 'STRING' } },
          sourceRefs: { type: 'ARRAY', items: { type: 'STRING' } },
          coreConcepts: { type: 'ARRAY', items: { type: 'STRING' } },
          bmpSummary: { type: 'STRING' },
          detailedExplanation: { type: 'STRING' },
          conceptRelationships: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              required: ['conceptA', 'conceptB', 'relationship'],
              properties: {
                conceptA: { type: 'STRING' },
                conceptB: { type: 'STRING' },
                relationship: { type: 'STRING' },
              },
            },
          },
          comparisons: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              required: ['itemA', 'itemB', 'distinction'],
              properties: {
                itemA: { type: 'STRING' },
                itemB: { type: 'STRING' },
                distinction: { type: 'STRING' },
              },
            },
          },
          processesOrStages: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              required: ['name', 'description'],
              properties: {
                stepNumber: { type: 'INTEGER' },
                name: { type: 'STRING' },
                description: { type: 'STRING' },
              },
            },
          },
          examples: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              required: ['context', 'illustration'],
              properties: {
                context: { type: 'STRING' },
                illustration: { type: 'STRING' },
                isAiGenerated: { type: 'BOOLEAN' },
              },
            },
          },
          commonMisconceptions: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              required: ['misconception', 'correction'],
              properties: {
                misconception: { type: 'STRING' },
                correction: { type: 'STRING' },
              },
            },
          },
          keyTakeaways: { type: 'ARRAY', items: { type: 'STRING' } },
          aiExplanation: { type: 'STRING' },
        },
      },
    },
    glossary: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        required: ['term', 'bmpDefinition', 'simpleAnalogy', 'sourceRefs'],
        properties: {
          term: { type: 'STRING' },
          bmpDefinition: { type: 'STRING' },
          simpleAnalogy: { type: 'STRING' },
          sourceRefs: { type: 'ARRAY', items: { type: 'STRING' } },
        },
      },
    },
    formulasOrProcedures: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        required: ['title', 'content', 'sourceRefs'],
        properties: {
          title: { type: 'STRING' },
          content: { type: 'STRING' },
          sourceRefs: { type: 'ARRAY', items: { type: 'STRING' } },
        },
      },
    },
    coverageNotes: {
      type: 'ARRAY',
      items: { type: 'STRING' },
    },
    initialQuestions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        required: [
          'topicLabel',
          'learningObjective',
          'questionType',
          'prompt',
          'options',
          'correctOption',
          'explanation',
          'difficulty',
          'sourceRefs',
        ],
        properties: {
          topicLabel: { type: 'STRING' },
          learningObjective: { type: 'STRING' },
          questionType: {
            type: 'STRING',
            enum: [
              'single_choice',
              'multiple_choice',
              'true_false',
              'conceptual_application',
              'scenario_based',
            ],
          },
          prompt: { type: 'STRING' },
          options: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              required: ['key', 'text'],
              properties: {
                key: { type: 'STRING' },
                text: { type: 'STRING' },
              },
            },
          },
          correctOption: { type: 'STRING' },
          explanation: { type: 'STRING' },
          difficulty: { type: 'STRING', enum: ['easy', 'medium', 'hard'] },
          sourceRefs: { type: 'ARRAY', items: { type: 'STRING' } },
        },
      },
    },
  },
};

export function validateAndAlignStudyPack(parsed, reviewedSources = []) {
  if (!parsed || !Array.isArray(parsed.topics)) {
    return parsed;
  }

  const topicMap = new Map();
  for (const t of parsed.topics) {
    if (t.topicLabel) {
      topicMap.set(t.topicLabel.toLowerCase().trim(), t);
    }
  }

  const validSourcePages = (reviewedSources || []).map((s) => `Halaman ${s.pageOrder}`);
  const fallbackSourceRef =
    validSourcePages.length > 0 ? [validSourcePages[0]] : ['Sumber Modul BMP'];

  for (const t of parsed.topics) {
    if (!t.sourceRefs || t.sourceRefs.length === 0) {
      t.sourceRefs = fallbackSourceRef;
    }
    if (!t.learningObjectives) t.learningObjectives = [];
    if (!t.coreConcepts) t.coreConcepts = [];
    if (!t.conceptRelationships) t.conceptRelationships = [];
    if (!t.comparisons) t.comparisons = [];
    if (!t.processesOrStages) t.processesOrStages = [];
    if (!t.examples) t.examples = [];
    if (!t.commonMisconceptions) t.commonMisconceptions = [];
    if (!t.keyTakeaways) t.keyTakeaways = [];
  }

  if (Array.isArray(parsed.initialQuestions)) {
    for (const q of parsed.initialQuestions) {
      const qTopicNorm = (q.topicLabel || '').toLowerCase().trim();
      let matchedTopic = topicMap.get(qTopicNorm);

      if (!matchedTopic) {
        matchedTopic = parsed.topics.find(
          (t) =>
            t.topicLabel.toLowerCase().includes(qTopicNorm) ||
            qTopicNorm.includes(t.topicLabel.toLowerCase())
        );
      }

      if (!matchedTopic && parsed.topics.length > 0) {
        matchedTopic = parsed.topics[0];
        q.topicLabel = matchedTopic.topicLabel;
      }

      if (matchedTopic) {
        if (!q.sourceRefs || q.sourceRefs.length === 0) {
          q.sourceRefs = matchedTopic.sourceRefs || fallbackSourceRef;
        }

        const STOPWORDS = new Set([
          'memahami', 'menjelaskan', 'mengidentifikasi', 'menganalisis', 'menerapkan',
          'membedakan', 'menguraikan', 'menyebutkan', 'konsep', 'pengertian', 'prinsip',
          'contoh', 'penerapan', 'model', 'layanan', 'dalam', 'untuk', 'yang', 'dari',
          'pada', 'dengan', 'atau', 'serta', 'antara', 'sebagai', 'melalui', 'dasar',
          'utama', 'penting', 'bagian', 'faktor', 'strategi', 'peran', 'fungsi',
        ]);

        const explanationText = (matchedTopic.detailedExplanation || '').toLowerCase();
        const objSnippet = (q.learningObjective || '').toLowerCase().trim();
        let isCovered = true;

        if (objSnippet) {
          if (explanationText.includes(objSnippet)) {
            isCovered = true;
          } else {
            const keywords = objSnippet
              .replace(/[^a-z0-9\s-]/gi, ' ')
              .split(/\s+/)
              .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
            if (keywords.length > 0) {
              const matchedCount = keywords.filter((kw) => explanationText.includes(kw)).length;
              isCovered =
                matchedCount >= Math.min(2, keywords.length) ||
                matchedCount / keywords.length >= 0.5;
            }
          }
        }

        if (
          q.learningObjective &&
          !matchedTopic.learningObjectives.includes(q.learningObjective) &&
          (!isCovered || matchedTopic.learningObjectives.length < 3)
        ) {
          matchedTopic.learningObjectives.push(q.learningObjective);
        }

        if (!isCovered && q.explanation) {
          matchedTopic.detailedExplanation += `\n\n${q.explanation}`;
          matchedTopic.bmpSummary = matchedTopic.detailedExplanation;
        }
      }
    }
  }

  return parsed;
}

export const PRACTICE_QUESTIONS_JSON_SCHEMA = {
  type: 'OBJECT',
  required: ['title', 'questions'],
  properties: {
    schemaVersion: { type: 'INTEGER' },
    title: { type: 'STRING' },
    questions: STUDY_PACK_SYNTHESIS_JSON_SCHEMA.properties.initialQuestions,
  },
};

async function getCompactPrerequisiteConcepts(courseId, currentModuleNumber) {
  const db = getDb();
  const prevModules = await db
    .select()
    .from(modules)
    .where(and(eq(modules.courseId, courseId), ne(modules.status, 'archived')))
    .orderBy(asc(modules.moduleNumber));

  const earlier = prevModules.filter((m) => m.moduleNumber < currentModuleNumber);
  if (earlier.length === 0) return [];

  const concepts = [];
  for (const mod of earlier.slice(-2)) {
    const [latestPack] = await db
      .select()
      .from(studyPacks)
      .where(eq(studyPacks.moduleId, mod.id))
      .orderBy(desc(studyPacks.version))
      .limit(1);

    if (latestPack?.summaryJson?.topics) {
      const topicNames = latestPack.summaryJson.topics
        .slice(0, 4)
        .map((t) => t.topicLabel);
      concepts.push({
        moduleNumber: mod.moduleNumber,
        moduleTitle: mod.title,
        topics: topicNames,
      });
    }
  }
  return concepts;
}

export const KB_MATERIAL_BATCH_JSON_SCHEMA = {
  type: 'OBJECT',
  required: ['topics', 'glossary'],
  properties: {
    topics: STUDY_PACK_SYNTHESIS_JSON_SCHEMA.properties.topics,
    glossary: STUDY_PACK_SYNTHESIS_JSON_SCHEMA.properties.glossary,
    formulasOrProcedures: STUDY_PACK_SYNTHESIS_JSON_SCHEMA.properties.formulasOrProcedures,
  },
};

export const kbMaterialBatchSchema = z.object({
  topics: z.array(topicLearningMaterialSchema).min(1),
  glossary: z
    .array(
      z.object({
        term: z.string().trim().min(1),
        bmpDefinition: z.string().optional().default(''),
        simpleAnalogy: z.string().trim().optional().default(''),
        sourceRefs: sourceRefsSchema,
      })
    )
    .optional()
    .default([]),
  formulasOrProcedures: z
    .array(
      z.object({
        title: z.string().trim().min(1),
        content: z.string().trim().min(1),
        sourceRefs: sourceRefsSchema,
      })
    )
    .optional()
    .default([]),
});

export function detectModuleKbStructure(reviewedSources = []) {
  if (!Array.isArray(reviewedSources) || reviewedSources.length === 0) {
    return [];
  }

  const sorted = [...reviewedSources].sort((a, b) => (a.pageOrder || 0) - (b.pageOrder || 0));

  const classifiedPages = sorted.map((s, idx) => {
    const text = (
      (s.extractedContentJson?.extractedText || '') +
      ' ' +
      (s.extractedContentJson?.pageTitle || '')
    ).toLowerCase();
    const tfMatch = text.match(/(?:tes\s*formatif|formatif)\s*([0-9]+)/i);
    const kbMatch = text.match(/(?:kegiatan\s*belajar|kb)\s*([0-9]+)/i);
    const tfNum = tfMatch ? Number.parseInt(tfMatch[1], 10) : null;
    const kbNum = kbMatch ? Number.parseInt(kbMatch[1], 10) : null;
    const isSummary = s.label === 'rangkuman' || /rangkuman/i.test(text);
    const isFormatif = s.label === 'tes_formatif' || /tes\s*formatif/i.test(text);

    return {
      index: idx,
      source: s,
      pageOrder: s.pageOrder,
      label: s.label,
      tfNum,
      kbNum,
      isSummary,
      isFormatif,
      textLength: (s.extractedContentJson?.extractedText || '').length,
    };
  });

  const detectedKbNums = new Set();
  classifiedPages.forEach((p) => {
    if (p.kbNum) detectedKbNums.add(p.kbNum);
    if (p.tfNum) detectedKbNums.add(p.tfNum);
  });

  if (detectedKbNums.size <= 1) {
    const totalChars = classifiedPages.reduce((sum, p) => sum + p.textLength, 0);
    return [
      {
        kbNumber: 1,
        title: 'Kegiatan Belajar 1',
        sources: sorted,
        pageRange: {
          start: sorted[0]?.pageOrder || 1,
          end: sorted[sorted.length - 1]?.pageOrder || 1,
        },
        hasSummary: classifiedPages.some((p) => p.isSummary),
        hasFormatif: classifiedPages.some((p) => p.isFormatif),
        totalChars,
      },
    ];
  }

  let currentKb = 1;
  const pageToKb = new Array(classifiedPages.length);

  for (let i = 0; i < classifiedPages.length; i++) {
    const p = classifiedPages[i];
    if (p.kbNum && p.kbNum > currentKb) {
      currentKb = p.kbNum;
    } else if (i > 0) {
      const prev = classifiedPages[i - 1];
      const prevWasFormatif = prev.isFormatif || prev.tfNum !== null;
      if (prevWasFormatif && (p.isSummary || p.label === 'rangkuman' || p.label === 'konsep_inti')) {
        currentKb += 1;
      }
    }
    if (p.tfNum && p.tfNum > currentKb) {
      currentKb = p.tfNum;
    }
    pageToKb[i] = currentKb;
  }

  const groupMap = new Map();
  classifiedPages.forEach((p, idx) => {
    const kb = pageToKb[idx];
    if (!groupMap.has(kb)) {
      groupMap.set(kb, []);
    }
    groupMap.get(kb).push(p.source);
  });

  const sortedKbs = Array.from(groupMap.keys()).sort((a, b) => a - b);
  return sortedKbs.map((kbNum) => {
    const kbSources = groupMap.get(kbNum);
    const totalChars = kbSources.reduce(
      (sum, s) => sum + (s.extractedContentJson?.extractedText?.length || 0),
      0
    );
    const hasSummary = kbSources.some(
      (s) => s.label === 'rangkuman' || /rangkuman/i.test(s.extractedContentJson?.extractedText || '')
    );
    const hasFormatif = kbSources.some(
      (s) =>
        s.label === 'tes_formatif' ||
        /tes\s*formatif/i.test(s.extractedContentJson?.extractedText || '')
    );
    return {
      kbNumber: kbNum,
      title: `Kegiatan Belajar ${kbNum}`,
      sources: kbSources,
      pageRange: {
        start: kbSources[0]?.pageOrder || 1,
        end: kbSources[kbSources.length - 1]?.pageOrder || 1,
      },
      hasSummary,
      hasFormatif,
      totalChars,
    };
  });
}

export function planKbBatches(kbStructure = [], options = {}) {
  const maxSafeCharsPerBatch = options.maxSafeCharsPerBatch || 35000;
  if (!Array.isArray(kbStructure) || kbStructure.length === 0) {
    return [];
  }

  const count = kbStructure.length;

  if (count === 1) {
    return [
      {
        batchIndex: 1,
        totalBatches: 1,
        kbs: kbStructure,
        isFinalBatch: true,
        splitReason: null,
      },
    ];
  }

  if (count === 2) {
    const totalChars = (kbStructure[0]?.totalChars || 0) + (kbStructure[1]?.totalChars || 0);
    if (totalChars > maxSafeCharsPerBatch) {
      return [
        {
          batchIndex: 1,
          totalBatches: 2,
          kbs: [kbStructure[0]],
          isFinalBatch: false,
          splitReason: `Kerapatan materi KB 1 & 2 (${totalChars} karakter) melampaui batas aman (${maxSafeCharsPerBatch}); dipisah agar materi tidak terkompresi.`,
        },
        {
          batchIndex: 2,
          totalBatches: 2,
          kbs: [kbStructure[1]],
          isFinalBatch: true,
          splitReason: null,
        },
      ];
    }
    return [
      {
        batchIndex: 1,
        totalBatches: 1,
        kbs: kbStructure,
        isFinalBatch: true,
        splitReason: null,
      },
    ];
  }

  if (count === 3) {
    const batch1Chars = (kbStructure[0]?.totalChars || 0) + (kbStructure[1]?.totalChars || 0);
    if (batch1Chars <= maxSafeCharsPerBatch) {
      return [
        {
          batchIndex: 1,
          totalBatches: 2,
          kbs: [kbStructure[0], kbStructure[1]],
          isFinalBatch: false,
          splitReason: null,
        },
        {
          batchIndex: 2,
          totalBatches: 2,
          kbs: [kbStructure[2]],
          isFinalBatch: true,
          splitReason: null,
        },
      ];
    }
    return [
      {
        batchIndex: 1,
        totalBatches: 3,
        kbs: [kbStructure[0]],
        isFinalBatch: false,
        splitReason: `Ukuran KB 1 & 2 (${batch1Chars} karakter) melebihi batas aman; dipartisi terarah.`,
      },
      {
        batchIndex: 2,
        totalBatches: 3,
        kbs: [kbStructure[1]],
        isFinalBatch: false,
        splitReason: null,
      },
      {
        batchIndex: 3,
        totalBatches: 3,
        kbs: [kbStructure[2]],
        isFinalBatch: true,
        splitReason: null,
      },
    ];
  }

  const mid = Math.ceil(count / 2);
  const part1 = kbStructure.slice(0, mid);
  const part2 = kbStructure.slice(mid);
  const part1Chars = part1.reduce((sum, kb) => sum + (kb.totalChars || 0), 0);
  const part2Chars = part2.reduce((sum, kb) => sum + (kb.totalChars || 0), 0);

  if (part1Chars <= maxSafeCharsPerBatch && part2Chars <= maxSafeCharsPerBatch) {
    return [
      {
        batchIndex: 1,
        totalBatches: 2,
        kbs: part1,
        isFinalBatch: false,
        splitReason: null,
      },
      {
        batchIndex: 2,
        totalBatches: 2,
        kbs: part2,
        isFinalBatch: true,
        splitReason: null,
      },
    ];
  }

  return kbStructure.map((kb, idx) => ({
    batchIndex: idx + 1,
    totalBatches: kbStructure.length,
    kbs: [kb],
    isFinalBatch: idx === kbStructure.length - 1,
    splitReason: `Kerapatan modul (${part1Chars + part2Chars} karakter) melampaui batas aman; dibagi per KB secara independen demi kualitas.`,
  }));
}

export function validateStudyPackCoverage(studyPack, reviewedSources = [], kbStructure = []) {
  const issues = [];
  const coveredKbs = new Set();
  const allTopics = studyPack?.topics || [];

  for (const kb of kbStructure) {
    const kbLabel = `kegiatan belajar ${kb.kbNumber}`;
    const matched = allTopics.some(
      (t) =>
        (t.topicLabel && t.topicLabel.toLowerCase().includes(kbLabel)) ||
        (t.title && t.title.toLowerCase().includes(kbLabel)) ||
        (kbStructure.length === 1 && allTopics.length >= 1)
    );
    if (matched) {
      coveredKbs.add(kb.kbNumber);
    } else {
      issues.push(`KB ${kb.kbNumber} belum memiliki topik yang sesuai di Study Pack.`);
    }
  }

  const referencedPages = new Set();
  const checkSourceRefs = (refs) => {
    if (Array.isArray(refs)) {
      refs.forEach((r) => {
        const m = String(r).match(/halaman\s*([0-9]+)/i);
        if (m) referencedPages.add(Number.parseInt(m[1], 10));
      });
    }
  };

  allTopics.forEach((t) => {
    checkSourceRefs(t.sourceRefs);
    (t.learningObjectives || []).forEach(checkSourceRefs);
  });
  (studyPack?.glossary || []).forEach((g) => checkSourceRefs(g.sourceRefs));
  (studyPack?.initialQuestions || []).forEach((q) => checkSourceRefs(q.sourceRefs));

  const totalSourcePages = reviewedSources.map((s) => s.pageOrder);
  const unmappedPages = totalSourcePages.filter((p) => !referencedPages.has(p));
  if (unmappedPages.length > 0) {
    issues.push(`Halaman sumber berikut belum dirujuk: ${unmappedPages.join(', ')}`);
  }

  let totalFormatifQuestions = 0;
  let coveredFormatifQuestions = 0;
  const missingQuestionPrompts = [];

  const fullTopicText = allTopics
    .map(
      (t) =>
        `${t.topicLabel || ''} ${t.detailedExplanation || ''} ${t.bmpSummary || ''} ${(t.coreConcepts || []).join(' ')}`
    )
    .join(' ')
    .toLowerCase();

  for (const s of reviewedSources) {
    const tqs = s.extractedContentJson?.transcribedQuestions || [];
    for (const tq of tqs) {
      totalFormatifQuestions++;
      const words = (tq.prompt || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 4);

      const matchedWords = words.filter((w) => fullTopicText.includes(w));
      const isRepresented = words.length === 0 || matchedWords.length / words.length >= 0.3;

      if (isRepresented) {
        coveredFormatifQuestions++;
      } else {
        missingQuestionPrompts.push(tq.prompt.slice(0, 60));
      }
    }
  }

  const kbCoverageScore = kbStructure.length > 0 ? (coveredKbs.size / kbStructure.length) * 40 : 40;
  const pageCoverageScore =
    totalSourcePages.length > 0
      ? ((totalSourcePages.length - unmappedPages.length) / totalSourcePages.length) * 30
      : 30;
  const questionCoverageScore =
    totalFormatifQuestions > 0
      ? (coveredFormatifQuestions / totalFormatifQuestions) * 30
      : 30;

  const coverageScore = Math.round(kbCoverageScore + pageCoverageScore + questionCoverageScore);

  return {
    coverageScore,
    totalKbsDetected: kbStructure.length,
    kbsCovered: coveredKbs.size,
    totalPages: totalSourcePages.length,
    pagesMapped: totalSourcePages.length - unmappedPages.length,
    unmappedPages,
    totalFormatifQuestions,
    coveredFormatifQuestions,
    missingItems: issues,
    validationPassed: coverageScore >= 80 && (kbStructure.length === 0 || coveredKbs.size === kbStructure.length),
  };
}

function formatSourceBlocks(sources = []) {
  return sources
    .map((s) => {
      const ext = s.extractedContentJson || {};
      const sectionsText = (ext.sections || [])
        .map((sec) => `[${sec.heading}]: ${sec.content}`)
        .join('\n');
      const questionsText = (ext.transcribedQuestions || [])
        .map((tq, idx) => {
          const opts = (tq.options || []).map((o) => `${o.key}. ${o.text}`).join(' | ');
          return `Soal ${idx + 1}: ${tq.prompt}${opts ? `\n   Opsi: ${opts}` : ''}${tq.answerHint ? `\n   Petunjuk: ${tq.answerHint}` : ''}`;
        })
        .join('\n');
      return `--- SUMBER [sourceId=${s.id} | Halaman=${s.pageOrder} | Label=${s.label} | File=${s.fileName}] ---
Judul Halaman: ${ext.pageTitle || '-'}
Teks Utama:
${ext.extractedText || ''}
${sectionsText ? `Bagian Teks:\n${sectionsText}\n` : ''}${questionsText ? `Butir Soal Tes Formatif Terdeteksi:\n${questionsText}\n` : ''}Istilah Kunci: ${(ext.keyTerms || []).join(', ') || '-'}
Rumus/Tabel: ${(ext.formulasOrTables || []).join('; ') || '-'}`;
    })
    .join('\n\n');
}

export function buildSystemInstruction({ isFinalBatch, totalQuestionCount, kbTitles }) {
  const qDirective = isFinalBatch
    ? `5. KESELARASAN PEDAGOGIS DENGAN SOAL (PEDAGOGICAL ALIGNMENT):
   - Rancang ${totalQuestionCount} butir soal latihan awal ("initialQuestions") yang representatif dan proporsional mencakup seluruh Kegiatan Belajar modul: ${kbTitles}.
   - Seluruh soal WAJIB bersumber dan DAPAT DIJAWAB dari penjelasan yang telah ditulis di "detailedExplanation", "coreConcepts", atau "glossary".
   - Setiap butir soal harus memiliki "topicLabel", "learningObjective", "questionType" ('single_choice', 'conceptual_application', 'scenario_based'), "difficulty", "sourceRefs", dan "explanation".
   - Distribusikan butir soal secara seimbang menguji penerapan konseptual dan pemahaman mendalam, bukan sekadar hafalan.`
    : `5. FOKUS KELENGKAPAN MATERI: Hasilkan seluruh topik dan glosarium secara mendalam tanpa melewatkan konsep apapun.`;

  return `Anda adalah kurator dan arsitek penyusun bahan belajar komprehensif Universitas Terbuka (BMP) yang berfokus pada ketuntasan pemahaman mandiri mahasiswa.

PRINSIP WAJIB:
1. JANGAN MERINGKAS TERLALU PENDEK: Mahasiswa belajar mandiri menggunakan bahan ini. Setiap topik WAJIB diuraikan secara mendalam dan jelas (minimal 4-5 paragraf naratif yang komprehensif per topik di "detailedExplanation"), bukan sekadar ringkasan permukaan.
2. BEDAH TUNTAS & REVERSE-ENGINEERING SELURUH SOAL TES FORMATIF (100% CAKUPAN WAJIB):
   - Mahasiswa sering kali HANYA mengunggah halaman "Rangkuman" dan "Tes Formatif" (tanpa mengunggah puluhan halaman isi bab).
   - Oleh karena itu, banyak konsep spesifik yang diujikan di soal "Tes Formatif" TIDAK tertulis di halaman "Rangkuman" singkat.
   - Anda WAJIB membedah SETIAP butir soal yang ada di seluruh halaman Tes Formatif pada KB ini dan mengubahnya menjadi materi pembelajaran utuh di dalam "detailedExplanation", "coreConcepts", "comparisons", "commonMisconceptions", dan "glossary"!
   - DILARANG MELEWATKAN SATU PUN konsep dari nomor soal Tes Formatif yang diunggah.
   - Untuk soal berbentuk pengecualian ("...kecuali..."), uraikan secara eksplisit seluruh faktor/unsur yang benar DAN jelaskan mengapa opsi pengecoh tersebut dikecualikan (masukkan ke "detailedExplanation" dan "commonMisconceptions").
   - Untuk soal yang memiliki opsi istilah teknis berbeda pada pilihan A/B/C/D, jelaskan definisi dan pembeda masing-masing istilah tersebut di "detailedExplanation", "comparisons", atau "glossary" sehingga mahasiswa memahami seluruh opsi.
3. PEMISAHAN KONTEN OTENTIK BMP VS BANTUAN AI:
   - "bmpSummary", "detailedExplanation", "coreConcepts", "comparisons", "processesOrStages": Berisi sintesis lengkap dari halaman Rangkuman DAN hasil bedah konsep seluruh butir soal Tes Formatif BMP. Pertahankan istilah asli BMP.
   - "aiExplanation", "simpleAnalogy", "examples" (dengan isAiGenerated=true): Berisi analogi bahasa manusiawi, perumpamaan sehari-hari, dan contoh penerapan konkret untuk mempermudah pemahaman mahasiswa.
4. STRUKTUR MATERI PER TOPIK (PISAHKAN PER KEGIATAN BELAJAR):
   - "topicLabel": Judul Kegiatan Belajar yang jelas (misal: "Kegiatan Belajar 1: ...").
   - "learningObjectives": 3-5 sasaran pembelajaran spesifik yang merangkum Rangkuman & Tes Formatif KB tersebut.
   - "coreConcepts": Seluruh konsep/definisi kunci dari Rangkuman & seluruh nomor Tes Formatif.
   - "detailedExplanation": Uraian penjelasan mendalam (4-6 paragraf terstruktur yang mencakup semua konsep di Rangkuman + semua materi yang ditanyakan pada setiap nomor soal Tes Formatif).
   - "conceptRelationships": Keterhubungan atau ketergantungan antar konsep.
   - "comparisons": Perbandingan terstruktur (itemA, itemB, distinction) untuk istilah-istilah yang berpotensi tertukar di soal Tes Formatif.
   - "processesOrStages": Alur langkah, evolusi era, atau tahapan prosedural/manajemen.
   - "commonMisconceptions": Miskonsepsi umum dan jebakan pengecualian ("kecuali") dari soal Tes Formatif beserta klarifikasi benarnya menurut BMP.
   - "keyTakeaways": Poin-poin kesimpulan esensial yang lengkap.
${qDirective}
6. REFERENSI SUMBER ("sourceRefs"):
   - Cantumkan referensi halaman BMP yang relevan (contoh: ["Halaman 1", "Halaman 3"]) pada setiap topik, istilah glosarium, dan butir soal.`;
}

export async function defaultTwoStageStudyPackSynthesizer({
  courseRecord,
  moduleRecord,
  reviewedSources,
  prerequisiteConcepts = [],
  questionCount = 10,
}) {
  const kbStructure = detectModuleKbStructure(reviewedSources);
  const batches = planKbBatches(kbStructure);

  const prereqText =
    prerequisiteConcepts.length > 0
      ? `\nKonteks Konsep Modul Sebelumnya (hanya sebagai jembatan konteks, BUKAN sumber soal modul ini):\n${JSON.stringify(prerequisiteConcepts)}`
      : '';

  const allKbTitles = kbStructure.map((kb) => `KB ${kb.kbNumber}: ${kb.title}`).join(', ');
  const batchResults = [];

  for (let bIdx = 0; bIdx < batches.length; bIdx++) {
    const batch = batches[bIdx];
    const batchSources = batch.kbs.flatMap((kb) => kb.sources);
    const batchKbTitles = batch.kbs.map((kb) => `Kegiatan Belajar ${kb.kbNumber}`).join(' & ');
    const sourceBlocks = formatSourceBlocks(batchSources);

    const isFinal = batch.isFinalBatch;
    const systemInstruction = buildSystemInstruction({
      isFinalBatch: isFinal,
      totalQuestionCount: questionCount,
      kbTitles: allKbTitles,
    });

    let previousContext = '';
    if (bIdx > 0 && batchResults.length > 0) {
      const prevTopicsSummary = batchResults
        .flatMap((r) => r.topics || [])
        .map((t) => `- ${t.topicLabel}: ${(t.coreConcepts || []).slice(0, 5).join(', ')}`)
        .join('\n');
      previousContext = `\nTopik yang sudah berhasil disintesis pada batch sebelumnya:\n${prevTopicsSummary}\n`;
    }

    const prompt = `Mata Kuliah: ${courseRecord?.code || ''} - ${courseRecord?.name || ''}
Modul ${moduleRecord.moduleNumber}: ${moduleRecord.title}${prereqText}
Batch Sintesis: ${bIdx + 1} dari ${batches.length} (Fokus: ${batchKbTitles})
${previousContext}
Materi Sumber Terverifikasi BMP untuk Batch Ini:
${sourceBlocks}

Instruksi Khusus Batch ${bIdx + 1}:
1. Inventarisasi menyeluruh paragraf Rangkuman dan seluruh butir soal Tes Formatif pada sumber batch ini.
2. Susun topik bahan belajar yang lengkap dan mendalam terpisah per Kegiatan Belajar (${batchKbTitles}).
3. Dilarang melewatkan satupun konsep, faktor, atau pengecualian ("kecuali...") dari butir soal Tes Formatif.
${
  isFinal
    ? `4. Rancang ${questionCount} butir soal latihan awal ("initialQuestions") yang proporsional menguji seluruh Kegiatan Belajar pada modul ini (${allKbTitles}), selaras dengan materi yang telah disusun.`
    : '4. Fokus penuh pada penyusunan topik dan glosarium mendalam untuk batch ini.'
}

Hasilkan output dalam format JSON sesuai schema.`;

    const responseSchema = isFinal
      ? STUDY_PACK_SYNTHESIS_JSON_SCHEMA
      : KB_MATERIAL_BATCH_JSON_SCHEMA;
    const zodSchema = isFinal ? studyPackSynthesisSchema : kbMaterialBatchSchema;

    const aiRes = await generateStructuredContent({
      taskType: 'generate_study_pack',
      contents: prompt,
      systemInstruction,
      responseSchema,
      zodSchema,
      thinkingLevel: 'low',
      enableGoogleSearch: false,
    });

    batchResults.push(aiRes.data);
  }

  // Integrasikan seluruh hasil batch
  const integratedTopics = [];
  const integratedGlossaryMap = new Map();
  const integratedFormulas = [];
  let finalQuestions = [];
  let mainTitle = `Bahan Belajar Modul ${moduleRecord.moduleNumber}: ${moduleRecord.title}`;
  let mainOverview = `Bahan belajar komprehensif Modul ${moduleRecord.moduleNumber} UT.`;
  let moduleLearningObjectives = [];

  for (let i = 0; i < batchResults.length; i++) {
    const res = batchResults[i];
    if (res.title) mainTitle = res.title;
    if (res.overview) mainOverview = res.overview;
    if (Array.isArray(res.moduleLearningObjectives) && res.moduleLearningObjectives.length > 0) {
      moduleLearningObjectives.push(...res.moduleLearningObjectives);
    }
    if (Array.isArray(res.topics)) {
      integratedTopics.push(...res.topics);
    }
    if (Array.isArray(res.glossary)) {
      res.glossary.forEach((g) => {
        const normKey = (g.term || '').toLowerCase().trim();
        if (!integratedGlossaryMap.has(normKey)) {
          integratedGlossaryMap.set(normKey, g);
        } else {
          const existing = integratedGlossaryMap.get(normKey);
          if ((g.bmpDefinition || '').length > (existing.bmpDefinition || '').length) {
            existing.bmpDefinition = g.bmpDefinition;
          }
          if (Array.isArray(g.sourceRefs)) {
            existing.sourceRefs = Array.from(new Set([...(existing.sourceRefs || []), ...g.sourceRefs]));
          }
        }
      });
    }
    if (Array.isArray(res.formulasOrProcedures)) {
      integratedFormulas.push(...res.formulasOrProcedures);
    }
    if (Array.isArray(res.initialQuestions) && res.initialQuestions.length > 0) {
      finalQuestions = res.initialQuestions;
    }
  }

  // Jika initialQuestions belum dibuat (misal dari batch intermediate saja), buat fallback kuis proporsional
  if (finalQuestions.length === 0) {
    integratedTopics.forEach((t, tIdx) => {
      finalQuestions.push({
        topicLabel: t.topicLabel || `Kegiatan Belajar ${tIdx + 1}`,
        learningObjective: (t.learningObjectives && t.learningObjectives[0]) || `Memahami ${t.topicLabel}`,
        questionType: 'conceptual_application',
        prompt: `Berdasarkan materi ${t.topicLabel}, manakah pernyataan yang paling tepat mengenai konsep utama yang diuraikan?`,
        options: [
          { key: 'A', text: (t.coreConcepts && t.coreConcepts[0]) || 'Konsep inti sesuai BMP' },
          { key: 'B', text: 'Konsep yang bertentangan dengan materi modul' },
          { key: 'C', text: 'Pernyataan umum yang tidak relevan' },
          { key: 'D', text: 'Semua jawaban salah' },
        ],
        correctOption: 'A',
        explanation: `Pilihan A tepat karena merupakan konsep inti yang dibahas pada ${t.topicLabel}.`,
        difficulty: 'medium',
        sourceRefs: t.sourceRefs || ['Halaman 1'],
      });
    });
  }

  const coverageReport = validateStudyPackCoverage(
    { topics: integratedTopics, glossary: Array.from(integratedGlossaryMap.values()), initialQuestions: finalQuestions },
    reviewedSources,
    kbStructure
  );

  const coverageNotes = [
    `Deteksi Struktur: ${coverageReport.totalKbsDetected} Kegiatan Belajar terpetakan secara otomatis.`,
    `Kelengkapan Halaman: ${coverageReport.pagesMapped}/${coverageReport.totalPages} halaman sumber BMP terverifikasi.`,
    `Skor Cakupan Materi: ${coverageReport.coverageScore}% (${coverageReport.coveredFormatifQuestions}/${coverageReport.totalFormatifQuestions} butir konsep Tes Formatif terakomodasi).`,
  ];

  if (coverageReport.missingItems.length > 0) {
    coverageNotes.push(...coverageReport.missingItems);
  }

  const integratedPack = {
    schemaVersion: 2,
    title: mainTitle,
    overview: mainOverview,
    moduleLearningObjectives: Array.from(new Set(moduleLearningObjectives)),
    topics: integratedTopics,
    glossary: Array.from(integratedGlossaryMap.values()),
    formulasOrProcedures: integratedFormulas,
    coverageNotes,
    coverageReport,
    initialQuestions: finalQuestions,
  };

  const validated = validateAndAlignStudyPack(integratedPack, reviewedSources);
  return { data: validated };
}

export async function defaultStudyPackSynthesizer(params) {
  return defaultTwoStageStudyPackSynthesizer(params);
}

export async function enqueueStudyPackSynthesis({
  moduleId,
  idempotencyKey,
  questionCount = 5,
  regenerate = false,
  overrideBudget = false,
  aiQueue,
  synthesizerFn = defaultStudyPackSynthesizer,
}) {
  const db = getDb();
  const [mod] = await db
    .select()
    .from(modules)
    .where(eq(modules.id, moduleId))
    .limit(1);

  if (!mod || mod.status === 'archived') {
    const err = new Error('Modul tidak ditemukan atau sudah diarsipkan.');
    err.statusCode = 404;
    err.errorCode = 'MODULE_NOT_FOUND';
    throw err;
  }

  const [course] = await db
    .select()
    .from(courses)
    .where(eq(courses.id, mod.courseId))
    .limit(1);

  const sources = await db
    .select()
    .from(sourceAssets)
    .where(eq(sourceAssets.moduleId, moduleId))
    .orderBy(asc(sourceAssets.pageOrder), asc(sourceAssets.createdAt));

  const extractedSources = sources.filter(
    (s) =>
      s.extractedContentJson &&
      typeof s.extractedContentJson.extractedText === 'string' &&
      s.extractedContentJson.extractedText.trim().length > 0
  );

  if (extractedSources.length === 0) {
    const err = new Error(
      'Belum ada sumber BMP yang diekstrak pada modul ini. Unggah dan ekstrak foto BMP terlebih dahulu.'
    );
    err.statusCode = 400;
    err.errorCode = 'NO_EXTRACTED_SOURCES';
    throw err;
  }

  const unreviewed = extractedSources.filter((s) => s.needsReview);
  if (unreviewed.length > 0) {
    const err = new Error(
      `Masih ada ${unreviewed.length} halaman ekstraksi yang berstatus "Perlu Review". Periksa dan tandai selesai review sebelum membuat Study Pack.`
    );
    err.statusCode = 400;
    err.errorCode = 'SOURCES_NEED_REVIEW';
    throw err;
  }

  const boundedQuestionCount = Math.min(25, Math.max(3, Number(questionCount) || 10));
  const config = getEnvConfig();
  const model = config.geminiModel || 'gemini-3.5-flash';

  const sourceDigest = extractedSources.map((s) => ({
    id: s.id,
    pageOrder: s.pageOrder,
    label: s.label,
    textHash: computeSha256(s.extractedContentJson?.extractedText || ''),
  }));

  const cacheKey = buildCacheKey({
    operation: 'generate_study_pack',
    targetType: 'module',
    targetId: moduleId,
    inputChecksum: computeSha256({ sourceDigest, boundedQuestionCount }),
    model,
    promptVersion: 'studypack-v4',
    schemaVersion: 2,
  });

  const executeFn = async () => {
    const prerequisiteConcepts = await getCompactPrerequisiteConcepts(
      mod.courseId,
      mod.moduleNumber
    );

    const aiResponse = await synthesizerFn({
      courseRecord: course,
      moduleRecord: mod,
      reviewedSources: extractedSources,
      prerequisiteConcepts,
      questionCount: boundedQuestionCount,
    });

    const parsed = studyPackSynthesisSchema.parse(aiResponse.data);
    const validated = validateAndAlignStudyPack(parsed, extractedSources);

    const savedRefs = await db.transaction(async (tx) => {
      const existingPacks = await tx
        .select({ version: studyPacks.version })
        .from(studyPacks)
        .where(eq(studyPacks.moduleId, moduleId))
        .orderBy(desc(studyPacks.version))
        .limit(1);

      const nextVersion = (existingPacks[0]?.version || 0) + 1;
      const now = new Date();

      const sourceRefsList = extractedSources.map((s) => ({
        sourceId: s.id,
        fileName: s.fileName,
        pageOrder: s.pageOrder,
        label: s.label,
      }));

      const [createdPack] = await tx
        .insert(studyPacks)
        .values({
          moduleId,
          version: nextVersion,
          title: validated.title || `Bahan Belajar Modul ${mod.moduleNumber} v${nextVersion}`,
          summaryJson: {
            schemaVersion: 2,
            overview: validated.overview,
            moduleLearningObjectives: validated.moduleLearningObjectives || [],
            topics: validated.topics,
            glossary: validated.glossary || [],
            formulasOrProcedures: validated.formulasOrProcedures || [],
            coverageNotes: validated.coverageNotes || [],
            coverageReport: validated.coverageReport || null,
          },
          sourceRefsJson: sourceRefsList,
          schemaVersion: 2,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      const [createdQSet] = await tx
        .insert(questionSets)
        .values({
          moduleId,
          courseId: mod.courseId,
          studyPackId: createdPack.id,
          setType: 'initial',
          parentAttemptId: null,
          title: `Latihan Awal — Modul ${mod.moduleNumber} (v${nextVersion})`,
          metadataJson: {
            studyPackVersion: nextVersion,
          },
          schemaVersion: 2,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      const questionValues = validated.initialQuestions.map((q, idx) => ({
        questionSetId: createdQSet.id,
        moduleId,
        questionOrder: idx + 1,
        topicLabel: q.topicLabel,
        learningObjective: q.learningObjective || `Memahami ${q.topicLabel}`,
        questionType: q.questionType || 'single_choice',
        prompt: q.prompt,
        optionsJson: q.options,
        correctOption: q.correctOption,
        explanation: q.explanation,
        sourceRefsJson: q.sourceRefs,
        difficulty: q.difficulty || 'medium',
        createdAt: now,
      }));

      await tx.insert(questions).values(questionValues);

      if (mod.status === 'empty' || mod.status === 'needs_review') {
        await tx
          .update(modules)
          .set({ status: 'in_progress', updatedAt: now })
          .where(eq(modules.id, moduleId));
      }

      return {
        moduleId,
        studyPackId: createdPack.id,
        studyPackVersion: nextVersion,
        questionSetId: createdQSet.id,
        questionCount: questionValues.length,
      };
    });

    return {
      model: aiResponse.model || model,
      usageMetadata: aiResponse.usageMetadata || null,
      searchGroundingUsed: Boolean(aiResponse.searchGroundingUsed),
      resultRefs: savedRefs,
    };
  };

  return aiQueue.submitJob({
    idempotencyKey,
    cacheKey,
    operation: 'generate_study_pack',
    targetType: 'module',
    targetId: moduleId,
    courseId: mod.courseId,
    moduleId,
    requestHash: computeSha256({ sourceDigest, boundedQuestionCount }),
    regenerate,
    overrideBudget,
    model,
    executeFn,
  });
}

export async function defaultPracticeSetGenerator({
  moduleRecord,
  latestStudyPack,
  questionCount = 5,
}) {
  const systemInstruction = `Anda adalah pembuat soal latihan adaptif Universitas Terbuka berbasis materi BMP.
Aturan:
1. Buat ${questionCount} butir soal pilihan ganda baru (opsi A, B, C, D) yang bersumber HANYA dari bahan materi belajar Study Pack di bawah.
2. Setiap butir soal WAJIB menguji konsep yang dijelaskan dalam materi Study Pack. Jangan menguji konsep yang tidak ada di dalam materi.
3. Sertakan "topicLabel", "learningObjective", "questionType" ('single_choice', 'conceptual_application', 'scenario_based'), "difficulty", "sourceRefs", dan "explanation" pada setiap butir soal.`;

  const prompt = `Modul ${moduleRecord.moduleNumber}: ${moduleRecord.title}
Bahan Belajar Terstruktur (Study Pack):
${JSON.stringify(latestStudyPack.summaryJson, null, 2)}

Buat ${questionCount} butir soal latihan pilihan ganda baru yang teruji keselarasan konsepnya dalam format JSON.`;

  return generateStructuredContent({
    taskType: 'generate_question_set',
    contents: prompt,
    systemInstruction,
    responseSchema: PRACTICE_QUESTIONS_JSON_SCHEMA,
    zodSchema: practiceQuestionSetOutputSchema,
  });
}

export async function enqueueAdditionalQuestionSet({
  moduleId,
  idempotencyKey,
  questionCount = 5,
  overrideBudget = false,
  aiQueue,
  generatorFn = defaultPracticeSetGenerator,
}) {
  const db = getDb();
  const [mod] = await db
    .select()
    .from(modules)
    .where(eq(modules.id, moduleId))
    .limit(1);

  if (!mod || mod.status === 'archived') {
    const err = new Error('Modul tidak ditemukan.');
    err.statusCode = 404;
    err.errorCode = 'MODULE_NOT_FOUND';
    throw err;
  }

  const [latestPack] = await db
    .select()
    .from(studyPacks)
    .where(eq(studyPacks.moduleId, moduleId))
    .orderBy(desc(studyPacks.version))
    .limit(1);

  if (!latestPack) {
    const err = new Error('Buat Study Pack terlebih dahulu sebelum meminta soal latihan tambahan.');
    err.statusCode = 400;
    err.errorCode = 'NO_STUDY_PACK';
    throw err;
  }

  const boundedCount = Math.min(30, Math.max(3, Number(questionCount) || 10));
  const config = getEnvConfig();
  const model = config.geminiModel || 'gemini-3.5-flash';

  const existingSets = await db
    .select({ id: questionSets.id })
    .from(questionSets)
    .where(eq(questionSets.moduleId, moduleId));

  const setIndex = existingSets.length + 1;

  const cacheKey = buildCacheKey({
    operation: 'generate_question_set',
    targetType: 'module',
    targetId: moduleId,
    inputChecksum: computeSha256({
      studyPackId: latestPack.id,
      boundedCount,
      setIndex,
    }),
    model,
    promptVersion: 'practice-v2',
    schemaVersion: 1,
  });

  const executeFn = async () => {
    const aiResponse = await generatorFn({
      moduleRecord: mod,
      latestStudyPack: latestPack,
      questionCount: boundedCount,
    });

    const parsed = practiceQuestionSetOutputSchema.parse(aiResponse.data);

    const savedRefs = await db.transaction(async (tx) => {
      const now = new Date();
      const [createdSet] = await tx
        .insert(questionSets)
        .values({
          moduleId,
          courseId: mod.courseId,
          studyPackId: latestPack.id,
          setType: 'practice',
          parentAttemptId: null,
          title: parsed.title || `Latihan Tambahan #${setIndex} — Modul ${mod.moduleNumber}`,
          metadataJson: { studyPackVersion: latestPack.version },
          schemaVersion: 1,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      const qValues = parsed.questions.map((q, idx) => ({
        questionSetId: createdSet.id,
        moduleId,
        questionOrder: idx + 1,
        topicLabel: q.topicLabel,
        learningObjective: q.learningObjective || `Menerapkan konsep ${q.topicLabel}`,
        questionType: q.questionType || 'conceptual_application',
        prompt: q.prompt,
        optionsJson: q.options,
        correctOption: q.correctOption,
        explanation: q.explanation,
        sourceRefsJson: q.sourceRefs,
        difficulty: q.difficulty || 'medium',
        createdAt: now,
      }));

      await tx.insert(questions).values(qValues);

      return {
        moduleId,
        questionSetId: createdSet.id,
        questionCount: qValues.length,
      };
    });

    return {
      model: aiResponse.model || model,
      usageMetadata: aiResponse.usageMetadata || null,
      searchGroundingUsed: Boolean(aiResponse.searchGroundingUsed),
      resultRefs: savedRefs,
    };
  };

  return aiQueue.submitJob({
    idempotencyKey,
    cacheKey,
    operation: 'generate_question_set',
    targetType: 'module',
    targetId: moduleId,
    courseId: mod.courseId,
    moduleId,
    requestHash: computeSha256({ studyPackId: latestPack.id, boundedCount, setIndex }),
    regenerate: true,
    overrideBudget,
    model,
    executeFn,
  });
}
