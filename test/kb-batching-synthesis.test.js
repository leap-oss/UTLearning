import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderModularJs } from '../src/services/htmlRenderer.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import {
  detectModuleKbStructure,
  countDistinctKbsInTopics,
  resolveFixedQuestionCountByKb,
  planKbBatches,
  validateStudyPackCoverage,
  studyPackSynthesisSchema,
  validateAndAlignStudyPack,
  defaultTwoStageStudyPackSynthesizer,
} from '../src/services/studyPackService.js';

function createMockSource({ pageOrder, label, text, transcribedQuestions = [], title = '' }) {
  return {
    id: `src-${pageOrder}`,
    pageOrder,
    label,
    fileName: `page-${pageOrder}.png`,
    extractedContentJson: {
      pageTitle: title,
      extractedText: text,
      transcribedQuestions,
      sections: [{ heading: title || label, content: text }],
      keyTerms: ['Teknologi', 'Sistem'],
      formulasOrTables: [],
    },
  };
}

test('KB Detection: Modul dengan 1 KB terpetakan tanpa halaman terlewat', () => {
  const sources = [
    createMockSource({ pageOrder: 1, label: 'rangkuman', text: 'Rangkuman materi dasar komputasi.' }),
    createMockSource({
      pageOrder: 2,
      label: 'tes_formatif',
      title: 'Tes Formatif 1',
      text: 'Tes Formatif 1\n1) Apa itu CPU?',
      transcribedQuestions: [{ prompt: 'Apa itu CPU?', options: [{ key: 'A', text: 'Unit pemroses' }] }],
    }),
  ];

  const kbs = detectModuleKbStructure(sources);
  assert.equal(kbs.length, 1);
  assert.equal(kbs[0].kbNumber, 1);
  assert.equal(kbs[0].sources.length, 2);
  assert.equal(kbs[0].sources[0].pageOrder, 1);
  assert.equal(kbs[0].sources[1].pageOrder, 2);
});

test('KB Detection: Modul dengan 2 KB terpetakan secara presisi', () => {
  const sources = [
    createMockSource({ pageOrder: 1, label: 'rangkuman', text: 'Rangkuman KB 1: Konsep TI.' }),
    createMockSource({ pageOrder: 2, label: 'tes_formatif', title: 'Tes Formatif 1', text: '1) Soal KB 1.' }),
    createMockSource({ pageOrder: 3, label: 'rangkuman', text: 'Rangkuman KB 2: Value Chain.' }),
    createMockSource({ pageOrder: 4, label: 'tes_formatif', title: 'Tes Formatif 2', text: '1) Soal KB 2.' }),
  ];

  const kbs = detectModuleKbStructure(sources);
  assert.equal(kbs.length, 2);
  assert.equal(kbs[0].kbNumber, 1);
  assert.deepEqual(kbs[0].sources.map((s) => s.pageOrder), [1, 2]);
  assert.equal(kbs[1].kbNumber, 2);
  assert.deepEqual(kbs[1].sources.map((s) => s.pageOrder), [3, 4]);
});

test('KB Detection: Modul dengan 3 KB terpetakan lengkap', () => {
  const sources = [
    createMockSource({ pageOrder: 1, label: 'rangkuman', text: 'Materi Rangkuman KB 1' }),
    createMockSource({ pageOrder: 2, label: 'tes_formatif', text: 'Tes Formatif 1 Soal 1-10' }),
    createMockSource({ pageOrder: 3, label: 'rangkuman', text: 'Materi Rangkuman KB 2' }),
    createMockSource({ pageOrder: 4, label: 'tes_formatif', text: 'Tes Formatif 2 Soal 1-10' }),
    createMockSource({ pageOrder: 5, label: 'rangkuman', text: 'Materi Rangkuman KB 3' }),
    createMockSource({ pageOrder: 6, label: 'tes_formatif', text: 'Tes Formatif 3 Soal 1-10' }),
  ];

  const kbs = detectModuleKbStructure(sources);
  assert.equal(kbs.length, 3);
  assert.equal(kbs[0].kbNumber, 1);
  assert.equal(kbs[1].kbNumber, 2);
  assert.equal(kbs[2].kbNumber, 3);
  assert.equal(kbs.flatMap((k) => k.sources).length, 6, 'Semua 6 halaman terpetakan');
});

test('KB Detection: Modul dengan lebih dari 3 KB (4 KB) terpetakan seimbang', () => {
  const sources = [
    createMockSource({ pageOrder: 1, label: 'rangkuman', text: 'Rangkuman 1' }),
    createMockSource({ pageOrder: 2, label: 'tes_formatif', text: 'Tes Formatif 1' }),
    createMockSource({ pageOrder: 3, label: 'rangkuman', text: 'Rangkuman 2' }),
    createMockSource({ pageOrder: 4, label: 'tes_formatif', text: 'Tes Formatif 2' }),
    createMockSource({ pageOrder: 5, label: 'rangkuman', text: 'Rangkuman 3' }),
    createMockSource({ pageOrder: 6, label: 'tes_formatif', text: 'Tes Formatif 3' }),
    createMockSource({ pageOrder: 7, label: 'rangkuman', text: 'Rangkuman 4' }),
    createMockSource({ pageOrder: 8, label: 'tes_formatif', text: 'Tes Formatif 4' }),
  ];

  const kbs = detectModuleKbStructure(sources);
  assert.equal(kbs.length, 4);
  assert.deepEqual(kbs.map((k) => k.kbNumber), [1, 2, 3, 4]);
});

test('Batch Planning: 1 KB menghasilkan 1 batch', () => {
  const kbs = [{ kbNumber: 1, totalChars: 5000, sources: [] }];
  const batches = planKbBatches(kbs);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].isFinalBatch, true);
  assert.equal(batches[0].kbs.length, 1);
});

test('Batch Planning: 2 KB ukuran wajar menghasilkan 1 batch (hemat API)', () => {
  const kbs = [
    { kbNumber: 1, totalChars: 6000, sources: [] },
    { kbNumber: 2, totalChars: 7000, sources: [] },
  ];
  const batches = planKbBatches(kbs, { maxSafeCharsPerBatch: 35000 });
  assert.equal(batches.length, 1);
  assert.equal(batches[0].kbs.length, 2);
  assert.equal(batches[0].isFinalBatch, true);
});

