import { z } from 'zod';

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
        if (
          [
            'single_choice',
            'multiple_choice',
            'true_false',
            'conceptual_application',
            'scenario_based',
          ].includes(val)
        ) {
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

export function isBoilerplateMasteryFormula(item) {
  if (!item) return true;
  const combined = `${item.title || ''} ${item.name || ''} ${item.content || ''} ${item.formulaOrSteps || ''}`.toLowerCase();
  return (
    combined.includes('tingkat penguasaan') ||
    combined.includes('jumlah jawaban yang benar') ||
    combined.includes('jumlah jawaban benar')
  );
}

export const formulaOrProcedureItemSchema = z
  .object({
    title: z.string().trim().optional(),
    name: z.string().trim().optional(),
    content: z.string().trim().optional(),
    formulaOrSteps: z.string().trim().optional(),
    whenToUse: z.string().trim().optional().default(''),
    sourceRefs: sourceRefsSchema,
  })
  .transform((item) => {
    const resolvedTitle = item.title || item.name || 'Rumus / Teorema';
    const resolvedContent = item.content || item.formulaOrSteps || '';
    return {
      title: resolvedTitle,
      name: resolvedTitle,
      content: resolvedContent,
      formulaOrSteps: resolvedContent,
      whenToUse: item.whenToUse || '',
      sourceRefs: item.sourceRefs || [],
    };
  });

export const formulasOrProceduresSchema = z
  .array(formulaOrProcedureItemSchema)
  .optional()
  .default([])
  .transform((items) =>
    (items || []).filter((it) => it.content && !isBoilerplateMasteryFormula(it))
  );

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
  formulasOrProcedures: formulasOrProceduresSchema,
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

export const PRACTICE_QUESTIONS_JSON_SCHEMA = {
  type: 'OBJECT',
  required: ['title', 'questions'],
  properties: {
    schemaVersion: { type: 'INTEGER' },
    title: { type: 'STRING' },
    questions: STUDY_PACK_SYNTHESIS_JSON_SCHEMA.properties.initialQuestions,
  },
};

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
        simpleAnalogy: z.string().optional().default(''),
        sourceRefs: sourceRefsSchema,
      })
    )
    .optional()
    .default([]),
  formulasOrProcedures: formulasOrProceduresSchema,
});

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

        if (
          !isCovered &&
          q.explanation &&
          !matchedTopic.detailedExplanation.includes(q.explanation)
        ) {
          matchedTopic.detailedExplanation += `\n\n${q.explanation}`;
          matchedTopic.bmpSummary = matchedTopic.detailedExplanation;
        }
      }
    }
  }

  return parsed;
}
