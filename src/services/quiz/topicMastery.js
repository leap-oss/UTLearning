import { eq, asc, desc, and, or, inArray, ne } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import {
  courses,
  modules,
  studyPacks,
  questionSets,
  questions,
  quizAttempts,
  attemptAnswers,
} from '../../db/schema.js';

export const WEAK_TOPIC_THRESHOLD = 75;
export const MASTERY_SCORE_THRESHOLD = 80;

export function normalizeTopicKey(rawLabel) {
  return String(rawLabel || '')
    .trim()
    .toLowerCase()
    .replace(/^(?:remedial|topik|materi)\s*[:\-–—]\s*/i, '')
    .replace(/^(?:kegiatan\s*belajar|kb)\s*\d+\s*[:.\-–—]?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const TOPIC_STOPWORDS = new Set([
  'dan', 'atau', 'yang', 'dalam', 'pada', 'untuk', 'dari', 'dengan', 'menurut',
  'tentang', 'sebagai', 'melalui', 'serta', 'konsep', 'dasar', 'pengertian',
  'materi', 'topik', 'modul', 'kegiatan', 'belajar',
]);

function extractTopicTokens(str) {
  return normalizeTopicKey(str)
    .replace(/[^a-z0-9\s]/gi, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !TOPIC_STOPWORDS.has(w));
}

export function resolveCanonicalTopicLabel(rawLabel, canonicalLabels = []) {
  const trimmed = String(rawLabel || '').trim() || 'Topik Utama';
  if (!Array.isArray(canonicalLabels) || canonicalLabels.length === 0) {
    return trimmed;
  }

  const exactMatch = canonicalLabels.find(
    (c) => String(c || '').trim().toLowerCase() === trimmed.toLowerCase()
  );
  if (exactMatch) return exactMatch;

  const normTarget = normalizeTopicKey(trimmed);
  if (!normTarget) return trimmed;

  for (const candidate of canonicalLabels) {
    const normCand = normalizeTopicKey(candidate);
    if (
      normCand &&
      (normCand === normTarget ||
        normCand.includes(normTarget) ||
        normTarget.includes(normCand))
    ) {
      return candidate;
    }
  }

  const targetTokens = extractTopicTokens(trimmed);
  if (targetTokens.length > 0) {
    let bestCandidate = null;
    let bestScore = 0;

    for (const candidate of canonicalLabels) {
      const candTokens = extractTopicTokens(candidate);
      if (candTokens.length === 0) continue;

      let matched = 0;
      for (const tt of targetTokens) {
        if (
          candTokens.some(
            (ct) => ct === tt || (ct.length >= 4 && tt.length >= 4 && (ct.startsWith(tt) || tt.startsWith(ct)))
          )
        ) {
          matched += 1;
        }
      }

      const ratio = matched / targetTokens.length;
      if ((matched >= 2 || ratio >= 0.5) && ratio > bestScore) {
        bestScore = ratio;
        bestCandidate = candidate;
      }
    }

    if (bestCandidate) {
      return bestCandidate;
    }
  }

  return trimmed;
}

export function computeTopicProgressFromAnswers(answerRows = [], canonicalLabels = []) {
  const topicBuckets = new Map();
  const discoveredLabels = [...canonicalLabels];

  for (const ans of answerRows) {
    const resolvedLabel = resolveCanonicalTopicLabel(ans.topicLabel, discoveredLabels);
    if (!discoveredLabels.includes(resolvedLabel)) {
      discoveredLabels.push(resolvedLabel);
    }

    let bucket = topicBuckets.get(resolvedLabel);
    if (!bucket) {
      bucket = {
        topicLabel: resolvedLabel,
        cumAnswered: 0,
        cumCorrect: 0,
        byAttempt: new Map(),
      };
      topicBuckets.set(resolvedLabel, bucket);
    }

    bucket.cumAnswered += 1;
    if (ans.isCorrect) bucket.cumCorrect += 1;

    const attKey = ans.attemptId || 'default';
    let attEntry = bucket.byAttempt.get(attKey);
    if (!attEntry) {
      attEntry = {
        attemptId: attKey,
        submittedAt: ans.submittedAt ? new Date(ans.submittedAt).getTime() : 0,
        answeredCount: 0,
        correctCount: 0,
      };
      bucket.byAttempt.set(attKey, attEntry);
    }
    attEntry.answeredCount += 1;
    if (ans.isCorrect) attEntry.correctCount += 1;
  }

  return Array.from(topicBuckets.values()).map((bucket) => {
    const cumPct =
      bucket.cumAnswered > 0 ? Math.round((bucket.cumCorrect / bucket.cumAnswered) * 100) : 0;

    const attemptStats = Array.from(bucket.byAttempt.values()).sort(
      (a, b) => b.submittedAt - a.submittedAt
    );
    const latestAtt = attemptStats[0];
    const latestPct =
      latestAtt && latestAtt.answeredCount > 0
        ? Math.round((latestAtt.correctCount / latestAtt.answeredCount) * 100)
        : cumPct;

    if (latestAtt && attemptStats.length > 1 && latestPct >= cumPct) {
      return {
        topicLabel: bucket.topicLabel,
        answeredCount: latestAtt.answeredCount,
        correctCount: latestAtt.correctCount,
        accuracyPercent: latestPct,
      };
    }

    return {
      topicLabel: bucket.topicLabel,
      answeredCount: bucket.cumAnswered,
      correctCount: bucket.cumCorrect,
      accuracyPercent: cumPct,
    };
  });
}

export async function evaluateAndUpdateModuleStatus(tx, moduleId) {
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
    .where(
      and(
        inArray(quizAttempts.questionSetId, qSetIds),
        eq(quizAttempts.status, 'submitted')
      )
    )
    .orderBy(desc(quizAttempts.submittedAt));

  if (attempts.length === 0) return;

  const latestAttempt = attempts[0];
  const hasMasteryAttempt = attempts.some((a) => a.score >= MASTERY_SCORE_THRESHOLD);

  let nextStatus = 'in_progress';
  if (hasMasteryAttempt) {
    nextStatus = 'mastered';
  } else {
    const answerRows = await tx
      .select({
        attemptId: attemptAnswers.attemptId,
        submittedAt: quizAttempts.submittedAt,
        topicLabel: questions.topicLabel,
        isCorrect: attemptAnswers.isCorrect,
      })
      .from(attemptAnswers)
      .innerJoin(quizAttempts, eq(attemptAnswers.attemptId, quizAttempts.id))
      .innerJoin(questions, eq(attemptAnswers.questionId, questions.id))
      .where(
        and(
          inArray(quizAttempts.questionSetId, qSetIds),
          eq(quizAttempts.status, 'submitted')
        )
      );

    const topicProgress = computeTopicProgressFromAnswers(answerRows);
    const weakTopics = topicProgress.filter((t) => t.accuracyPercent < WEAK_TOPIC_THRESHOLD);

    if (latestAttempt.score < MASTERY_SCORE_THRESHOLD || weakTopics.length > 0) {
      nextStatus = 'needs_review';
    }
  }

  const now = new Date();
  const [updatedMod] = await tx
    .update(modules)
    .set({ status: nextStatus, updatedAt: now })
    .where(eq(modules.id, moduleId))
    .returning();

  if (updatedMod?.courseId) {
    await tx
      .update(courses)
      .set({ updatedAt: now })
      .where(eq(courses.id, updatedMod.courseId));
  }
}

export async function getModuleProgress(moduleId) {
  const db = getDb();

  const [modSetAttemptRows, packRows, answerRows] = await Promise.all([
    db
      .select({
        mod: modules,
        qSet: questionSets,
        attempt: quizAttempts,
      })
      .from(modules)
      .leftJoin(questionSets, eq(questionSets.moduleId, modules.id))
      .leftJoin(
        quizAttempts,
        and(
          eq(quizAttempts.questionSetId, questionSets.id),
          eq(quizAttempts.status, 'submitted')
        )
      )
      .where(eq(modules.id, moduleId))
      .orderBy(desc(questionSets.createdAt), desc(quizAttempts.submittedAt)),
    db
      .select({
        summaryJson: studyPacks.summaryJson,
        version: studyPacks.version,
      })
      .from(studyPacks)
      .where(eq(studyPacks.moduleId, moduleId))
      .orderBy(desc(studyPacks.version))
      .limit(1),
    db
      .select({
        attemptId: attemptAnswers.attemptId,
        submittedAt: quizAttempts.submittedAt,
        topicLabel: questions.topicLabel,
        isCorrect: attemptAnswers.isCorrect,
      })
      .from(attemptAnswers)
      .innerJoin(quizAttempts, eq(attemptAnswers.attemptId, quizAttempts.id))
      .innerJoin(questions, eq(attemptAnswers.questionId, questions.id))
      .innerJoin(questionSets, eq(questions.questionSetId, questionSets.id))
      .where(
        and(
          eq(questionSets.moduleId, moduleId),
          eq(quizAttempts.status, 'submitted')
        )
      ),
  ]);

  if (modSetAttemptRows.length === 0) return null;

  const mod = modSetAttemptRows[0].mod;
  const qSetTitleMap = new Map();
  const attemptsMap = new Map();

  for (const row of modSetAttemptRows) {
    if (row.qSet && !qSetTitleMap.has(row.qSet.id)) {
      qSetTitleMap.set(row.qSet.id, {
        title: row.qSet.title,
        setType: row.qSet.setType,
      });
    }
    if (row.attempt && row.attempt.status === 'submitted' && !attemptsMap.has(row.attempt.id)) {
      attemptsMap.set(row.attempt.id, row.attempt);
    }
  }

  const attempts = Array.from(attemptsMap.values()).sort(
    (a, b) => new Date(b.submittedAt || 0).getTime() - new Date(a.submittedAt || 0).getTime()
  );

  const hasMasteryAttempt = attempts.some((a) => a.score >= MASTERY_SCORE_THRESHOLD);
  if (mod.status !== 'archived' && hasMasteryAttempt && mod.status !== 'mastered') {
    await db
      .update(modules)
      .set({ status: 'mastered', updatedAt: new Date() })
      .where(eq(modules.id, mod.id));
    mod.status = 'mastered';
  }

  const canonicalTopics = (packRows[0]?.summaryJson?.topics || [])
    .map((t) => t.topicLabel || t.title)
    .filter(Boolean);

  const topicProgress = computeTopicProgressFromAnswers(answerRows, canonicalTopics);
  const bestScore =
    attempts.length > 0 ? Math.max(...attempts.map((a) => a.score)) : null;

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
    bestScore,
    attempts: attempts.map((a) => ({
      ...a,
      questionSetTitle: qSetTitleMap.get(a.questionSetId)?.title || 'Kuis',
      setType: qSetTitleMap.get(a.questionSetId)?.setType || 'initial',
    })),
    topicProgress,
    weakTopics: topicProgress.filter((t) => t.accuracyPercent < WEAK_TOPIC_THRESHOLD),
  };
}

export async function getCourseProgress(courseId) {
  const db = getDb();

  const courseModRows = await db
    .select({
      course: courses,
      mod: modules,
    })
    .from(courses)
    .leftJoin(
      modules,
      and(eq(modules.courseId, courses.id), ne(modules.status, 'archived'))
    )
    .where(eq(courses.id, courseId))
    .orderBy(asc(modules.moduleNumber));

  if (courseModRows.length === 0) return null;

  const course = courseModRows[0].course;
  const courseModules = courseModRows.map((r) => r.mod).filter(Boolean);
  const modIds = courseModules.map((m) => m.id);

  const qSetCondition =
    modIds.length > 0
      ? or(eq(questionSets.courseId, courseId), inArray(questionSets.moduleId, modIds))
      : eq(questionSets.courseId, courseId);

  const [qSetAttemptRows, packRows, answerRows] = await Promise.all([
    db
      .select({
        qSet: questionSets,
        attempt: quizAttempts,
      })
      .from(questionSets)
      .leftJoin(
        quizAttempts,
        and(
          eq(quizAttempts.questionSetId, questionSets.id),
          eq(quizAttempts.status, 'submitted')
        )
      )
      .where(qSetCondition)
      .orderBy(desc(questionSets.createdAt), desc(quizAttempts.submittedAt)),
    modIds.length > 0
      ? db
          .select({
            id: studyPacks.id,
            moduleId: studyPacks.moduleId,
            version: studyPacks.version,
            summaryJson: studyPacks.summaryJson,
          })
          .from(studyPacks)
          .where(inArray(studyPacks.moduleId, modIds))
          .orderBy(desc(studyPacks.version))
      : Promise.resolve([]),
    modIds.length > 0
      ? db
          .select({
            moduleId: questionSets.moduleId,
            attemptId: attemptAnswers.attemptId,
            submittedAt: quizAttempts.submittedAt,
            topicLabel: questions.topicLabel,
            isCorrect: attemptAnswers.isCorrect,
          })
          .from(attemptAnswers)
          .innerJoin(quizAttempts, eq(attemptAnswers.attemptId, quizAttempts.id))
          .innerJoin(questions, eq(attemptAnswers.questionId, questions.id))
          .innerJoin(questionSets, eq(questions.questionSetId, questionSets.id))
          .where(
            and(
              inArray(questionSets.moduleId, modIds),
              eq(quizAttempts.status, 'submitted')
            )
          )
      : Promise.resolve([]),
  ]);

  const latestPackByMod = new Map();
  for (const p of packRows) {
    if (!latestPackByMod.has(p.moduleId)) {
      latestPackByMod.set(p.moduleId, p);
    }
  }

  const qSetsById = new Map();
  const attemptsBySetId = new Map();
  for (const row of qSetAttemptRows) {
    const qs = row.qSet;
    if (!qSetsById.has(qs.id)) {
      qSetsById.set(qs.id, qs);
    }
    if (row.attempt && row.attempt.status === 'submitted') {
      let list = attemptsBySetId.get(qs.id);
      if (!list) {
        list = [];
        attemptsBySetId.set(qs.id, list);
      }
      if (!list.some((a) => a.id === row.attempt.id)) {
        list.push(row.attempt);
      }
    }
  }

  const answersByMod = new Map();
  for (const ans of answerRows) {
    if (!ans.moduleId) continue;
    let list = answersByMod.get(ans.moduleId);
    if (!list) {
      list = [];
      answersByMod.set(ans.moduleId, list);
    }
    list.push(ans);
  }

  const modsToMarkMastered = [];
  const moduleBreakdown = courseModules.map((mod) => {
    const modQSets = [];
    for (const qs of qSetsById.values()) {
      if (qs.moduleId === mod.id) {
        modQSets.push(qs);
      }
    }

    const qSetTitleMap = new Map(
      modQSets.map((s) => [s.id, { title: s.title, setType: s.setType }])
    );

    const modAttempts = [];
    for (const qs of modQSets) {
      const list = attemptsBySetId.get(qs.id) || [];
      for (const a of list) {
        modAttempts.push(a);
      }
    }
    modAttempts.sort(
      (a, b) => new Date(b.submittedAt || 0).getTime() - new Date(a.submittedAt || 0).getTime()
    );

    const hasMasteryAttempt = modAttempts.some((a) => a.score >= MASTERY_SCORE_THRESHOLD);
    if (mod.status !== 'archived' && hasMasteryAttempt && mod.status !== 'mastered') {
      mod.status = 'mastered';
      modsToMarkMastered.push(mod.id);
    }

    const latestPack = latestPackByMod.get(mod.id);
    const canonicalTopics = (latestPack?.summaryJson?.topics || [])
      .map((t) => t.topicLabel || t.title)
      .filter(Boolean);

    const topicProgress = computeTopicProgressFromAnswers(
      answersByMod.get(mod.id) || [],
      canonicalTopics
    );
    const bestScore =
      modAttempts.length > 0 ? Math.max(...modAttempts.map((a) => a.score)) : null;

    return {
      moduleId: mod.id,
      moduleNumber: mod.moduleNumber,
      title: mod.title,
      status: mod.status,
      attemptCount: modAttempts.length,
      averageScore:
        modAttempts.length > 0
          ? Math.round(modAttempts.reduce((sum, a) => sum + a.score, 0) / modAttempts.length)
          : null,
      latestScore: modAttempts[0]?.score ?? null,
      bestScore,
      attempts: modAttempts.map((a) => ({
        ...a,
        questionSetTitle: qSetTitleMap.get(a.questionSetId)?.title || 'Kuis',
        setType: qSetTitleMap.get(a.questionSetId)?.setType || 'initial',
      })),
      topicProgress,
      weakTopics: topicProgress.filter((t) => t.accuracyPercent < WEAK_TOPIC_THRESHOLD),
      hasVerifiedStudyPack: Boolean(latestPack),
      latestStudyPackVersion: latestPack?.version ?? null,
    };
  });

  if (modsToMarkMastered.length > 0) {
    await db
      .update(modules)
      .set({ status: 'mastered', updatedAt: new Date() })
      .where(inArray(modules.id, modsToMarkMastered));
  }

  const examSimulations = [];
  for (const qs of qSetsById.values()) {
    if (qs.courseId === courseId && qs.setType === 'exam_simulation') {
      const simAttempts = (attemptsBySetId.get(qs.id) || []).slice().sort(
        (a, b) => new Date(b.submittedAt || 0).getTime() - new Date(a.submittedAt || 0).getTime()
      );
      examSimulations.push({
        id: qs.id,
        title: qs.title,
        metadata: qs.metadataJson || {},
        createdAt: qs.createdAt,
        attempts: simAttempts,
      });
    }
  }

  return {
    courseId: course.id,
    code: course.code,
    name: course.name,
    expectedModuleCount: course.expectedModuleCount,
    modules: moduleBreakdown,
    examSimulations,
  };
}