test('Batch Planning: 2 KB melebihi batas token aman otomatis dipisah 2 batch', () => {
  const kbs = [
    { kbNumber: 1, totalChars: 25000, sources: [] },
    { kbNumber: 2, totalChars: 20000, sources: [] },
  ];
  const batches = planKbBatches(kbs, { maxSafeCharsPerBatch: 35000 });
  assert.equal(batches.length, 2);
  assert.equal(batches[0].kbs.length, 1);
  assert.equal(batches[0].kbs[0].kbNumber, 1);
  assert.equal(batches[0].isFinalBatch, false);
  assert.ok(batches[0].splitReason.includes('melampaui batas aman'));
  assert.equal(batches[1].kbs[0].kbNumber, 2);
  assert.equal(batches[1].isFinalBatch, true);
});

test('Batch Planning: 3 KB default 1 batch (hemat RPD — seluruh KB disintesis dalam 1 request)', () => {
  const kbs = [
    { kbNumber: 1, totalChars: 8000, sources: [] },
    { kbNumber: 2, totalChars: 8000, sources: [] },
    { kbNumber: 3, totalChars: 8000, sources: [] },
  ];
  const batches = planKbBatches(kbs);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].kbs.map((k) => k.kbNumber), [1, 2, 3]);
  assert.equal(batches[0].isFinalBatch, true);
});

test('Batch Planning: 4 KB ukuran normal digabung ke 1 batch tunggal (hemat RPD)', () => {
  const kbs = [
    { kbNumber: 1, totalChars: 6000, sources: [] },
    { kbNumber: 2, totalChars: 6000, sources: [] },
    { kbNumber: 3, totalChars: 6000, sources: [] },
    { kbNumber: 4, totalChars: 6000, sources: [] },
  ];
  const batches = planKbBatches(kbs);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].kbs.map((k) => k.kbNumber), [1, 2, 3, 4]);
  assert.equal(batches[0].isFinalBatch, true);
});

test('Coverage Validation: Mendeteksi kelengkapan KB, halaman terpetakan, dan soal formatif', () => {
  const sources = [
    createMockSource({ pageOrder: 1, label: 'rangkuman', text: 'Konsep cloud computing dan virtualisasi' }),
    createMockSource({
      pageOrder: 2,
      label: 'tes_formatif',
      text: '1) Model penyediaan sumber daya tervirtualisasi adalah komputasi awan',
      transcribedQuestions: [
        { prompt: 'Model penyediaan sumber daya tervirtualisasi melalui jaringan adalah komputasi...' },
      ],
    }),
  ];
  const kbStructure = detectModuleKbStructure(sources);

  const mockStudyPack = {
    topics: [
      {
        topicLabel: 'Kegiatan Belajar 1: Komputasi Modern',
        detailedExplanation: 'Membahas model penyediaan sumber daya komputasi awan tervirtualisasi melalui jaringan.',
        bmpSummary: 'Membahas komputasi awan.',
        coreConcepts: ['Komputasi Awan', 'Virtualisasi'],
        sourceRefs: ['Halaman 1', 'Halaman 2'],
      },
    ],
    glossary: [
      {
        term: 'Komputasi Awan',
        bmpDefinition: 'Penyediaan sumber daya komputer melalui jaringan internet.',
        sourceRefs: ['Halaman 1'],
      },
    ],
    initialQuestions: [
      {
        topicLabel: 'Kegiatan Belajar 1: Komputasi Modern',
        prompt: 'Penyediaan sumber daya melalui jaringan adalah...',
        sourceRefs: ['Halaman 2'],
      },
    ],
  };

  const report = validateStudyPackCoverage(mockStudyPack, sources, kbStructure);
  assert.equal(report.kbsCovered, 1);
  assert.equal(report.totalKbsDetected, 1);
  assert.equal(report.pagesMapped, 2);
  assert.equal(report.coveredFormatifQuestions, 1);
  assert.ok(report.coverageScore >= 90);
  assert.equal(report.validationPassed, true);
});

test('Coverage Validation: Menandai jika ada halaman sumber atau KB yang belum terakomodasi', () => {
  const sources = [
    createMockSource({ pageOrder: 1, label: 'rangkuman', text: 'Konsep dasar' }),
    createMockSource({ pageOrder: 2, label: 'tes_formatif', text: 'Tes Formatif 1' }),
    createMockSource({ pageOrder: 3, label: 'rangkuman', text: 'Konsep KB 2' }),
    createMockSource({ pageOrder: 4, label: 'tes_formatif', text: 'Tes Formatif 2' }),
  ];
  const kbStructure = detectModuleKbStructure(sources);

  // Study pack yang hanya memuat KB 1 dan melupakan Halaman 3 dan 4
  const incompletePack = {
    topics: [
      {
        topicLabel: 'Kegiatan Belajar 1: Konsep Dasar',
        detailedExplanation: 'Hanya membahas KB 1.',
        bmpSummary: 'KB 1',
        coreConcepts: ['Konsep Dasar'],
        sourceRefs: ['Halaman 1', 'Halaman 2'],
      },
    ],
    glossary: [],
    initialQuestions: [],
  };

  const report = validateStudyPackCoverage(incompletePack, sources, kbStructure);
  assert.equal(report.kbsCovered, 1);
  assert.equal(report.totalKbsDetected, 2);
  assert.ok(report.unmappedPages.includes(3));
  assert.ok(report.unmappedPages.includes(4));
  assert.equal(report.validationPassed, false);
});

test('Quiz Runner vs Attempt Review: Sasaran Pembelajaran disembunyikan di Runner dan tampil di Review', () => {
  const runnerPath = path.join(projectRoot, 'public/partials/view-quiz-runner.html');
  const reviewPath = path.join(projectRoot, 'public/partials/view-attempt-review.html');

  const runnerHtml = fs.readFileSync(runnerPath, 'utf8');
  const reviewHtml = fs.readFileSync(reviewPath, 'utf8');

  // Di runner: TIDAK boleh ada render learningObjective sebelum soal dijawab
  assert.equal(
    runnerHtml.includes('q.learningObjective'),
    false,
    'view-quiz-runner.html must NOT display learningObjective'
  );

  // Di review: HARUS tetap ada render learningObjective untuk pembahasan
  assert.equal(
    reviewHtml.includes('rq.learningObjective'),
    true,
    'view-attempt-review.html must display learningObjective for explanation'
  );
});

