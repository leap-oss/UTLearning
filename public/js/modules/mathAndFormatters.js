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
    const courseCode = String(this.activeModule?.course?.code || this.activeCourse?.code || '').trim();
    const courseName = String(this.activeModule?.course?.name || this.activeCourse?.name || '').toLowerCase();

    return (
      /^(?:mata|stat|sats)/i.test(courseCode) ||
      /\b(?:matematika|kalkulus|aljabar|statistika|geometri|trigonometri|probabilitas|ekonometrika)\b/i.test(
        courseName
      )
    );
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

  formatPlainTextSegment(str) {
    let escaped = this.escapeHtml(str);
    // Strip markdown heading hashes (#, ##, ###) and render heading text bold
    escaped = escaped.replace(/^[ \t]*#{1,6}[ \t]+(.+)$/gm, '<strong>$1</strong>');
    // Inline code `...`
    escaped = escaped.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
    // Bold **...**
    escaped = escaped.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    // Italic *word* (avoiding multiplication like a * b or (*))
    escaped = escaped.replace(/(?<![*\w])\*([A-Za-z0-9_][^*\n]*?[A-Za-z0-9_])\*(?![*\w])/g, '<em>$1</em>');
    return escaped;
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
        result += this.formatPlainTextSegment(raw.slice(lastIndex, match.index));
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
      result += this.formatPlainTextSegment(raw.slice(lastIndex));
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
    let s = String(rawText || '')
      // Repair corrupted LaTeX escapes where \n, \f, \b, \t inside JSON became control characters
      .replace(/\r?\n(eg|eq|otin|abla)(?=$|[^a-zA-Z])/g, '\\n$1')
      .replace(/\x0c(rac|orall)(?=$|[^a-zA-Z])/g, '\\f$1')
      .replace(/\x08(inom|egin|eta|ar|igcup|igcap)(?=$|[^a-zA-Z])/g, '\\b$1')
      .replace(/\t(imes|heta|au|ext|frac|o)(?=$|[^a-zA-Z])/g, '\\t$1');
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

  parseFlowchartNodeToken(rawToken, nodeMap) {
    const token = String(rawToken || '').trim();
    if (!token) return null;

    let id = '';
    let shape = 'rect';
    let label = token;
    let explicitShape = false;

    let m;
    if ((m = token.match(/^([A-Za-z0-9_]*)\(\[([\s\S]*?)\]\)$/))) {
      id = m[1]; shape = 'terminator'; label = m[2].trim(); explicitShape = true;
    } else if ((m = token.match(/^([A-Za-z0-9_]*)\(\(([\s\S]*?)\)\)$/))) {
      id = m[1]; shape = 'terminator'; label = m[2].trim(); explicitShape = true;
    } else if ((m = token.match(/^([A-Za-z0-9_]*)\(\s*([\s\S]*?)\s*\)$/))) {
      id = m[1]; shape = 'terminator'; label = m[2].trim(); explicitShape = true;
    } else if ((m = token.match(/^([A-Za-z0-9_]*)\[\/([\s\S]*?)\/\]$/))) {
      id = m[1]; shape = 'io'; label = m[2].trim(); explicitShape = true;
    } else if ((m = token.match(/^([A-Za-z0-9_]*)\{([\s\S]*?)\}$/))) {
      id = m[1]; shape = 'decision'; label = m[2].trim(); explicitShape = true;
    } else if ((m = token.match(/^([A-Za-z0-9_]*)\[([\s\S]*?)\]$/))) {
      id = m[1];
      const inner = m[2].trim();
      if (inner === '.') {
        shape = 'port'; label = ''; explicitShape = true;
      } else {
        shape = 'rect'; label = inner; explicitShape = true;
      }
    } else {
      id = token;
    }

    if (!id) {
      const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      id = slug ? `anon_${shape}_${slug}` : `anon_${shape}_${nodeMap.size + 1}`;
    }

    if (!nodeMap.has(id)) {
      nodeMap.set(id, { id, shape, label });
    } else if (explicitShape) {
      const existing = nodeMap.get(id);
      existing.shape = shape;
      existing.label = label;
    }
    return id;
  },

  renderFlowchartSvg(blockText) {
    // Join continuation lines that begin with an arrow (e.g. "\n--> [Proses]") onto the previous line
    const joinedText = String(blockText || '')
      .replace(/\r\n/g, '\n')
      .replace(/--(?!>)\s*([^-\n|>[\]{}()]+?)\s*-->/g, '-->|$1|')
      .replace(/\n\s*(-->(?:\|[^|]*\|)?|---)/g, ' $1');

    const lines = joinedText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('%%'));

    if (lines.length === 0) return '';

    let direction = 'TD';
    let startIdx = 0;
    const headerMatch = lines[0].match(/^(?:flowchart|graph)\s+(TD|TB|LR|RL)/i);
    if (headerMatch) {
      const dir = headerMatch[1].toUpperCase();
      direction = dir === 'LR' || dir === 'RL' ? 'LR' : 'TD';
      startIdx = 1;
    }

    const nodeMap = new Map();
    const edges = [];

    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i].replace(/;\s*$/, '');
      if (!line) continue;

      // Split chained edges like A --> B -->|Ya| C
      const parts = line.split(/\s*(-->(?:\|[^|]*\|)?|---\s*)\s*/);
      if (parts.length === 1) {
        this.parseFlowchartNodeToken(parts[0], nodeMap);
        continue;
      }

      let prevId = this.parseFlowchartNodeToken(parts[0], nodeMap);
      for (let p = 1; p < parts.length; p += 2) {
        const connector = parts[p] || '-->';
        const nextToken = parts[p + 1];
        if (!nextToken) break;
        const nextId = this.parseFlowchartNodeToken(nextToken, nodeMap);
        const labelMatch = connector.match(/\|([^|]*)\|/);
        if (prevId && nextId) {
          edges.push({ from: prevId, to: nextId, label: labelMatch ? labelMatch[1].trim() : '' });
        }
        prevId = nextId;
      }
    }

    const nodes = Array.from(nodeMap.values());
    if (nodes.length === 0) {
      return `<pre class="well">${this.escapeHtml(blockText)}</pre>`;
    }

    // Assign (layer, lane) via BFS from root nodes
    const inDeg = new Map(nodes.map((n) => [n.id, 0]));
    const adj = new Map(nodes.map((n) => [n.id, []]));
    for (const e of edges) {
      inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);
      adj.get(e.from)?.push(e);
    }

    const roots = nodes.filter((n) => (inDeg.get(n.id) || 0) === 0);
    if (roots.length === 0) roots.push(nodes[0]);

    const layerOf = new Map();
    const laneOf = new Map();
    const occupied = new Set();
    const queue = [];

    roots.forEach((r, idx) => {
      layerOf.set(r.id, 0);
      laneOf.set(r.id, idx);
      occupied.add(`0:${idx}`);
      queue.push(r.id);
    });

    while (queue.length > 0) {
      const curr = queue.shift();
      const currLayer = layerOf.get(curr) || 0;
      const currLane = laneOf.get(curr) || 0;
      const outEdges = adj.get(curr) || [];

      outEdges.forEach((e, idx) => {
        if (layerOf.has(e.to)) return;
        const nextLayer = currLayer + (idx === 0 || outEdges.length === 1 ? 1 : 0);
        let nextLane = currLane + idx;
        while (occupied.has(`${nextLayer}:${nextLane}`)) {
          nextLane += 1;
        }
        layerOf.set(e.to, nextLayer);
        laneOf.set(e.to, nextLane);
        occupied.add(`${nextLayer}:${nextLane}`);
        queue.push(e.to);
      });
    }

    // Fallback for any disconnected nodes
    nodes.forEach((n, idx) => {
      if (!layerOf.has(n.id)) {
        layerOf.set(n.id, idx);
        laneOf.set(n.id, 0);
      }
    });

    const isLR = direction === 'LR';
    const hasLabels = nodes.some((n) => n.label.length > 0);
    const cellW = hasLabels ? 228 : 92;
    const cellH = hasLabels ? 96 : 68;
    const padX = 48;
    const padY = 24;

    let maxLayer = 0;
    let maxLane = 0;
    const pos = new Map();

    for (const n of nodes) {
      const layer = layerOf.get(n.id) || 0;
      const lane = laneOf.get(n.id) || 0;
      if (layer > maxLayer) maxLayer = layer;
      if (lane > maxLane) maxLane = lane;

      const cx = padX + (isLR ? layer : lane) * cellW + cellW / 2;
      const cy = padY + (isLR ? lane : layer) * cellH + cellH / 2;
      const textLen = n.label.length;
      const w =
        n.shape === 'port'
          ? 6
          : n.shape === 'decision'
            ? n.label
              ? Math.min(216, Math.max(124, textLen * 7.6 + 52))
              : 48
            : n.label
              ? Math.min(198, Math.max(96, textLen * 7.2 + 28))
              : 58;
      const h =
        n.shape === 'port'
          ? 6
          : n.shape === 'decision'
            ? n.label
              ? 60
              : 40
            : n.label
              ? 38
              : 28;
      pos.set(n.id, { cx, cy, w, h, node: n });
    }

    const svgW = padX * 2 + ((isLR ? maxLayer : maxLane) + 1) * cellW;
    const svgH = padY * 2 + ((isLR ? maxLane : maxLayer) + 1) * cellH;
    const markerId = `fc-arrow-${Math.random().toString(36).slice(2, 8)}`;

    let svg = `<div class="flowchart-wrap" role="img" aria-label="Diagram alir flowchart"><svg class="flowchart-svg" viewBox="0 0 ${svgW} ${svgH}" width="${svgW}" height="${svgH}" xmlns="http://www.w3.org/2000/svg">`;
    svg += `<defs><marker id="${markerId}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 1 L 10 5 L 0 9 z" fill="currentColor" /></marker></defs>`;

    // Draw edges first
    for (const e of edges) {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (!a || !b) continue;

      const dx = b.cx - a.cx;
      const dy = b.cy - a.cy;

      let pathD = '';
      let lx = (a.cx + b.cx) / 2;
      let ly = (a.cy + b.cy) / 2 - 6;

      // Loop-back edge on the same column in TD mode: route around the left side of the column
      if (!isLR && dy < -4 && Math.abs(dx) < 8) {
        const xStart = a.cx - a.w / 2;
        const yStart = a.cy;
        const xEnd = b.cx - b.w / 2 - 2;
        const yEnd = b.cy;
        const loopX = Math.max(12, Math.min(xStart, xEnd) - 28);
        pathD = `M ${xStart} ${yStart} L ${loopX} ${yStart} L ${loopX} ${yEnd} L ${xEnd} ${yEnd}`;
        lx = loopX - 4;
        ly = (yStart + yEnd) / 2;
      } else {
        let x1 = a.cx;
        let y1 = a.cy;
        let x2 = b.cx;
        let y2 = b.cy;

        if (Math.abs(dy) >= Math.abs(dx)) {
          const s = dy >= 0 ? 1 : -1;
          y1 = a.cy + s * (a.h / 2);
          y2 = b.cy - s * (b.h / 2 + 2);
        } else {
          const s = dx >= 0 ? 1 : -1;
          x1 = a.cx + s * (a.w / 2);
          x2 = b.cx - s * (b.w / 2 + 2);
        }

        pathD =
          Math.abs(x1 - x2) < 2 || Math.abs(y1 - y2) < 2
            ? `M ${x1} ${y1} L ${x2} ${y2}`
            : `M ${x1} ${y1} L ${x2} ${y1} L ${x2} ${y2}`;
        lx = (x1 + x2) / 2;
        ly = (y1 + y2) / 2 - (Math.abs(y1 - y2) < 4 ? 7 : 3);
      }

      svg += `<path d="${pathD}" class="fc-edge" marker-end="url(#${markerId})" />`;
      if (e.label) {
        svg += `<text x="${lx}" y="${ly}" class="fc-edge-label" text-anchor="middle">${this.escapeHtml(e.label)}</text>`;
      }
    }

    // Draw nodes
    for (const p of pos.values()) {
      const { cx, cy, w, h, node } = p;
      if (node.shape === 'port') continue;

      const x = cx - w / 2;
      const y = cy - h / 2;
      if (node.shape === 'terminator') {
        svg += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" ry="${h / 2}" class="fc-node fc-node--term" />`;
      } else if (node.shape === 'decision') {
        const pts = `${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}`;
        svg += `<polygon points="${pts}" class="fc-node fc-node--decision" />`;
      } else if (node.shape === 'io') {
        const skew = 10;
        const pts = `${x + skew},${y} ${x + w},${y} ${x + w - skew},${y + h} ${x},${y + h}`;
        svg += `<polygon points="${pts}" class="fc-node fc-node--io" />`;
      } else {
        svg += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" ry="3" class="fc-node" />`;
      }

      if (node.label) {
        const shortLabel = node.label.length > 32 ? `${node.label.slice(0, 30)}…` : node.label;
        svg += `<text x="${cx}" y="${cy + 4}" class="fc-label" text-anchor="middle">${this.escapeHtml(shortLabel)}</text>`;
      }
    }

    svg += '</svg></div>';
    return svg;
  },

  renderMath(input) {
    if (input == null || input === '') return '';
    const flowchartBlocks = [];
    const codeBlocks = [];

    let withPlaceholders = String(input).replace(
      /```(?:flowchart|mermaid)\s*\n([\s\S]*?)```/gi,
      (_match, body) => {
        const idx = flowchartBlocks.length;
        flowchartBlocks.push(this.renderFlowchartSvg(body));
        return `\n@@FLOWCHART_${idx}@@\n`;
      }
    );

    withPlaceholders = withPlaceholders.replace(
      /```(?:[a-zA-Z0-9_+-]*)?[ \t]*\n([\s\S]*?)```/g,
      (_match, codeBody) => {
        const idx = codeBlocks.length;
        codeBlocks.push(`<pre class="code-snippet"><code>${this.escapeHtml(codeBody.trim())}</code></pre>`);
        return `\n@@CODEBLOCK_${idx}@@\n`;
      }
    );

    const normalized = this.normalizeCollapsedMathLayout(withPlaceholders);
    const lines = normalized.split('\n');
    const hasAnyTableLine = lines.some((l) => this.isTableRowLine(l));

    let rendered;
    if (!hasAnyTableLine) {
      rendered = this.renderInlineMathSegment(normalized);
    } else {
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

      rendered = outputBlocks.join('\n');
    }

    if (codeBlocks.length > 0) {
      rendered = rendered.replace(/\n?@@CODEBLOCK_(\d+)@@\n?/g, (_m, idx) => codeBlocks[Number(idx)] || '');
    }
    if (flowchartBlocks.length > 0) {
      rendered = rendered.replace(/@@FLOWCHART_(\d+)@@/g, (_m, idx) => flowchartBlocks[Number(idx)] || '');
    }
    return rendered;
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
