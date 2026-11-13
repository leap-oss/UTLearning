function extractExplicitKbNumbers(text = '') {
  const nums = new Set();
  const re = /\b(?:kegiatan\s*belajar|kb|tes\s*formatif|formatif)\s*([1-9]\d?)\b/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    const n = Number.parseInt(match[1], 10);
    if (n >= 1 && n <= 9) {
      nums.add(n);
    }
  }
  return Array.from(nums).sort((a, b) => a - b);
}

export function countDistinctKbsInTopics(topics = []) {
  if (!Array.isArray(topics) || topics.length === 0) return 0;
  const kbNums = new Set();
  for (const t of topics) {
    const label = `${t?.topicLabel || ''} ${t?.title || ''}`;
    for (const n of extractExplicitKbNumbers(label)) {
      kbNums.add(n);
    }
  }
  if (kbNums.size >= 1) {
    return kbNums.size;
  }
  return Math.min(3, topics.length);
}

export function detectModuleKbStructure(reviewedSources = []) {
  if (!Array.isArray(reviewedSources) || reviewedSources.length === 0) {
    return [];
  }

  const sorted = [...reviewedSources].sort((a, b) => (a.pageOrder || 0) - (b.pageOrder || 0));

  const classifiedPages = sorted.map((s, idx) => {
    const text = (
      (s.extractedContentJson?.extractedText || '') +
      ' ' +
      (s.extractedContentJson?.pageTitle || '')
    ).toLowerCase();
    const tfMatches = [];
    const tfRe = /\b(?:tes\s*formatif|formatif)\s*([1-9])\b/gi;
    let m;
    while ((m = tfRe.exec(text)) !== null) {
      tfMatches.push(Number.parseInt(m[1], 10));
    }
    const kbMatches = [];
    const kbRe = /\b(?:kegiatan\s*belajar|kb)\s*([1-9])\b/gi;
    while ((m = kbRe.exec(text)) !== null) {
      kbMatches.push(Number.parseInt(m[1], 10));
    }
    const tfNum = tfMatches.length > 0 ? tfMatches[0] : null;
    const kbNum = kbMatches.length > 0 ? kbMatches[0] : null;
    const isSummary = s.label === 'rangkuman' || /rangkuman/i.test(text);
    const isFormatif = s.label === 'tes_formatif' || /tes\s*formatif/i.test(text);

    return {
      index: idx,
      source: s,
      pageOrder: s.pageOrder,
      label: s.label,
      tfNum,
      kbNum,
      allKbNums: Array.from(new Set([...kbMatches, ...tfMatches])),
      isSummary,
      isFormatif,
      textLength: (s.extractedContentJson?.extractedText || '').length,
    };
  });

  const detectedKbNums = new Set();
  classifiedPages.forEach((p) => {
    p.allKbNums.forEach((n) => detectedKbNums.add(n));
  });

  if (detectedKbNums.size <= 1) {
    const totalChars = classifiedPages.reduce((sum, p) => sum + p.textLength, 0);
    return [
      {
        kbNumber: 1,
        title: 'Kegiatan Belajar 1',
        sources: sorted,
        pageRange: {
          start: sorted[0]?.pageOrder || 1,
          end: sorted[sorted.length - 1]?.pageOrder || 1,
        },
        hasSummary: classifiedPages.some((p) => p.isSummary),
        hasFormatif: classifiedPages.some((p) => p.isFormatif),
        totalChars,
      },
    ];
  }

  const maxDetectedKb = Math.max(...Array.from(detectedKbNums));
  let currentKb = 1;
  const pageToKb = new Array(classifiedPages.length);

  for (let i = 0; i < classifiedPages.length; i++) {
    const p = classifiedPages[i];
    if (p.kbNum && p.kbNum >= currentKb && p.kbNum <= maxDetectedKb) {
      currentKb = p.kbNum;
    } else if (i > 0) {
      const prev = classifiedPages[i - 1];
      const prevWasFormatif = prev.isFormatif || prev.tfNum !== null;
      // Hanya naikkan nomor KB setelah halaman Tes Formatif jika ini halaman Rangkuman baru (bukan sekadar halaman 'materi' tambahan)
      if (
        prevWasFormatif &&
        (p.isSummary || p.label === 'rangkuman') &&
        currentKb < maxDetectedKb
      ) {
        currentKb += 1;
      }
    }
    if (p.tfNum && p.tfNum >= currentKb && p.tfNum <= maxDetectedKb) {
      currentKb = p.tfNum;
    }
    pageToKb[i] = currentKb;
  }

  const groupMap = new Map();
  classifiedPages.forEach((p, idx) => {
    const kb = pageToKb[idx];
    if (!groupMap.has(kb)) {
      groupMap.set(kb, []);
    }
    groupMap.get(kb).push(p.source);
  });

  const sortedKbs = Array.from(groupMap.keys()).sort((a, b) => a - b);
  return sortedKbs.map((kbNum) => {
    const kbSources = groupMap.get(kbNum);
    const totalChars = kbSources.reduce(
      (sum, s) => sum + (s.extractedContentJson?.extractedText?.length || 0),
      0
    );
    const hasSummary = kbSources.some(
      (s) => s.label === 'rangkuman' || /rangkuman/i.test(s.extractedContentJson?.extractedText || '')
    );
    const hasFormatif = kbSources.some(
      (s) =>
        s.label === 'tes_formatif' ||
        /tes\s*formatif/i.test(s.extractedContentJson?.extractedText || '')
    );
    return {
      kbNumber: kbNum,
      title: `Kegiatan Belajar ${kbNum}`,
      sources: kbSources,
      pageRange: {
        start: kbSources[0]?.pageOrder || 1,
        end: kbSources[kbSources.length - 1]?.pageOrder || 1,
      },
      hasSummary,
      hasFormatif,
      totalChars,
    };
  });
}

