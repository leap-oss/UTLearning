window.AppModules = window.AppModules || {};

window.AppModules.mathAndFormatters = {
  isBoilerplateMasteryText(text) {
    const lower = String(text || '').toLowerCase();
    if (!lower.trim()) return true;
    return (
      lower.includes('tingkat penguasaan') ||
      lower.includes('jumlah jawaban yang benar') ||
      lower.includes('jumlah jawaban benar') ||
      (lower.includes('70%') && lower.includes('79%') && lower.includes('80%'))
    );
  },

  get isMathModule() {
    const courseCode = String(this.activeModule?.course?.code || this.activeCourse?.code || '');
    const courseName = String(this.activeModule?.course?.name || this.activeCourse?.name || '');
    const modTitle = String(this.activeModule?.title || '');
    const combinedMeta = `${courseCode} ${courseName} ${modTitle}`.toLowerCase();

    if (
      /^(?:mata|stat|sats)/i.test(courseCode.trim()) ||
      /\b(?:matematika|kalkulus|aljabar|statistika|geometri|trigonometri|himpunan|logika|bilangan|kombinatorika|peluang|diskrit|matriks|persamaan|fungsi|limit|turunan|integral)\b/i.test(
        combinedMeta
      )
    ) {
      return true;
    }

    const latexPattern = /\$(?!\$)[^$]+\$|\\(?:frac|sqrt|lim|sum|int|cup|cap|subset|subseteq|in|notin|neg|land|lor|Rightarrow|Leftrightarrow|forall|exists|mathbb)/;
    const sources = this.activeModule?.sources || [];
    if (
      sources.some((s) =>
        latexPattern.test(String(s.extractedContentJson?.extractedText || ''))
      )
    ) {
      return true;
    }

    return false;
  },

  get visibleFormulasOrProcedures() {
    if (!this.isMathModule) return [];
    const rawList = this.activeStudyPack?.summaryJson?.formulasOrProcedures || [];
    return rawList
      .map((fp) => ({
        title: fp.title || fp.name || 'Rumus / Teorema',
        content: fp.content || fp.formulaOrSteps || '',
        whenToUse: fp.whenToUse || '',
        sourceRefs: fp.sourceRefs || [],
      }))
      .filter(
        (fp) =>
          fp.content &&
          !this.isBoilerplateMasteryText(`${fp.title} ${fp.content}`)
      );
  },

  visibleSourceFormulas(src) {
    if (!this.isMathModule || !src?.extractedContentJson?.formulasOrTables) return [];
    return src.extractedContentJson.formulasOrTables.filter(
      (fmt) => fmt && !this.isBoilerplateMasteryText(fmt)
    );
  },

  difficultyLabel(diff) {
    const map = {
      easy: 'Mudah',
      medium: 'Menengah',
      hard: 'Analitis',
      mixed: 'Campuran seimbang',
    };
    return map[diff] || diff || 'Campuran seimbang';
  },

  setTypeLabel(setType) {
    const map = {
      initial: 'Kuis Awal Study Pack',
      practice: 'Latihan Tambahan',
      remedial: 'Remedial Terfokus',
      exam_simulation: 'Simulasi UAS Komprehensif',
    };
    return map[setType] || setType;
  },

  formatDateTime(iso) {
    if (!iso) return '-';
    try {
      return new Date(iso).toLocaleString('id-ID', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  },

  formatSemester(val) {
    if (!val) return '';
    const trimmed = String(val).trim();
    if (!trimmed) return '';
    if (/^semester\s+/i.test(trimmed)) {
      return trimmed;
    }
    if (/^\d+$/.test(trimmed)) {
      return `Semester ${trimmed}`;
    }
    return trimmed;
  },

  formatBytes(bytes) {
    if (typeof bytes !== 'number' || Number.isNaN(bytes)) return '-';
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
  },

  escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  renderMath(input) {
    if (input == null || input === '') return '';
    const raw = String(input);
    const tokenRegex = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\$(?!\$)(?:\\.|[^$\\\n])+\$|\\\([\s\S]+?\\\))/g;
    let result = '';
    let lastIndex = 0;
    let match;

    while ((match = tokenRegex.exec(raw)) !== null) {
      if (match.index > lastIndex) {
        result += this.escapeHtml(raw.slice(lastIndex, match.index));
      }
      const token = match[0];
      let displayMode = false;
      let expr = token;
      if (token.startsWith('$$') && token.endsWith('$$')) {
        displayMode = true;
        expr = token.slice(2, -2).trim();
      } else if (token.startsWith('\\[') && token.endsWith('\\]')) {
        displayMode = true;
        expr = token.slice(2, -2).trim();
      } else if (token.startsWith('\\(') && token.endsWith('\\)')) {
        expr = token.slice(2, -2).trim();
      } else if (token.startsWith('$') && token.endsWith('$')) {
        expr = token.slice(1, -1).trim();
      }

      if (typeof window !== 'undefined' && window.katex && typeof window.katex.renderToString === 'function') {
        try {
          result += window.katex.renderToString(expr, {
            displayMode,
            throwOnError: false,
            strict: false,
            trust: false,
          });
        } catch {
          result += `<code>${this.escapeHtml(token)}</code>`;
        }
      } else {
        result += `<code>${this.escapeHtml(token)}</code>`;
      }

      lastIndex = tokenRegex.lastIndex;
    }

    if (lastIndex < raw.length) {
      result += this.escapeHtml(raw.slice(lastIndex));
    }

    return result;
  },

  renderFormula(input) {
    if (input == null || input === '') return '';
    const raw = String(input).trim();
    if (!raw) return '';
    if (raw.includes('$') || raw.includes('\\(') || raw.includes('\\[')) {
      return this.renderMath(raw);
    }
    if (/\\(?:frac|sqrt|lim|sum|int|prod|binom|cup|cap|subset|subseteq|in|notin|neg|land|lor|rightarrow|leftrightarrow|Rightarrow|Leftrightarrow|equiv|forall|exists|mathbb|begin|le|ge|neq|pm|approx|times|cdot)/.test(raw)) {
      return this.renderMath(`$${raw}$`);
    }
    return this.renderMath(raw);
  },

  get mathToolbarGroups() {
    return [
      {
        label: 'Struktur Equation',
        items: [
          { title: 'Pecahan (a/b)', label: 'a/b', snippet: '$\\frac{a}{b}$' },
          { title: 'Pangkat (x^n)', label: 'xⁿ', snippet: '$x^{2}$' },
          { title: 'Indeks Bawah (x_i)', label: 'xᵢ', snippet: '$x_{1}$' },
          { title: 'Akar Kuadrat', label: '√x', snippet: '$\\sqrt{x}$' },
          { title: 'Akar Pangkat n', label: 'ⁿ√x', snippet: '$\\sqrt[n]{x}$' },
          { title: 'Nilai Mutlak', label: '|x|', snippet: '$|x|$' },
          { title: 'Sistem Persamaan', label: '{ Sistem', snippet: '$$\\begin{cases} x + y = 1 \\\\ x - y = 0 \\end{cases}$$' },
          { title: 'Matriks 2x2', label: '[Matriks]', snippet: '$$\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$$' },
        ],
      },
      {
        label: 'Logika Matematika',
        items: [
          { title: 'Negasi (Ingkaran)', label: '¬', snippet: '$\\neg p$' },
          { title: 'Konjungsi (DAN)', label: '∧', snippet: '$p \\land q$' },
          { title: 'Disjungsi (ATAU)', label: '∨', snippet: '$p \\lor q$' },
          { title: 'Implikasi (Jika... maka...)', label: '⇒', snippet: '$p \\Rightarrow q$' },
          { title: 'Biimplikasi (...jika dan hanya jika...)', label: '⇔', snippet: '$p \\Leftrightarrow q$' },
          { title: 'Ekuivalen Logis', label: '≡', snippet: '$\\equiv$' },
          { title: 'Kuantor Universal (Untuk semua)', label: '∀', snippet: '$\\forall x$' },
          { title: 'Kuantor Eksistensial (Ada)', label: '∃', snippet: '$\\exists x$' },
        ],
      },
      {
        label: 'Himpunan & Bilangan',
        items: [
          { title: 'Anggota Himpunan', label: '∈', snippet: '$x \\in A$' },
          { title: 'Bukan Anggota', label: '∉', snippet: '$x \\notin A$' },
          { title: 'Himpunan Bagian (Subset)', label: '⊆', snippet: '$A \\subseteq B$' },
          { title: 'Subset Sejati', label: '⊂', snippet: '$A \\subset B$' },
          { title: 'Gabungan (Union)', label: '∪', snippet: '$A \\cup B$' },
          { title: 'Irisan (Intersection)', label: '∩', snippet: '$A \\cap B$' },
          { title: 'Komplemen Himpunan', label: 'Aᶜ', snippet: '$A^{c}$' },
          { title: 'Himpunan Kosong', label: '∅', snippet: '$\\emptyset$' },
          { title: 'Notasi Pembentuk Himpunan', label: '{x | P(x)}', snippet: '$\\{x \\in \\mathbb{R} \\mid x > 0\\}$' },
          { title: 'Bilangan Real', label: 'ℝ', snippet: '$\\mathbb{R}$' },
          { title: 'Bilangan Bulat', label: 'ℤ', snippet: '$\\mathbb{Z}$' },
          { title: 'Bilangan Asli', label: 'ℕ', snippet: '$\\mathbb{N}$' },
        ],
      },
      {
        label: 'Fungsi & Kalkulus',
        items: [
          { title: 'Fungsi Komposisi', label: 'f ∘ g', snippet: '$(f \\circ g)(x)$' },
          { title: 'Fungsi Invers', label: 'f⁻¹(x)', snippet: '$f^{-1}(x)$' },
          { title: 'Limit', label: 'lim', snippet: '$\\lim_{x \\to a} f(x)$' },
          { title: 'Tak Hingga', label: '∞', snippet: '$\\infty$' },
          { title: 'Turunan (dy/dx)', label: 'dy/dx', snippet: '$\\frac{dy}{dx}$' },
          { title: 'Sigma (Penjumlahan)', label: '∑', snippet: '$\\sum_{i=1}^{n} x_i$' },
          { title: 'Integral', label: '∫', snippet: '$\\int_{a}^{b} f(x)\\,dx$' },
          { title: 'Kombinasi nCr', label: 'C(n,r)', snippet: '$\\binom{n}{r}$' },
          { title: 'Kurang dari / sama dengan', label: '≤', snippet: '$\\le$' },
          { title: 'Lebih dari / sama dengan', label: '≥', snippet: '$\\ge$' },
          { title: 'Tidak sama dengan', label: '≠', snippet: '$\\neq$' },
          { title: 'Plus-Minus', label: '±', snippet: '$\\pm$' },
        ],
      },
    ];
  },

  insertMathSnippet(textareaId, snippet, fieldName = 'extractedText') {
    const el = document.getElementById(textareaId);
    const currentVal = String(this.sourceEditForm[fieldName] || '');
    if (!el) {
      this.sourceEditForm[fieldName] = currentVal ? `${currentVal} ${snippet}` : snippet;
      return;
    }
    const start = el.selectionStart ?? currentVal.length;
    const end = el.selectionEnd ?? currentVal.length;
    const before = currentVal.slice(0, start);
    const after = currentVal.slice(end);
    this.sourceEditForm[fieldName] = `${before}${snippet}${after}`;
    this.$nextTick(() => {
      el.focus();
      const cursorPos = start + snippet.length;
      el.setSelectionRange(cursorPos, cursorPos);
    });
  },
};
