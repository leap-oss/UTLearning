import { eq, asc, desc, and, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import {
  courses,
  modules,
  studyPacks,
  questionSets,
  questions,
  quizAttempts,
  attemptAnswers,
} from '../db/schema.js';
import { getEnvConfig } from '../config/env.js';
import { buildCacheKey, computeSha256 } from './aiRetry.js';
import { generateStructuredContent } from './geminiClient.js';
import { mcqQuestionSchema } from './studyPackService.js';

export const submitAttemptPayloadSchema = z.object({
  answers: z
    .array(
      z.object({
        questionId: z.string().uuid('Format questionId tidak valid.'),
        selectedOption: z.string().trim().min(1).max(16).transform((s) => s.toUpperCase()),
      })
    )
    .min(1, 'Minimal satu jawaban harus dikirim.'),
});

export const remedialBatchOutputSchema = z.object({
  schemaVersion: z.number().int().optional().default(1),
  title: z
    .string()
    .optional()
    .default('Remedial Terfokus')
    .transform((s) => (s && s.trim().length >= 2 ? s.trim() : 'Remedial Terfokus')),
  diagnosticFeedback: z.object({
    overallDiagnosis: z
      .string()
      .optional()
      .default('Analisis miskonsepsi berdasarkan jawaban yang salah.')
      .transform((s) =>
        s && s.trim().length >= 2
          ? s.trim()
          : 'Analisis miskonsepsi berdasarkan jawaban yang salah.'
      ),
    topicDiagnostics: z
      .array(
        z.object({
          topicLabel: z
            .string()
            .optional()
            .default('Topik Remedial')
            .transform((s) => (s && s.trim() ? s.trim() : 'Topik Remedial')),
          misconceptionAnalysis: z
            .string()
            .optional()
            .default('')
            .transform((s) => (s && s.trim() ? s.trim() : 'Perlu penguatan konsep pada topik ini.')),
          reviewGuidance: z
            .string()
            .optional()
            .default('')
            .transform((s) => (s && s.trim() ? s.trim() : 'Baca kembali bagian rangkuman BMP.')),
          sourceRefs: z.array(z.string()).optional().default(['Sumber Modul BMP']),
        })
      )
      .min(1),
  }),
  remedialQuestions: z.array(mcqQuestionSchema).min(1).max(15),
});

export const REMEDIAL_BATCH_JSON_SCHEMA = {
  type: 'OBJECT',
  required: ['title', 'diagnosticFeedback', 'remedialQuestions'],
  properties: {
    schemaVersion: { type: 'INTEGER' },
    title: { type: 'STRING' },
    diagnosticFeedback: {
      type: 'OBJECT',
      required: ['overallDiagnosis', 'topicDiagnostics'],
      properties: {
        overallDiagnosis: { type: 'STRING' },
        topicDiagnostics: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            required: ['topicLabel', 'misconceptionAnalysis', 'reviewGuidance', 'sourceRefs'],
            properties: {
              topicLabel: { type: 'STRING' },
              misconceptionAnalysis: { type: 'STRING' },
              reviewGuidance: { type: 'STRING' },
              sourceRefs: { type: 'ARRAY', items: { type: 'STRING' } },
            },
          },
        },
      },
    },
    remedialQuestions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        required: ['topicLabel', 'prompt', 'options', 'correctOption', 'explanation', 'difficulty', 'sourceRefs'],
        properties: {
          topicLabel: { type: 'STRING' },
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
          difficulty: { type: 'STRING' },
          sourceRefs: { type: 'ARRAY', items: { type: 'STRING' } },
        },
      },
    },
  },
};

export const examSimulationQuestionSchema = z
  .object({
    moduleNumber: z
      .union([z.number(), z.string()])
      .optional()
      .default(1)
      .transform((v) => {
        const n = Number.parseInt(String(v).replace(/[^0-9]/g, ''), 10);
        return Number.isInteger(n) && n >= 1 ? n : 1;
      }),
    topicLabel: z.string().optional(),
    prompt: z.string(),
    options: z.any(),
    correctOption: z.string(),
    explanation: z.string().optional(),
    difficulty: z.string().optional(),
    sourceRefs: z.array(z.string()).optional(),
  })
  .transform((raw) => {
    const parsedMcq = mcqQuestionSchema.parse(raw);
    return {
      ...parsedMcq,
      moduleNumber: raw.moduleNumber,
    };
  });

