import { asc, desc, eq, ne } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import {
  courses,
  modules,
  sourceAssets,
  studyPacks,
  questionSets,
  quizAttempts,
} from '../db/schema.js';
import { computeFreshnessInfo } from './quiz/topicMastery.js';

export const DEFAULT_STUDY_TIMEZONE = 'Asia/Jakarta';

function resolveValidTimeZone(rawTimeZone) {
  const candidate = String(rawTimeZone || DEFAULT_STUDY_TIMEZONE).trim() || DEFAULT_STUDY_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: candidate });
    return candidate;
  } catch {
    return DEFAULT_STUDY_TIMEZONE;
  }
}

/**
 * Formats a date into a YYYY-MM-DD calendar key in the user's time zone.
 */
export function toCalendarDateKey(dateInput, timeZone = DEFAULT_STUDY_TIMEZONE) {
  const date = new Date(dateInput);
  if (Number.isNaN(date.getTime())) return null;
  const tz = resolveValidTimeZone(timeZone);
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * Shifts a YYYY-MM-DD calendar date key by deltaDays without DST skew.
 */
export function shiftCalendarDateKey(dateKey, deltaDays) {
  const [y, m, d] = String(dateKey || '')
    .split('-')
    .map((n) => Number.parseInt(n, 10));
  if (!y || !m || !d) return null;
  const shifted = new Date(Date.UTC(y, m - 1, d + deltaDays));
  const yy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function shortWeekdayLabel(dateKey) {
  const [y, m, d] = dateKey.split('-').map((n) => Number.parseInt(n, 10));
  const utc = new Date(Date.UTC(y, m - 1, d));
  try {
    return new Intl.DateTimeFormat('id-ID', {
      weekday: 'short',
      timeZone: 'UTC',
    }).format(utc);
  } catch {
    return dateKey.slice(5);
  }
}

/**
 * Computes real study streak and 7-day momentum directly from submitted quiz timestamps.
 */
export function computeStudyStreak(
  submittedAtList,
  { timeZone = DEFAULT_STUDY_TIMEZONE, referenceDate = new Date() } = {}
) {
  const tz = resolveValidTimeZone(timeZone);
  const countsByDate = new Map();

  for (const rawTs of submittedAtList || []) {
    if (!rawTs) continue;
    const key = toCalendarDateKey(rawTs, tz);
    if (!key) continue;
    countsByDate.set(key, (countsByDate.get(key) || 0) + 1);
  }

  const todayKey = toCalendarDateKey(referenceDate, tz);
  const yesterdayKey = shiftCalendarDateKey(todayKey, -1);
  const todayDoneCount = countsByDate.get(todayKey) || 0;
  const studiedToday = todayDoneCount > 0;

  let currentStreakDays = 0;
  let cursorKey = studiedToday ? todayKey : countsByDate.has(yesterdayKey) ? yesterdayKey : null;
  while (cursorKey && countsByDate.has(cursorKey)) {
    currentStreakDays += 1;
    cursorKey = shiftCalendarDateKey(cursorKey, -1);
  }

  const sortedDates = Array.from(countsByDate.keys()).sort();
  let bestStreakDays = 0;
  let running = 0;
  let prevKey = null;
  for (const key of sortedDates) {
    if (prevKey && shiftCalendarDateKey(prevKey, 1) === key) {
      running += 1;
    } else {
      running = 1;
    }
    if (running > bestStreakDays) {
      bestStreakDays = running;
    }
    prevKey = key;
  }

  const activeDaysLast7 = [];
  for (let offset = -6; offset <= 0; offset += 1) {
    const key = shiftCalendarDateKey(todayKey, offset);
    activeDaysLast7.push({
      dateKey: key,
      dayLabel: shortWeekdayLabel(key),
      count: countsByDate.get(key) || 0,
      isToday: offset === 0,
    });
  }

  return {
    currentStreakDays,
    bestStreakDays,
    studiedToday,
    todayDoneCount,
    totalActiveDays: countsByDate.size,
    activeDaysLast7,
  };
}

function buildFocusSlot(slotType, badgeLabel, candidate, config) {
  return {
    slotType,
    badgeLabel,
    durationHint: config.durationHint,
    courseId: candidate.courseId,
    courseCode: candidate.courseCode,
    courseName: candidate.courseName,
    moduleId: candidate.moduleId,
    moduleNumber: candidate.moduleNumber,
    moduleTitle: candidate.moduleTitle,
    headline: config.headline,
    reason: config.reason,
    actionType: config.actionType,
    ctaLabel: config.ctaLabel,
    secondaryActionType: config.secondaryActionType || null,
    secondaryCtaLabel: config.secondaryCtaLabel || null,
    questionSetId: config.questionSetId || null,
    daysSinceLastAttempt: candidate.daysSinceLastAttempt,
  };
}

/**
 * Curates up to 3 varied, low-friction daily focus missions from module readiness candidates.
 * Never throws a 0-attempt reader directly into a quiz as primary action before reading the Study Pack.
 */
export function selectDailyFocusSlots(candidates = []) {
  const slots = [];
  const usedModuleIds = new Set();
  const usedCourseIds = new Set();

  const pickFirst = (list, comparator) => {
    const filtered = list.filter((c) => !usedModuleIds.has(c.moduleId));
    if (filtered.length === 0) return null;
    if (comparator) {
      filtered.sort(comparator);
    }
    return filtered[0];
  };

  // Slot 1: Urgent / Quick Win (needs_review -> stale mastered warmup -> ready sources needing Study Pack -> unreviewed sources)
  const needsReviewReady = pickFirst(
    candidates.filter((c) => c.status === 'needs_review' && c.preferredQuestionSetId),
    (a, b) => (a.latestScore ?? 0) - (b.latestScore ?? 0) || a.moduleNumber - b.moduleNumber
  );
  if (needsReviewReady) {
    usedModuleIds.add(needsReviewReady.moduleId);
    usedCourseIds.add(needsReviewReady.courseId);
    slots.push(
      buildFocusSlot('quick_win', 'Target Cepat', needsReviewReady, {
        durationHint: '10–15 mnt',
        headline: `Pulihkan ${needsReviewReady.courseCode} Modul ${needsReviewReady.moduleNumber}`,
        reason:
          typeof needsReviewReady.latestScore === 'number'
            ? `Skor terakhir ${needsReviewReady.latestScore}% (target >= 80%). Ulangi latihan untuk mengunci penguasaan.`
            : 'Terdapat topik di bawah batas 75%. Selesaikan 1 sesi latihan fokus.',
        actionType: 'start_quiz',
        ctaLabel: 'Kerjakan Kuis',
        questionSetId: needsReviewReady.preferredQuestionSetId,
      })
    );
  } else {
    const staleMastered = pickFirst(
      candidates.filter((c) => c.needsFreshnessWarmup && c.hasAnyQuestions),
      (a, b) => (b.daysSinceLastAttempt ?? 0) - (a.daysSinceLastAttempt ?? 0)
    );
    if (staleMastered) {
      usedModuleIds.add(staleMastered.moduleId);
      usedCourseIds.add(staleMastered.courseId);
      slots.push(
        buildFocusSlot('quick_win', 'Segarkan Ingatan', staleMastered, {
          durationHint: '5 mnt · Gratis AI',
          headline: `Pemanasan Kilat ${staleMastered.courseCode} Modul ${staleMastered.moduleNumber}`,
          reason: `Sudah ${staleMastered.daysSinceLastAttempt} hari sejak latihan terakhir. Uji 5 soal acak agar ingatan tetap tajam menuju UAS.`,
          actionType: 'start_warmup',
          ctaLabel: 'Pemanasan 5 soal',
        })
      );
    } else {
      const readyForPack = pickFirst(
        candidates.filter((c) => c.sourceCount > 0 && c.unreviewedSourceCount === 0 && !c.hasStudyPack),
        (a, b) => b.courseCompletionRatio - a.courseCompletionRatio || a.moduleNumber - b.moduleNumber
      );
      if (readyForPack) {
        usedModuleIds.add(readyForPack.moduleId);
        usedCourseIds.add(readyForPack.courseId);
        slots.push(
          buildFocusSlot('quick_win', 'Siap Disusun', readyForPack, {
            durationHint: '5 mnt',
            headline: `Susun Study Pack ${readyForPack.courseCode} Modul ${readyForPack.moduleNumber}`,
            reason: `${readyForPack.sourceCount} halaman BMP sudah terverifikasi dan siap dirangkum menjadi bahan belajar + kuis.`,
            actionType: 'open_module_study',
            ctaLabel: 'Susun Study Pack',
          })
        );
      } else {
        const needsVerify = pickFirst(
          candidates.filter((c) => c.unreviewedSourceCount > 0),
          (a, b) => a.moduleNumber - b.moduleNumber
        );
        if (needsVerify) {
          usedModuleIds.add(needsVerify.moduleId);
          usedCourseIds.add(needsVerify.courseId);
          slots.push(
            buildFocusSlot('quick_win', 'Perlu Verifikasi', needsVerify, {
              durationHint: '5–10 mnt',
              headline: `Verifikasi ${needsVerify.unreviewedSourceCount} halaman ${needsVerify.courseCode} Modul ${needsVerify.moduleNumber}`,
              reason: 'Teks hasil ekstraksi sudah siap diperiksa sebelum disusun menjadi Study Pack.',
              actionType: 'open_module_sources',
              ctaLabel: 'Periksa Sumber',
            })
          );
        }
      }
    }
  }

  // Slot 2: Focus Conquest (Closest-to-100% course first; read Study Pack first when 0 attempts!)
  const zeroAttemptConquest = pickFirst(
    candidates.filter(
      (c) => c.hasStudyPack && c.attemptCount === 0 && c.status !== 'mastered' && c.preferredQuestionSetId
    ),
    (a, b) => b.courseCompletionRatio - a.courseCompletionRatio || a.moduleNumber - b.moduleNumber
  );
  if (zeroAttemptConquest) {
    usedModuleIds.add(zeroAttemptConquest.moduleId);
    usedCourseIds.add(zeroAttemptConquest.courseId);
    slots.push(
      buildFocusSlot('conquest', 'Hampir Tuntas · 0 Percobaan', zeroAttemptConquest, {
        durationHint: '15–20 mnt',
        headline: `Pelajari ${zeroAttemptConquest.courseCode} Modul ${zeroAttemptConquest.moduleNumber}`,
        reason: `Study Pack siap dibaca namun belum ada percobaan kuis.${zeroAttemptConquest.courseRemainingModules > 0 ? ` Mata kuliah ini tinggal ${zeroAttemptConquest.courseRemainingModules} modul lagi menuju tuntas.` : ''} Pahami intisarinya dulu lalu uji diri di tab Kuis.`,
        actionType: 'open_module_study',
        ctaLabel: 'Baca Study Pack',
        secondaryActionType: 'start_quiz',
        secondaryCtaLabel: 'Langsung Kuis',
        questionSetId: zeroAttemptConquest.preferredQuestionSetId,
      })
    );
  } else {
    const inProgressConquest = pickFirst(
      candidates.filter((c) => c.status === 'in_progress' && c.preferredQuestionSetId),
      (a, b) => b.courseCompletionRatio - a.courseCompletionRatio || a.moduleNumber - b.moduleNumber
    );
    if (inProgressConquest) {
      usedModuleIds.add(inProgressConquest.moduleId);
      usedCourseIds.add(inProgressConquest.courseId);
      slots.push(
        buildFocusSlot('conquest', 'Lanjutkan Progres', inProgressConquest, {
          durationHint: '15 mnt',
          headline: `Tuntaskan ${inProgressConquest.courseCode} Modul ${inProgressConquest.moduleNumber}`,
          reason: 'Selesaikan kuis dengan skor minimal 80% untuk menandai modul ini Dikuasai.',
          actionType: 'start_quiz',
          ctaLabel: 'Lanjutkan Kuis',
          questionSetId: inProgressConquest.preferredQuestionSetId,
        })
      );
    }
  }

  // Fallback when Slot 1 had no urgent alerts: encourage balanced progress on another lagging course
  if (slots.length < 3) {
    const laggingCourseUnread = pickFirst(
      candidates.filter(
        (c) =>
          c.hasStudyPack &&
          c.attemptCount === 0 &&
          c.status !== 'mastered' &&
          c.preferredQuestionSetId
      ),
      (a, b) => {
        const aDiffCourse = usedCourseIds.has(a.courseId) ? 1 : 0;
        const bDiffCourse = usedCourseIds.has(b.courseId) ? 1 : 0;
        return (
          aDiffCourse - bDiffCourse ||
          a.courseCompletionRatio - b.courseCompletionRatio ||
          a.moduleNumber - b.moduleNumber
        );
      }
    );
    if (laggingCourseUnread) {
      usedModuleIds.add(laggingCourseUnread.moduleId);
      usedCourseIds.add(laggingCourseUnread.courseId);
      slots.push(
        buildFocusSlot('quick_win', 'Cicil Matkul Lain', laggingCourseUnread, {
          durationHint: '15 mnt',
          headline: `Baca ${laggingCourseUnread.courseCode} Modul ${laggingCourseUnread.moduleNumber}`,
          reason: `Supaya mata kuliah ini tidak tertinggal: baca rangkuman & cek Flashcard sebelum mencoba kuis pertamanya.`,
          actionType: 'open_module_study',
          ctaLabel: 'Baca Study Pack',
          secondaryActionType: 'start_quiz',
          secondaryCtaLabel: 'Langsung Kuis',
          questionSetId: laggingCourseUnread.preferredQuestionSetId,
        })
      );
    }
  }

  // Slot 3: Incremental BMP upload (Empty modules, 1 Kegiatan Belajar at a time)
  const emptyIncrement = pickFirst(
    candidates.filter((c) => c.status === 'empty' || c.sourceCount === 0),
    (a, b) => {
      const aStarted = a.courseCompletionRatio > 0 ? 1 : 0;
      const bStarted = b.courseCompletionRatio > 0 ? 1 : 0;
      return bStarted - aStarted || b.courseCompletionRatio - a.courseCompletionRatio || a.moduleNumber - b.moduleNumber;
    }
  );
  if (emptyIncrement && slots.length < 3) {
    usedModuleIds.add(emptyIncrement.moduleId);
    slots.push(
      buildFocusSlot('increment', 'Cicilan Ekstraksi', emptyIncrement, {
        durationHint: '10 mnt',
        headline: `Cicil BMP ${emptyIncrement.courseCode} Modul ${emptyIncrement.moduleNumber}`,
        reason: 'Modul masih kosong. Cukup foto dan ekstrak 1 Kegiatan Belajar (2–3 halaman) hari ini agar tidak menumpuk.',
        actionType: 'open_module_sources',
        ctaLabel: 'Unggah BMP',
      })
    );
  } else if (slots.length < 3) {
    const anyWarmupFallback = pickFirst(
      candidates.filter((c) => c.hasAnyQuestions),
      (a, b) => (b.daysSinceLastAttempt ?? -1) - (a.daysSinceLastAttempt ?? -1)
    );
    if (anyWarmupFallback) {
      usedModuleIds.add(anyWarmupFallback.moduleId);
      slots.push(
        buildFocusSlot('increment', 'Pemanasan Berkala', anyWarmupFallback, {
          durationHint: '5 mnt · Gratis AI',
          headline: `Pemanasan ${anyWarmupFallback.courseCode} Modul ${anyWarmupFallback.moduleNumber}`,
          reason: 'Uji 5 soal acak singkat dari bank soal modul ini untuk menjaga daya ingat tanpa kuota AI.',
          actionType: 'start_warmup',
          ctaLabel: 'Pemanasan 5 soal',
        })
      );
    }
  }

  return slots;
}

/**
 * Computes overall daily focus missions, study streak, readiness stats, and 14-day freshness decay items.
 */
export async function getDailyStudyFocus({
  referenceDate = new Date(),
  timeZone = DEFAULT_STUDY_TIMEZONE,
} = {}) {
  const db = getDb();

  const [activeCourses, activeModules, allSources, allPacks, allQuestionSets, submittedAttempts] =
    await Promise.all([
      db
        .select()
        .from(courses)
        .where(ne(courses.status, 'archived'))
        .orderBy(asc(courses.code)),
      db
        .select()
        .from(modules)
        .where(ne(modules.status, 'archived'))
        .orderBy(asc(modules.moduleNumber)),
      db
        .select({
          id: sourceAssets.id,
          moduleId: sourceAssets.moduleId,
          needsReview: sourceAssets.needsReview,
        })
        .from(sourceAssets),
      db
        .select({
          id: studyPacks.id,
          moduleId: studyPacks.moduleId,
          version: studyPacks.version,
        })
        .from(studyPacks)
        .orderBy(desc(studyPacks.version)),
      db
        .select({
          id: questionSets.id,
          moduleId: questionSets.moduleId,
          setType: questionSets.setType,
          createdAt: questionSets.createdAt,
        })
        .from(questionSets)
        .orderBy(desc(questionSets.createdAt)),
      db
        .select({
          id: quizAttempts.id,
          questionSetId: quizAttempts.questionSetId,
          score: quizAttempts.score,
          submittedAt: quizAttempts.submittedAt,
        })
        .from(quizAttempts)
        .where(eq(quizAttempts.status, 'submitted'))
        .orderBy(desc(quizAttempts.submittedAt)),
    ]);

  const courseById = new Map(activeCourses.map((c) => [c.id, c]));
  const moduleCourseCounts = new Map();
  for (const c of activeCourses) {
    moduleCourseCounts.set(c.id, {
      total: 0,
      mastered: 0,
      expected: Number(c.expectedModuleCount) || 9,
    });
  }

  for (const mod of activeModules) {
    if (!courseById.has(mod.courseId)) continue;
    const stats = moduleCourseCounts.get(mod.courseId);
    stats.total += 1;
    if (mod.status === 'mastered') {
      stats.mastered += 1;
    }
  }

  const sourcesByModule = new Map();
  for (const src of allSources) {
    const entry = sourcesByModule.get(src.moduleId) || { total: 0, unreviewed: 0 };
    entry.total += 1;
    if (src.needsReview) entry.unreviewed += 1;
    sourcesByModule.set(src.moduleId, entry);
  }

  const packByModule = new Map();
  for (const sp of allPacks) {
    if (!packByModule.has(sp.moduleId)) {
      packByModule.set(sp.moduleId, sp);
    }
  }

  const qSetsByModule = new Map();
  const qSetModuleMap = new Map();
  for (const qs of allQuestionSets) {
    if (qs.moduleId) {
      qSetModuleMap.set(qs.id, qs.moduleId);
      const list = qSetsByModule.get(qs.moduleId) || [];
      list.push(qs);
      qSetsByModule.set(qs.moduleId, list);
    }
  }

  const attemptsByModule = new Map();
  const submittedTimestamps = [];
  for (const att of submittedAttempts) {
    if (att.submittedAt) submittedTimestamps.push(att.submittedAt);
    const modId = qSetModuleMap.get(att.questionSetId);
    if (!modId) continue;
    const list = attemptsByModule.get(modId) || [];
    list.push(att);
    attemptsByModule.set(modId, list);
  }

  const candidates = [];
  const staleMasteredModules = [];
  let totalModules = 0;
  let totalExpectedModules = 0;
  let masteredModules = 0;
  let inProgressModules = 0;
  let needsReviewModules = 0;
  let emptyModules = 0;

  for (const c of activeCourses) {
    const cStats = moduleCourseCounts.get(c.id);
    totalExpectedModules += Math.max(cStats.total, cStats.expected);
  }

  for (const mod of activeModules) {
    const course = courseById.get(mod.courseId);
    if (!course) continue;
    totalModules += 1;
    if (mod.status === 'mastered') masteredModules += 1;
    else if (mod.status === 'in_progress') inProgressModules += 1;
    else if (mod.status === 'needs_review') needsReviewModules += 1;
    else emptyModules += 1;

    const cStats = moduleCourseCounts.get(course.id);
    const courseDenom = Math.max(cStats.total, cStats.expected, 1);
    const courseCompletionRatio = cStats.mastered / courseDenom;
    const courseRemainingModules = Math.max(0, courseDenom - cStats.mastered);

    const srcStats = sourcesByModule.get(mod.id) || { total: 0, unreviewed: 0 };
    const latestPack = packByModule.get(mod.id) || null;
    const modSets = qSetsByModule.get(mod.id) || [];
    const modAttempts = attemptsByModule.get(mod.id) || [];
    const latestAttempt = modAttempts[0] || null;
    const freshness = computeFreshnessInfo(
      latestAttempt?.submittedAt ?? null,
      mod.status,
      referenceDate
    );

    const preferredSet =
      modSets.find((s) => s.setType === 'remedial') ||
      modSets.find((s) => s.setType === 'practice') ||
      modSets.find((s) => s.setType === 'initial') ||
      modSets[0] ||
      null;

    const candidate = {
      courseId: course.id,
      courseCode: course.code,
      courseName: course.name,
      courseCompletionRatio,
      courseRemainingModules,
      moduleId: mod.id,
      moduleNumber: mod.moduleNumber,
      moduleTitle: mod.title,
      status: mod.status,
      sourceCount: srcStats.total,
      unreviewedSourceCount: srcStats.unreviewed,
      hasStudyPack: Boolean(latestPack),
      hasAnyQuestions: modSets.length > 0,
      preferredQuestionSetId: preferredSet?.id || null,
      attemptCount: modAttempts.length,
      latestScore: latestAttempt?.score ?? null,
      ...freshness,
    };

    candidates.push(candidate);
    if (freshness.needsFreshnessWarmup) {
      staleMasteredModules.push({
        courseId: course.id,
        courseCode: course.code,
        moduleId: mod.id,
        moduleNumber: mod.moduleNumber,
        moduleTitle: mod.title,
        daysSinceLastAttempt: freshness.daysSinceLastAttempt,
        hasQuestions: modSets.length > 0,
      });
    }
  }

  staleMasteredModules.sort((a, b) => (b.daysSinceLastAttempt ?? 0) - (a.daysSinceLastAttempt ?? 0));

  let closestCourse = null;
  for (const c of activeCourses) {
    const stats = moduleCourseCounts.get(c.id);
    const denom = Math.max(stats.total, stats.expected, 1);
    const remaining = Math.max(0, denom - stats.mastered);
    if (remaining <= 0) continue;
    const pct = Math.round((stats.mastered / denom) * 100);
    if (!closestCourse || pct > closestCourse.masteredPct || (pct === closestCourse.masteredPct && remaining < closestCourse.remainingModules)) {
      closestCourse = {
        id: c.id,
        code: c.code,
        name: c.name,
        mastered: stats.mastered,
        total: denom,
        remainingModules: remaining,
        masteredPct: pct,
      };
    }
  }

  const effectiveTotalModules = Math.max(totalExpectedModules, totalModules, 1);
  const remainingToMaster = Math.max(0, effectiveTotalModules - masteredModules);
  const readinessPercent = Math.round((masteredModules / effectiveTotalModules) * 100);

  return {
    generatedAt: referenceDate.toISOString(),
    streak: computeStudyStreak(submittedTimestamps, { timeZone, referenceDate }),
    summary: {
      totalCourses: activeCourses.length,
      totalModules: effectiveTotalModules,
      masteredModules,
      inProgressModules,
      needsReviewModules,
      emptyModules,
      remainingToMaster,
      readinessPercent,
      staleMasteredCount: staleMasteredModules.length,
      closestCourse,
    },
    staleMasteredModules: staleMasteredModules.slice(0, 5),
    slots: selectDailyFocusSlots(candidates),
  };
}
