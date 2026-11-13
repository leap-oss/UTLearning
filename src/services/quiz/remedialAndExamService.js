import { eq, asc, desc, and, ne } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import {
  courses,
  modules,
  studyPacks,
  questionSets,
  questions,
} from '../../db/schema.js';
import { getEnvConfig } from '../../config/env.js';
import { buildCacheKey, computeSha256 } from '../aiRetry.js';
import { generateStructuredContent } from '../geminiClient.js';
import {
  remedialBatchOutputSchema,
  REMEDIAL_BATCH_JSON_SCHEMA,
  examSimulationOutputSchema,
  EXAM_SIMULATION_JSON_SCHEMA,
} from './quizSchemas.js';
import {
  normalizeTopicKey,
  resolveCanonicalTopicLabel,
} from './topicMastery.js';
import { getAttemptReviewById } from './quizGradingService.js';

export async function defaultRemedialGenerator({
  attemptReview,
  wrongQuestions,
  relevantTopicsContext,
  questionCount = null,
}) {
  const targetCount = questionCount
    ? Math.min(20, Math.max(2, Number(questionCount)))
    : Math.min(10, Math.max(wrongQuestions.length * 2, 5));

  const systemInstruction = `Anda adalah tutor diagnostik adaptif Universitas Terbuka berbasis materi BMP yang telah diverifikasi.
Tugas Anda:
1. PENDALAMAN MATERI TERFOKUS (Micro-Lesson sebelum kuis remedial):
   Untuk setiap topik yang salah, susun materi pendalaman terarah agar siswa memahaminya SEBELUM mengerjakan soal remedial:
   - "misconceptionAnalysis": Inti miskonsepsi mahasiswa secara ringkas.
   - "whyYouWereTripped": Analisis kontras spesifik mengapa opsi salah yang dipilih siswa tampak mengecoh (untuk soal matematika: tunjukkan letak kekeliruan tanda, langkah aljabar, sifat himpunan/logika, atau rumus), dan bagaimana cara membedakannya dengan jawaban yang benar menurut BMP. DILARANG merangkum ulang seluruh bab, fokuslah pada titik beda (contrastive).
   - "bmpKeyRule": 1-2 kalimat kaidah / aturan emas / rumus kunci BMP yang wajib diingat.
   - "practicalAnalogy": Analogi intuitif atau jembatan logika praktis sehari-hari agar siswa mudah mengingat konsep/rumus tersebut (diberi tanda bantuan AI).
   - "reviewGuidance": Panduan bagian halaman/materi BMP yang perlu diperiksa.
2. LATIHAN REMEDIAL:
   Rancang ${targetCount} soal remedial pilihan ganda baru (4 opsi: A, B, C, D) yang menguji learning objective yang sama dari topik yang salah, namun dengan angka/skenario/distraktor/konteks baru yang berbeda (JANGAN mengulang kalimat soal asli).
3. STANDAR NOTASI MATEMATIKA (LaTeX):
   Tuliskan seluruh persamaan, rumus, pecahan, pangkat, himpunan, dan simbol logika pada "diagnosticFeedback", "prompt", "options", dan "explanation" dalam notasi LaTeX standar ($...$ untuk inline dan $$...$$ untuk rumus blok), serta sertakan langkah penyelesaian step-by-step di "explanation".
4. Sertakan "learningObjective", "questionType" ('scenario_based', 'conceptual_application', 'single_choice'), tingkat "difficulty", dan "sourceRefs" pada setiap soal.`;

  const prompt = `Hasil Pengerjaan Kuis: Skor ${attemptReview.score}% (${attemptReview.correctCount}/${attemptReview.totalCount})
Target Jumlah Soal Remedial: ${targetCount}

Daftar Soal yang Dijawab Salah oleh Mahasiswa:
${JSON.stringify(
  wrongQuestions.map((wq) => ({
    topicLabel: wq.topicLabel,
    learningObjective: wq.learningObjective || `Memahami ${wq.topicLabel}`,
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

Hasilkan umpan balik diagnostik dan soal remedial baru dalam JSON.`;

  return generateStructuredContent({
    taskType: 'generate_remedial',
    contents: prompt,
    systemInstruction,
    responseSchema: REMEDIAL_BATCH_JSON_SCHEMA,
    zodSchema: remedialBatchOutputSchema,
    enableGoogleSearch: true,
  });
}