test('Two-Stage Synthesis Pipeline: Mengintegrasikan batch material KB 1, 2, 3 menjadi satu Study Pack utuh', async () => {
  const sources = [
    createMockSource({ pageOrder: 1, label: 'rangkuman', text: 'KB 1 text' }),
    createMockSource({ pageOrder: 2, label: 'tes_formatif', title: 'Tes Formatif 1', text: 'KB 1 questions' }),
    createMockSource({ pageOrder: 3, label: 'rangkuman', text: 'KB 2 text' }),
    createMockSource({ pageOrder: 4, label: 'tes_formatif', title: 'Tes Formatif 2', text: 'KB 2 questions' }),
    createMockSource({ pageOrder: 5, label: 'rangkuman', text: 'KB 3 text' }),
    createMockSource({ pageOrder: 6, label: 'tes_formatif', title: 'Tes Formatif 3', text: 'KB 3 questions' }),
  ];

  const kbStructure = detectModuleKbStructure(sources);
  assert.equal(kbStructure.length, 3);

  const batches = planKbBatches(kbStructure);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].kbs.length, 3);

  // Simulasi sintesis batch 1 (KB 1 & 2)
  const batch1Output = {
    topics: [
      {
        topicLabel: 'Kegiatan Belajar 1: Konsep Dasar',
        bmpSummary: 'Rangkuman lengkap KB 1.',
        detailedExplanation: 'Uraian terstruktur konsep dasar TI dan infrastruktur.',
        coreConcepts: ['Konsep TI', 'Infrastruktur'],
        keyTakeaways: ['TI adalah platform'],
        sourceRefs: ['Halaman 1', 'Halaman 2'],
      },
      {
        topicLabel: 'Kegiatan Belajar 2: Strategi TI',
        bmpSummary: 'Rangkuman lengkap KB 2.',
        detailedExplanation: 'Uraian keunggulan kompetitif dan value chain.',
        coreConcepts: ['Keunggulan Kompetitif', 'Value Chain'],
        keyTakeaways: ['Value chain membagi aktivitas'],
        sourceRefs: ['Halaman 3', 'Halaman 4'],
      },
    ],
    glossary: [
      {
        term: 'Value Chain',
        bmpDefinition: 'Rantai nilai bisnis.',
        sourceRefs: ['Halaman 3'],
      },
    ],
  };

  // Simulasi sintesis batch 2 (KB 3 + Quiz mencakup KB 1, 2, 3)
  const batch2Output = {
    title: 'Bahan Belajar Modul 1 Komprehensif',
    overview: 'Menguraikan 3 Kegiatan Belajar lengkap.',
    topics: [
      {
        topicLabel: 'Kegiatan Belajar 3: Tata Kelola TI',
        bmpSummary: 'Rangkuman lengkap KB 3.',
        detailedExplanation: 'Uraian investasi TI dan TCO.',
        coreConcepts: ['Investasi TI', 'TCO'],
        keyTakeaways: ['TCO memperhitungkan seluruh biaya'],
        sourceRefs: ['Halaman 5', 'Halaman 6'],
      },
    ],
    glossary: [
      {
        term: 'TCO',
        bmpDefinition: 'Total Cost of Ownership.',
        sourceRefs: ['Halaman 5'],
      },
    ],
    coverageNotes: [],
    initialQuestions: [
      {
        topicLabel: 'Kegiatan Belajar 1: Konsep Dasar',
        learningObjective: 'Memahami platform TI',
        prompt: 'Soal representasi KB 1?',
        options: [{ key: 'A', text: 'Pilihan A' }, { key: 'B', text: 'Pilihan B' }],
        correctOption: 'A',
        explanation: 'Penjelasan KB 1',
        sourceRefs: ['Halaman 1'],
      },
      {
        topicLabel: 'Kegiatan Belajar 2: Strategi TI',
        learningObjective: 'Menerapkan Value Chain',
        prompt: 'Soal representasi KB 2?',
        options: [{ key: 'A', text: 'Pilihan A' }, { key: 'B', text: 'Pilihan B' }],
        correctOption: 'A',
        explanation: 'Penjelasan KB 2',
        sourceRefs: ['Halaman 3'],
      },
      {
        topicLabel: 'Kegiatan Belajar 3: Tata Kelola TI',
        learningObjective: 'Menghitung TCO',
        prompt: 'Soal representasi KB 3?',
        options: [{ key: 'A', text: 'Pilihan A' }, { key: 'B', text: 'Pilihan B' }],
        correctOption: 'A',
        explanation: 'Penjelasan KB 3',
        sourceRefs: ['Halaman 5'],
      },
    ],
  };

  // Gabungkan kedua batch
  const integrated = {
    schemaVersion: 2,
    title: batch2Output.title,
    overview: batch2Output.overview,
    topics: [...batch1Output.topics, ...batch2Output.topics],
    glossary: [...batch1Output.glossary, ...batch2Output.glossary],
    coverageNotes: [],
    initialQuestions: batch2Output.initialQuestions,
  };

  const validated = validateAndAlignStudyPack(integrated, sources);
  assert.equal(validated.topics.length, 3, 'Menghasilkan tepat 3 topik KB');
  assert.equal(validated.topics[0].topicLabel, 'Kegiatan Belajar 1: Konsep Dasar');
  assert.equal(validated.topics[1].topicLabel, 'Kegiatan Belajar 2: Strategi TI');
  assert.equal(validated.topics[2].topicLabel, 'Kegiatan Belajar 3: Tata Kelola TI');
  assert.equal(validated.glossary.length, 2);
  assert.equal(validated.initialQuestions.length, 3);

  // Kuis mencakup seluruh KB secara seimbang
  const quizKbs = validated.initialQuestions.map((q) => q.topicLabel);
  assert.ok(quizKbs.some((lbl) => lbl.includes('Kegiatan Belajar 1')));
  assert.ok(quizKbs.some((lbl) => lbl.includes('Kegiatan Belajar 2')));
  assert.ok(quizKbs.some((lbl) => lbl.includes('Kegiatan Belajar 3')));

  const coverageReport = validateStudyPackCoverage(validated, sources, kbStructure);
  assert.equal(coverageReport.kbsCovered, 3);
  assert.equal(coverageReport.totalKbsDetected, 3);
  assert.equal(coverageReport.validationPassed, true);
});