export function resolveFixedQuestionCountByKb(kbCount = 1) {
  const count = Number(kbCount) || 1;
  if (count >= 3) return 25;
  if (count === 2) return 20;
  return 10;
}

export function planKbBatches(kbStructure = [], options = {}) {
  const maxSafeCharsPerBatch = options.maxSafeCharsPerBatch || 35000;
  if (!Array.isArray(kbStructure) || kbStructure.length === 0) {
    return [];
  }

  const count = kbStructure.length;

  if (count === 1) {
    return [
      {
        batchIndex: 1,
        totalBatches: 1,
        kbs: kbStructure,
        isFinalBatch: true,
        splitReason: null,
      },
    ];
  }

  if (count === 2) {
    const totalChars = (kbStructure[0]?.totalChars || 0) + (kbStructure[1]?.totalChars || 0);
    if (totalChars > maxSafeCharsPerBatch) {
      return [
        {
          batchIndex: 1,
          totalBatches: 2,
          kbs: [kbStructure[0]],
          isFinalBatch: false,
          splitReason: `Kerapatan materi KB 1 & 2 (${totalChars} karakter) melampaui batas aman (${maxSafeCharsPerBatch}); dipisah agar materi tidak terkompresi.`,
        },
        {
          batchIndex: 2,
          totalBatches: 2,
          kbs: [kbStructure[1]],
          isFinalBatch: true,
          splitReason: null,
        },
      ];
    }
    return [
      {
        batchIndex: 1,
        totalBatches: 1,
        kbs: kbStructure,
        isFinalBatch: true,
        splitReason: null,
      },
    ];
  }

  if (count === 3) {
    const batch1Chars = (kbStructure[0]?.totalChars || 0) + (kbStructure[1]?.totalChars || 0);
    if (batch1Chars <= maxSafeCharsPerBatch) {
      return [
        {
          batchIndex: 1,
          totalBatches: 2,
          kbs: [kbStructure[0], kbStructure[1]],
          isFinalBatch: false,
          splitReason: null,
        },
        {
          batchIndex: 2,
          totalBatches: 2,
          kbs: [kbStructure[2]],
          isFinalBatch: true,
          splitReason: null,
        },
      ];
    }
    return [
      {
        batchIndex: 1,
        totalBatches: 3,
        kbs: [kbStructure[0]],
        isFinalBatch: false,
        splitReason: `Ukuran KB 1 & 2 (${batch1Chars} karakter) melebihi batas aman; dipartisi terarah.`,
      },
      {
        batchIndex: 2,
        totalBatches: 3,
        kbs: [kbStructure[1]],
        isFinalBatch: false,
        splitReason: null,
      },
      {
        batchIndex: 3,
        totalBatches: 3,
        kbs: [kbStructure[2]],
        isFinalBatch: true,
        splitReason: null,
      },
    ];
  }

  const mid = Math.ceil(count / 2);
  const part1 = kbStructure.slice(0, mid);
  const part2 = kbStructure.slice(mid);
  const part1Chars = part1.reduce((sum, kb) => sum + (kb.totalChars || 0), 0);
  const part2Chars = part2.reduce((sum, kb) => sum + (kb.totalChars || 0), 0);

  if (part1Chars <= maxSafeCharsPerBatch && part2Chars <= maxSafeCharsPerBatch) {
    return [
      {
        batchIndex: 1,
        totalBatches: 2,
        kbs: part1,
        isFinalBatch: false,
        splitReason: null,
      },
      {
        batchIndex: 2,
        totalBatches: 2,
        kbs: part2,
        isFinalBatch: true,
        splitReason: null,
      },
    ];
  }

  return kbStructure.map((kb, idx) => ({
    batchIndex: idx + 1,
    totalBatches: kbStructure.length,
    kbs: [kb],
    isFinalBatch: idx === kbStructure.length - 1,
    splitReason: `Kerapatan modul (${part1Chars + part2Chars} karakter) melampaui batas aman; dibagi per KB secara independen demi kualitas.`,
  }));
}