export const examSimulationOutputSchema = z.object({
  schemaVersion: z.number().int().optional().default(1),
  title: z.string().trim().min(2),
  questions: z.array(examSimulationQuestionSchema).min(2).max(30),
});

export const EXAM_SIMULATION_JSON_SCHEMA = {
  type: 'OBJECT',
  required: ['title', 'questions'],
  properties: {
    schemaVersion: { type: 'INTEGER' },
    title: { type: 'STRING' },
    questions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        required: [
          'moduleNumber',
          'topicLabel',
          'prompt',
          'options',
          'correctOption',
          'explanation',
          'difficulty',
          'sourceRefs',
        ],
        properties: {
          moduleNumber: { type: 'INTEGER' },
          topicLabel: { type: 'STRING' },
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
          difficulty: { type: 'STRING' },
          sourceRefs: { type: 'ARRAY', items: { type: 'STRING' } },
        },
      },
    },
  },
};

/**
 * Get question set for taking a quiz.
 * IMPORTANT: Never include correctOption or explanation before submission!
 */
export async function getQuestionSetWithoutAnswerKey(questionSetId) {
  const db = getDb();
  const [qSet] = await db
    .select()
    .from(questionSets)
    .where(eq(questionSets.id, questionSetId))
    .limit(1);

  if (!qSet) {
    return null;
  }

  const rawQuestions = await db
    .select({
      id: questions.id,
      questionSetId: questions.questionSetId,
      moduleId: questions.moduleId,
      questionOrder: questions.questionOrder,
      topicLabel: questions.topicLabel,
      prompt: questions.prompt,
      optionsJson: questions.optionsJson,
      difficulty: questions.difficulty,
      sourceRefsJson: questions.sourceRefsJson,
    })
    .from(questions)
    .where(eq(questions.questionSetId, questionSetId))
    .orderBy(asc(questions.questionOrder));

  const pastAttempts = await db
    .select()
    .from(quizAttempts)
    .where(eq(quizAttempts.questionSetId, questionSetId))
    .orderBy(desc(quizAttempts.submittedAt));

  return {
    id: qSet.id,
    moduleId: qSet.moduleId,
    courseId: qSet.courseId,
    studyPackId: qSet.studyPackId,
    setType: qSet.setType,
    parentAttemptId: qSet.parentAttemptId,
    title: qSet.title,
    metadata: qSet.metadataJson || {},
    createdAt: qSet.createdAt,
    questions: rawQuestions.map((q) => ({
      id: q.id,
      moduleId: q.moduleId,
      questionOrder: q.questionOrder,
      topicLabel: q.topicLabel,
      prompt: q.prompt,
      options: q.optionsJson,
      difficulty: q.difficulty,
      sourceRefs: q.sourceRefsJson,
    })),
    attempts: pastAttempts,
  };
}

async function evaluateAndUpdateModuleStatus(tx, moduleId) {
  if (!moduleId) return;

  const modQSets = await tx
    .select({ id: questionSets.id })
    .from(questionSets)
    .where(eq(questionSets.moduleId, moduleId));

  if (modQSets.length === 0) return;

  const qSetIds = modQSets.map((s) => s.id);
  const attempts = await tx
    .select()
    .from(quizAttempts)
    .where(inArray(quizAttempts.questionSetId, qSetIds))
    .orderBy(desc(quizAttempts.submittedAt));

  if (attempts.length === 0) return;

  const latestAttempt = attempts[0];
  const distinctSetsPassed = new Set(
    attempts.filter((a) => a.score >= 80).map((a) => a.questionSetId)
  );

  // Mastery rule (Section 2): minimum score >= 80 on more than one distinct question set
  // (or >= 2 attempts with latest >= 80 and average >= 80), never locking other modules.
  let nextStatus = 'in_progress';
  if (latestAttempt.score < 70) {
    nextStatus = 'needs_review';
  } else if (distinctSetsPassed.size >= 2 && latestAttempt.score >= 80) {
    nextStatus = 'mastered';
  } else if (attempts.length >= 2 && latestAttempt.score >= 85 && attempts[1].score >= 80) {
    nextStatus = 'mastered';
  }

  await tx
    .update(modules)
    .set({ status: nextStatus, updatedAt: new Date() })
    .where(eq(modules.id, moduleId));
}