test('Fixed Question Count by KB: 1 KB = 10, 2 KB = 20, >= 3 KB = 25, and Runner paginates 10 per step', () => {
  assert.equal(resolveFixedQuestionCountByKb(1), 10);
  assert.equal(resolveFixedQuestionCountByKb(2), 20);
  assert.equal(resolveFixedQuestionCountByKb(3), 25);
  assert.equal(resolveFixedQuestionCountByKb(4), 25);

  const runnerPath = path.join(projectRoot, 'public/partials/view-quiz-runner.html');
  const runnerHtml = fs.readFileSync(runnerPath, 'utf8');
  assert.equal(runnerHtml.includes('currentQuizPageQuestions'), true);
  assert.equal(runnerHtml.includes('nextQuizPage()'), true);
  assert.equal(runnerHtml.includes('prevQuizPage()'), true);

  // Adding extra 'materi' pages to a 2-KB module must NOT inflate KB count to 3 (stays 2 KB = 20 soal)
  const twoKbWithExtraMaterial = [
    createMockSource({
      pageOrder: 1,
      label: 'rangkuman',
      title: 'Rangkuman Kegiatan Belajar 1',
      text: 'Rangkuman Kegiatan Belajar 1 tentang konsep dasar.',
    }),
    createMockSource({
      pageOrder: 2,
      label: 'tes_formatif',
      title: 'Tes Formatif 1',
      text: 'Tes Formatif 1 soal nomor 1 sampai 5.',
    }),
    createMockSource({
      pageOrder: 3,
      label: 'rangkuman',
      title: 'Rangkuman Kegiatan Belajar 2',
      text: 'Rangkuman Kegiatan Belajar 2 tentang arsitektur.',
    }),
    createMockSource({
      pageOrder: 4,
      label: 'tes_formatif',
      title: 'Tes Formatif 2',
      text: 'Tes Formatif 2 soal nomor 1 sampai 5.',
    }),
    createMockSource({
      pageOrder: 5,
      label: 'materi',
      title: 'Materi Tambahan Contoh Kasus',
      text: 'Penjelasan tambahan dan tabel ilustrasi pendukung KB 2.',
    }),
  ];
  const detectedWithExtra = detectModuleKbStructure(twoKbWithExtraMaterial);
  assert.equal(detectedWithExtra.length, 2);
  assert.equal(resolveFixedQuestionCountByKb(detectedWithExtra.length), 20);

  // Even if Study Pack topics has 3 entries (KB 1, KB 2, and a supplementary topic), countDistinctKbsInTopics returns 2
  const topicsWithExtra = [
    { topicLabel: 'Kegiatan Belajar 1: Konsep Dasar' },
    { topicLabel: 'Kegiatan Belajar 2: Arsitektur Sistem' },
    { topicLabel: 'Materi Tambahan: Studi Kasus' },
  ];
  assert.equal(countDistinctKbsInTopics(topicsWithExtra), 2);
  assert.equal(resolveFixedQuestionCountByKb(countDistinctKbsInTopics(topicsWithExtra)), 20);
});

test('Immediate Floating Progress Card: all actions call startAiJobFeedback before fetch so Vercel serverless shows progress immediately', () => {
  const publicDir = path.join(projectRoot, 'public');
  const appJs = renderModularJs(publicDir);

  assert.equal(appJs.includes('startAiJobFeedback('), true);
  assert.equal(appJs.includes('clearPendingAiJobFeedback()'), true);

  // Verify each major action sets activeAiJob before fetch
  const requiredActions = [
    'submitSourceExtraction()',
    'saveSourceReview(sourceId',
    'quickApproveSource(source)',
    'generateStudyPackAndQuiz(regenerate = false)',
    'generateExtraPracticeSet()',
    'submitQuizAnswers()',
    'generateRemedialFromAttempt(attemptId',
    'generateExamSimulation()',
    'submitCourseForm()',
    'restoreCourse(course)',
    'submitModuleForm()',
    'handleTocImageUpload(event)',
    'executeConfirmDialog()',
  ];

  for (const fnSig of requiredActions) {
    const startIdx = appJs.indexOf(fnSig);
    assert.notEqual(startIdx, -1, `Expected to find ${fnSig} in app.js`);
    const slice = appJs.slice(startIdx, startIdx + 700);
    const feedbackIdx = slice.indexOf('startAiJobFeedback(');
    const fetchIdx = slice.indexOf('fetch(');
    assert.notEqual(feedbackIdx, -1, `Expected ${fnSig} to call startAiJobFeedback`);
    if (fetchIdx !== -1) {
      assert.ok(
        feedbackIdx < fetchIdx,
        `Expected ${fnSig} to call startAiJobFeedback before fetch() so progress card renders immediately on Vercel`
      );
    }
  }
});

test('RPD Efficiency Architecture: OCR up to 15 images in 1 request, Study Pack + Quiz in 1 request (2 requests/module)', async () => {
  const { getEnvConfig } = await import('../src/config/env.js');
  const { buildSystemInstruction } = await import('../src/services/studyPack/kbPlanner.js');

  const config = getEnvConfig();
  assert.equal(config.aiMaxImagesPerBatch, 15, 'Max images per batch should default to 15');
  assert.equal(config.aiMaxOutputTokensExtraction, 65536, 'Extraction output token budget should be 65536');
  assert.equal(config.aiMaxOutputTokensStudyPack, 65536, 'Study Pack output token budget should be 65536');

  // Verify 15 pages across 3 KBs are planned into 1 single batch request
  const fifteenSources = Array.from({ length: 15 }, (_, idx) => {
    const pageOrder = idx + 1;
    const kbNum = Math.min(3, Math.ceil(pageOrder / 5));
    const isFormatif = pageOrder % 5 === 0;
    return createMockSource({
      pageOrder,
      label: isFormatif ? 'tes_formatif' : 'rangkuman',
      title: isFormatif ? `Tes Formatif ${kbNum}` : `Rangkuman Kegiatan Belajar ${kbNum}`,
      text: `${isFormatif ? `Tes Formatif ${kbNum}` : `Kegiatan Belajar ${kbNum}`} — halaman ${pageOrder} berisi materi lengkap.`,
    });
  });

  const kbs = detectModuleKbStructure(fifteenSources);
  assert.equal(kbs.length, 3);
  const batches = planKbBatches(kbs);
  assert.equal(batches.length, 1, 'All 3 KBs from 15 pages must be synthesized in 1 single request');
  assert.equal(batches[0].isFinalBatch, true);

  const sysPrompt = buildSystemInstruction({
    isFinalBatch: true,
    totalQuestionCount: 25,
    kbTitles: 'KB 1, KB 2, KB 3',
  });
  assert.ok(sysPrompt.includes('ZERO COMPRESSION'), 'System instruction must enforce zero compression policy');
  assert.ok(sysPrompt.includes('65.536 token'), 'System instruction must encourage using full token budget');
});