export function validateStudyPackCoverage(studyPack, reviewedSources = [], kbStructure = []) {
  const issues = [];
  const coveredKbs = new Set();
  const allTopics = studyPack?.topics || [];

  for (const kb of kbStructure) {
    const kbLabel = `kegiatan belajar ${kb.kbNumber}`;
    const matched = allTopics.some(
      (t) =>
        (t.topicLabel && t.topicLabel.toLowerCase().includes(kbLabel)) ||
        (t.title && t.title.toLowerCase().includes(kbLabel)) ||
        (kbStructure.length === 1 && allTopics.length >= 1)
    );
    if (matched) {
      coveredKbs.add(kb.kbNumber);
    } else {
      issues.push(`KB ${kb.kbNumber} belum memiliki topik yang sesuai di Study Pack.`);
    }
  }

  const referencedPages = new Set();
  const checkSourceRefs = (refs) => {
    if (Array.isArray(refs)) {
      refs.forEach((r) => {
        const m = String(r).match(/halaman\s*([0-9]+)/i);
        if (m) referencedPages.add(Number.parseInt(m[1], 10));
      });
    }
  };

  allTopics.forEach((t) => {
    checkSourceRefs(t.sourceRefs);
    (t.learningObjectives || []).forEach(checkSourceRefs);
  });
  (studyPack?.glossary || []).forEach((g) => checkSourceRefs(g.sourceRefs));
  (studyPack?.initialQuestions || []).forEach((q) => checkSourceRefs(q.sourceRefs));

  const totalSourcePages = reviewedSources.map((s) => s.pageOrder);
  const unmappedPages = totalSourcePages.filter((p) => !referencedPages.has(p));
  if (unmappedPages.length > 0) {
    issues.push(`Halaman sumber berikut belum dirujuk: ${unmappedPages.join(', ')}`);
  }

  let totalFormatifQuestions = 0;
  let coveredFormatifQuestions = 0;
  const missingQuestionPrompts = [];

  const fullTopicText = [
    ...allTopics.map(
      (t) =>
        `${t.topicLabel || ''} ${t.detailedExplanation || ''} ${t.bmpSummary || ''} ${(t.coreConcepts || []).join(' ')} ${(t.examples || []).map((e) => `${e.context || ''} ${e.illustration || ''}`).join(' ')}`
    ),
    ...(studyPack?.formulasOrProcedures || []).map(
      (f) => `${f.name || ''} ${f.formulaOrSteps || ''} ${f.whenToUse || ''}`
    ),
  ]
    .join(' ')
    .toLowerCase();

  for (const s of reviewedSources) {
    const tqs = s.extractedContentJson?.transcribedQuestions || [];
    for (const tq of tqs) {
      totalFormatifQuestions++;
      const rawPrompt = (tq.prompt || '').toLowerCase();
      const words = rawPrompt
        .replace(/\\[a-z]+/g, ' ')
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 3);

      const mathTokens = Array.from(
        new Set(
          rawPrompt.match(
            /\\(?:frac|sqrt|lim|sum|int|cup|cap|subset|subseteq|in|notin|neg|land|lor|rightarrow|leftrightarrow|forall|exists)|[a-z]\([a-z]\)/g
          ) || []
        )
      );

      const matchedWords = words.filter((w) => fullTopicText.includes(w));
      const matchedMath = mathTokens.filter((mt) => fullTopicText.includes(mt));
      const isRepresented =
        (words.length === 0 && mathTokens.length === 0) ||
        (words.length > 0 && matchedWords.length / words.length >= 0.3) ||
        (mathTokens.length > 0 && matchedMath.length / mathTokens.length >= 0.5);

      if (isRepresented) {
        coveredFormatifQuestions++;
      } else {
        missingQuestionPrompts.push(tq.prompt.slice(0, 60));
      }
    }
  }

  const kbCoverageScore = kbStructure.length > 0 ? (coveredKbs.size / kbStructure.length) * 40 : 40;
  const pageCoverageScore =
    totalSourcePages.length > 0
      ? ((totalSourcePages.length - unmappedPages.length) / totalSourcePages.length) * 30
      : 30;
  const questionCoverageScore =
    totalFormatifQuestions > 0
      ? (coveredFormatifQuestions / totalFormatifQuestions) * 30
      : 30;

  const coverageScore = Math.round(kbCoverageScore + pageCoverageScore + questionCoverageScore);

  return {
    coverageScore,
    totalKbsDetected: kbStructure.length,
    kbsCovered: coveredKbs.size,
    totalPages: totalSourcePages.length,
    pagesMapped: totalSourcePages.length - unmappedPages.length,
    unmappedPages,
    totalFormatifQuestions,
    coveredFormatifQuestions,
    missingItems: issues,
    validationPassed:
      coverageScore >= 80 && (kbStructure.length === 0 || coveredKbs.size === kbStructure.length),
  };
}

