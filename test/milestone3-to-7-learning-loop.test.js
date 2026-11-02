import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { getDb, closeDb } from '../src/db/client.js';
import { courses, aiGenerationJobs, aiUsageEvents } from '../src/db/schema.js';
import { AiJobQueue } from '../src/services/aiQueue.js';

const testCourseIds = [];
const testJobIds = [];

// Valid 1x1 PNG buffer (with PNG magic bytes 89 50 4E 47 0D 0A 1A 0A)
const VALID_PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

after(async () => {
  const db = getDb();
  if (testJobIds.length > 0) {
    await db.delete(aiUsageEvents).where(inArray(aiUsageEvents.jobId, testJobIds));
    await db.delete(aiGenerationJobs).where(inArray(aiGenerationJobs.id, testJobIds));
  }
  if (testCourseIds.length > 0) {
    await db.delete(courses).where(inArray(courses.id, testCourseIds));
  }
  await closeDb();
});

test('Milestones 3 to 7: Complete learning loop (upload -> extract -> review -> study pack + quiz -> local grading -> remedial -> exam simulation)', async () => {
  const queue = new AiJobQueue({ sleepFn: async () => {} });

  const mockExtractorFn = async ({ moduleRecord, sourceRecordsWithBuffers }) => ({
    model: 'gemini-2.5-flash',
    usageMetadata: { promptTokenCount: 250, candidatesTokenCount: 180, totalTokenCount: 430 },
    data: {
      schemaVersion: 1,
      pages: sourceRecordsWithBuffers.map((item) => ({
        sourceImageId: item.source.id,
        pageOrder: item.source.pageOrder,
        pageTitle: `Rangkuman Modul ${moduleRecord.moduleNumber}`,
        extractedText: `Teks BMP Modul ${moduleRecord.moduleNumber}: Sistem operasi mengelola proses, memori, dan berkas.`,
        sections: [{ heading: 'Konsep Utama', content: 'Manajemen proses dan penjadwalan.' }],
        keyTerms: ['Kernel', 'Process Control Block (PCB)'],
        formulasOrTables: [],
        transcribedQuestions: [],
        ambiguousParts: ['Baris bawah halaman sedikit buram'],
        needsReview: true,
      })),
    },
  });

  const mockSynthesizerFn = async ({ moduleRecord }) => ({
    model: 'gemini-2.5-flash',
    usageMetadata: { promptTokenCount: 320, candidatesTokenCount: 410, totalTokenCount: 730 },
    data: {
      schemaVersion: 1,
      title: `Study Pack Modul ${moduleRecord.moduleNumber}: ${moduleRecord.title}`,
      overview: `Ringkasan terverifikasi untuk Modul ${moduleRecord.moduleNumber}.`,
      topics: [
        {
          topicLabel: `Arsitektur Kernel M${moduleRecord.moduleNumber}`,
          bmpSummary: 'Kernel adalah inti sistem operasi yang mengatur sumber daya perangkat keras.',
          aiExplanation: 'Bayangkan kernel seperti manajer lalu lintas yang mengatur antrean kendaraan.',
          keyTakeaways: ['Kernel berjalan di mode terproteksi'],
          sourceRefs: [`Halaman 1 Modul ${moduleRecord.moduleNumber}`],
        },
        {
          topicLabel: `Manajemen Proses M${moduleRecord.moduleNumber}`,
          bmpSummary: ' setiap proses direpresentasikan oleh Process Control Block (PCB).',
          aiExplanation: 'PCB ibarat kartu identitas lengkap sebuah proses.',
          keyTakeaways: ['PCB menyimpan PID dan status proses'],
          sourceRefs: [`Halaman 1 Modul ${moduleRecord.moduleNumber}`],
        },
      ],
      glossary: [
        {
          term: 'PCB (Process Control Block)',
          bmpDefinition: 'Struktur data sistem operasi yang menyimpan informasi proses.',
          simpleAnalogy: 'Map berkas pasien di rumah sakit.',
          sourceRefs: [`Halaman 1 Modul ${moduleRecord.moduleNumber}`],
        },
      ],
      formulasOrProcedures: [],
      coverageNotes: [],
      initialQuestions: [
        {
          topicLabel: `Arsitektur Kernel M${moduleRecord.moduleNumber}`,
          prompt: 'Apa komponen inti sistem operasi yang mengelola sumber daya perangkat keras?',
          options: [
            { key: 'A', text: 'Kernel' },
            { key: 'B', text: 'Kompiler' },
            { key: 'C', text: 'Browser' },
            { key: 'D', text: 'Text Editor' },
          ],
          correctOption: 'A',
          explanation: 'Berdasarkan BMP Halaman 1, Kernel adalah inti sistem operasi.',
          difficulty: 'easy',
          sourceRefs: [`Halaman 1 Modul ${moduleRecord.moduleNumber}`],
        },
        {
          topicLabel: `Manajemen Proses M${moduleRecord.moduleNumber}`,
          prompt: 'Struktur data apa yang menyimpan informasi status dan identitas sebuah proses?',
          options: [
            { key: 'A', text: 'FAT Table' },
            { key: 'B', text: 'Process Control Block (PCB)' },
            { key: 'C', text: 'HTML DOM' },
            { key: 'D', text: 'DNS Record' },
          ],
          correctOption: 'B',
          explanation: 'PCB menyimpan identitas dan status eksekusi proses.',
          difficulty: 'medium',
          sourceRefs: [`Halaman 1 Modul ${moduleRecord.moduleNumber}`],
        },
      ],
    },
  });

  const mockRemedialGeneratorFn = async ({ wrongQuestions }) => ({
    model: 'gemini-2.5-flash',
    usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 260, totalTokenCount: 460 },
    data: {
      schemaVersion: 1,
      title: 'Remedial Terfokus: Manajemen Proses',
      diagnosticFeedback: {
        overallDiagnosis: 'Mahasiswa masih tertukar antara struktur data sistem berkas dan struktur data proses.',
        topicDiagnostics: wrongQuestions.map((wq) => ({
          topicLabel: wq.topicLabel,
          misconceptionAnalysis: 'Memilih struktur penyimpanan disk, padahal yang ditanyakan adalah representasi proses di memori.',
          reviewGuidance: 'Pelajari kembali definisi Process Control Block (PCB) pada Halaman 1.',
          sourceRefs: wq.sourceRefs,
        })),
      },
      remedialQuestions: [
        {
          topicLabel: wrongQuestions[0].topicLabel,
          prompt: 'Saat terjadi context switch, di manakah sistem operasi menyimpan nilai register terakhir dari proses yang dihentikan sementara?',
          options: [
            { key: 'A', text: 'Di dalam Process Control Block (PCB)' },
            { key: 'B', text: 'Di tabel partisi harddisk' },
            { key: 'C', text: 'Di cache browser' },
            { key: 'D', text: 'Di konfigurasi jaringan' },
          ],
          correctOption: 'A',
          explanation: 'Saat context switch, state proses disimpan ke dalam PCB miliknya.',
          difficulty: 'medium',
          sourceRefs: wrongQuestions[0].sourceRefs,
        },
      ],
    },
  });

  const mockExamSimulationGeneratorFn = async ({ selectedModuleSummaries }) => ({
    model: 'gemini-2.5-flash',
    usageMetadata: { promptTokenCount: 400, candidatesTokenCount: 500, totalTokenCount: 900 },
    data: {
      schemaVersion: 1,
      title: 'Simulasi UAS Komprehensif Sistem Operasi',
      questions: selectedModuleSummaries.flatMap((modSum) => [
        {
          moduleNumber: modSum.moduleNumber,
          topicLabel: modSum.topics[0]?.topicLabel || `Topik M${modSum.moduleNumber}`,
          prompt: `[Modul ${modSum.moduleNumber}] Manakah pernyataan yang benar mengenai ${modSum.moduleTitle}?`,
          options: [
            { key: 'A', text: 'Mengelola eksekusi dan sumber daya secara terstruktur' },
            { key: 'B', text: 'Hanya berjalan ketika komputer dimatikan' },
            { key: 'C', text: 'Tidak memerlukan memori utama' },
            { key: 'D', text: 'Bukan bagian dari sistem operasi' },
          ],
          correctOption: 'A',
          explanation: `Sesuai materi Modul ${modSum.moduleNumber}, sistem operasi mengelola sumber daya secara terstruktur.`,
          difficulty: 'medium',
          sourceRefs: [`Modul ${modSum.moduleNumber} Hal. 1`],
        },
      ]),
    },
  });

  const app = createApp({
    aiQueue: queue,
    extractorFn: mockExtractorFn,
    synthesizerFn: mockSynthesizerFn,
    remedialGeneratorFn: mockRemedialGeneratorFn,
    examSimulationGeneratorFn: mockExamSimulationGeneratorFn,
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. Create Course + Module 1 + Module 2
    const cRes = await fetch(`${baseUrl}/api/courses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: 'MSIM4201',
        name: 'Sistem Operasi (E2E Loop)',
        semesterLabel: 'Semester 3',
        expectedModuleCount: 9,
      }),
    });
    const { course } = await cRes.json();
    testCourseIds.push(course.id);

    const m1Res = await fetch(`${baseUrl}/api/courses/${course.id}/modules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ moduleNumber: 1, title: 'Konsep Dasar & Kernel' }),
    });
    const { module: mod1 } = await m1Res.json();

    const m2Res = await fetch(`${baseUrl}/api/courses/${course.id}/modules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ moduleNumber: 2, title: 'Penjadwalan & Sinkronisasi' }),
    });
    const { module: mod2 } = await m2Res.json();

    // 2. Milestone 3: Reject fake image file (text disguised as .png)
    const badForm = new FormData();
    badForm.append('images', new Blob(['not an image'], { type: 'image/png' }), 'fake.png');
    const badUploadRes = await fetch(`${baseUrl}/api/modules/${mod1.id}/sources/extract`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `bad-img-${crypto.randomUUID()}` },
      body: badUploadResForm(badForm),
    });
    assert.equal(badUploadRes.status, 400);

    // 3. Milestone 3: Valid multipart upload to Module 1
    const form1 = new FormData();
    form1.append('images', new Blob([VALID_PNG_BUFFER], { type: 'image/png' }), 'bmp-m1-hal1.png');
    form1.append('labels', 'rangkuman');
    form1.append('pageOrders', '1');

    const ext1Res = await fetch(`${baseUrl}/api/modules/${mod1.id}/sources/extract`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `ext-m1-${crypto.randomUUID()}` },
      body: form1,
    });
    assert.equal(ext1Res.status, 202);
    const ext1Body = await ext1Res.json();
    testJobIds.push(ext1Body.jobId);

    await queue.waitForIdle();

    // Verify source is saved with needsReview = true
    const mod1AfterExtRes = await fetch(`${baseUrl}/api/modules/${mod1.id}`);
    const { module: mod1AfterExt } = await mod1AfterExtRes.json();
    assert.equal(mod1AfterExt.sources.length, 1);
    assert.equal(mod1AfterExt.sources[0].needsReview, true);

    // Attempting to synthesize study pack before reviewing source should return 400 SOURCES_NEED_REVIEW
    const prematurePackRes = await fetch(`${baseUrl}/api/modules/${mod1.id}/study-packs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `premature-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({ questionCount: 5 }),
    });
    assert.equal(prematurePackRes.status, 400);
    const prematureBody = await prematurePackRes.json();
    assert.equal(prematureBody.error, 'SOURCES_NEED_REVIEW');

    // Review and approve the extracted source
    const sourceId1 = mod1AfterExt.sources[0].id;
    const reviewRes = await fetch(`${baseUrl}/api/sources/${sourceId1}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        extractedText: 'Teks BMP Modul 1 Terverifikasi: Kernel dan PCB.',
        needsReview: false,
      }),
    });
    assert.equal(reviewRes.status, 200);

    // 4. Milestone 4: Generate Study Pack v1 + Initial Question Set in 1 batch call
    const sp1Res = await fetch(`${baseUrl}/api/modules/${mod1.id}/study-packs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `sp-m1-v1-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({ questionCount: 5 }),
    });
    assert.equal(sp1Res.status, 202);
    const sp1Job = await sp1Res.json();
    testJobIds.push(sp1Job.jobId);

    await queue.waitForIdle();

    // Regenerate Study Pack v2 and verify v1 is preserved
    const sp2Res = await fetch(`${baseUrl}/api/modules/${mod1.id}/study-packs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `sp-m1-v2-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({ questionCount: 5, regenerate: true }),
    });
    assert.equal(sp2Res.status, 202);
    const sp2Job = await sp2Res.json();
    testJobIds.push(sp2Job.jobId);

    await queue.waitForIdle();

    const mod1WithPacksRes = await fetch(`${baseUrl}/api/modules/${mod1.id}`);
    const { module: mod1WithPacks } = await mod1WithPacksRes.json();
    assert.equal(mod1WithPacks.studyPacks.length, 2, 'Both v1 and v2 study packs preserved');
    assert.equal(mod1WithPacks.questionSets.length, 2);

    const initialQSetId = mod1WithPacks.questionSets[0].id;

    // 5. Milestone 5: GET /api/question-sets/:id hides correctOption & explanation
    const qSetGetRes = await fetch(`${baseUrl}/api/question-sets/${initialQSetId}`);
    assert.equal(qSetGetRes.status, 200);
    const { questionSet } = await qSetGetRes.json();
    assert.equal(questionSet.questions.length, 2);
    for (const q of questionSet.questions) {
      assert.equal(q.correctOption, undefined, 'correctOption must never be sent before submit');
      assert.equal(q.explanation, undefined, 'explanation must never be sent before submit');
    }

    // Submit answers (1 correct 'A', 1 wrong 'D') + try spoofing score: 100
    const submitRes = await fetch(`${baseUrl}/api/question-sets/${initialQSetId}/attempts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        score: 100, // Spoofed client score must be ignored by server!
        answers: [
          { questionId: questionSet.questions[0].id, selectedOption: 'A' }, // Correct
          { questionId: questionSet.questions[1].id, selectedOption: 'D' }, // Wrong (correct is B)
        ],
      }),
    });
    assert.equal(submitRes.status, 201);
    const { attempt: gradedAttempt } = await submitRes.json();
    assert.equal(gradedAttempt.score, 50, 'Server must compute 50% (1/2) and ignore client score: 100');
    assert.equal(gradedAttempt.correctCount, 1);
    assert.equal(gradedAttempt.totalCount, 2);
    assert.equal(gradedAttempt.questions[1].correctOption, 'B');

    // 6. Milestone 6: Generate batched diagnostic feedback & remedial set from the attempt
    const remRes = await fetch(`${baseUrl}/api/attempts/${gradedAttempt.attemptId}/remedial`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `rem-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({}),
    });
    assert.equal(remRes.status, 202);
    const remJob = await remRes.json();
    testJobIds.push(remJob.jobId);

    await queue.waitForIdle();

    const jobDetailRes = await fetch(`${baseUrl}/api/ai/jobs/${remJob.jobId}`);
    const remJobDetail = await jobDetailRes.json();
    assert.equal(remJobDetail.status, 'succeeded');
    assert.ok(remJobDetail.resultRefs.remedialQuestionSetId);

    const remSetRes = await fetch(
      `${baseUrl}/api/question-sets/${remJobDetail.resultRefs.remedialQuestionSetId}`
    );
    const { questionSet: remedialSet } = await remSetRes.json();
    assert.equal(remedialSet.setType, 'remedial');
    assert.equal(remedialSet.parentAttemptId, gradedAttempt.attemptId);
    assert.ok(remedialSet.metadata.diagnosticFeedback.overallDiagnosis);

    // 7. Milestone 7: Upload, review, and synthesize Module 2, then generate Course Exam Simulation
    const form2 = new FormData();
    form2.append('images', new Blob([VALID_PNG_BUFFER], { type: 'image/png' }), 'bmp-m2-hal1.png');
    form2.append('labels', 'rangkuman');
    form2.append('pageOrders', '1');

    const ext2Res = await fetch(`${baseUrl}/api/modules/${mod2.id}/sources/extract`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `ext-m2-${crypto.randomUUID()}` },
      body: form2,
    });
    const ext2Job = await ext2Res.json();
    testJobIds.push(ext2Job.jobId);
    await queue.waitForIdle();

    const mod2DetailRes = await fetch(`${baseUrl}/api/modules/${mod2.id}`);
    const { module: mod2Detail } = await mod2DetailRes.json();
    await fetch(`${baseUrl}/api/sources/${mod2Detail.sources[0].id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ needsReview: false }),
    });

    const spMod2Res = await fetch(`${baseUrl}/api/modules/${mod2.id}/study-packs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `sp-m2-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({ questionCount: 5 }),
    });
    const spMod2Job = await spMod2Res.json();
    testJobIds.push(spMod2Job.jobId);
    await queue.waitForIdle();

    // Generate Comprehensive Exam Simulation across Module 1 & Module 2
    const simRes = await fetch(`${baseUrl}/api/courses/${course.id}/exam-simulations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `sim-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({
        moduleIds: [mod1.id, mod2.id],
        questionCount: 6,
        difficulty: 'mixed',
      }),
    });
    assert.equal(simRes.status, 202);
    const simJob = await simRes.json();
    testJobIds.push(simJob.jobId);
    await queue.waitForIdle();

    const simJobDoneRes = await fetch(`${baseUrl}/api/ai/jobs/${simJob.jobId}`);
    const simJobDone = await simJobDoneRes.json();
    assert.equal(simJobDone.status, 'succeeded');
    const simQuestionSetId = simJobDone.resultRefs.questionSetId;

    // Take the Exam Simulation and verify per-module breakdown
    const simQSetRes = await fetch(`${baseUrl}/api/question-sets/${simQuestionSetId}`);
    const { questionSet: simQSet } = await simQSetRes.json();
    assert.equal(simQSet.questions.length, 2);

    const simAttemptRes = await fetch(`${baseUrl}/api/question-sets/${simQuestionSetId}/attempts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        answers: [
          { questionId: simQSet.questions[0].id, selectedOption: 'A' }, // Mod 1 correct
          { questionId: simQSet.questions[1].id, selectedOption: 'B' }, // Mod 2 wrong
        ],
      }),
    });
    assert.equal(simAttemptRes.status, 201);
    const { attempt: simAttempt } = await simAttemptRes.json();
    assert.equal(simAttempt.score, 50);
    assert.equal(simAttempt.moduleBreakdown.length, 2, 'Must report score breakdown for both modules');
    assert.equal(simAttempt.moduleBreakdown[0].score, 100);
    assert.equal(simAttempt.moduleBreakdown[1].score, 0);

    // Check module & course progress endpoints
    const progMod1Res = await fetch(`${baseUrl}/api/modules/${mod1.id}/progress`);
    assert.equal(progMod1Res.status, 200);
    const { progress: progMod1 } = await progMod1Res.json();
    assert.equal(progMod1.attemptCount, 1);

    const progCourseRes = await fetch(`${baseUrl}/api/courses/${course.id}/progress`);
    assert.equal(progCourseRes.status, 200);
    const { progress: progCourse } = await progCourseRes.json();
    assert.equal(progCourse.modules.length, 2);
    assert.equal(progCourse.examSimulations.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

function badUploadResForm(form) {
  return form;
}
