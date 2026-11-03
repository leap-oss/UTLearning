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
        if (q.learningObjective && !matchedTopic.learningObjectives.includes(q.learningObjective)) {
          matchedTopic.learningObjectives.push(q.learningObjective);
        }

        if (!q.sourceRefs || q.sourceRefs.length === 0) {
          q.sourceRefs = matchedTopic.sourceRefs || fallbackSourceRef;
        }

        const explanationText = (matchedTopic.detailedExplanation || '').toLowerCase();
        const objSnippet = (q.learningObjective || '').toLowerCase().trim();
        const isCovered = objSnippet ? explanationText.includes(objSnippet) : true;

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

export async function defaultStudyPackSynthesizer({
  courseRecord,
  moduleRecord,
  reviewedSources,
  prerequisiteConcepts,
  questionCount = 5,
}) {
  const systemInstruction = `Anda adalah kurator dan arsitek penyusun bahan belajar komprehensif Universitas Terbuka (BMP) yang berfokus pada ketuntasan pemahaman mandiri mahasiswa.

PRINSIP WAJIB:
1. JANGAN MERINGKAS TERLALU PENDEK: Mahasiswa belajar mandiri menggunakan bahan ini. Setiap topik WAJIB diuraikan secara mendalam dan jelas (minimal 2-3 paragraf naratif per topik di "detailedExplanation"), bukan sekadar 1-2 kalimat ringkasan umum.
2. PEMISAHAN KONTEN OTENTIK BMP VS BANTUAN AI:
   - "bmpSummary", "detailedExplanation", "coreConcepts", "comparisons", "processesOrStages": HANYA berasal dari materi sumber BMP yang telah direview. Pertahankan istilah asli BMP.
   - "aiExplanation", "simpleAnalogy", "examples" (dengan isAiGenerated=true): Berisi analogi bahasa manusiawi, perumpamaan sehari-hari, dan contoh penerapan konkret untuk mempermudah pemahaman mahasiswa.
3. STRUKTUR MATERI PER TOPIK:
   - "topicLabel": Judul topik yang jelas.
   - "learningObjectives": 1-3 sasaran pembelajaran spesifik.
   - "coreConcepts": Konsep/definisi kunci yang harus dikuasai.
   - "detailedExplanation": Uraian penjelasan mendalam (fakta, latar belakang, cara kerja, alasan penting).
   - "conceptRelationships": Keterhubungan atau ketergantungan antar konsep.
   - "comparisons": Perbandingan terstruktur (itemA, itemB, distinction) jika ada istilah yang berpotensi tertukar.
   - "processesOrStages": Alur langkah atau tahapan berurutan jika ada mekanisme prosedural.
   - "commonMisconceptions": Miskonsepsi umum dan klarifikasi benarnya menurut BMP.
   - "keyTakeaways": Poin-poin kesimpulan esensial.
4. KESELARASAN PEDAGOGIS DENGAN SOAL (PEDAGOGICAL ALIGNMENT):
   - Seluruh ${questionCount} soal pada "initialQuestions" WAJIB bersumber dan DAPAT DIJAWAB dari penjelasan yang telah Anda tulis di "detailedExplanation", "coreConcepts", atau "glossary".
   - DILARANG membuat soal yang menguji konsep di luar materi yang telah Anda jelaskan.
   - Setiap butir soal harus memiliki "learningObjective", "questionType" ('single_choice', 'conceptual_application', 'scenario_based'), "difficulty", "sourceRefs", dan "explanation".
5. REFERENSI SUMBER ("sourceRefs"):
   - Cantumkan referensi halaman BMP yang relevan (contoh: ["Halaman 1"]) pada setiap topik, istilah glosarium, dan butir soal.`;

  const sourceBlocks = reviewedSources
    .map((s) => {
      const ext = s.extractedContentJson || {};
      const sectionsText = (ext.sections || [])
        .map((sec) => `[${sec.heading}]: ${sec.content}`)
        .join('\n');
      return `--- SUMBER [sourceId=${s.id} | Halaman=${s.pageOrder} | Label=${s.label} | File=${s.fileName}] ---
Judul Halaman: ${ext.pageTitle || '-'}
Teks Utama:
${ext.extractedText || ''}
${sectionsText ? `Bagian Teks:\n${sectionsText}\n` : ''}Istilah Kunci: ${(ext.keyTerms || []).join(', ') || '-'}
Rumus/Tabel: ${(ext.formulasOrTables || []).join('; ') || '-'}`;
    })
    .join('\n\n');

  const prereqText =
    prerequisiteConcepts.length > 0
      ? `\nKonteks Konsep Modul Sebelumnya (hanya sebagai jembatan konteks, BUKAN sumber soal modul ini):\n${JSON.stringify(prerequisiteConcepts)}`
      : '';

  const prompt = `Mata Kuliah: ${courseRecord?.code || ''} - ${courseRecord?.name || ''}
Modul ${moduleRecord.moduleNumber}: ${moduleRecord.title}${prereqText}

Materi Sumber Terverifikasi BMP:
${sourceBlocks}

Instruksi Tugas:
1. Lakukan analisis mendalam terhadap cakupan materi BMP di atas.
2. Susun Bahan Belajar Lengkap (Study Pack) yang kaya penjelasan konseptual, terstruktur per topik, dan dilengkapi glosarium.
3. Rancang ${questionCount} butir soal latihan awal yang selaras secara pedagogis dengan materi yang disusun.
4. Pastikan mahasiswa dapat memahami konsep dan menjawab seluruh soal tersebut setelah mempelajari materi ini.

Hasilkan seluruh materi belajar dan butir soal dalam format JSON sesuai schema.`;

  return generateStructuredContent({
    taskType: 'generate_study_pack',
    contents: prompt,
    systemInstruction,
    responseSchema: STUDY_PACK_SYNTHESIS_JSON_SCHEMA,
    zodSchema: studyPackSynthesisSchema,
    enableGoogleSearch: true,
  });
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
    promptVersion: 'studypack-v3',
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