test('5-API Key Pool + 4-Tier Model Failover Cascade: gemini-4-hydrogen -> gemini-3.6-flash -> gemini-3.8-flash -> gemini-3.5-flash-lite', async () => {
  const { getEnvConfig, DEFAULT_GEMINI_MODEL_CHAIN } = await import('../src/config/env.js');
  const {
    GeminiApiKeyPool,
    defaultApiKeyPool,
    generateStructuredContent,
    getMsUntilDailyQuotaReset,
  } = await import('../src/services/geminiClient.js');
  const os = await import('node:os');

  assert.deepEqual(DEFAULT_GEMINI_MODEL_CHAIN, [
    'gemini-4-hydrogen',
    'gemini-3.6-flash',
    'gemini-3.8-flash',
    'gemini-3.5-flash-lite',
  ]);

  const snapshot = {};
  for (const k of Object.keys(process.env)) {
    if (/gemini/i.test(k)) {
      snapshot[k] = process.env[k];
      delete process.env[k];
    }
  }

  try {
    process.env.Gemini_API_1 = 'key-1-alpha1234';
    process.env.Gemini_API_2 = 'key-2-bravo1234';
    process.env.Gemini_API_3 = 'key-3-charlie12';
    process.env.Gemini_API_4 = 'key-4-delta1234';
    process.env.Gemini_API_5 = 'key-5-echo12345';
    process.env.GEMINI_MODEL = 'gemini-4-hydrogen';

    defaultApiKeyPool.reset();
    const keys = defaultApiKeyPool.getKeys();
    assert.equal(keys.length, 5, 'Should parse all 5 numbered API keys');

    const config = getEnvConfig();
    assert.deepEqual(config.geminiFallbackModels, [
      'gemini-4-hydrogen',
      'gemini-3.6-flash',
      'gemini-3.8-flash',
      'gemini-3.5-flash-lite',
    ]);

    const attemptedCalls = [];
    // Stub getClientForKey to simulate RPD exhaustion across models until gemini-3.5-flash-lite succeeds on key #1
    const origGetClient = defaultApiKeyPool.getClientForKey.bind(defaultApiKeyPool);
    defaultApiKeyPool.getClientForKey = (key) => ({
      models: {
        generateContent: async ({ model }) => {
          attemptedCalls.push({ model, key });
          if (model !== 'gemini-3.5-flash-lite') {
            const err = new Error(`Quota exceeded for metric: GenerateRequestsPerDay on ${model}`);
            err.status = 429;
            throw err;
          }
          return {
            text: JSON.stringify({ ok: true, modelUsed: model, keyUsed: key }),
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 },
          };
        },
      },
    });

    try {
      const res = await generateStructuredContent({
        taskType: 'extract_sources',
        contents: 'Test cascade',
      });

      assert.equal(res.model, 'gemini-3.5-flash-lite');
      assert.equal(res.data.ok, true);
      // 5 keys tried on gemini-4-hydrogen + 5 keys on gemini-3.6-flash + 5 keys on gemini-3.8-flash + 1st key succeeds on gemini-3.5-flash-lite = 16 attempts
      assert.equal(attemptedCalls.length, 16);
      assert.deepEqual(
        attemptedCalls.slice(0, 5).map((c) => c.model),
        Array(5).fill('gemini-4-hydrogen')
      );
      assert.deepEqual(
        attemptedCalls.slice(5, 10).map((c) => c.model),
        Array(5).fill('gemini-3.6-flash')
      );
      assert.deepEqual(
        attemptedCalls.slice(10, 15).map((c) => c.model),
        Array(5).fill('gemini-3.8-flash')
      );
      assert.equal(attemptedCalls[15].model, 'gemini-3.5-flash-lite');

      // Second call immediately skips all daily-locked keys/models and hits gemini-3.5-flash-lite in 1 attempt
      const resSecond = await generateStructuredContent({
        taskType: 'extract_sources',
        contents: 'Second call skips daily-locked models',
      });
      assert.equal(resSecond.model, 'gemini-3.5-flash-lite');
      assert.equal(attemptedCalls.length, 17, 'Second call must skip all cooled-down tiers without probing keys again');

      // Partial exhaustion: if keys 1-4 already cooled down on gemini-4-hydrogen and only key 5 remains, failing key 5 must NOT re-try keys 1-4
      defaultApiKeyPool.reset();
      for (const k of ['key-1-alpha1234', 'key-2-bravo1234', 'key-3-charlie12', 'key-4-delta1234']) {
        defaultApiKeyPool.markCooldown(k, 60 * 60 * 1000, 'gemini-4-hydrogen');
      }
      attemptedCalls.length = 0;
      const resPartial = await generateStructuredContent({
        taskType: 'extract_sources',
        contents: 'Only key-5 left on primary model',
      });
      assert.equal(resPartial.model, 'gemini-3.5-flash-lite');
      const h4Calls = attemptedCalls.filter((c) => c.model === 'gemini-4-hydrogen');
      assert.equal(h4Calls.length, 1, 'Must only attempt remaining active key-5 on gemini-4-hydrogen');
      assert.equal(h4Calls[0].key, 'key-5-echo12345');

      // Daily reset window & persistent cooldown file across restarts (hashed keys, no plaintext secret stored)
      const resetMs = getMsUntilDailyQuotaReset();
      assert.ok(resetMs >= 5 * 60 * 1000 && resetMs <= 24 * 60 * 60 * 1000 + 60_000);

      const persistFile = path.join(os.default.tmpdir(), `ut-test-cd-${Date.now()}.json`);
      try {
        const poolA = new GeminiApiKeyPool({ persistPath: persistFile });
        poolA.getKeys();
        poolA.markCooldown('key-1-alpha1234', resetMs, 'gemini-4-hydrogen');
        const rawDisk = fs.readFileSync(persistFile, 'utf8');
        assert.equal(rawDisk.includes('key-1-alpha1234'), false, 'Persisted cooldown file must hash keys');

        const poolB = new GeminiApiKeyPool({ persistPath: persistFile });
        assert.equal(poolB.getActiveKeyInfo('gemini-4-hydrogen').key, 'key-2-bravo1234');
      } finally {
        fs.rmSync(persistFile, { force: true });
      }
    } finally {
      defaultApiKeyPool.getClientForKey = origGetClient;
      defaultApiKeyPool.reset();
    }
  } finally {
    for (const k of Object.keys(process.env)) {
      if (/gemini/i.test(k)) delete process.env[k];
    }
    Object.assign(process.env, snapshot);
    defaultApiKeyPool.reset();
  }
});

