import test from 'node:test';
import assert from 'node:assert/strict';
import {
  studyPackSynthesisSchema,
  topicLearningMaterialSchema,
  validateAndAlignStudyPack,
} from '../src/services/studyPackService.js';

test('Comprehensive Study Pack: v1 Legacy Schema backward compatibility', () => {
  const legacyV1Input = {
    schemaVersion: 1,
    title: 'Study Pack Modul 1 v1',
    overview: 'Ringkasan singkat modul 1.',
    topics: [
      {
        topicLabel: 'Konsep Kernel',
        bmpSummary: 'Kernel adalah inti dari sistem operasi.',
        aiExplanation: 'Kernel ibarat otak pengatur lalu lintas.',
        keyTakeaways: ['Kernel mengatur hardware'],
        sourceRefs: ['Halaman 1'],
      },
    ],
    glossary: [
      {
        term: 'Kernel',
        bmpDefinition: 'Inti OS.',
        simpleAnalogy: 'Otak sistem.',
        sourceRefs: ['Halaman 1'],
      },
    ],
    coverageNotes: [],
    initialQuestions: [
      {
        topicLabel: 'Konsep Kernel',
        learningObjective: 'Memahami fungsi kernel',
        questionType: 'single_choice',
        prompt: 'Apa fungsi utama kernel dalam sistem operasi?',
        options: [
          { key: 'A', text: 'Mengelola perangkat keras' },
          { key: 'B', text: 'Membuat dokumen' },
        ],
        correctOption: 'A',
        explanation: 'Kernel bertugas mengelola perangkat keras.',
        difficulty: 'easy',
        sourceRefs: ['Halaman 1'],
      },
    ],
  };

  const parsed = studyPackSynthesisSchema.parse(legacyV1Input);
  assert.equal(parsed.title, 'Study Pack Modul 1 v1');
  assert.equal(parsed.topics.length, 1);
  // Auto-populates detailedExplanation from bmpSummary for legacy consumers
  assert.equal(parsed.topics[0].bmpSummary, 'Kernel adalah inti dari sistem operasi.');
  assert.equal(parsed.topics[0].detailedExplanation, 'Kernel adalah inti dari sistem operasi.');
  assert.deepEqual(parsed.topics[0].coreConcepts, []);
  assert.deepEqual(parsed.topics[0].comparisons, []);
});