/**
 * Grade quiz submission strictly on the server using stored answer keys.
 */
export async function submitQuizAttempt(questionSetId, rawPayload) {
  const payload = submitAttemptPayloadSchema.parse(rawPayload);
  const db = getDb();

  const [qSet] = await db
    .select()
    .from(questionSets)
    .where(eq(questionSets.id, questionSetId))
    .limit(1);

  if (!qSet) {
    const err = new Error('Question set tidak ditemukan.');
    err.statusCode = 404;
    err.errorCode = 'QUESTION_SET_NOT_FOUND';
    throw err;
  }

  const dbQuestions = await db
    .select()
    .from(questions)
    .where(eq(questions.questionSetId, questionSetId))
    .orderBy(asc(questions.questionOrder));

  if (dbQuestions.length === 0) {
    const err = new Error('Question set ini tidak memiliki soal.');
    err.statusCode = 400;
    err.errorCode = 'EMPTY_QUESTION_SET';
    throw err;
  }

  const questionMap = new Map(dbQuestions.map((q) => [q.id, q]));
  const submittedAnswersByQuestionId = new Map();

  for (const ans of payload.answers) {
    if (!questionMap.has(ans.questionId)) {
      const err = new Error(`Soal ${ans.questionId} bukan bagian dari question set ini.`);
      err.statusCode = 400;
      err.errorCode = 'INVALID_QUESTION_ID';
      throw err;
    }
    submittedAnswersByQuestionId.set(ans.questionId, ans.selectedOption);
  }

  if (submittedAnswersByQuestionId.size !== dbQuestions.length) {
    const err = new Error(
      `Harap jawab seluruh ${dbQuestions.length} soal sebelum mengirim (${submittedAnswersByQuestionId.size}/${dbQuestions.length} terjawab).`
    );
    err.statusCode = 400;
    err.errorCode = 'INCOMPLETE_ANSWERS';
    throw err;
  }

  let correctCount = 0;
  const gradedItems = [];

  for (const q of dbQuestions) {
    const selectedOption = submittedAnswersByQuestionId.get(q.id);
    const isCorrect = selectedOption === String(q.correctOption).toUpperCase();
    if (isCorrect) {
      correctCount += 1;
    }
    gradedItems.push({
      question: q,
      selectedOption,
      isCorrect,
    });
  }

  const totalCount = dbQuestions.length;
  const score = Math.round((correctCount / totalCount) * 100);
  const now = new Date();

  const savedAttempt = await db.transaction(async (tx) => {
    const [attempt] = await tx
      .insert(quizAttempts)
      .values({
        questionSetId,
        startedAt: now,
        submittedAt: now,
        score,
        correctCount,
        totalCount,
        status: 'submitted',
      })
      .returning();

    const answerRows = gradedItems.map((item) => ({
      attemptId: attempt.id,
      questionId: item.question.id,
      selectedOption: item.selectedOption,
      isCorrect: item.isCorrect,
      answeredAt: now,
    }));

    await tx.insert(attemptAnswers).values(answerRows);

    if (qSet.moduleId) {
      await evaluateAndUpdateModuleStatus(tx, qSet.moduleId);
    }

    return attempt;
  });

  return getAttemptReviewById(savedAttempt.id);
}

