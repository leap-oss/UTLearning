process.env.NODE_ENV = 'test';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { inArray } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { getDb, closeDb } from '../src/db/client.js';
import {
  courses,
  modules,
  studyPacks,
  questionSets,
  questions,
  quizAttempts,
} from '../src/db/schema.js';
import {
  computeStudyStreak,
  selectDailyFocusSlots,
} from '../src/services/studyFocusService.js';
import {
  computeFreshnessInfo,
  FRESHNESS_WARMUP_DAYS,
} from '../src/services/quizAndRemedialService.js';
import { renderModularHtml, renderModularJs } from '../src/services/htmlRenderer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');

const createdCourseIds = [];

after(async () => {
  const db = getDb();
  if (createdCourseIds.length > 0) {
    await db.delete(courses).where(inArray(courses.id, createdCourseIds));
  }
  await closeDb();
});

async function withServer(run) {
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

test('computeStudyStreak accurately counts active days and preserves yesterday streak until midnight', () => {
  const ref = new Date('2026-11-18T08:00:00+07:00');
  const timestamps = [
    '2026-11-17T20:00:00+07:00',
    '2026-11-16T21:00:00+07:00',
    '2026-11-16T10:00:00+07:00',
    '2026-11-15T19:00:00+07:00',
    '2026-11-10T11:00:00+07:00',
  ];

  const beforeToday = computeStudyStreak(timestamps, {
    timeZone: 'Asia/Jakarta',
    referenceDate: ref,
  });
  assert.equal(beforeToday.studiedToday, false);
  assert.equal(beforeToday.todayDoneCount, 0);
  assert.equal(beforeToday.currentStreakDays, 3);
  assert.equal(beforeToday.bestStreakDays, 3);
  assert.equal(beforeToday.activeDaysLast7.length, 7);

  const afterToday = computeStudyStreak([...timestamps, '2026-11-18T09:30:00+07:00'], {
    timeZone: 'Asia/Jakarta',
    referenceDate: ref,
  });
  assert.equal(afterToday.studiedToday, true);
  assert.equal(afterToday.todayDoneCount, 1);
  assert.equal(afterToday.currentStreakDays, 4);
  assert.equal(afterToday.bestStreakDays, 4);
});

test('computeFreshnessInfo flags mastered modules at or beyond 14 days without flagging recent or non-mastered modules', () => {
  const ref = new Date('2026-11-18T12:00:00Z');
  const fifteenDaysAgo = new Date(ref.getTime() - 15 * 24 * 60 * 60 * 1000);
  const threeDaysAgo = new Date(ref.getTime() - 3 * 24 * 60 * 60 * 1000);

  const staleMastered = computeFreshnessInfo(fifteenDaysAgo, 'mastered', ref);
  assert.equal(staleMastered.daysSinceLastAttempt, 15);
  assert.equal(staleMastered.needsFreshnessWarmup, true);
  assert.equal(FRESHNESS_WARMUP_DAYS, 14);

  const freshMastered = computeFreshnessInfo(threeDaysAgo, 'mastered', ref);
  assert.equal(freshMastered.daysSinceLastAttempt, 3);
  assert.equal(freshMastered.needsFreshnessWarmup, false);

  const staleInProgress = computeFreshnessInfo(fifteenDaysAgo, 'in_progress', ref);
  assert.equal(staleInProgress.needsFreshnessWarmup, false);
});

test('selectDailyFocusSlots curates distinct modules across quick_win, conquest, and increment', () => {
  const slots = selectDailyFocusSlots([
    {
      courseId: 'c1',
      courseCode: 'MSIM4203',
      courseName: 'Sistem Operasi',
      courseCompletionRatio: 0.78,
      courseRemainingModules: 2,
      moduleId: 'm1',
      moduleNumber: 1,
      moduleTitle: 'Dasar SO',
      status: 'mastered',
      sourceCount: 3,
      unreviewedSourceCount: 0,
      hasStudyPack: true,
      hasAnyQuestions: true,
      preferredQuestionSetId: 'qs1',
      attemptCount: 1,
      latestScore: 90,
      daysSinceLastAttempt: 18,
      needsFreshnessWarmup: true,
    },
    {
      courseId: 'c1',
      courseCode: 'MSIM4203',
      courseName: 'Sistem Operasi',
      courseCompletionRatio: 0.78,
      courseRemainingModules: 2,
      moduleId: 'm5',
      moduleNumber: 5,
      moduleTitle: 'Manajemen Memori',
      status: 'in_progress',
      sourceCount: 4,
      unreviewedSourceCount: 0,
      hasStudyPack: true,
      hasAnyQuestions: true,
      preferredQuestionSetId: 'qs5',
      attemptCount: 0,
      latestScore: null,
      daysSinceLastAttempt: null,
      needsFreshnessWarmup: false,
    },
    {
      courseId: 'c2',
      courseCode: 'MKWN4101',
      courseName: 'Agama',
      courseCompletionRatio: 0.11,
      courseRemainingModules: 8,
      moduleId: 'm2',
      moduleNumber: 2,
      moduleTitle: 'Konsep Ketuhanan',
      status: 'empty',
      sourceCount: 0,
      unreviewedSourceCount: 0,
      hasStudyPack: false,
      hasAnyQuestions: false,
      preferredQuestionSetId: null,
      attemptCount: 0,
      latestScore: null,
      daysSinceLastAttempt: null,
      needsFreshnessWarmup: false,
    },
  ]);

  assert.equal(slots.length, 3);
  assert.equal(slots[0].slotType, 'quick_win');
  assert.equal(slots[0].actionType, 'start_warmup');
  assert.equal(slots[0].moduleId, 'm1');
  assert.equal(slots[1].slotType, 'conquest');
  assert.equal(slots[1].actionType, 'open_module_study');
  assert.equal(slots[1].ctaLabel, 'Baca Study Pack');
  assert.equal(slots[1].secondaryActionType, 'start_quiz');
  assert.equal(slots[1].moduleId, 'm5');
  assert.equal(slots[2].slotType, 'increment');
  assert.equal(slots[2].actionType, 'open_module_sources');
  assert.equal(slots[2].moduleId, 'm2');

  // Verify fallback picks another lagging course for balanced reading when Slot 1 has no urgent items
  const fallbackSlots = selectDailyFocusSlots([
    {
      courseId: 'c1',
      courseCode: 'MSIM4203',
      courseName: 'Sistem Operasi',
      courseCompletionRatio: 0.5,
      courseRemainingModules: 3,
      moduleId: 'm5',
      moduleNumber: 5,
      moduleTitle: 'Java If',
      status: 'in_progress',
      sourceCount: 4,
      unreviewedSourceCount: 0,
      hasStudyPack: true,
      hasAnyQuestions: true,
      preferredQuestionSetId: 'qs5',
      attemptCount: 0,
      latestScore: null,
      daysSinceLastAttempt: null,
      needsFreshnessWarmup: false,
    },
    {
      courseId: 'c3',
      courseCode: 'MATA4101',
      courseName: 'Pengantar Matematika',
      courseCompletionRatio: 0,
      courseRemainingModules: 9,
      moduleId: 'm10',
      moduleNumber: 1,
      moduleTitle: 'Himpunan',
      status: 'in_progress',
      sourceCount: 4,
      unreviewedSourceCount: 0,
      hasStudyPack: true,
      hasAnyQuestions: true,
      preferredQuestionSetId: 'qs10',
      attemptCount: 0,
      latestScore: null,
      daysSinceLastAttempt: null,
      needsFreshnessWarmup: false,
    },
  ]);
  assert.equal(fallbackSlots.length, 2);
  assert.equal(fallbackSlots[0].moduleId, 'm5');
  assert.equal(fallbackSlots[0].actionType, 'open_module_study');
  assert.equal(fallbackSlots[1].moduleId, 'm10');
  assert.equal(fallbackSlots[1].actionType, 'open_module_study');
});

test('API integration: focus endpoint, instant check-question (locked for exam_simulation), warmup-quiz, and newlyMastered flag', async () => {
  const db = getDb();

  const [course] = await db
    .insert(courses)
    .values({
      code: 'TEST9001',
      name: 'Uji Gamifikasi Berkelanjutan',
      semesterLabel: '2026/2027 Test',
      expectedModuleCount: 2,
    })
    .returning();
  createdCourseIds.push(course.id);

  const [mod1, mod2] = await db
    .insert(modules)
    .values([
      { courseId: course.id, moduleNumber: 1, title: 'Modul Fokus 1', status: 'in_progress' },
      { courseId: course.id, moduleNumber: 2, title: 'Modul Stale 2', status: 'mastered' },
    ])
    .returning();

  const [pack1] = await db
    .insert(studyPacks)
    .values({
      moduleId: mod1.id,
      version: 1,
      title: 'Pack Modul 1',
      summaryJson: { overview: 'Ringkasan', topics: [], glossary: [], formulasOrProcedures: [] },
      sourceRefsJson: [],
      schemaVersion: 2,
    })
    .returning();

  const [initialSet] = await db
    .insert(questionSets)
    .values({
      moduleId: mod1.id,
      courseId: course.id,
      studyPackId: pack1.id,
      setType: 'initial',
      title: 'Kuis Awal Modul 1',
      schemaVersion: 1,
    })
    .returning();

  const initialQs = await db
    .insert(questions)
    .values([
      {
        questionSetId: initialSet.id,
        moduleId: mod1.id,
        questionOrder: 1,
        topicLabel: 'Topik A',
        learningObjective: 'Memahami A',
        questionType: 'single_choice',
        prompt: 'Apa jawaban untuk soal uji 1?',
        optionsJson: [
          { key: 'A', text: 'Benar A' },
          { key: 'B', text: 'Salah B' },
        ],
        correctOption: 'A',
        explanation: 'Penjelasan A',
        difficulty: 'easy',
        sourceRefsJson: ['Hal 1'],
      },
      {
        questionSetId: initialSet.id,
        moduleId: mod1.id,
        questionOrder: 2,
        topicLabel: 'Topik B',
        learningObjective: 'Memahami B',
        questionType: 'single_choice',
        prompt: 'Apa jawaban untuk soal uji 2?',
        optionsJson: [
          { key: 'A', text: 'Salah A' },
          { key: 'B', text: 'Benar B' },
        ],
        correctOption: 'B',
        explanation: 'Penjelasan B',
        difficulty: 'medium',
        sourceRefsJson: ['Hal 2'],
      },
    ])
    .returning();

  // Create exam_simulation set to verify instant-check is forbidden
  const [examSet] = await db
    .insert(questionSets)
    .values({
      moduleId: null,
      courseId: course.id,
      setType: 'exam_simulation',
      title: 'Simulasi UAS Uji',
      schemaVersion: 1,
    })
    .returning();

  const [examQ] = await db
    .insert(questions)
    .values({
      questionSetId: examSet.id,
      moduleId: mod1.id,
      questionOrder: 1,
      topicLabel: 'Topik UAS',
      learningObjective: 'Memahami UAS',
      questionType: 'single_choice',
      prompt: 'Soal simulasi UAS?',
      optionsJson: [
        { key: 'A', text: 'Opsi A' },
        { key: 'B', text: 'Opsi B' },
      ],
      correctOption: 'A',
      explanation: 'Pembahasan UAS',
      difficulty: 'hard',
      sourceRefsJson: ['Hal 5'],
    })
    .returning();

  // Seed a 17-day-old mastered attempt on mod2 so Freshness Decay activates
  const [mod2Set] = await db
    .insert(questionSets)
    .values({
      moduleId: mod2.id,
      courseId: course.id,
      setType: 'initial',
      title: 'Kuis Modul 2',
      schemaVersion: 1,
    })
    .returning();

  await db.insert(questions).values([
    {
      questionSetId: mod2Set.id,
      moduleId: mod2.id,
      questionOrder: 1,
      topicLabel: 'Retensi 1',
      learningObjective: 'Uji retensi 1',
      questionType: 'single_choice',
      prompt: 'Pertanyaan retensi 1?',
      optionsJson: [
        { key: 'A', text: 'Satu' },
        { key: 'B', text: 'Dua' },
      ],
      correctOption: 'A',
      explanation: 'Kunci A',
      difficulty: 'easy',
      sourceRefsJson: [],
    },
    {
      questionSetId: mod2Set.id,
      moduleId: mod2.id,
      questionOrder: 2,
      topicLabel: 'Retensi 2',
      learningObjective: 'Uji retensi 2',
      questionType: 'single_choice',
      prompt: 'Pertanyaan retensi 2?',
      optionsJson: [
        { key: 'A', text: 'Salah' },
        { key: 'B', text: 'Benar' },
      ],
      correctOption: 'B',
      explanation: 'Kunci B',
      difficulty: 'easy',
      sourceRefsJson: [],
    },
  ]);

  const seventeenDaysAgo = new Date(Date.now() - 17 * 24 * 60 * 60 * 1000);
  await db.insert(quizAttempts).values({
    questionSetId: mod2Set.id,
    startedAt: seventeenDaysAgo,
    submittedAt: seventeenDaysAgo,
    score: 100,
    correctCount: 1,
    totalCount: 1,
    status: 'submitted',
    answersJson: [],
  });

  await withServer(async (baseUrl) => {
    // 1. Check single question allowed on initial set & returns only that question's result
    const checkRes = await fetch(`${baseUrl}/api/question-sets/${initialSet.id}/check-question`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: initialQs[0].id, selectedOption: 'A' }),
    });
    assert.equal(checkRes.status, 200);
    const checkBody = await checkRes.json();
    assert.equal(checkBody.check.isCorrect, true);
    assert.equal(checkBody.check.correctOption, 'A');
    assert.equal(checkBody.check.explanation, 'Penjelasan A');

    // 2. Check single question forbidden on exam_simulation
    const examCheckRes = await fetch(`${baseUrl}/api/question-sets/${examSet.id}/check-question`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: examQ.id, selectedOption: 'A' }),
    });
    assert.equal(examCheckRes.status, 403);
    const examCheckBody = await examCheckRes.json();
    assert.equal(examCheckBody.error, 'EXAM_SIMULATION_LOCKED');

    // 3. Submit initial quiz on mod1 with 100% -> newlyMastered === true
    const submitRes = await fetch(`${baseUrl}/api/question-sets/${initialSet.id}/attempts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        answers: [
          { questionId: initialQs[0].id, selectedOption: 'A' },
          { questionId: initialQs[1].id, selectedOption: 'B' },
        ],
      }),
    });
    assert.equal(submitRes.status, 201);
    const submitBody = await submitRes.json();
    assert.equal(submitBody.attempt.score, 100);
    assert.equal(submitBody.attempt.newlyMastered, true);

    // 4. Course progress reports Freshness Decay on mod2 (>= 14 days stale)
    const progRes = await fetch(`${baseUrl}/api/courses/${course.id}/progress`);
    assert.equal(progRes.status, 200);
    const progBody = await progRes.json();
    const mod2Prog = progBody.progress.modules.find((m) => m.moduleId === mod2.id);
    assert.equal(mod2Prog.needsFreshnessWarmup, true);
    assert.ok(mod2Prog.daysSinceLastAttempt >= 17);

    // 5. Warmup quiz endpoint creates a practice warmup set from saved questions without AI
    const warmupRes = await fetch(`${baseUrl}/api/modules/${mod2.id}/warmup-quiz`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxQuestions: 5 }),
    });
    assert.equal(warmupRes.status, 201);
    const warmupBody = await warmupRes.json();
    assert.equal(warmupBody.questionSet.setType, 'warmup');
    assert.equal(warmupBody.questionSet.questions.length, 2);
    assert.equal('correctOption' in warmupBody.questionSet.questions[0], false);

    // 6. Focus endpoint returns structured streak + summary + curated slots
    const focusRes = await fetch(`${baseUrl}/api/dashboard/focus?tz=Asia/Jakarta`);
    assert.equal(focusRes.status, 200);
    const focusBody = await focusRes.json();
    assert.ok(focusBody.focus.streak.studiedToday);
    assert.ok(focusBody.focus.streak.currentStreakDays >= 1);
    assert.ok(Array.isArray(focusBody.focus.slots));
  });
});

test('Frontend modular HTML & JS bundle compiles without top-level const/let conflicts and supports flashcards & outcome tiers', () => {
  const html = renderModularHtml(publicDir);
  const bundledJs = renderModularJs(publicDir);

  assert.equal(html.includes('id="a11y-live-status"'), true);
  assert.equal(html.includes('id="uas-target-date"'), true);
  assert.equal(html.includes('Mode Flashcard'), true);
  assert.equal(html.includes('Cek langsung per soal'), true);
  assert.equal(html.includes('confetti-burst'), true);

  const windowObj = {
    AppModules: {},
    localStorage: {
      _map: new Map(),
      getItem(k) { return this._map.get(k) ?? null; },
      setItem(k, v) { this._map.set(k, String(v)); },
      removeItem(k) { this._map.delete(k); },
    },
    Intl,
    matchMedia: () => ({ matches: true }),
    addEventListener: () => {},
  };

  const sandbox = {
    window: windowObj,
    document: { addEventListener: () => {}, documentElement: { classList: { add: () => {}, remove: () => {} } } },
    Alpine: { data: () => {} },
    Intl,
    Temporal: undefined,
    localStorage: windowObj.localStorage,
    setTimeout,
    clearTimeout,
    performance: { now: () => 0 },
  };
  vm.createContext(sandbox);
  // Running bundle twice simulates re-evaluation / double script checks without SyntaxError
  vm.runInContext(bundledJs, sandbox);
  vm.runInContext(bundledJs, sandbox);

  const M = sandbox.window.AppModules;
  const appInstance = {};
  for (const mod of [
    M.state,
    M.apiAndJobs,
    M.coursesAndModules,
    M.sourcesAndExtraction,
    M.studyPackAndReader,
    M.quizAndRemedial,
    M.mathAndFormatters,
  ]) {
    Object.defineProperties(appInstance, Object.getOwnPropertyDescriptors(mod));
  }

  appInstance.activeModule = {
    studyPacks: [
      {
        version: 1,
        summaryJson: {
          glossary: [
            { term: 'Kernel', bmpDefinition: 'Inti sistem operasi', simpleAnalogy: 'Otak pengendali' },
          ],
          topics: [
            {
              topicLabel: 'Topik 1',
              commonMisconceptions: [
                { misconception: 'Kernel sama dengan shell', correction: 'Shell antarmuka pengguna, kernel inti OS.' },
              ],
            },
          ],
        },
      },
    ],
  };

  assert.equal(appInstance.availableFlashcards.length, 2);
  appInstance.startFlashcardSession();
  assert.equal(appInstance.flashcardSession.active, true);
  assert.equal(appInstance.flashcardSession.totalUnique, 2);
  appInstance.revealFlashcard();
  assert.equal(appInstance.flashcardSession.revealed, true);
  appInstance.gradeFlashcard(false); // Re-queue
  assert.equal(appInstance.flashcardSession.rememberedCount, 0);
  assert.equal(appInstance.flashcardSession.cards.length, 2);
  appInstance.revealFlashcard();
  appInstance.gradeFlashcard(true);
  assert.equal(appInstance.flashcardSession.rememberedCount, 1);
  assert.equal(appInstance.flashcardSession.cards.length, 1);

  appInstance.activeAttemptReview = { score: 85, newlyMastered: true };
  assert.equal(appInstance.attemptOutcomeFeedback.badge, 'Baru Dikuasai');
  appInstance.activeAttemptReview = { score: 70, newlyMastered: false };
  assert.equal(appInstance.attemptOutcomeFeedback.tone, 'review');

  appInstance.dailyFocus = { summary: { remainingToMaster: 10 } };
  appInstance.setUasExamDate('2099-12-31');
  assert.ok(appInstance.uasCountdownSummary.daysLeft > 0);
});