test('Math Layout Preservation: interval math like (-infty, 0) cup (0, infty) and blank lines between questions are never split/collapsed', async () => {
  const { normalizeExtractedText } = await import('../src/services/extractionService.js');

  const rawExtracted = [
    '7) $(f \\circ g)(x) = \\dots$.',
    'A. $\\frac{2 - x}{x + 1}$',
    'B. $\\frac{1}{x}$',
    '',
    '8) $D(g \\circ f) = \\dots$.',
    'A. $(-\\infty, 0) \\cup (0, \\infty)$',
    'B. $(-\\infty, -1) \\cup (-1, \\infty)$',
    '',
    '9) $D(f \\circ g) = \\dots$.',
    'A. $(-\\infty, 0) \\cup (0, \\infty)$',
    'B. $[0, 1) \\cup (1, 2]$',
  ].join('\n');

  const normalizedServer = normalizeExtractedText(rawExtracted);
  assert.ok(
    normalizedServer.includes('A. $(-\\infty, 0) \\cup (0, \\infty)$'),
    'Server normalizeExtractedText must NOT split $( -\\infty, 0) \\cup (0, \\infty )$ across lines'
  );
  assert.ok(
    normalizedServer.includes('B. $[0, 1) \\cup (1, 2]$'),
    'Server normalizeExtractedText must NOT split $[0, 1)$ across lines'
  );
  assert.ok(
    normalizedServer.includes('B. $\\frac{1}{x}$\n\n8) $D(g \\circ f)'),
    'Blank line between question 7 and 8 must be preserved'
  );

  // Also test frontend normalizeCollapsedMathLayout directly
  const mathModuleCode = fs.readFileSync(
    path.join(projectRoot, 'public/js/modules/mathAndFormatters.js'),
    'utf8'
  );
  const fakeWindow = { AppModules: {} };
  new Function('window', mathModuleCode)(fakeWindow);
  const formatter = fakeWindow.AppModules.mathAndFormatters;

  const formatted = formatter.normalizeCollapsedMathLayout(normalizedServer);
  assert.ok(
    formatted.includes('A. $(-\\infty, 0) \\cup (0, \\infty)$'),
    'Frontend normalizeCollapsedMathLayout must NOT split $( -\\infty, 0) \\cup (0, \\infty )$ across lines'
  );
  assert.ok(
    formatted.includes('B. $\\frac{1}{x}$\n\n8) $D(g \\circ f)'),
    'Frontend normalizeCollapsedMathLayout must preserve blank line before 8)'
  );

  // Also test healing already-saved broken intervals from older extractions
  const legacyBroken = '9) $D(f \\circ g) = \\dots$.\nA. $(-\\infty,\n\n0) \\cup (0, \\infty)$\nB. $(-\\infty, -1) \\cup (-1, \\infty)$';
  const healed = formatter.normalizeCollapsedMathLayout(legacyBroken);
  assert.ok(
    healed.includes('A. $(-\\infty, 0) \\cup (0, \\infty)$'),
    'Frontend must heal legacy split interval math back onto one line so KaTeX renders it'
  );

  // Also test splitting collapsed long prose walls (e.g. NL=0 AI study pack explanations) into paragraphs
  const { ensureReadableParagraphs } = await import('../src/services/studyPack/studyPackSchemas.js');
  const wallOfText =
    'Keamanan berkas dalam sistem operasi mengatur hak akses direktori. Pada sistem operasi Windows, pengaturan dilakukan di tab Security dengan fitur (1) Full control; dan (2) Read and execute untuk berkas program (.exe). ' +
    'Apabila folder induk mewariskan izin, tersedia opsi Disable Inheritance di menu lanjutan. ' +
    'Sementara itu, pada sistem operasi Linux, perintah chown dan chgrp mengatur kepemilikan berkas serta direktori bagi user, group, dan other. ' +
    'Selain kepemilikan, perintah chmod u+x text.txt mengatur izin eksekusi secara simbolik tanpa mengganggu isi berkas. ' +
    'Pada metode numerik, sembilan bit permission memakai bobot biner $1$ atau $0$ dengan total oktal $4+2+1=7$ yang sangat ringkas.';

  const frontendParagraphs = formatter.normalizeCollapsedMathLayout(wallOfText).split('\n\n');
  const backendParagraphs = ensureReadableParagraphs(wallOfText).split('\n\n');
  assert.ok(frontendParagraphs.length >= 2, 'Frontend formatter must break un-paragraphed long prose into multiple paragraphs');
  assert.ok(backendParagraphs.length >= 2, 'Backend normalizer must break un-paragraphed long prose into multiple paragraphs');
  assert.ok(!backendParagraphs.some((p) => p.endsWith('text.') || p.endsWith('(')), 'Must never break mid-filename (.txt/.exe) or inside parentheses');
  assert.ok(backendParagraphs.join('\n\n').includes('$4+2+1=7$'), 'Math tokens must remain intact across paragraph splits');
});