export async function getAttemptReviewById(attemptId) {
  const db = getDb();
  const [attempt] = await db
    .select()
    .from(quizAttempts)
    .where(eq(quizAttempts.id, attemptId))
    .limit(1);

  if (!attempt) {
    return null;
  }

  const [qSet] = await db
    .select()
    .from(questionSets)
    .where(eq(questionSets.id, attempt.questionSetId))
    .limit(1);

  const dbQuestions = await db
    .select()
    .from(questions)
    .where(eq(questions.questionSetId, attempt.questionSetId))
    .orderBy(asc(questions.questionOrder));

  const answers = await db
    .select()
    .from(attemptAnswers)
    .where(eq(attemptAnswers.attemptId, attemptId));

  const answerByQId = new Map(answers.map((a) => [a.questionId, a]));

  // Lookup module titles if questions belong to multiple modules (e.g., exam simulation)
  const moduleIds = Array.from(
    new Set(dbQuestions.map((q) => q.moduleId).filter(Boolean))
  );
  const moduleMap = new Map();
  if (moduleIds.length > 0) {
    const modRows = await db
      .select()
      .from(modules)
      .where(inArray(modules.id, moduleIds));
    for (const m of modRows) {
      moduleMap.set(m.id, m);
    }
  }

  const topicStatsMap = new Map();
  const moduleStatsMap = new Map();

  const reviewQuestions = dbQuestions.map((q) => {
    const ans = answerByQId.get(q.id);
    const isCorrect = Boolean(ans?.isCorrect);
    const modInfo = q.moduleId ? moduleMap.get(q.moduleId) : null;

    // Topic breakdown
    const tStat = topicStatsMap.get(q.topicLabel) || {
      topicLabel: q.topicLabel,
      correct: 0,
      total: 0,
    };
    tStat.total += 1;
    if (isCorrect) tStat.correct += 1;
    topicStatsMap.set(q.topicLabel, tStat);

    // Module breakdown
    if (modInfo) {
      const mStat = moduleStatsMap.get(modInfo.id) || {
        moduleId: modInfo.id,
        moduleNumber: modInfo.moduleNumber,
        moduleTitle: modInfo.title,
        correct: 0,
        total: 0,
      };
      mStat.total += 1;
      if (isCorrect) mStat.correct += 1;
      moduleStatsMap.set(modInfo.id, mStat);
    }

    return {
      questionId: q.id,
      questionOrder: q.questionOrder,
      moduleId: q.moduleId,
      moduleNumber: modInfo?.moduleNumber ?? null,
      moduleTitle: modInfo?.title ?? null,
      topicLabel: q.topicLabel,
      prompt: q.prompt,
      options: q.optionsJson,
      selectedOption: ans?.selectedOption || null,
      correctOption: q.correctOption,
      isCorrect,
      explanation: q.explanation,
      sourceRefs: q.sourceRefsJson,
      difficulty: q.difficulty,
    };
  });

  const topicBreakdown = Array.from(topicStatsMap.values()).map((t) => ({
    ...t,
    score: t.total > 0 ? Math.round((t.correct / t.total) * 100) : 0,
  }));

  const moduleBreakdown = Array.from(moduleStatsMap.values())
    .sort((a, b) => a.moduleNumber - b.moduleNumber)
    .map((m) => ({
      ...m,
      score: m.total > 0 ? Math.round((m.correct / m.total) * 100) : 0,
    }));

  // Find linked remedial question sets created from this attempt
  const remedialSets = await db
    .select()
    .from(questionSets)
    .where(eq(questionSets.parentAttemptId, attemptId))
    .orderBy(desc(questionSets.createdAt));

  return {
    attemptId: attempt.id,
    questionSetId: attempt.questionSetId,
    questionSetTitle: qSet?.title || '',
    setType: qSet?.setType || 'initial',
    moduleId: qSet?.moduleId || null,
    courseId: qSet?.courseId || null,
    score: attempt.score,
    correctCount: attempt.correctCount,
    totalCount: attempt.totalCount,
    submittedAt: attempt.submittedAt,
    questions: reviewQuestions,
    weakTopics: topicBreakdown.filter((t) => t.score < 100),
    topicBreakdown,
    moduleBreakdown,
    remedialSets,
  };
}

