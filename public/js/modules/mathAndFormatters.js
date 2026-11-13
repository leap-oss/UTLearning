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

  renderInlineMathSegment(rawSegment) {
    if (rawSegment == null || rawSegment === '') return '';
    const raw = String(rawSegment);
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

  splitTableCells(rowText) {
    let trimmed = String(rowText || '').trim();
    if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
    if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);

    const cells = [];
    let current = '';
    let inMath = false;

    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (ch === '$' && trimmed[i - 1] !== '\\') {
        inMath = !inMath;
        current += ch;
      } else if (ch === '|' && !inMath) {
        cells.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    cells.push(current.trim());
    return cells;
  },

  isTableRowLine(line) {
    const t = String(line || '').trim();
    if (!t) return false;
    // Standard markdown table row: | col1 | col2 |
    if (t.startsWith('|') && t.endsWith('|') && t.length > 2) return true;
    // Numbered pipe row (e.g. "1. $(a, b)$ | $\{x \mid a < x < b\}$") with pipe outside $...$
    const cells = this.splitTableCells(t);
    return cells.length >= 2 && (/^\d+[.)]\s+/.test(t) || cells.length >= 3);
  },

  isTableDividerLine(line) {
    const cells = this.splitTableCells(line);
    return cells.length >= 2 && cells.every((c) => /^:?-{2,}:?$/.test(c));
  },

  buildHtmlTable(tableLines) {
    if (!tableLines || tableLines.length === 0) return '';
    const rows = [];
    let headerCells = null;

    if (tableLines.length >= 2 && this.isTableDividerLine(tableLines[1])) {
      headerCells = this.splitTableCells(tableLines[0]);
      for (let i = 2; i < tableLines.length; i++) {
        if (!this.isTableDividerLine(tableLines[i])) {
          rows.push(this.splitTableCells(tableLines[i]));
        }
      }
    } else {
      for (const line of tableLines) {
        if (!this.isTableDividerLine(line)) {
          rows.push(this.splitTableCells(line));
        }
      }
    }

    // If numbered pipe rows like "1. $(a, b)$ | $\{x \mid ...\}$" have no explicit header, split "1." into its own column
    if (
      !headerCells &&
      rows.length >= 2 &&
      rows.every((r) => r.length === 2 && /^\d+[.)]\s+/.test(r[0]))
    ) {
      headerCells = ['No.', 'Selang / Notasi', 'Himpunan / Keterangan'];
      for (let i = 0; i < rows.length; i++) {
        const m = rows[i][0].match(/^(\d+[.)])\s+([\s\S]+)$/);
        if (m) {
          rows[i] = [m[1], m[2], rows[i][1]];
        }
      }
    }

    const colCount = Math.max(
      headerCells ? headerCells.length : 0,
      ...rows.map((r) => r.length)
    );

    let html = '<div class="math-table-wrap"><table class="math-table">';
    if (headerCells) {
      html += '<thead><tr>';
      for (let c = 0; c < colCount; c++) {
        html += `<th scope="col">${this.renderInlineMathSegment(headerCells[c] || '')}</th>`;
      }
      html += '</tr></thead>';
    }
    html += '<tbody>';
    for (const r of rows) {
      html += '<tr>';
      for (let c = 0; c < colCount; c++) {
        html += `<td>${this.renderInlineMathSegment(r[c] || '')}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    return html;
  },

  normalizeCollapsedMathLayout(rawText) {
    let s = String(rawText || '');
    // Normalize inline numbered pipe lists (e.g. "... : 1. $(a,b)$ | $\{...\}$ 2. $(a,b]$ | $\{...\}$ ...") into separate lines
    if (/\d+\.\s*[^|\n]+\|\s*\$/.test(s)) {
      s = s.replace(/([^\n])\s+(\d+\.\s*(?:\(|\[|\$))/g, '$1\n$2');
    }
    // Put headings like "Rangkuman", "Himpunan Bilangan Kompleks", "Bentuk 1:", "Bentuk 2:", "Operasi Bilangan Kompleks" on new lines if collapsed
    s = s
      .replace(/([^\n])\s+((?:Bentuk\s+[12]|Operasi\s+Bilangan\s+Kompleks|Hierarki\s+Himpunan\s+Bilangan|Petunjuk\s+Jawaban\s+Latihan|Rangkuman|Tes\s+Formatif\s+\d+)\s*:?)/g, '$1\n\n$2')
      .replace(/([^\n])\s+(\([a-d]\)\s+\$)/g, '$1\n$2');
    // Put collapsed "Soal nomor X) s.d. nomor Y)" instructions on their own line
    s = s.replace(/([^\n])\s+(Soal\s+nomor\s+\d+\)?)/g, '$1\n\n$2');
    // Put collapsed numbered items "1) ...", "2) ...", ..., "20) ..." on their own line (avoiding "nomor 12)" or "dan 17)")
    s = s.replace(/(?<!nomor|dan)\s+(\d{1,2}\)\s+(?:[A-Z$(\\]|a\.|b\.|c\.))/g, '\n$1');
    return s;
  },

  renderMath(input) {
    if (input == null || input === '') return '';
    const normalized = this.normalizeCollapsedMathLayout(String(input));
    const lines = normalized.split('\n');

    const hasAnyTableLine = lines.some((l) => this.isTableRowLine(l));
    if (!hasAnyTableLine) {
      return this.renderInlineMathSegment(normalized);
    }

    const outputBlocks = [];
    let textBuffer = [];
    let tableBuffer = [];

    const flushText = () => {
      if (textBuffer.length > 0) {
        outputBlocks.push(this.renderInlineMathSegment(textBuffer.join('\n')));
        textBuffer = [];
      }
    };

    const flushTable = () => {
      if (tableBuffer.length >= 2) {
        outputBlocks.push(this.buildHtmlTable(tableBuffer));
      } else if (tableBuffer.length === 1) {
        outputBlocks.push(this.renderInlineMathSegment(tableBuffer[0]));
      }
      tableBuffer = [];
    };

    for (const line of lines) {
      if (this.isTableRowLine(line) || (tableBuffer.length > 0 && this.isTableDividerLine(line))) {
        flushText();
        tableBuffer.push(line);
      } else {
        flushTable();
        textBuffer.push(line);
      }
    }
    flushTable();
    flushText();

    return outputBlocks.join('\n');
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