test('Upload UX: Drag-and-Drop and Clipboard Paste (Ctrl+V) work alongside manual file input without breaking TOC/module handlers', async () => {
  const { renderModularHtml, renderModularJs } = await import('../src/services/htmlRenderer.js');
  const publicDir = path.join(projectRoot, 'public');
  const html = renderModularHtml(publicDir);
  const bundledJs = renderModularJs(publicDir);

  assert.ok(html.includes('@drop.prevent="handleSourceDrop($event)"'), 'Module dropzone must support drag-and-drop');
  assert.ok(html.includes('@click="pasteSourceFromClipboard()"'), 'Module upload must include clipboard paste trigger');
  assert.ok(html.includes('@change="handleFileSelect($event)"'), 'Manual file upload must remain intact');
  assert.ok(html.includes('@drop.prevent="handleTocDrop($event)"'), 'Course TOC dropzone must support drag-and-drop');
  assert.ok(html.includes('class="staged-thumb"'), 'Staged file rows should render thumbnail previews');
  assert.equal(html.includes('id="staged-default-label"'), false, 'Staging UI must not show default label select');
  assert.equal(html.includes('x-model="item.label"'), false, 'Staged rows must not show manual page type form (AI determines label)');

  // Evaluate state + sourcesAndExtraction + combined bundle (browser double-load) in sandboxed context
  const fakeWindow = { AppModules: {} };
  const notices = [];
  const errors = [];
  const stateCode = fs.readFileSync(path.join(projectRoot, 'public/js/modules/state.js'), 'utf8');
  const srcCode = fs.readFileSync(path.join(projectRoot, 'public/js/modules/sourcesAndExtraction.js'), 'utf8');
  new Function('window', stateCode)(fakeWindow);
  new Function('window', srcCode)(fakeWindow);
  assert.doesNotThrow(
    () => new Function(stateCode + '\n' + srcCode + '\n' + bundledJs),
    'Combined modular JS bundle must parse cleanly even when modules load before /js/app.js'
  );

  const ctx = {
    ...fakeWindow.AppModules.state,
    ...fakeWindow.AppModules.sourcesAndExtraction,
    activeModule: { id: 'mod-1', sources: [{ id: 'existing-1' }] },
    currentView: 'module',
    moduleTab: 'sources',
    stagedFiles: [],
    showNotice: (m) => notices.push(m),
    showError: (m) => errors.push(m),
  };

  // Stub URL.createObjectURL & URL.revokeObjectURL for Node test
  const origCreate = globalThis.URL.createObjectURL;
  const origRevoke = globalThis.URL.revokeObjectURL;
  let seqUrl = 0;
  globalThis.URL.createObjectURL = () => `blob:mock-${++seqUrl}`;
  globalThis.URL.revokeObjectURL = () => {};

  try {
    // 1) Simulate Drag-and-Drop with 1 valid PNG and 1 unsupported PDF
    const validImg = new File([new Uint8Array([1, 2, 3])], 'hal-2.png', { type: 'image/png' });
    const invalidPdf = new File([new Uint8Array([4, 5])], 'notes.pdf', { type: 'application/pdf' });
    ctx.isSourceDragOver = true;
    ctx.handleSourceDrop({
      dataTransfer: {
        items: [
          { kind: 'file', getAsFile: () => validImg },
          { kind: 'file', getAsFile: () => invalidPdf },
        ],
      },
    });
    assert.equal(ctx.isSourceDragOver, false);
    assert.equal(ctx.stagedFiles.length, 1);
    assert.equal('label' in ctx.stagedFiles[0], false, 'Staged items no longer carry manual label');
    assert.equal(ctx.stagedFiles[0].pageOrder, 2, 'pageOrder must continue after existing sources');
    assert.ok(errors[0].includes('1 file non-gambar diabaikan'));

    // Also verify AI auto-classification helper & schema enum
    const { resolveExtractedPageLabel, EXTRACTION_RESPONSE_JSON_SCHEMA } = await import('../src/services/extractionService.js');
    assert.deepEqual(EXTRACTION_RESPONSE_JSON_SCHEMA.properties.pages.items.properties.pageType.enum, [
      'materi',
      'rangkuman',
      'tes_formatif',
    ]);
    assert.equal(resolveExtractedPageLabel({ pageType: 'tes_formatif', extractedText: 'Isi biasa' }), 'tes_formatif');
    assert.equal(resolveExtractedPageLabel({ pageType: 'rangkuman', extractedText: 'Isi biasa' }), 'rangkuman');
    assert.equal(resolveExtractedPageLabel({ pageTitle: 'Tes Formatif 2', extractedText: '1) Apa...' }), 'tes_formatif');
    assert.equal(resolveExtractedPageLabel({ pageTitle: 'Rangkuman KB 1', extractedText: 'Ringkasan...' }), 'rangkuman');

    // 2) Simulate Ctrl+V clipboard screenshot with generic 'image.png' name
    let prevented = false;
    const clipPng = new File([new Uint8Array([9, 8, 7])], 'image.png', { type: 'image/png' });
    ctx.handleGlobalImagePaste({
      clipboardData: {
        items: [{ kind: 'file', getAsFile: () => clipPng }],
      },
      preventDefault: () => {
        prevented = true;
      },
    });
    assert.equal(prevented, true);
    assert.equal(ctx.stagedFiles.length, 2);
    assert.match(ctx.stagedFiles[1].file.name, /^clipboard-.*\.png$/, 'Generic clipboard filename should be renamed');
    assert.equal(ctx.stagedFiles[1].pageOrder, 3);

    // 3) Text-only paste must NOT be hijacked (allows normal text editing)
    let textPrevented = false;
    ctx.handleGlobalImagePaste({
      clipboardData: { items: [{ kind: 'string', getAsFile: () => null }] },
      preventDefault: () => {
        textPrevented = true;
      },
    });
    assert.equal(textPrevented, false);
    assert.equal(ctx.stagedFiles.length, 2);
  } finally {
    globalThis.URL.createObjectURL = origCreate;
    globalThis.URL.revokeObjectURL = origRevoke;
  }
});

