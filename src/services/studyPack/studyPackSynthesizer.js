import { eq, asc, desc, and, ne } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import {
  courses,
  modules,
  sourceAssets,
  studyPacks,
  questionSets,
  questions,
} from '../../db/schema.js';
import { getEnvConfig } from '../../config/env.js';
import { buildCacheKey, computeSha256 } from '../aiRetry.js';
import { generateStructuredContent } from '../geminiClient.js';
import {
  studyPackSynthesisSchema,
  practiceQuestionSetOutputSchema,
  kbMaterialBatchSchema,
  STUDY_PACK_SYNTHESIS_JSON_SCHEMA,
  PRACTICE_QUESTIONS_JSON_SCHEMA,
  KB_MATERIAL_BATCH_JSON_SCHEMA,
  validateAndAlignStudyPack,
} from './studyPackSchemas.js';
import {
  detectModuleKbStructure,
  countDistinctKbsInTopics,
  resolveFixedQuestionCountByKb,
  planKbBatches,
  validateStudyPackCoverage,
  formatSourceBlocks,
  buildSystemInstruction,
} from './kbPlanner.js';

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

export async function defaultTwoStageStudyPackSynthesizer({
  courseRecord,
  moduleRecord,
  reviewedSources,
  prerequisiteConcepts = [],
  questionCount,
}) {
  const kbStructure = detectModuleKbStructure(reviewedSources);
  const fixedQuestionCount =
    Number(questionCount) || resolveFixedQuestionCountByKb(kbStructure.length);
  const batches = planKbBatches(kbStructure);

  const prereqText =
    prerequisiteConcepts.length > 0
      ? `\nKonteks Konsep Modul Sebelumnya (hanya sebagai jembatan konteks, BUKAN sumber soal modul ini):\n${JSON.stringify(prerequisiteConcepts)}`
      : '';

  const allKbTitles = kbStructure.map((kb) => `KB ${kb.kbNumber}: ${kb.title}`).join(', ');
  const batchResults = [];
  const accumulatedUsage = {
    promptTokenCount: 0,
    candidatesTokenCount: 0,
    thoughtsTokenCount: 0,
    toolUsePromptTokenCount: 0,
    cachedContentTokenCount: 0,
    totalTokenCount: 0,
  };
  let hasUsageMetadata = false;
  let lastModel = null;
  let anySearchGrounding = false;

  for (let bIdx = 0; bIdx < batches.length; bIdx++) {
    const batch = batches[bIdx];
    const batchSources = batch.kbs.flatMap((kb) => kb.sources);
    const batchKbTitles = batch.kbs.map((kb) => `Kegiatan Belajar ${kb.kbNumber}`).join(' & ');
    const sourceBlocks = formatSourceBlocks(batchSources);

    const isFinal = batch.isFinalBatch;
    const systemInstruction = buildSystemInstruction({
      isFinalBatch: isFinal,
      totalQuestionCount: fixedQuestionCount,
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
    ? `4. Rancang TEPAT ${fixedQuestionCount} butir soal latihan awal ("initialQuestions") yang proporsional menguji seluruh Kegiatan Belajar pada modul ini (${allKbTitles}), selaras dengan materi yang telah disusun.`
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

    if (aiRes?.usageMetadata && typeof aiRes.usageMetadata === 'object') {
      hasUsageMetadata = true;
      const u = aiRes.usageMetadata;
      accumulatedUsage.promptTokenCount += Number(u.promptTokenCount ?? u.inputTokens ?? 0) || 0;
      accumulatedUsage.candidatesTokenCount += Number(u.candidatesTokenCount ?? u.outputTokens ?? 0) || 0;
      accumulatedUsage.thoughtsTokenCount += Number(u.thoughtsTokenCount ?? u.thinkingTokens ?? 0) || 0;
      accumulatedUsage.toolUsePromptTokenCount += Number(u.toolUsePromptTokenCount ?? 0) || 0;
      accumulatedUsage.cachedContentTokenCount += Number(u.cachedContentTokenCount ?? u.cachedTokens ?? 0) || 0;
      accumulatedUsage.totalTokenCount += Number(u.totalTokenCount ?? u.totalTokens ?? 0) || 0;
    }
    if (aiRes?.model) lastModel = aiRes.model;
    if (aiRes?.searchGroundingUsed) anySearchGrounding = true;

    batchResults.push(aiRes.data);
  }

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
  return {
    data: validated,
    usageMetadata: hasUsageMetadata ? accumulatedUsage : null,
    model: lastModel,
    searchGroundingUsed: anySearchGrounding,
  };
}

export async function defaultStudyPackSynthesizer(params) {
  return defaultTwoStageStudyPackSynthesizer(params);
}

export async function enqueueStudyPackSynthesis({
  moduleId,
  idempotencyKey,
  questionCount,
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

  const detectedKbs = detectModuleKbStructure(extractedSources);
  const autoFixedQuestionCount = resolveFixedQuestionCountByKb(detectedKbs.length);
  const boundedQuestionCount =
    questionCount !== undefined && questionCount !== null && questionCount !== ''
      ? Math.min(25, Math.max(3, Number(questionCount) || autoFixedQuestionCount))
      : autoFixedQuestionCount;
  const config = getEnvConfig();
  const model = config.geminiModel || 'gemini-4-hydrogen';

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
2. Setiap butir soal WAJIB menguji konsep atau rumus yang dijelaskan dalam materi Study Pack. Jangan menguji konsep yang tidak ada di dalam materi.
3. Sertakan "topicLabel", "learningObjective", "questionType" ('single_choice', 'conceptual_application', 'scenario_based'), "difficulty", "sourceRefs", dan "explanation" pada setiap butir soal.
4. Untuk soal matematika/hitungan/logika simbolik, tuliskan seluruh rumus, pecahan, pangkat, himpunan, dan simbol logika pada "prompt", "options", dan "explanation" menggunakan notasi LaTeX standar ($...$ untuk inline dan $$...$$ untuk rumus blok), serta sertakan langkah perhitungan/pembuktian step-by-step di "explanation".
5. Untuk soal Algoritma / Flowchart, Anda BOLEH menyisipkan diagram alir dengan blok \`\`\`flowchart ... \`\`\` (sintaks: \`([Terminator])\`, \`[Proses]\`, \`[/Input-Output/]\`, \`{Keputusan}\`, \`-->\`, \`-->|label|\`) pada "prompt", "options", atau "explanation" — aplikasi akan otomatis merendernya menjadi diagram SVG.`;

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
  questionCount,
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

  const detectedSourceKbs =
    extractedSources.length > 0 ? detectModuleKbStructure(extractedSources).length : 0;

  const packTopicsCount =
    detectedSourceKbs ||
    latestPack.summaryJson?.coverageReport?.totalKbsDetected ||
    countDistinctKbsInTopics(latestPack.summaryJson?.topics || []) ||
    1;
  const fixedPracticeCount = resolveFixedQuestionCountByKb(packTopicsCount);
  const boundedCount =
    questionCount !== undefined && questionCount !== null && questionCount !== ''
      ? Math.min(25, Math.max(3, Number(questionCount) || fixedPracticeCount))
      : fixedPracticeCount;
  const config = getEnvConfig();
  const model = config.geminiModel || 'gemini-4-hydrogen';

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

      const packTopics = (latestPack.summaryJson?.topics || [])
        .map((t) => String(t.topicLabel || t.title || '').trim())
        .filter(Boolean);

      const qValues = parsed.questions.map((q, idx) => {
        const rawTopic = String(q.topicLabel || '').trim();
        const normQ = rawTopic
          .toLowerCase()
          .replace(/^(?:kegiatan\s*belajar|kb)\s*\d+\s*[:.\-–—]?\s*/i, '')
          .trim();
        const matchedPackTopic =
          packTopics.find((pt) => pt.toLowerCase() === rawTopic.toLowerCase()) ||
          packTopics.find((pt) => {
            const normPt = pt
              .toLowerCase()
              .replace(/^(?:kegiatan\s*belajar|kb)\s*\d+\s*[:.\-–—]?\s*/i, '')
              .trim();
            return normPt && normQ && (normPt.includes(normQ) || normQ.includes(normPt));
          }) ||
          rawTopic;

        return {
          questionSetId: createdSet.id,
          moduleId,
          questionOrder: idx + 1,
          topicLabel: matchedPackTopic,
          learningObjective: q.learningObjective || `Menerapkan konsep ${matchedPackTopic}`,
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