export function formatSourceBlocks(sources = []) {
  return sources
    .map((s) => {
      const ext = s.extractedContentJson || {};
      const sectionsText = (ext.sections || [])
        .map((sec) => `[${sec.heading}]: ${sec.content}`)
        .join('\n');
      const questionsText = (ext.transcribedQuestions || [])
        .map((tq, idx) => {
          const opts = (tq.options || []).map((o) => `${o.key}. ${o.text}`).join(' | ');
          return `Soal ${idx + 1}: ${tq.prompt}${opts ? `\n   Opsi: ${opts}` : ''}${tq.answerHint ? `\n   Petunjuk: ${tq.answerHint}` : ''}`;
        })
        .join('\n');
      return `--- SUMBER [sourceId=${s.id} | Halaman=${s.pageOrder} | Label=${s.label} | File=${s.fileName}] ---
Judul Halaman: ${ext.pageTitle || '-'}
Teks Utama:
${ext.extractedText || ''}
${sectionsText ? `Bagian Teks:\n${sectionsText}\n` : ''}${questionsText ? `Butir Soal Tes Formatif Terdeteksi:\n${questionsText}\n` : ''}Istilah Kunci: ${(ext.keyTerms || []).join(', ') || '-'}
Rumus/Tabel: ${(ext.formulasOrTables || []).join('; ') || '-'}`;
    })
    .join('\n\n');
}