test('Comprehensive Study Pack: v2 Rich Learning Materials validation', () => {
  const richV2Input = {
    schemaVersion: 2,
    title: 'Bahan Belajar Lengkap Modul 1: Sistem Operasi',
    overview: 'Bahan belajar komprehensif menguraikan arsitektur OS dan manajemen memori.',
    moduleLearningObjectives: [
      'Menjelaskan peran kernel dalam manajemen perangkat keras',
      'Membedakan mode kernel dan mode pengguna',
    ],
    topics: [
      {
        topicLabel: 'Arsitektur dan Struktur Kernel',
        learningObjectives: ['Memahami arsitektur kernel mikro vs monolitik'],
        sourceRefs: ['Halaman 3', 'Halaman 4'],
        coreConcepts: ['Monolithic Kernel', 'Microkernel', 'Dual-mode operation'],
        bmpSummary: 'Kernel mengontrol eksekusi instruksi istimewa.',
        detailedExplanation:
          'Kernel merupakan perangkat lunak sentral yang mengeksekusi instruksi pada mode istimewa (ring 0). ' +
          'Sistem operasi memisahkan ruang memori antara user space dan kernel space untuk mencegah aplikasi pengguna merusak stabilitas sistem.',
        conceptRelationships: [
          {
            conceptA: 'User Mode',
            conceptB: 'Kernel Mode',
            relationship: 'Aplikasi beralih ke kernel mode melalui mekanisme system call.',
          },
        ],
        comparisons: [
          {
            itemA: 'Monolithic Kernel',
            itemB: 'Microkernel',
            distinction: 'Monolithic memuat semua layanan di ring 0, sedangkan Microkernel hanya memuat layanan esensial.',
          },
        ],
        processesOrStages: [
          {
            stepNumber: 1,
            name: 'Pemicu System Call',
            description: 'Aplikasi memicu instruksi trap perangkat lunak.',
          },
          {
            stepNumber: 2,
            name: 'Peralihan Mode',
            description: 'CPU mengubah bit mode dari user mode (1) menjadi kernel mode (0).',
          },
        ],
        examples: [
          {
            context: 'Membaca Berkas',
            illustration: 'Fungsi read() memanggil system call sys_read di kernel.',
            isAiGenerated: true,
          },
        ],
        commonMisconceptions: [
          {
            misconception: 'Aplikasi dapat langsung mengakses hard disk tanpa perantara.',
            correction: 'Semua akses I/O wajib melalui perantara kernel demi keamanan.',
          },
        ],
        keyTakeaways: [
          'Dual mode mencegah eksekusi instruksi ilegal oleh pengguna',
          'System call adalah gerbang transisi mode',
        ],
        aiExplanation: 'Bayangkan user mode seperti penumpang dan kernel mode seperti kapten kapal.',
      },
    ],
    glossary: [
      {
        term: 'System Call',
        bmpDefinition: 'Antarmuka program antara program pengguna dan layanan kernel OS.',
        simpleAnalogy: 'Pintu loket pelayanan dokumen resmi.',
        sourceRefs: ['Halaman 4'],
      },
    ],
    coverageNotes: ['Seluruh materi pada halaman 3-4 BMP tercakup lengkap'],
    initialQuestions: [
      {
        topicLabel: 'Arsitektur dan Struktur Kernel',
        learningObjective: 'Membedakan Monolithic Kernel dan Microkernel',
        questionType: 'conceptual_application',
        prompt: 'Manakah karakteristik utama yang membedakan microkernel dari monolithic kernel?',
        options: [
          { key: 'A', text: 'Microkernel hanya menjalankan layanan esensial di ruang kernel terproteksi' },
          { key: 'B', text: 'Microkernel tidak memerlukan CPU' },
          { key: 'C', text: 'Monolithic kernel tidak mendukung device driver' },
          { key: 'D', text: 'Keduanya identik dalam alokasi memori' },
        ],
        correctOption: 'A',
        explanation: 'Berdasarkan BMP Halaman 4, microkernel memindahkan layanan non-esensial ke user space.',
        difficulty: 'medium',
        sourceRefs: ['Halaman 4'],
      },
    ],
  };

  const parsed = studyPackSynthesisSchema.parse(richV2Input);
  assert.equal(parsed.schemaVersion, 2);
  assert.equal(parsed.topics.length, 1);

  const t = parsed.topics[0];
  assert.equal(t.topicLabel, 'Arsitektur dan Struktur Kernel');
  assert.equal(t.coreConcepts.length, 3);
  assert.equal(t.comparisons.length, 1);
  assert.equal(t.comparisons[0].itemA, 'Monolithic Kernel');
  assert.equal(t.processesOrStages.length, 2);
  assert.equal(t.commonMisconceptions.length, 1);
  assert.ok(t.detailedExplanation.includes('ring 0'));

  // Test pedagogical alignment & validation guard
  const reviewedSources = [
    { id: 'src-1', pageOrder: 3, label: 'materi' },
    { id: 'src-2', pageOrder: 4, label: 'materi' },
  ];

  const validated = validateAndAlignStudyPack(parsed, reviewedSources);
  assert.ok(validated.topics[0].learningObjectives.includes('Membedakan Monolithic Kernel dan Microkernel'));
  assert.equal(validated.initialQuestions[0].sourceRefs.length, 1);
  assert.equal(validated.initialQuestions[0].sourceRefs[0], 'Halaman 4');
});

test('Comprehensive Study Pack: Pedagogical Alignment enriches topic when question tests new concept', () => {
  const inputWithUncoveredQuestion = {
    schemaVersion: 2,
    title: 'Modul Penjadwalan CPU',
    overview: 'Penjadwalan proses.',
    topics: [
      {
        topicLabel: 'Algoritma Round Robin',
        bmpSummary: 'Round Robin menggunakan time quantum.',
        detailedExplanation: 'Algoritma Round Robin membagi waktu CPU secara adil dengan giliran time quantum.',
        keyTakeaways: ['Adil untuk time sharing'],
        sourceRefs: ['Halaman 7'],
      },
    ],
    glossary: [],
    coverageNotes: [],
    initialQuestions: [
      {
        topicLabel: 'Algoritma Round Robin',
        learningObjective: 'Menganalisis dampak context switch yang terlalu sering',
        questionType: 'conceptual_application',
        prompt: 'Apa akibat jika time quantum pada algoritma Round Robin disetel terlalu kecil?',
        options: [
          { key: 'A', text: 'Overhead context switch meningkat drastis dan efisiensi CPU menurun' },
          { key: 'B', text: 'Proses akan langsung terhenti selamanya' },
        ],
        correctOption: 'A',
        explanation: 'Time quantum yang terlalu kecil menyebabkan CPU terlalu sering melakukan context switch.',
        difficulty: 'hard',
        sourceRefs: ['Halaman 7'],
      },
    ],
  };

  const parsed = studyPackSynthesisSchema.parse(inputWithUncoveredQuestion);
  const validated = validateAndAlignStudyPack(parsed, [{ pageOrder: 7 }]);

  // Question tested 'dampak context switch' which was not in original detailedExplanation:
  // validateAndAlignStudyPack automatically enriches the topic with the learning objective & explanation!
  assert.ok(
    validated.topics[0].learningObjectives.includes(
      'Menganalisis dampak context switch yang terlalu sering'
    )
  );
  assert.ok(validated.topics[0].detailedExplanation.includes('context switch'));
  assert.ok(validated.topics[0].bmpSummary.includes('context switch'));
});