export async function enqueueRemedialGeneration({
  attemptId,
  idempotencyKey,
  questionCount = null,
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

  const boundedQuestionCount = questionCount
    ? Math.min(20, Math.max(2, Number(questionCount)))
    : null;
  const config = getEnvConfig();
  const model = config.geminiModel || 'gemini-4-hydrogen';

  const cacheKey = buildCacheKey({
    operation: 'generate_remedial',
    targetType: 'attempt',
    targetId: attemptId,
    inputChecksum: computeSha256({
      attemptId,
      wrongIds: wrongQuestions.map((w) => w.questionId),
      boundedQuestionCount,
    }),
    model,
    promptVersion: 'remedial-v2',
    schemaVersion: 1,
  });

  const executeFn = async () => {
    let relevantTopicsContext = [];
    if (attemptReview.moduleId) {
      const [latestPack] = await db
        .select()
        .from(studyPacks)
        .where(eq(studyPacks.moduleId, attemptReview.moduleId))
        .orderBy(desc(studyPacks.version))
        .limit(1);

      if (latestPack?.summaryJson?.topics) {
        const wrongCanonicalSet = new Set(
          wrongQuestions.map((w) => normalizeTopicKey(w.topicLabel))
        );
        relevantTopicsContext = latestPack.summaryJson.topics.filter((t) => {
          const normT = normalizeTopicKey(t.topicLabel || '');
          return (
            wrongCanonicalSet.has(normT) ||
            Array.from(wrongCanonicalSet).some(
              (wk) => wk && normT && (normT.includes(wk) || wk.includes(normT))
            )
          );
        });
        if (relevantTopicsContext.length === 0) {
          relevantTopicsContext = latestPack.summaryJson.topics.slice(0, 3);
        }
      }
    }

    const canonicalWrongLabels = Array.from(
      new Set([
        ...wrongQuestions.map((w) => w.topicLabel).filter(Boolean),
        ...relevantTopicsContext.map((t) => t.topicLabel).filter(Boolean),
      ])
    );

    const aiResponse = await generatorFn({
      attemptReview,
      wrongQuestions,
      relevantTopicsContext,
      questionCount: boundedQuestionCount,
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

      const qValues = parsed.remedialQuestions.map((q, idx) => {
        const canonicalTopic = resolveCanonicalTopicLabel(q.topicLabel, canonicalWrongLabels);
        return {
          questionSetId: remedialSet.id,
          moduleId: attemptReview.moduleId,
          questionOrder: idx + 1,
          topicLabel: canonicalTopic,
          learningObjective: q.learningObjective || `Remediasi ${canonicalTopic}`,
          questionType: q.questionType || 'conceptual_application',
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
  questionCount = 40,
  difficulty = 'mixed',
}) {
  const systemInstruction = `Anda adalah pembuat latihan Simulasi UAS komprehensif Universitas Terbuka berbasis materi BMP yang telah diverifikasi.
Aturan wajib:
1. Buat TEPAT ${questionCount} soal pilihan ganda (opsi A, B, C, D) dengan distribusi yang seimbang antar modul yang dipilih.
2. Jangan membiarkan satu modul mendominasi seluruh soal.
3. Setiap soal wajib mencantumkan "moduleNumber" yang sesuai dengan modul asalnya, "topicLabel", "explanation", dan "sourceRefs".
4. Tingkat kesulitan target: ${difficulty}.
5. Untuk soal matematika/hitungan/logika simbolik, tuliskan seluruh rumus, pecahan, pangkat, himpunan, dan simbol logika pada "prompt", "options", dan "explanation" dalam notasi LaTeX standar ($...$ untuk inline dan $$...$$ untuk rumus blok) serta uraikan langkah penyelesaian step-by-step di "explanation".
6. Simulasi ini adalah latihan komprehensif dari materi yang tersedia, bukan prediksi soal UAS resmi. Jangan mengarang konsep di luar ringkasan modul yang diberikan.`;

  const prompt = `Mata Kuliah: ${courseRecord.code} - ${courseRecord.name}
Jumlah Soal Wajib: ${questionCount}
Ringkasan Kompak per Modul Terpilih:
${JSON.stringify(selectedModuleSummaries, null, 2)}

Hasilkan paket soal Simulasi UAS komprehensif (${questionCount} butir soal) dalam format JSON.`;

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
  questionCount = 40,
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

  const boundedQuestionCount = Math.min(50, Math.max(4, Number(questionCount) || 40));
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
    formulasOrProcedures: sp.summaryJson?.formulasOrProcedures || [],
    topics: (sp.summaryJson?.topics || []).map((t) => ({
      topicLabel: t.topicLabel,
      coreConcepts: t.coreConcepts || [],
      bmpSummary: t.bmpSummary || t.detailedExplanation || '',
      sourceRefs: t.sourceRefs,
    })),
  }));

  const config = getEnvConfig();
  const model = config.geminiModel || 'gemini-4-hydrogen';

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
          learningObjective: q.learningObjective || `Memahami ${q.topicLabel}`,
          questionType: q.questionType || 'scenario_based',
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