export async function defaultRemedialGenerator({
  attemptReview,
  wrongQuestions,
  relevantTopicsContext,
}) {
  const systemInstruction = `Anda adalah tutor diagnostik Universitas Terbuka berbasis sumber BMP.
Tugas Anda:
1. Analisis semua jawaban salah mahasiswa secara bersamaan (batched diagnostic).
2. Jelaskan letak miskonsepsi konsep berdasarkan materi BMP (bukan sekadar menyebut benar/salah).
3. Buat ${Math.min(5, Math.max(2, wrongQuestions.length))} soal remedial pilihan ganda baru dengan konteks/skenario berbeda tetapi menguji topik/kompetensi yang salah tersebut.
4. Sertakan "sourceRefs" pada setiap soal dan analisis topik.`;

  const prompt = `Hasil Pengerjaan Kuis: Skor ${attemptReview.score}% (${attemptReview.correctCount}/${attemptReview.totalCount})
Daftar Soal yang Dijawab Salah oleh Mahasiswa:
${JSON.stringify(
  wrongQuestions.map((wq) => ({
    topicLabel: wq.topicLabel,
    prompt: wq.prompt,
    options: wq.options,
    studentSelectedOption: wq.selectedOption,
    correctOption: wq.correctOption,
    explanation: wq.explanation,
    sourceRefs: wq.sourceRefs,
  })),
  null,
  2
)}

Konteks Topik Materi BMP Terkait:
${JSON.stringify(relevantTopicsContext, null, 2)}

Hasilkan umpan balik diagnostik dan soal remedial dalam JSON.`;

  return generateStructuredContent({
    taskType: 'generate_remedial',
    contents: prompt,
    systemInstruction,
    responseSchema: REMEDIAL_BATCH_JSON_SCHEMA,
    zodSchema: remedialBatchOutputSchema,
  });
}