export function buildSystemInstruction({ isFinalBatch, totalQuestionCount, kbTitles }) {
  const qDirective = isFinalBatch
    ? `5. KESELARASAN PEDAGOGIS DENGAN SOAL (PEDAGOGICAL ALIGNMENT):
   - Rancang ${totalQuestionCount} butir soal latihan awal ("initialQuestions") yang representatif dan proporsional mencakup seluruh Kegiatan Belajar modul: ${kbTitles}.
   - Seluruh soal WAJIB bersumber dan DAPAT DIJAWAB dari penjelasan yang telah ditulis di "detailedExplanation", "coreConcepts", "formulasOrProcedures", atau "glossary".
   - Setiap butir soal harus memiliki "topicLabel", "learningObjective", "questionType" ('single_choice', 'conceptual_application', 'scenario_based'), "difficulty", "sourceRefs", dan "explanation".
   - Untuk soal matematika/hitungan/logika simbolik, tuliskan seluruh rumus di "prompt", "options", dan "explanation" dalam LaTeX ($...$ atau $$...$$) serta uraikan langkah penurunan/penyelesaian secara bertahap (step-by-step) di "explanation".
   - Distribusikan butir soal secara seimbang menguji penerapan konseptual, perhitungan/pembuktian, dan pemahaman mendalam.`
    : `5. FOKUS KELENGKAPAN MATERI & RUMUS: Hasilkan seluruh topik, rumus/prosedur ("formulasOrProcedures"), dan glosarium secara mendalam tanpa melewatkan konsep atau rumus apapun.`;

  return `Anda adalah kurator dan arsitek penyusun bahan belajar komprehensif Universitas Terbuka (BMP) yang berfokus pada ketuntasan pemahaman mandiri mahasiswa, termasuk untuk mata kuliah eksakta/matematika.

PRINSIP WAJIB:
1. JANGAN MERINGKAS TERLALU PENDEK: Mahasiswa belajar mandiri menggunakan bahan ini. Setiap topik WAJIB diuraikan secara mendalam dan jelas (minimal 4-5 paragraf naratif yang komprehensif per topik di "detailedExplanation"), bukan sekadar ringkasan permukaan.
2. BEDAH TUNTAS & REVERSE-ENGINEERING SELURUH SOAL TES FORMATIF (100% CAKUPAN WAJIB):
   - Mahasiswa sering kali HANYA mengunggah halaman "Rangkuman" dan "Tes Formatif" (tanpa mengunggah puluhan halaman isi bab).
   - Oleh karena itu, banyak konsep, sifat teorema, atau langkah penyelesaian spesifik yang diujikan di soal "Tes Formatif" TIDAK tertulis di halaman "Rangkuman" singkat.
   - Anda WAJIB membedah SETIAP butir soal yang ada di seluruh halaman Tes Formatif pada KB ini dan mengubahnya menjadi materi pembelajaran utuh di dalam "detailedExplanation", "coreConcepts", "formulasOrProcedures", "comparisons", "examples", "commonMisconceptions", dan "glossary"!
   - DILARANG MELEWATKAN SATU PUN konsep atau rumus dari nomor soal Tes Formatif yang diunggah.
   - Untuk soal berbentuk pengecualian ("...kecuali..."), uraikan secara eksplisit seluruh sifat/unsur yang benar DAN jelaskan mengapa opsi pengecoh tersebut dikecualikan (masukkan ke "detailedExplanation" dan "commonMisconceptions").
   - Untuk soal yang memiliki opsi istilah/rumus berbeda pada pilihan A/B/C/D, jelaskan definisi dan pembeda masing-masing istilah/rumus tersebut di "detailedExplanation", "comparisons", atau "glossary".
3. STANDAR NOTASI MATEMATIKA, PERSAMAAN & LOGIKA SIMBOLIK (LaTeX):
   - Seluruh persamaan matematika, pecahan ($\frac{a}{b}$), akar ($\sqrt{x}$), pangkat ($x^n$), indeks ($x_i$), limit ($\lim_{x \to a}$), integral, matriks, notasi himpunan ($\in, \subset, \subseteq, \cup, \cap, \emptyset, A^c, \mathbb{R}$), dan logika matematika ($\neg, \land, \lor, \Rightarrow, \Leftrightarrow, \equiv, \forall, \exists$) di SELURUH field teks WAJIB ditulis dengan format LaTeX: gunakan $...$ untuk inline math dan $$...$$ untuk rumus blok.
   - Array "formulasOrProcedures" KHUSUS diisi apabila modul ini merupakan materi Matematika / Eksakta / Hitungan yang memuat rumus, teorema, hukum aljabar/logika/himpunan, atau identitas matematika (berisi "title", "content" dalam LaTeX, dan "sourceRefs").
   - DILARANG mengisi "formulasOrProcedures" dengan rumus generik penilaian mandiri UT ("Tingkat Penguasaan = Jumlah Jawaban Benar / Jumlah Soal x 100%") atau tahapan manajemen/narasi teori non-matematika (tahapan teori/manajemen cukup ditaruh di "processesOrStages" pada topik terkait). Untuk modul teori non-matematika, kosongkan "formulasOrProcedures": [].
   - Pada materi matematika/eksakta, bagian "examples" dan "processesOrStages" WAJIB menyertakan contoh soal beserta langkah penyelesaian bertahap (Diketahui -> Rumus/Teorema -> Substitusi/Penurunan -> Hasil Akhir).
4. PEMISAHAN KONTEN OTENTIK BMP VS BANTUAN AI:
   - "bmpSummary", "detailedExplanation", "coreConcepts", "comparisons", "processesOrStages", "formulasOrProcedures": Berisi sintesis lengkap dari halaman Rangkuman DAN hasil bedah konsep seluruh butir soal Tes Formatif BMP. Pertahankan istilah dan notasi asli BMP.
   - "aiExplanation", "simpleAnalogy", "examples" (dengan isAiGenerated=true): Berisi analogi bahasa manusiawi, intuisi visual/logika, dan contoh penyelesaian tambahan untuk mempermudah pemahaman mahasiswa.
5. STRUKTUR MATERI PER TOPIK (SATU OBJEK TOPIK PER KEGIATAN BELAJAR):
   - WAJIB menggabungkan seluruh halaman Rangkuman, Tes Formatif, dan halaman Materi Tambahan yang berada pada Kegiatan Belajar yang sama ke dalam SATU objek topik utuh untuk Kegiatan Belajar tersebut (misal jika batch ini berisi KB 1 & KB 2, hasilkan tepat 2 objek di "topics": satu untuk KB 1 dan satu untuk KB 2). JANGAN memecah halaman materi tambahan menjadi objek topik baru di luar jumlah KB!
   - "topicLabel": Judul Kegiatan Belajar yang jelas dan diawali nomor KB (misal: "Kegiatan Belajar 1: ...").
   - "learningObjectives": 3-5 sasaran pembelajaran spesifik yang merangkum Rangkuman, Materi, & Tes Formatif KB tersebut.
   - "coreConcepts": Seluruh konsep/definisi/sifat kunci dari Rangkuman, Materi, & seluruh nomor Tes Formatif.
   - "detailedExplanation": Uraian penjelasan mendalam (4-6 paragraf terstruktur yang mencakup semua konsep & rumus di Rangkuman/Materi + semua materi yang ditanyakan pada setiap nomor soal Tes Formatif).
   - "conceptRelationships": Keterhubungan atau ketergantungan antar konsep/teorema.
   - "comparisons": Perbandingan terstruktur (itemA, itemB, distinction) untuk istilah/notasi/rumus yang berpotensi tertukar.
   - "processesOrStages": Alur langkah penyelesaian soal, pembuktian, atau tahapan prosedural.
   - "commonMisconceptions": Miskonsepsi umum, kesalahan tanda/rumus/aljabar, dan jebakan pengecualian ("kecuali") dari soal Tes Formatif beserta klarifikasi benarnya menurut BMP.
   - "keyTakeaways": Poin-poin kesimpulan dan rumus kunci esensial yang lengkap.
${qDirective}
6. REFERENSI SUMBER ("sourceRefs"):
   - Cantumkan referensi halaman BMP yang relevan (contoh: ["Halaman 1", "Halaman 3"]) pada setiap topik, rumus, istilah glosarium, dan butir soal.`;
}
