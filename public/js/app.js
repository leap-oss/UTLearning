document.addEventListener('alpine:init', () => {
  Alpine.data('appShell', () => ({
    // Navigation: 'dashboard' | 'course' | 'module' | 'quiz_runner' | 'attempt_review' | 'system'
    currentView: 'dashboard',
    moduleTab: 'sources', // 'sources' | 'study' | 'quiz' | 'progress'

    // System & Usage state
    loadingHealth: false,
    healthError: null,
    health: null,
    usageSummary: null,
    lastCheckedAt: null,

    // Courses & Modules state
    loadingCourses: false,
    coursesError: null,
    courses: [],
    includeArchivedCourses: false,
    selectedSemester: 'ALL',

    activeCourse: null,
    courseProgress: null,
    loadingCourseDetail: false,

    // Active Module state
    activeModule: null,
    moduleProgress: null,
    selectedStudyPackVersion: null,
    loadingModuleDetail: false,

    // Upload staging state
    stagedFiles: [], // { id, file, previewUrl, label, pageOrder }
    editingSourceId: null,
    sourceEditForm: {
      label: 'materi',
      pageOrder: 1,
      pageTitle: '',
      extractedText: '',
      needsReview: false,
    },
    savingSourceEdit: false,

    // Active AI Job polling state
    activeAiJob: null, // { jobId, operation, status, attemptCount, maxAttempts, message }
    pollingTimer: null,

    // Study pack synthesis form
    synthesisQuestionCount: 5,

    // Quiz Runner state
    activeQuestionSet: null,
    quizSelections: {}, // { [questionId]: 'A' | 'B' | 'C' | 'D' }
    submittingQuiz: false,
    activeAttemptReview: null,

    // Exam Simulation form
    examSimForm: {
      selectedModuleIds: [],
      questionCount: 10,
      difficulty: 'mixed',
    },

    // Feedback banners
    noticeMessage: null,
    errorMessage: null,

    // Course Modal state
    showCourseModal: false,
    editingCourseId: null,
    savingCourse: false,
    courseForm: {
      code: '',
      name: '',
      semesterLabel: '',
      expectedModuleCount: 9,
    },

    // Module Modal state
    showModuleModal: false,
    editingModuleId: null,
    savingModule: false,
    moduleForm: {
      moduleNumber: 1,
      title: '',
      status: 'empty',
    },

    // Confirm Archive Modal state
    confirmDialog: {
      open: false,
      title: '',
      message: '',
      confirmLabel: 'Arsipkan',
      processing: false,
      onConfirm: null,
    },

    async init() {
      this.$watch('currentView', () => this.focusViewTitle());
      this.$watch('showCourseModal', (open) => open && this.focusFirstField('#course-code-input'));
      this.$watch('showModuleModal', (open) => open && this.focusFirstField('#module-num-input'));
      this.$watch('confirmDialog.open', (open) => open && this.focusFirstField('#confirm-cancel-btn'));
      await Promise.all([this.loadCourses(), this.refreshSystemStatus()]);
    },

    async fetchJson(url, options = {}, retryCount = 1) {
      const method = (options.method || 'GET').toUpperCase();
      for (let attempt = 0; attempt <= retryCount; attempt += 1) {
        try {
          const res = await fetch(url, options);
          const rawText = await res.text();
          let data = {};
          if (rawText && rawText.trim().length > 0) {
            try {
              data = JSON.parse(rawText);
            } catch {
              if (!res.ok) {
                throw new Error(`Server merespons HTTP ${res.status}.`);
              }
              throw new Error('Respons server belum lengkap, silakan coba lagi.');
            }
          } else if (!res.ok) {
            throw new Error(`Server merespons HTTP ${res.status} (kosong).`);
          }

          return { ok: res.ok, status: res.status, data };
        } catch (err) {
          if (method === 'GET' && attempt < retryCount) {
            await new Promise((r) => setTimeout(r, 900));
            continue;
          }
          throw err;
        }
      }
    },

    generateIdempotencyKey(prefix = 'act') {
      const rand =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      return `${prefix}-${rand}`;
    },

    showNotice(msg) {
      this.noticeMessage = msg;
      this.errorMessage = null;
      setTimeout(() => {
        if (this.noticeMessage === msg) this.noticeMessage = null;
      }, 5000);
    },

    showError(msg) {
      this.errorMessage = msg;
    },

    clearBanners() {
      this.noticeMessage = null;
      this.errorMessage = null;
    },

    get semesterOptions() {
      const set = new Set();
      for (const c of this.courses) {
        if (c.semesterLabel) set.add(c.semesterLabel);
      }
      return Array.from(set).sort();
    },

    get filteredCourses() {
      if (this.selectedSemester === 'ALL') return this.courses;
      return this.courses.filter((c) => (c.semesterLabel || '') === this.selectedSemester);
    },

    get activeStudyPack() {
      const packs = this.activeModule?.studyPacks || [];
      if (packs.length === 0) return null;
      if (this.selectedStudyPackVersion != null) {
        const found = packs.find((p) => Number(p.version) === Number(this.selectedStudyPackVersion));
        if (found) return found;
      }
      return packs[0];
    },

    get unreviewedSourcesCount() {
      const sources = this.activeModule?.sources || [];
      return sources.filter((s) => s.needsReview).length;
    },

    get verifiedCourseModules() {
      const mods = this.courseProgress?.modules || [];
      return mods.filter((m) => m.hasVerifiedStudyPack);
    },

    getModuleProgressItem(moduleId) {
      if (!moduleId) return null;
      const mods = this.courseProgress?.modules || [];
      return mods.find((m) => m.moduleId === moduleId) || null;
    },

    get courseOverviewMetrics() {
      const counts = this.activeCourse?.moduleCounts || {};
      const total = counts.total ?? (this.activeCourse?.modules?.length || 0);
      const expected = this.activeCourse?.expectedModuleCount || 9;
      const mastered = counts.mastered ?? 0;
      const inProgress = counts.in_progress ?? 0;
      const needsReview = counts.needs_review ?? 0;
      const empty = counts.empty ?? Math.max(0, total - mastered - inProgress - needsReview);

      const progModules = this.courseProgress?.modules || [];
      const verifiedPacks = progModules.filter((m) => m.hasVerifiedStudyPack).length;
      const totalAttempts = progModules.reduce((acc, m) => acc + (m.attemptCount || 0), 0);
      const scoredModules = progModules.filter((m) => typeof m.averageScore === 'number');
      const avgScore =
        scoredModules.length > 0
          ? Math.round(
              scoredModules.reduce((acc, m) => acc + m.averageScore, 0) / scoredModules.length
            )
          : null;

      const denom = Math.max(total, 1);
      return {
        total,
        expected,
        mastered,
        inProgress,
        needsReview,
        empty,
        verifiedPacks,
        totalAttempts,
        avgScore,
        masteredPct: total > 0 ? Math.round((mastered / denom) * 100) : 0,
        inProgressPct: total > 0 ? Math.round((inProgress / denom) * 100) : 0,
        needsReviewPct: total > 0 ? Math.round((needsReview / denom) * 100) : 0,
      };
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

    async refreshSystemStatus() {
      this.loadingHealth = true;
      this.healthError = null;

      try {
        const [healthRes, usageRes] = await Promise.all([
          fetch('/api/health', { headers: { Accept: 'application/json' } }),
          fetch('/api/ai/usage/summary', { headers: { Accept: 'application/json' } }),
        ]);

        if (!healthRes.ok) {
          throw new Error(`Health HTTP ${healthRes.status}`);
        }

        this.health = await healthRes.json();
        if (usageRes.ok) {
          this.usageSummary = await usageRes.json();
        }
        this.lastCheckedAt = new Date().toLocaleTimeString('id-ID');
      } catch (err) {
        this.healthError = err instanceof Error ? err.message : 'Gagal menghubungi server.';
      } finally {
        this.loadingHealth = false;
      }
    },

    async loadCourses() {
      this.loadingCourses = true;
      this.coursesError = null;

      try {
        const query = this.includeArchivedCourses ? '?includeArchived=true' : '';
        const { ok, status, data } = await this.fetchJson(`/api/courses${query}`, {
          headers: { Accept: 'application/json' },
        });
        if (!ok) {
          throw new Error(data.message || `HTTP ${status}`);
        }
        this.courses = data.courses || [];
      } catch (err) {
        this.coursesError = err instanceof Error ? err.message : 'Gagal memuat mata kuliah.';
      } finally {
        this.loadingCourses = false;
      }
    },

    async openCourse(courseId) {
      this.clearBanners();
      this.loadingCourseDetail = true;
      try {
        const [courseRes, progRes] = await Promise.all([
          this.fetchJson(`/api/courses/${courseId}`, { headers: { Accept: 'application/json' } }),
          this.fetchJson(`/api/courses/${courseId}/progress`, { headers: { Accept: 'application/json' } }),
        ]);
        if (!courseRes.ok) {
          throw new Error(courseRes.data.message || 'Gagal membuka mata kuliah.');
        }
        this.activeCourse = courseRes.data.course;
        if (progRes.ok) {
          this.courseProgress = progRes.data.progress;
          this.examSimForm.selectedModuleIds = (this.courseProgress?.modules || [])
            .filter((m) => m.hasVerifiedStudyPack)
            .map((m) => m.moduleId);
        }
        this.currentView = 'course';
      } catch (err) {
        this.showError(err instanceof Error ? err.message : 'Gagal memuat detail mata kuliah.');
      } finally {
        this.loadingCourseDetail = false;
      }
    },

    async openModule(moduleId, defaultTab = null) {
      this.clearBanners();
      this.loadingModuleDetail = true;
      try {
        const [modRes, progRes] = await Promise.all([
          this.fetchJson(`/api/modules/${moduleId}`, { headers: { Accept: 'application/json' } }),
          this.fetchJson(`/api/modules/${moduleId}/progress`, { headers: { Accept: 'application/json' } }),
        ]);
        if (!modRes.ok) {
          throw new Error(modRes.data.message || 'Gagal membuka modul.');
        }
        this.activeModule = modRes.data.module;
        if (progRes.ok) {
          this.moduleProgress = progRes.data.progress;
        }
        const packs = this.activeModule.studyPacks || [];
        this.selectedStudyPackVersion = packs[0]?.version ?? null;

        if (defaultTab) {
          this.moduleTab = defaultTab;
        } else if (packs.length > 0) {
          this.moduleTab = 'study';
        } else {
          this.moduleTab = 'sources';
        }

        this.editingSourceId = null;
        this.currentView = 'module';
      } catch (err) {
        this.showError(err instanceof Error ? err.message : 'Gagal memuat modul.');
      } finally {
        this.loadingModuleDetail = false;
      }
    },

    backToDashboard() {
      this.currentView = 'dashboard';
      this.activeCourse = null;
      this.activeModule = null;
      this.loadCourses();
    },

    async backToCourse() {
      if (this.activeModule?.courseId) {
        await this.openCourse(this.activeModule.courseId);
      } else if (this.activeCourse?.id) {
        await this.openCourse(this.activeCourse.id);
      } else {
        this.backToDashboard();
      }
    },

    // ==================== UPLOAD & EXTRACTION REVIEW ====================
    handleFileSelect(event) {
      const files = Array.from(event.target.files || []);
      if (files.length === 0) return;

      const existingCount = (this.activeModule?.sources?.length || 0) + this.stagedFiles.length;
      files.forEach((file, idx) => {
        const previewUrl = URL.createObjectURL(file);
        this.stagedFiles.push({
          id: `${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 7)}`,
          file,
          previewUrl,
          label: 'materi',
          pageOrder: existingCount + idx + 1,
        });
      });

      event.target.value = '';
    },

    moveStagedFile(index, direction) {
      const targetIndex = index + direction;
      if (targetIndex < 0 || targetIndex >= this.stagedFiles.length) return;
      const copy = [...this.stagedFiles];
      const [item] = copy.splice(index, 1);
      copy.splice(targetIndex, 0, item);
      copy.forEach((entry, i) => {
        entry.pageOrder = i + 1;
      });
      this.stagedFiles = copy;
    },

    removeStagedFile(index) {
      const item = this.stagedFiles[index];
      if (item?.previewUrl) {
        URL.revokeObjectURL(item.previewUrl);
      }
      this.stagedFiles.splice(index, 1);
    },

    clearStagedFiles() {
      for (const item of this.stagedFiles) {
        if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      }
      this.stagedFiles = [];
    },

    async submitSourceExtraction() {
      if (!this.activeModule || this.stagedFiles.length === 0) return;
      this.clearBanners();

      const formData = new FormData();
      for (const item of this.stagedFiles) {
        formData.append('images', item.file);
        formData.append('labels', item.label);
        formData.append('pageOrders', String(item.pageOrder));
      }

      const idemKey = this.generateIdempotencyKey('extract');

      try {
        const res = await fetch(`/api/modules/${this.activeModule.id}/sources/extract`, {
          method: 'POST',
          headers: {
            'Idempotency-Key': idemKey,
            Accept: 'application/json',
          },
          body: formData,
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.message || 'Gagal mengirim gambar untuk diekstrak.');
        }

        this.clearStagedFiles();
        await this.pollAiJobUntilDone(data.jobId, 'Mengekstrak teks & struktur halaman BMP...', async () => {
          await this.openModule(this.activeModule.id, 'sources');
          await this.refreshSystemStatus();
          this.showNotice('Ekstraksi selesai! Silakan periksa hasil ekstraksi sebelum membuat Study Pack.');
        });
      } catch (err) {
        this.showError(err instanceof Error ? err.message : 'Gagal menjalankan ekstraksi.');
      }
    },

    startEditSource(source) {
      this.editingSourceId = source.id;
      const ext = source.extractedContentJson || {};
      this.sourceEditForm = {
        label: source.label || 'materi',
        pageOrder: source.pageOrder || 1,
        pageTitle: ext.pageTitle || '',
        extractedText: ext.extractedText || '',
        needsReview: false,
      };
    },

    async saveSourceReview(sourceId, markReviewed = true) {
      this.savingSourceEdit = true;
      this.clearBanners();
      try {
        const res = await fetch(`/api/sources/${sourceId}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            label: this.sourceEditForm.label,
            pageOrder: Number(this.sourceEditForm.pageOrder) || 1,
            pageTitle: this.sourceEditForm.pageTitle,
            extractedText: this.sourceEditForm.extractedText,
            needsReview: !markReviewed,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.message || 'Gagal menyimpan review sumber.');
        }
        this.editingSourceId = null;
        await this.openModule(this.activeModule.id, 'sources');
        this.showNotice(
          markReviewed
            ? 'Hasil ekstraksi disimpan dan ditandai sudah direview.'
            : 'Perubahan ekstraksi disimpan.'
        );
      } catch (err) {
        this.showError(err instanceof Error ? err.message : 'Gagal menyimpan review.');
      } finally {
        this.savingSourceEdit = false;
      }
    },

    async quickApproveSource(source) {
      try {
        const res = await fetch(`/api/sources/${source.id}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ needsReview: false }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.message || 'Gagal menandai selesai review.');
        }
        await this.openModule(this.activeModule.id, 'sources');
        this.showNotice(`Halaman ${source.pageOrder} ditandai selesai direview.`);
      } catch (err) {
        this.showError(err instanceof Error ? err.message : 'Gagal memperbarui status sumber.');
      }
    },

    async removeSourceAsset(source) {
      try {
        const res = await fetch(`/api/sources/${source.id}`, {
          method: 'DELETE',
          headers: { Accept: 'application/json' },
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.message || 'Gagal menghapus sumber.');
        }
        await this.openModule(this.activeModule.id, 'sources');
        this.showNotice('Sumber halaman berhasil dihapus.');
      } catch (err) {
        this.showError(err instanceof Error ? err.message : 'Gagal menghapus sumber.');
      }
    },

    // ==================== STUDY PACK & QUIZ SYNTHESIS ====================
    async generateStudyPackAndQuiz(regenerate = false) {
      if (!this.activeModule) return;
      this.clearBanners();

      const idemKey = this.generateIdempotencyKey('studypack');
      try {
        const res = await fetch(`/api/modules/${this.activeModule.id}/study-packs`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idemKey,
            Accept: 'application/json',
          },
          body: JSON.stringify({
            questionCount: Number(this.synthesisQuestionCount) || 5,
            regenerate,
          }),
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.message || 'Gagal memulai pembuatan Study Pack.');
        }

        await this.pollAiJobUntilDone(
          data.jobId,
          'Menyusun Study Pack (Rangkuman BMP, Istilah, Penjelasan AI) & Kuis Awal...',
          async () => {
            await this.openModule(this.activeModule.id, 'study');
            await this.refreshSystemStatus();
            this.showNotice(
              data.reusedCache
                ? 'Study Pack dimuat dari cache hasil sebelumnya (0 panggilan AI baru).'
                : 'Study Pack & Kuis Awal berhasil dibuat dan disimpan!'
            );
          }
        );
      } catch (err) {
        this.showError(err instanceof Error ? err.message : 'Gagal membuat Study Pack.');
      }
    },

    async generateExtraPracticeSet() {
      if (!this.activeModule) return;
      this.clearBanners();

      const idemKey = this.generateIdempotencyKey('practice');
      try {
        const res = await fetch(`/api/modules/${this.activeModule.id}/question-sets`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idemKey,
            Accept: 'application/json',
          },
          body: JSON.stringify({ questionCount: 5 }),
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.message || 'Gagal membuat set latihan tambahan.');
        }

        await this.pollAiJobUntilDone(
          data.jobId,
          'Membuat soal latihan tambahan dari Study Pack...',
          async () => {
            await this.openModule(this.activeModule.id, 'quiz');
            await this.refreshSystemStatus();
            this.showNotice('Set soal latihan tambahan berhasil dibuat!');
          }
        );
      } catch (err) {
        this.showError(err instanceof Error ? err.message : 'Gagal membuat soal tambahan.');
      }
    },

    // ==================== QUIZ RUNNER, GRADING & REMEDIAL ====================
    async startQuiz(questionSetId) {
      this.clearBanners();
      try {
        const res = await fetch(`/api/question-sets/${questionSetId}`, {
          headers: { Accept: 'application/json' },
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.message || 'Gagal memuat soal kuis.');
        }
        this.activeQuestionSet = data.questionSet;
        this.quizSelections = {};
        this.activeAttemptReview = null;
        this.currentView = 'quiz_runner';
      } catch (err) {
        this.showError(err instanceof Error ? err.message : 'Gagal membuka kuis.');
      }
    },

    get answeredCount() {
      return Object.keys(this.quizSelections || {}).length;
    },

    async submitQuizAnswers() {
      if (!this.activeQuestionSet) return;
      const totalQ = this.activeQuestionSet.questions?.length || 0;
      if (this.answeredCount < totalQ) {
        this.showError(`Harap pilih jawaban untuk seluruh ${totalQ} soal sebelum mengumpulkan.`);
        return;
      }

      this.submittingQuiz = true;
      this.clearBanners();

      const answersPayload = this.activeQuestionSet.questions.map((q) => ({
        questionId: q.id,
        selectedOption: this.quizSelections[q.id],
      }));

      try {
        const res = await fetch(`/api/question-sets/${this.activeQuestionSet.id}/attempts`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ answers: answersPayload }),
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.message || 'Gagal mengirim jawaban kuis.');
        }

        this.activeAttemptReview = data.attempt;
        this.currentView = 'attempt_review';
        this.showNotice(`Kuis selesai dinilai di server! Skor Anda: ${data.attempt.score}%`);
      } catch (err) {
        this.showError(err instanceof Error ? err.message : 'Gagal menilai kuis.');
      } finally {
        this.submittingQuiz = false;
      }
    },

    async openAttemptReview(attemptId) {
      this.clearBanners();
      try {
        const res = await fetch(`/api/attempts/${attemptId}`, {
          headers: { Accept: 'application/json' },
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.message || 'Gagal memuat pembahasan attempt.');
        }
        this.activeAttemptReview = data.attempt;
        this.currentView = 'attempt_review';
      } catch (err) {
        this.showError(err instanceof Error ? err.message : 'Gagal membuka pembahasan.');
      }
    },

    async generateRemedialFromAttempt(attemptId) {
      this.clearBanners();
      const idemKey = this.generateIdempotencyKey('remedial');
      try {
        const res = await fetch(`/api/attempts/${attemptId}/remedial`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idemKey,
            Accept: 'application/json',
          },
          body: JSON.stringify({}),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.message || 'Gagal memulai pembuatan remedial.');
        }

        await this.pollAiJobUntilDone(
          data.jobId,
          'Menganalisis pola kesalahan konsep & menyusun soal remedial terfokus...',
          async (jobResult) => {
            await this.openAttemptReview(attemptId);
            await this.refreshSystemStatus();
            this.showNotice('Analisis diagnostik & paket soal remedial berhasil dibuat!');
            if (jobResult?.resultRefs?.remedialQuestionSetId) {
              await this.startQuiz(jobResult.resultRefs.remedialQuestionSetId);
            }
          }
        );
      } catch (err) {
        this.showError(err instanceof Error ? err.message : 'Gagal membuat remedial.');
      }
    },

    async returnFromQuizOrReview() {
      if (this.activeAttemptReview?.moduleId) {
        await this.openModule(this.activeAttemptReview.moduleId, 'quiz');
      } else if (this.activeQuestionSet?.moduleId) {
        await this.openModule(this.activeQuestionSet.moduleId, 'quiz');
      } else if (this.activeAttemptReview?.courseId) {
        await this.openCourse(this.activeAttemptReview.courseId);
      } else if (this.activeCourse?.id) {
        await this.openCourse(this.activeCourse.id);
      } else {
        this.backToDashboard();
      }
    },

    // ==================== COURSE EXAM SIMULATION ====================
    toggleExamSimModule(moduleId) {
      const idx = this.examSimForm.selectedModuleIds.indexOf(moduleId);
      if (idx >= 0) {
        this.examSimForm.selectedModuleIds.splice(idx, 1);
      } else {
        this.examSimForm.selectedModuleIds.push(moduleId);
      }
    },

    async generateExamSimulation() {
      if (!this.activeCourse) return;
      this.clearBanners();

      const idemKey = this.generateIdempotencyKey('examsim');
      try {
        const res = await fetch(`/api/courses/${this.activeCourse.id}/exam-simulations`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idemKey,
            Accept: 'application/json',
          },
          body: JSON.stringify({
            moduleIds: this.examSimForm.selectedModuleIds,
            questionCount: Number(this.examSimForm.questionCount) || 10,
            difficulty: this.examSimForm.difficulty || 'mixed',
            regenerate: true,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.message || 'Gagal memulai pembuatan Simulasi UAS.');
        }

        await this.pollAiJobUntilDone(
          data.jobId,
          'Menyusun soal Simulasi UAS komprehensif lintas modul terpilih...',
          async (jobResult) => {
            await this.openCourse(this.activeCourse.id);
            await this.refreshSystemStatus();
            this.showNotice('Paket Simulasi UAS komprehensif siap dikerjakan!');
            if (jobResult?.resultRefs?.questionSetId) {
              await this.startQuiz(jobResult.resultRefs.questionSetId);
            }
          }
        );
      } catch (err) {
        this.showError(err instanceof Error ? err.message : 'Gagal membuat Simulasi UAS.');
      }
    },

    // ==================== AI JOB POLLING ====================
    async pollAiJobUntilDone(jobId, label, onSuccess) {
      if (this.pollingTimer) {
        clearTimeout(this.pollingTimer);
      }

      this.activeAiJob = {
        jobId,
        label,
        status: 'queued',
        attemptCount: 0,
        maxAttempts: 3,
      };

      const pollOnce = async () => {
        try {
          const res = await fetch(`/api/ai/jobs/${jobId}`, {
            headers: { Accept: 'application/json' },
          });
          if (!res.ok) {
            throw new Error(`Gagal memeriksa status job (${res.status})`);
          }
          const job = await res.json();
          this.activeAiJob = {
            ...this.activeAiJob,
            status: job.status,
            attemptCount: job.attemptCount,
            maxAttempts: job.maxAttempts,
          };

          if (job.status === 'succeeded') {
            this.activeAiJob = null;
            if (onSuccess) await onSuccess(job);
            return;
          }

          if (job.status === 'failed' || job.status === 'interrupted') {
            const errMsg =
              job.lastErrorMessage ||
              `Proses AI berhenti dengan status ${job.status} (${job.lastErrorCode || 'ERROR'}).`;
            this.activeAiJob = null;
            this.showError(errMsg);
            await this.refreshSystemStatus();
            return;
          }

          this.pollingTimer = setTimeout(pollOnce, 1200);
        } catch (err) {
          this.activeAiJob = null;
          this.showError(err instanceof Error ? err.message : 'Gagal memantau status job AI.');
        }
      };

      await pollOnce();
    },

    // ==================== COURSE & MODULE CRUD MODALS ====================
    openCreateCourseModal() {
      this.clearBanners();
      this.editingCourseId = null;
      this.courseForm = {
        code: '',
        name: '',
        semesterLabel: '',
        expectedModuleCount: 9,
      };
      this.showCourseModal = true;
    },

    openEditCourseModal(course) {
      this.clearBanners();
      this.editingCourseId = course.id;
      this.courseForm = {
        code: course.code || '',
        name: course.name || '',
        semesterLabel: course.semesterLabel || '',
        expectedModuleCount: course.expectedModuleCount || 9,
      };
      this.showCourseModal = true;
    },

    async submitCourseForm() {
      this.savingCourse = true;
      this.clearBanners();

      try {
        const isEdit = Boolean(this.editingCourseId);
        const url = isEdit ? `/api/courses/${this.editingCourseId}` : '/api/courses';
        const method = isEdit ? 'PATCH' : 'POST';

        const res = await fetch(url, {
          method,
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            code: this.courseForm.code,
            name: this.courseForm.name,
            semesterLabel: this.courseForm.semesterLabel,
            expectedModuleCount: Number(this.courseForm.expectedModuleCount) || 9,
          }),
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.message || 'Gagal menyimpan mata kuliah.');
        }

        this.showCourseModal = false;
        await this.loadCourses();

        if (this.activeCourse && this.activeCourse.id === data.course.id) {
          this.activeCourse = data.course;
        }

        this.showNotice(
          isEdit ? 'Mata kuliah berhasil diperbarui.' : 'Mata kuliah berhasil ditambahkan.'
        );
      } catch (err) {
        this.showError(err instanceof Error ? err.message : 'Gagal menyimpan mata kuliah.');
      } finally {
        this.savingCourse = false;
      }
    },

    confirmArchiveCourse(course) {
      this.confirmDialog = {
        open: true,
        title: `Arsipkan ${course.code}?`,
        message: `Mata kuliah "${course.name}" akan disembunyikan dari daftar aktif tetapi seluruh modul dan riwayat belajarnya tetap aman tersimpan.`,
        confirmLabel: 'Ya, Arsipkan',
        processing: false,
        onConfirm: async () => {
          const res = await fetch(`/api/courses/${course.id}`, {
            method: 'DELETE',
            headers: { Accept: 'application/json' },
          });
          const data = await res.json();
          if (!res.ok) {
            throw new Error(data.message || 'Gagal mengarsipkan mata kuliah.');
          }
          if (this.activeCourse && this.activeCourse.id === course.id) {
            this.currentView = 'dashboard';
            this.activeCourse = null;
          }
          await this.loadCourses();
          this.showNotice(`Mata kuliah ${course.code} diarsipkan.`);
        },
      };
    },

    async restoreCourse(course) {
      try {
        const res = await fetch(`/api/courses/${course.id}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ status: 'active' }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.message || 'Gagal memulihkan mata kuliah.');
        }
        await this.loadCourses();
        this.showNotice(`Mata kuliah ${course.code} dipulihkan ke daftar aktif.`);
      } catch (err) {
        this.showError(err instanceof Error ? err.message : 'Gagal memulihkan mata kuliah.');
      }
    },

    suggestNextModuleNumber() {
      const mods = this.activeCourse?.modules || [];
      const used = new Set(mods.map((m) => m.moduleNumber));
      let candidate = 1;
      while (used.has(candidate)) {
        candidate += 1;
      }
      return candidate;
    },

    openCreateModuleModal() {
      if (!this.activeCourse) return;
      this.clearBanners();
      this.editingModuleId = null;
      this.moduleForm = {
        moduleNumber: this.suggestNextModuleNumber(),
        title: '',
        status: 'empty',
      };
      this.showModuleModal = true;
    },

    openEditModuleModal(mod) {
      this.clearBanners();
      this.editingModuleId = mod.id;
      this.moduleForm = {
        moduleNumber: mod.moduleNumber,
        title: mod.title,
        status: mod.status,
      };
      this.showModuleModal = true;
    },

    async submitModuleForm() {
      if (!this.activeCourse) return;
      this.savingModule = true;
      this.clearBanners();

      try {
        const isEdit = Boolean(this.editingModuleId);
        const url = isEdit
          ? `/api/modules/${this.editingModuleId}`
          : `/api/courses/${this.activeCourse.id}/modules`;
        const method = isEdit ? 'PATCH' : 'POST';

        const res = await fetch(url, {
          method,
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            moduleNumber: Number(this.moduleForm.moduleNumber),
            title: this.moduleForm.title,
            status: this.moduleForm.status,
          }),
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.message || 'Gagal menyimpan modul.');
        }

        this.showModuleModal = false;
        await this.openCourse(this.activeCourse.id);
        await this.loadCourses();
        this.showNotice(
          isEdit
            ? `Modul ${data.module.moduleNumber} berhasil diperbarui.`
            : `Modul ${data.module.moduleNumber} berhasil ditambahkan.`
        );
      } catch (err) {
        this.showError(err instanceof Error ? err.message : 'Gagal menyimpan modul.');
      } finally {
        this.savingModule = false;
      }
    },

    confirmArchiveModule(mod) {
      this.confirmDialog = {
        open: true,
        title: `Arsipkan Modul ${mod.moduleNumber}?`,
        message: `Modul "${mod.title}" akan diarsipkan. Riwayat pengerjaan dan materi yang ada tetap tersimpan di database.`,
        confirmLabel: 'Ya, Arsipkan Modul',
        processing: false,
        onConfirm: async () => {
          const res = await fetch(`/api/modules/${mod.id}`, {
            method: 'DELETE',
            headers: { Accept: 'application/json' },
          });
          const data = await res.json();
          if (!res.ok) {
            throw new Error(data.message || 'Gagal mengarsipkan modul.');
          }
          if (this.activeCourse) {
            await this.openCourse(this.activeCourse.id);
          }
          await this.loadCourses();
          this.showNotice(`Modul ${mod.moduleNumber} diarsipkan.`);
        },
      };
    },

    async executeConfirmDialog() {
      if (!this.confirmDialog.onConfirm) return;
      this.confirmDialog.processing = true;
      try {
        await this.confirmDialog.onConfirm();
        this.confirmDialog.open = false;
      } catch (err) {
        this.showError(err instanceof Error ? err.message : 'Operasi gagal.');
        this.confirmDialog.open = false;
      } finally {
        this.confirmDialog.processing = false;
      }
    },

    moduleStatusLabel(status) {
      const map = {
        empty: 'Belum dipelajari',
        in_progress: 'Sedang dipelajari',
        needs_review: 'Perlu review',
        mastered: 'Dikuasai',
        archived: 'Diarsipkan',
      };
      return map[status] || status;
    },

    moduleStatusBadgeClass(status) {
      switch (status) {
        case 'mastered':
          return 'state state--mastered';
        case 'in_progress':
          return 'state state--progress';
        case 'needs_review':
          return 'state state--review';
        default:
          return 'state state--empty';
      }
    },

    // Proportional widths from real module counts. Returns zeros when nothing is registered.
    statusSegments(counts) {
      const c = counts || {};
      const total = c.total || 0;
      const pct = (n) => (total > 0 ? Math.round(((n || 0) / total) * 1000) / 10 : 0);
      return {
        total,
        mastered: c.mastered || 0,
        inProgress: c.in_progress || 0,
        needsReview: c.needs_review || 0,
        empty: c.empty || 0,
        masteredPct: pct(c.mastered),
        inProgressPct: pct(c.in_progress),
        needsReviewPct: pct(c.needs_review),
      };
    },

    scoreStateClass(score) {
      if (typeof score !== 'number') return 'state state--empty';
      return score >= 80 ? 'state state--ok' : 'state state--review';
    },

    get examEligibility() {
      const verified = this.verifiedCourseModules.length;
      return {
        verified,
        ready: verified >= 2,
        missing: Math.max(0, 2 - verified),
      };
    },

    get answeredPct() {
      const total = this.activeQuestionSet?.questions?.length || 0;
      return total > 0 ? Math.round((this.answeredCount / total) * 100) : 0;
    },

    get isBusy() {
      return Boolean(
        this.loadingCourses ||
          this.loadingCourseDetail ||
          this.loadingModuleDetail ||
          this.submittingQuiz
      );
    },

    viewTitle() {
      switch (this.currentView) {
        case 'course':
          return this.activeCourse?.name;
        case 'module':
          return this.activeModule?.title;
        case 'quiz_runner':
          return this.activeQuestionSet?.title;
        case 'attempt_review':
          return this.activeAttemptReview?.questionSetTitle;
        case 'system':
          return 'Status sistem';
        default:
          return 'Perpustakaan kuliah';
      }
    },

    focusViewTitle() {
      const title = this.viewTitle();
      document.title = title ? `${title} | UT AI Learning Companion` : 'UT AI Learning Companion';
      this.$nextTick(() => {
        const heading = document.querySelector(
          `[data-view="${this.currentView}"] [data-view-title]`
        );
        if (heading) heading.focus({ preventScroll: true });
        window.scrollTo({ top: 0 });
      });
    },

    focusFirstField(selector) {
      this.$nextTick(() => {
        const el = document.querySelector(selector);
        if (el) el.focus();
      });
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

    formatBytes(bytes) {
      if (typeof bytes !== 'number' || Number.isNaN(bytes)) return '-';
      return `${(bytes / 1_000_000).toFixed(1)} MB`;
    },
  }));
});