test('Empty Response & 5xx Failover + Cooldown Skip + Extraction Sub-Batch Auto-Split', async () => {
  const { defaultApiKeyPool, generateStructuredContent } = await import('../src/services/geminiClient.js');
  const { defaultGeminiExtractionCall } = await import('../src/services/extractionService.js');

  const snapshot = {};
  for (const k of Object.keys(process.env)) {
    if (/gemini/i.test(k)) {
      snapshot[k] = process.env[k];
      delete process.env[k];
    }
  }

  try {
    process.env.Gemini_API_1 = 'key-1-alpha1234';
    process.env.Gemini_API_2 = 'key-2-bravo1234';
    process.env.Gemini_API_3 = 'key-3-charlie12';
    process.env.GEMINI_MODEL = 'gemini-4-hydrogen';

    defaultApiKeyPool.reset();
    const origGetClient = defaultApiKeyPool.getClientForKey.bind(defaultApiKeyPool);

    try {
      // Case 1: Primary model returns HTTP 200 empty response (RECITATION); fallback model 3.6 returns 500 on key-2 then succeeds on key-3
      const calls1 = [];
      defaultApiKeyPool.getClientForKey = (key) => ({
        models: {
          generateContent: async ({ model }) => {
            calls1.push({ model, key });
            if (model === 'gemini-4-hydrogen') {
              return {
                text: '',
                candidates: [{ finishReason: 'RECITATION', content: { parts: [] } }],
                usageMetadata: { promptTokenCount: 10035, totalTokenCount: 10035 },
              };
            }
            if (model === 'gemini-3.6-flash' && key === 'key-2-bravo1234') {
              const err500 = new Error('Internal server error');
              err500.status = 500;
              throw err500;
            }
            return {
              text: JSON.stringify({ ok: true, modelUsed: model, keyUsed: key }),
              usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 80, totalTokenCount: 200 },
            };
          },
        },
      });

      const res1 = await generateStructuredContent({
        taskType: 'extract_sources',
        contents: 'Test empty failover',
      });
      assert.equal(res1.model, 'gemini-3.6-flash');
      assert.equal(res1.data.ok, true);
      assert.deepEqual(
        calls1,
        [
          { model: 'gemini-4-hydrogen', key: 'key-1-alpha1234' },
          { model: 'gemini-3.6-flash', key: 'key-2-bravo1234' },
          { model: 'gemini-3.6-flash', key: 'key-3-charlie12' },
        ],
        'Empty response on primary must immediately failover to next model with rotated API key'
      );

      // Case 2: Skip model whose keys are ALL already on RPD cooldown on subsequent calls
      defaultApiKeyPool.reset();
      for (const k of defaultApiKeyPool.getKeys()) {
        defaultApiKeyPool.markCooldown(k, 60 * 60 * 1000, 'gemini-4-hydrogen');
      }
      assert.equal(defaultApiKeyPool.areAllKeysOnCooldown('gemini-4-hydrogen'), true);
      assert.equal(defaultApiKeyPool.areAllKeysOnCooldown('gemini-3.6-flash'), false);

      const calls2 = [];
      defaultApiKeyPool.getClientForKey = (key) => ({
        models: {
          generateContent: async ({ model }) => {
            calls2.push({ model, key });
            return {
              text: JSON.stringify({ ok: true }),
              usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20, totalTokenCount: 70 },
            };
          },
        },
      });
      const res2 = await generateStructuredContent({
        taskType: 'extract_sources',
        contents: 'Test cooldown skip',
      });
      assert.equal(res2.model, 'gemini-3.6-flash');
      assert.equal(calls2.length, 1, 'Should skip exhausted gemini-4-hydrogen and hit gemini-3.6-flash in 1 call');

      // Case 3: defaultGeminiExtractionCall auto-splits multi-image batch into halves if ALL 4 models return empty output when combined
      defaultApiKeyPool.reset();
      defaultApiKeyPool.getClientForKey = () => ({
        models: {
          generateContent: async ({ model, contents }) => {
            const imageParts = (contents || []).filter((c) => c && c.inlineData);
            if (imageParts.length > 2) {
              return {
                text: '',
                candidates: [{ finishReason: 'OTHER', content: { parts: [] } }],
                usageMetadata: { promptTokenCount: 500, totalTokenCount: 500 },
              };
            }
            // Extract sourceImageId values from text parts right before each inlineData
            const textParts = (contents || []).filter((c) => c && typeof c.text === 'string');
            const ids = textParts
              .map((p) => {
                const m = p.text.match(/sourceImageId:\s*(\S+)/);
                const po = p.text.match(/pageOrder:\s*(\d+)/);
                return m ? { id: m[1], pageOrder: po ? Number(po[1]) : 1 } : null;
              })
              .filter(Boolean);

            return {
              text: JSON.stringify({
                schemaVersion: 1,
                pages: ids.map((item) => ({
                  sourceImageId: item.id,
                  pageOrder: item.pageOrder,
                  pageTitle: `Hal ${item.pageOrder}`,
                  extractedText: `Isi halaman ${item.pageOrder}`,
                  sections: [],
                  keyTerms: [],
                  formulasOrTables: [],
                  transcribedQuestions: [],
                  ambiguousParts: [],
                  needsReview: false,
                })),
              }),
              usageMetadata: { promptTokenCount: 250, candidatesTokenCount: 150, totalTokenCount: 400 },
            };
          },
        },
      });

      const fakeSources = [1, 2, 3, 4].map((n) => ({
        source: {
          id: `src-${n}`,
          pageOrder: n,
          label: 'materi',
          fileName: `hal-${n}.png`,
          mimeType: 'image/png',
        },
        buffer: Buffer.from([1, 2, 3]),
      }));

      const splitResult = await defaultGeminiExtractionCall({
        moduleRecord: { moduleNumber: 6, title: 'Manajemen File Sistem Operasi' },
        sourceRecordsWithBuffers: fakeSources,
      });

      assert.equal(splitResult.data.pages.length, 4);
      assert.deepEqual(
        splitResult.data.pages.map((p) => p.sourceImageId),
        ['src-1', 'src-2', 'src-3', 'src-4']
      );
      assert.equal(splitResult.usageMetadata.totalTokenCount, 800);

      // Case 4: Consecutive successful calls rotate round-robin across all 3 configured API keys
      defaultApiKeyPool.reset();
      const usedKeys = [];
      defaultApiKeyPool.getClientForKey = (key) => ({
        models: {
          generateContent: async () => {
            usedKeys.push(key);
            return {
              text: JSON.stringify({ ok: true }),
              usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 },
            };
          },
        },
      });

      for (let i = 0; i < 4; i++) {
        await generateStructuredContent({
          taskType: 'extract_sources',
          contents: `Round robin ping ${i}`,
        });
      }
      assert.deepEqual(usedKeys, [
        'key-1-alpha1234',
        'key-2-bravo1234',
        'key-3-charlie12',
        'key-1-alpha1234',
      ]);

      // Case 5: Request timeout on a model skips other keys on that stalled model tier and isolates it for 3m
      defaultApiKeyPool.reset();
      const timeoutCalls = [];
      defaultApiKeyPool.getClientForKey = (key) => ({
        models: {
          generateContent: async ({ model }) => {
            timeoutCalls.push({ model, key });
            if (model === 'gemini-4-hydrogen') {
              const abortErr = new Error('The operation was aborted due to timeout');
              abortErr.name = 'TimeoutError';
              abortErr.code = 20;
              throw abortErr;
            }
            return {
              text: JSON.stringify({ ok: true }),
              usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 30 },
            };
          },
        },
      });
      const resTimeout1 = await generateStructuredContent({
        taskType: 'extract_sources',
        contents: 'Timeout jump',
      });
      assert.equal(resTimeout1.model, 'gemini-3.6-flash');
      assert.equal(
        timeoutCalls.filter((c) => c.model === 'gemini-4-hydrogen').length,
        1,
        'Stalled model timeout must jump immediately without wasting time on remaining keys of same stalled tier'
      );

      const resTimeout2 = await generateStructuredContent({
        taskType: 'extract_sources',
        contents: 'Subsequent call skips stalled tier',
      });
      assert.equal(resTimeout2.model, 'gemini-3.6-flash');
      assert.equal(
        timeoutCalls.filter((c) => c.model === 'gemini-4-hydrogen').length,
        1,
        'Second call within timeout cooldown window must skip stalled tier completely'
      );

      // Verify frontend extractApiErrorMessage translates 504/Vercel proxy timeout payloads clearly
      const apiWin = { AppModules: {} };
      const apiCode = fs.readFileSync(path.join(projectRoot, 'public/js/modules/apiAndJobs.js'), 'utf8');
      new Function('window', apiCode)(apiWin);
      const apiHelper = apiWin.AppModules.apiAndJobs;
      const msg504 = apiHelper.extractApiErrorMessage({ error: { code: '504', message: 'FUNCTION_INVOCATION_TIMEOUT' } }, 504, 'Fallback');
      assert.match(msg504, /HTTP 504/i);
      assert.match(msg504, /60 detik/);
      assert.equal(
        apiHelper.extractApiErrorMessage({ error: { message: 'Nested err details' } }, 500, 'Fallback'),
        'Nested err details'
      );
    } finally {
      defaultApiKeyPool.getClientForKey = origGetClient;
      defaultApiKeyPool.reset();
    }
  } finally {
    for (const k of Object.keys(process.env)) {
      if (/gemini/i.test(k)) delete process.env[k];
    }
    Object.assign(process.env, snapshot);
    defaultApiKeyPool.reset();
  }
});
