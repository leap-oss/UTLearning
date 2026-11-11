import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  detectModuleKbStructure,
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

test('Batch Planning: 3 KB default 2 batch (Batch 1: KB 1 & 2, Batch 2: KB 3)', () => {
  const kbs = [
    { kbNumber: 1, totalChars: 8000, sources: [] },
    { kbNumber: 2, totalChars: 8000, sources: [] },
    { kbNumber: 3, totalChars: 8000, sources: [] },
  ];
  const batches = planKbBatches(kbs, { maxSafeCharsPerBatch: 35000 });
  assert.equal(batches.length, 2);
  assert.deepEqual(batches[0].kbs.map((k) => k.kbNumber), [1, 2]);
  assert.equal(batches[0].isFinalBatch, false);
  assert.deepEqual(batches[1].kbs.map((k) => k.kbNumber), [3]);
  assert.equal(batches[1].isFinalBatch, true);
});

test('Batch Planning: 4 KB didistribusikan seimbang ke 2 batch', () => {
  const kbs = [
    { kbNumber: 1, totalChars: 6000, sources: [] },
    { kbNumber: 2, totalChars: 6000, sources: [] },
    { kbNumber: 3, totalChars: 6000, sources: [] },
    { kbNumber: 4, totalChars: 6000, sources: [] },
  ];
  const batches = planKbBatches(kbs, { maxSafeCharsPerBatch: 35000 });
  assert.equal(batches.length, 2);
  assert.deepEqual(batches[0].kbs.map((k) => k.kbNumber), [1, 2]);
  assert.deepEqual(batches[1].kbs.map((k) => k.kbNumber), [3, 4]);
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
  const runnerPath = path.join(process.cwd(), 'public/partials/view-quiz-runner.html');
  const reviewPath = path.join(process.cwd(), 'public/partials/view-attempt-review.html');

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
  assert.equal(batches.length, 2);

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
