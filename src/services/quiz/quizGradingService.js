import { eq, asc, desc, and, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import {
  modules,
  questionSets,
  questions,
  quizAttempts,
  attemptAnswers,
} from '../../db/schema.js';
import { submitAttemptPayloadSchema } from './quizSchemas.js';
import { evaluateAndUpdateModuleStatus } from './topicMastery.js';

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
      learningObjective: questions.learningObjective,
      questionType: questions.questionType,
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
      learningObjective: q.learningObjective || `Memahami ${q.topicLabel}`,
      questionType: q.questionType || 'single_choice',
      prompt: q.prompt,
      options: q.optionsJson,
      difficulty: q.difficulty,
      sourceRefs: q.sourceRefsJson,
    })),
    attempts: pastAttempts,
  };
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
    await tx
      .delete(quizAttempts)
      .where(and(eq(quizAttempts.questionSetId, questionSetId), eq(quizAttempts.status, 'in_progress')));

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
        answersJson: payload.answers,
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

export async function saveQuizDraft(questionSetId, { selections = {} } = {}) {
  const db = getDb();
  const now = new Date();

  const [existingDraft] = await db
    .select()
    .from(quizAttempts)
    .where(and(eq(quizAttempts.questionSetId, questionSetId), eq(quizAttempts.status, 'in_progress')))
    .limit(1);

  if (existingDraft) {
    const [updated] = await db
      .update(quizAttempts)
      .set({
        answersJson: selections,
        startedAt: now,
      })
      .where(eq(quizAttempts.id, existingDraft.id))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(quizAttempts)
    .values({
      questionSetId,
      startedAt: now,
      submittedAt: null,
      score: 0,
      correctCount: 0,
      totalCount: 0,
      status: 'in_progress',
      answersJson: selections,
    })
    .returning();

  return created;
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

    const tStat = topicStatsMap.get(q.topicLabel) || {
      topicLabel: q.topicLabel,
      correct: 0,
      total: 0,
    };
    tStat.total += 1;
    if (isCorrect) tStat.correct += 1;
    topicStatsMap.set(q.topicLabel, tStat);

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
      learningObjective: q.learningObjective || `Memahami ${q.topicLabel}`,
      questionType: q.questionType || 'single_choice',
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