export async function enqueueRemedialGeneration({
  attemptId,
  idempotencyKey,
  regenerate = false,
  overrideBudget = false,
  aiQueue,
  generatorFn = defaultRemedialGenerator,
}) {
  const db = getDb();
  const attemptReview = await getAttemptReviewById(attemptId);
  if (!attemptReview) {
    const err = new Error('Attempt kuis tidak ditemukan.');
    err.statusCode = 404;
    err.errorCode = 'ATTEMPT_NOT_FOUND';
    throw err;
  }

  const wrongQuestions = attemptReview.questions.filter((q) => !q.isCorrect);
  if (wrongQuestions.length === 0) {
    const err = new Error(
      'Semua jawaban pada attempt ini sudah benar (100%). Tidak diperlukan remedial.'
    );
    err.statusCode = 400;
    err.errorCode = 'NO_WRONG_ANSWERS';
    throw err;
  }

  const config = getEnvConfig();
  const model = config.geminiModel || 'gemini-2.5-flash';

  const cacheKey = buildCacheKey({
    operation: 'generate_remedial',
    targetType: 'attempt',
    targetId: attemptId,
    inputChecksum: computeSha256({
      attemptId,
      wrongIds: wrongQuestions.map((w) => w.questionId),
    }),
    model,
    promptVersion: 'remedial-v1',
    schemaVersion: 1,
  });

  const executeFn = async () => {
    // Load only relevant topic summaries from the module's latest study pack
    let relevantTopicsContext = [];
    if (attemptReview.moduleId) {
      const [latestPack] = await db
        .select()
        .from(studyPacks)
        .where(eq(studyPacks.moduleId, attemptReview.moduleId))
        .orderBy(desc(studyPacks.version))
        .limit(1);

      if (latestPack?.summaryJson?.topics) {
        const wrongTopicLabels = new Set(
          wrongQuestions.map((w) => w.topicLabel.toLowerCase())
        );
        relevantTopicsContext = latestPack.summaryJson.topics.filter((t) =>
          wrongTopicLabels.has(String(t.topicLabel || '').toLowerCase())
        );
        if (relevantTopicsContext.length === 0) {
          relevantTopicsContext = latestPack.summaryJson.topics.slice(0, 3);
        }
      }
    }

    const aiResponse = await generatorFn({
      attemptReview,
      wrongQuestions,
      relevantTopicsContext,
    });

    const parsed = remedialBatchOutputSchema.parse(aiResponse.data);

    const savedRefs = await db.transaction(async (tx) => {
      const now = new Date();
      const [remedialSet] = await tx
        .insert(questionSets)
        .values({
          moduleId: attemptReview.moduleId,
          courseId: attemptReview.courseId,
          studyPackId: null,
          setType: 'remedial',
          parentAttemptId: attemptId,
          title: parsed.title || `Remedial Terfokus (${wrongQuestions.length} Topik Lemah)`,
          metadataJson: {
            parentAttemptId: attemptId,
            diagnosticFeedback: parsed.diagnosticFeedback,
          },
          schemaVersion: 1,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      const qValues = parsed.remedialQuestions.map((q, idx) => ({
        questionSetId: remedialSet.id,
        moduleId: attemptReview.moduleId,
        questionOrder: idx + 1,
        topicLabel: q.topicLabel,
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
        attemptId,
        moduleId: attemptReview.moduleId,
        remedialQuestionSetId: remedialSet.id,
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
    operation: 'generate_remedial',
    targetType: 'attempt',
    targetId: attemptId,
    courseId: attemptReview.courseId,
    moduleId: attemptReview.moduleId,
    requestHash: computeSha256({ attemptId }),
    regenerate,
    overrideBudget,
    model,
    executeFn,
  });
}

export async function defaultExamSimulationGenerator({
  courseRecord,
  selectedModuleSummaries,
  questionCount = 10,
  difficulty = 'mixed',
}) {
  const systemInstruction = `Anda adalah pembuat latihan Simulasi UAS komprehensif Universitas Terbuka berbasis materi BMP yang telah diverifikasi.
Aturan wajib:
1. Buat total ${questionCount} soal pilihan ganda (opsi A, B, C, D) dengan distribusi yang seimbang antar modul yang dipilih.
2. Jangan membiarkan satu modul mendominasi seluruh soal.
3. Setiap soal wajib mencantumkan "moduleNumber" yang sesuai dengan modul asalnya, "topicLabel", "explanation", dan "sourceRefs".
4. Tingkat kesulitan target: ${difficulty}.
5. Simulasi ini adalah latihan komprehensif dari materi yang tersedia, bukan prediksi soal UAS resmi. Jangan mengarang konsep di luar ringkasan modul yang diberikan.`;

  const prompt = `Mata Kuliah: ${courseRecord.code} - ${courseRecord.name}
Jumlah Soal: ${questionCount}
Ringkasan Kompak per Modul Terpilih:
${JSON.stringify(selectedModuleSummaries, null, 2)}

Hasilkan paket soal Simulasi UAS komprehensif dalam format JSON.`;

  return generateStructuredContent({
    taskType: 'generate_exam_simulation',
    contents: prompt,
    systemInstruction,
    responseSchema: EXAM_SIMULATION_JSON_SCHEMA,
    zodSchema: examSimulationOutputSchema,
  });
}

export async function enqueueCourseExamSimulation({
  courseId,
  moduleIds = null,
  questionCount = 10,
  difficulty = 'mixed',
  idempotencyKey,
  regenerate = false,
  overrideBudget = false,
  aiQueue,
  generatorFn = defaultExamSimulationGenerator,
}) {
  const db = getDb();
  const [course] = await db
    .select()
    .from(courses)
    .where(eq(courses.id, courseId))
    .limit(1);

  if (!course || course.status === 'archived') {
    const err = new Error('Mata kuliah tidak ditemukan atau diarsipkan.');
    err.statusCode = 404;
    err.errorCode = 'COURSE_NOT_FOUND';
    throw err;
  }

  const allCourseModules = await db
    .select()
    .from(modules)
    .where(and(eq(modules.courseId, courseId), ne(modules.status, 'archived')))
    .orderBy(asc(modules.moduleNumber));

  const requestedModules =
    Array.isArray(moduleIds) && moduleIds.length > 0
      ? allCourseModules.filter((m) => moduleIds.includes(m.id))
      : allCourseModules;

  // Gather latest verified study pack for each selected module
  const selectedWithPacks = [];
  for (const mod of requestedModules) {
    const [latestPack] = await db
      .select()
      .from(studyPacks)
      .where(eq(studyPacks.moduleId, mod.id))
      .orderBy(desc(studyPacks.version))
      .limit(1);

    if (latestPack) {
      selectedWithPacks.push({
        module: mod,
        studyPack: latestPack,
      });
    }
  }

  if (selectedWithPacks.length < 2) {
    const err = new Error(
      'Simulasi UAS komprehensif membutuhkan minimal 2 modul yang sudah memiliki Study Pack terverifikasi.'
    );
    err.statusCode = 400;
    err.errorCode = 'INSUFFICIENT_VERIFIED_MODULES';
    throw err;
  }

  const boundedQuestionCount = Math.min(25, Math.max(4, Number(questionCount) || 10));
  const validDifficulty = ['easy', 'medium', 'hard', 'mixed'].includes(difficulty)
    ? difficulty
    : 'mixed';

  const compactSummaries = selectedWithPacks.map(({ module: m, studyPack: sp }) => ({
    moduleId: m.id,
    moduleNumber: m.moduleNumber,
    moduleTitle: m.title,
    studyPackId: sp.id,
    studyPackVersion: sp.version,
    overview: sp.summaryJson?.overview || '',
    topics: (sp.summaryJson?.topics || []).map((t) => ({
      topicLabel: t.topicLabel,
      bmpSummary: t.bmpSummary,
      sourceRefs: t.sourceRefs,
    })),
  }));

  const config = getEnvConfig();
  const model = config.geminiModel || 'gemini-2.5-flash';

  const inputSignature = {
    courseId,
    packs: compactSummaries.map((c) => ({
      moduleId: c.moduleId,
      studyPackId: c.studyPackId,
    })),
    boundedQuestionCount,
    validDifficulty,
  };

  const cacheKey = buildCacheKey({
    operation: 'generate_exam_simulation',
    targetType: 'course',
    targetId: courseId,
    inputChecksum: computeSha256(inputSignature),
    model,
    promptVersion: 'exam-sim-v1',
    schemaVersion: 1,
  });

  const moduleByNumber = new Map(
    selectedWithPacks.map(({ module: m }) => [m.moduleNumber, m])
  );
  const fallbackModule = selectedWithPacks[0].module;

  const executeFn = async () => {
    const aiResponse = await generatorFn({
      courseRecord: course,
      selectedModuleSummaries: compactSummaries,
      questionCount: boundedQuestionCount,
      difficulty: validDifficulty,
    });

    const parsed = examSimulationOutputSchema.parse(aiResponse.data);

    const savedRefs = await db.transaction(async (tx) => {
      const now = new Date();
      const [simSet] = await tx
        .insert(questionSets)
        .values({
          moduleId: null,
          courseId,
          studyPackId: null,
          setType: 'exam_simulation',
          parentAttemptId: null,
          title:
            parsed.title ||
            `Simulasi UAS ${course.code} (${selectedWithPacks.length} Modul, ${parsed.questions.length} Soal)`,
          metadataJson: {
            disclaimer:
              'Simulasi UAS adalah latihan komprehensif dari materi BMP yang telah Anda unggah, bukan prediksi atau bocoran soal UAS resmi UT.',
            includedModules: compactSummaries.map((c) => ({
              moduleId: c.moduleId,
              moduleNumber: c.moduleNumber,
              moduleTitle: c.moduleTitle,
            })),
            difficulty: validDifficulty,
          },
          schemaVersion: 1,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      const qValues = parsed.questions.map((q, idx) => {
        const matchedMod = moduleByNumber.get(q.moduleNumber) || fallbackModule;
        return {
          questionSetId: simSet.id,
          moduleId: matchedMod.id,
          questionOrder: idx + 1,
          topicLabel: q.topicLabel,
          prompt: q.prompt,
          optionsJson: q.options,
          correctOption: q.correctOption,
          explanation: q.explanation,
          sourceRefsJson: q.sourceRefs,
          difficulty: q.difficulty || 'medium',
          createdAt: now,
        };
      });

      await tx.insert(questions).values(qValues);

      return {
        courseId,
        questionSetId: simSet.id,
        questionCount: qValues.length,
        moduleCount: selectedWithPacks.length,
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
    operation: 'generate_exam_simulation',
    targetType: 'course',
    targetId: courseId,
    courseId,
    moduleId: null,
    requestHash: computeSha256(inputSignature),
    regenerate,
    overrideBudget,
    model,
    executeFn,
  });
}

export async function getModuleProgress(moduleId) {
  const db = getDb();
  const [mod] = await db
    .select()
    .from(modules)
    .where(eq(modules.id, moduleId))
    .limit(1);

  if (!mod) return null;

  const qSets = await db
    .select()
    .from(questionSets)
    .where(eq(questionSets.moduleId, moduleId))
    .orderBy(desc(questionSets.createdAt));

  const qSetIds = qSets.map((s) => s.id);
  let attempts = [];
  if (qSetIds.length > 0) {
    attempts = await db
      .select()
      .from(quizAttempts)
      .where(inArray(quizAttempts.questionSetId, qSetIds))
      .orderBy(desc(quizAttempts.submittedAt));
  }

  // Calculate topic mastery across all answers on questions belonging to this module
  const modQuestions = await db
    .select()
    .from(questions)
    .where(eq(questions.moduleId, moduleId));

  const qMap = new Map(modQuestions.map((q) => [q.id, q]));
  const modQuestionIds = modQuestions.map((q) => q.id);

  let answers = [];
  if (modQuestionIds.length > 0) {
    answers = await db
      .select()
      .from(attemptAnswers)
      .where(inArray(attemptAnswers.questionId, modQuestionIds));
  }

  const topicMap = new Map();
  for (const ans of answers) {
    const q = qMap.get(ans.questionId);
    if (!q) continue;
    const entry = topicMap.get(q.topicLabel) || {
      topicLabel: q.topicLabel,
      answeredCount: 0,
      correctCount: 0,
    };
    entry.answeredCount += 1;
    if (ans.isCorrect) entry.correctCount += 1;
    topicMap.set(q.topicLabel, entry);
  }

  const topicProgress = Array.from(topicMap.values()).map((t) => ({
    ...t,
    accuracyPercent:
      t.answeredCount > 0 ? Math.round((t.correctCount / t.answeredCount) * 100) : 0,
  }));

  const qSetTitleMap = new Map(qSets.map((s) => [s.id, { title: s.title, setType: s.setType }]));

  return {
    moduleId: mod.id,
    moduleNumber: mod.moduleNumber,
    title: mod.title,
    status: mod.status,
    attemptCount: attempts.length,
    averageScore:
      attempts.length > 0
        ? Math.round(attempts.reduce((sum, a) => sum + a.score, 0) / attempts.length)
        : null,
    latestScore: attempts[0]?.score ?? null,
    attempts: attempts.map((a) => ({
      ...a,
      questionSetTitle: qSetTitleMap.get(a.questionSetId)?.title || 'Kuis',
      setType: qSetTitleMap.get(a.questionSetId)?.setType || 'initial',
    })),
    topicProgress,
    weakTopics: topicProgress.filter((t) => t.accuracyPercent < 75),
  };
}

export async function getCourseProgress(courseId) {
  const db = getDb();
  const [course] = await db
    .select()
    .from(courses)
    .where(eq(courses.id, courseId))
    .limit(1);

  if (!course) return null;

  const courseModules = await db
    .select()
    .from(modules)
    .where(and(eq(modules.courseId, courseId), ne(modules.status, 'archived')))
    .orderBy(asc(modules.moduleNumber));

  const moduleBreakdown = [];
  for (const mod of courseModules) {
    const prog = await getModuleProgress(mod.id);
    const [latestPack] = await db
      .select({ id: studyPacks.id, version: studyPacks.version })
      .from(studyPacks)
      .where(eq(studyPacks.moduleId, mod.id))
      .orderBy(desc(studyPacks.version))
      .limit(1);

    moduleBreakdown.push({
      ...prog,
      hasVerifiedStudyPack: Boolean(latestPack),
      latestStudyPackVersion: latestPack?.version ?? null,
    });
  }

  // Also fetch exam simulations for this course
  const examSimSets = await db
    .select()
    .from(questionSets)
    .where(
      and(
        eq(questionSets.courseId, courseId),
        eq(questionSets.setType, 'exam_simulation')
      )
    )
    .orderBy(desc(questionSets.createdAt));

  const simIds = examSimSets.map((s) => s.id);
  let simAttempts = [];
  if (simIds.length > 0) {
    simAttempts = await db
      .select()
      .from(quizAttempts)
      .where(inArray(quizAttempts.questionSetId, simIds))
      .orderBy(desc(quizAttempts.submittedAt));
  }

  const attemptsBySetId = new Map();
  for (const a of simAttempts) {
    const list = attemptsBySetId.get(a.questionSetId) || [];
    list.push(a);
    attemptsBySetId.set(a.questionSetId, list);
  }

  const examSimulations = examSimSets.map((s) => ({
    id: s.id,
    title: s.title,
    metadata: s.metadataJson || {},
    createdAt: s.createdAt,
    attempts: attemptsBySetId.get(s.id) || [],
  }));

  return {
    courseId: course.id,
    code: course.code,
    name: course.name,
    expectedModuleCount: course.expectedModuleCount,
    modules: moduleBreakdown,
    examSimulations,
  };
}
