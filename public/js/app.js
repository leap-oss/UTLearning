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
    synthesisQuestionCount: 10,
    practiceQuestionCount: 10,
    remedialQuestionCount: 5,
    activeTopicId: null,

    // Quiz Runner state
    activeQuestionSet: null,
    remedialRunnerStep: 'quiz', // 'study' | 'quiz'
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
    isAutoMappingToc: false,
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
      this.$watch('currentView', (view) => {
        this.focusViewTitle();
        if (view === 'module' && this.moduleTab === 'study') {
          this.$nextTick(() => {
            this.setupTopicScrollSpy();
            this.refreshActiveTopic();
          });
        }
      });
      this.$watch('moduleTab', (tab) => {
        if (tab === 'study') {
          this.$nextTick(() => {
            this.setupTopicScrollSpy();
            this.refreshActiveTopic();
          });
        }
      });
      this.$watch('selectedStudyPackVersion', () => {
        if (this.moduleTab === 'study') {
          this.$nextTick(() => {
            this.setupTopicScrollSpy();
            this.refreshActiveTopic();
          });
        }
      });
      this.$watch('showCourseModal', (open) => open && this.focusFirstField('#course-code-input'));
      this.$watch('showModuleModal', (open) => open && this.focusFirstField('#module-num-input'));
      this.$watch('confirmDialog.open', (open) => open && this.focusFirstField('#confirm-cancel-btn'));
      await this.loadCourses();
      this.refreshSystemStatus(this.currentView === 'system');
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

    refreshActiveTopic() {
      const sections = Array.from(document.querySelectorAll('.reader section.topic, .reader section#glossary'));
      if (sections.length > 0 && !this.activeTopicId) {
        this.activeTopicId = sections[0].id;
      }
    },

    scrollToTopic(topicId, event) {
      if (event) event.preventDefault();
      const el = document.getElementById(topicId);
      if (!el) return;
      const isMobile = window.innerWidth <= 960;
      const offset = isMobile ? 112 : 72;
      const y = el.getBoundingClientRect().top + window.scrollY - offset;
      window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
      this.activeTopicId = topicId;

      if (isMobile) {
        const toc = document.querySelector('.reader .toc');
        const activeLink = toc?.querySelector(`.toc-link[href="#${topicId}"]`);
        if (toc && activeLink) {
          const tocRect = toc.getBoundingClientRect();
          const linkRect = activeLink.getBoundingClientRect();
          const scrollLeftDiff = linkRect.left + linkRect.width / 2 - (tocRect.left + tocRect.width / 2);
          toc.scrollBy({ left: scrollLeftDiff, behavior: 'smooth' });
        }
      }
    },

    setupTopicScrollSpy() {
      if (this._scrollSpyAttached) {
        this.refreshActiveTopic();
        return;
      }
      this._scrollSpyAttached = true;

      const updateActive = () => {
        if (this.currentView !== 'module' || this.moduleTab !== 'study') return;
        const sections = Array.from(document.querySelectorAll('.reader section.topic, .reader section#glossary'));
        if (!sections.length) return;

        const scrollY = window.scrollY || window.pageYOffset;
        const isMobile = window.innerWidth <= 960;
        const offset = isMobile ? 130 : 90;

        let foundId = null;
        for (const section of sections) {
          const top = section.getBoundingClientRect().top + scrollY - offset;
          if (scrollY >= top) {
            foundId = section.id;
          }
        }

        if (!foundId && sections.length > 0) {
          foundId = sections[0].id;
        }

        if (foundId && this.activeTopicId !== foundId) {
          this.activeTopicId = foundId;
          if (isMobile) {
            const toc = document.querySelector('.reader .toc');
            const activeLink = toc?.querySelector(`.toc-link[href="#${foundId}"]`);
            if (toc && activeLink) {
              const tocRect = toc.getBoundingClientRect();
              const linkRect = activeLink.getBoundingClientRect();
              const scrollLeftDiff = linkRect.left + linkRect.width / 2 - (tocRect.left + tocRect.width / 2);
              toc.scrollBy({ left: scrollLeftDiff, behavior: 'smooth' });
            }
          }
        }
      };

      window.addEventListener(
        'scroll',
        () => {
          if (!this._scrollSpyTicking) {
            window.requestAnimationFrame(() => {
              updateActive();
              this._scrollSpyTicking = false;
            });
            this._scrollSpyTicking = true;
          }
        },
        { passive: true }
      );

      setTimeout(updateActive, 150);
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

    async refreshSystemStatus(includeUsage = true) {
      this.loadingHealth = true;
      this.healthError = null;

      try {
        const shouldFetchUsage = includeUsage || this.currentView === 'system';
        const [healthRes, usageRes] = await Promise.all([
          fetch('/api/health', { headers: { Accept: 'application/json' } }),
          shouldFetchUsage
            ? fetch('/api/ai/usage/summary', { headers: { Accept: 'application/json' } })
            : Promise.resolve(null),
        ]);

        if (!healthRes.ok) {
          throw new Error(`Health HTTP ${healthRes.status}`);
        }

        this.health = await healthRes.json();
        if (usageRes && usageRes.ok) {
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
        if (this.moduleTab === 'study') {
          this.$nextTick(() => {
            this.setupTopicScrollSpy();
            this.refreshActiveTopic();
          });
        }
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
        const targetModuleId = this.activeModule.id;
        await this.pollAiJobUntilDone(data.jobId, 'Mengekstrak teks & struktur halaman BMP...', async (jobResult) => {
          const modIdToOpen = targetModuleId || jobResult?.resultRefs?.moduleId || jobResult?.targetId;
          if (modIdToOpen) {
            await this.openModule(modIdToOpen, 'sources');
          }
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
      const targetModuleId = this.activeModule.id;
      this.clearBanners();

      const idemKey = this.generateIdempotencyKey('studypack');
      try {
        const res = await fetch(`/api/modules/${targetModuleId}/study-packs`, {
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
          async (jobResult) => {
            const modIdToOpen = targetModuleId || jobResult?.resultRefs?.moduleId || jobResult?.targetId;
            if (modIdToOpen) {
              await this.openModule(modIdToOpen, 'study');
            }
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
      const targetModuleId = this.activeModule.id;
      this.clearBanners();

      const idemKey = this.generateIdempotencyKey('practice');
      const count = Number(this.practiceQuestionCount) || 10;
      try {
        const res = await fetch(`/api/modules/${targetModuleId}/question-sets`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idemKey,
            Accept: 'application/json',
          },
          body: JSON.stringify({ questionCount: count }),
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.message || 'Gagal membuat set latihan tambahan.');
        }

        await this.pollAiJobUntilDone(
          data.jobId,
          'Membuat soal latihan tambahan dari Study Pack...',
          async (jobResult) => {
            const modIdToOpen = targetModuleId || jobResult?.resultRefs?.moduleId || jobResult?.targetId;
            if (modIdToOpen) {
              await this.openModule(modIdToOpen, 'quiz');
            }
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
        
        // If this is a remedial set with diagnostic feedback, start at 'study' step so student reads deepening first!
        const meta = data.questionSet?.metadata || data.questionSet?.metadataJson || {};
        const hasDiagnostics = Boolean(meta.diagnosticFeedback?.topicDiagnostics?.length > 0);
        if (data.questionSet?.setType === 'remedial' && hasDiagnostics) {
          this.remedialRunnerStep = 'study';
        } else {
          this.remedialRunnerStep = 'quiz';
        }
        
        // Restore in-progress draft answers if available
        const inProgressDraft = (data.questionSet.attempts || []).find((a) => a.status === 'in_progress');
        if (inProgressDraft && inProgressDraft.answersJson) {
          this.quizSelections = { ...inProgressDraft.answersJson };
          this.showNotice('Melanjutkan sesi pengerjaan kuis yang tersimpan.');
        }

        this.activeAttemptReview = null;
        this.currentView = 'quiz_runner';
      } catch (err) {
        this.showError(err instanceof Error ? err.message : 'Gagal membuka kuis.');
      }
    },

    async jumpToTopicInStudyPack(topicLabel) {
      if (!this.activeQuestionSet?.moduleId) return;
      const modId = this.activeQuestionSet.moduleId;
      await this.openModule(modId, 'study');
      this.$nextTick(() => {
        if (!topicLabel) return;
        const sections = Array.from(document.querySelectorAll('.reader section.topic'));
        const clean = topicLabel.toLowerCase().trim();
        const matched = sections.find((s) => s.textContent.toLowerCase().includes(clean));
        if (matched) {
          this.scrollToTopic(matched.id);
        }
      });
    },

    async saveDraftProgress() {
      if (!this.activeQuestionSet?.id || Object.keys(this.quizSelections || {}).length === 0) return;
      try {
        await fetch(`/api/question-sets/${this.activeQuestionSet.id}/draft`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ selections: this.quizSelections }),
        });
      } catch {
        // Silent draft auto-save failure
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

    async generateRemedialFromAttempt(attemptId, questionCount = 5) {
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
          body: JSON.stringify({ questionCount: Number(questionCount) || 5 }),
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
        await this.openModule(this.activeAttemptReview.moduleId, 'progress');
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
            semesterLabel: this.formatSemester(this.courseForm.semesterLabel),
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

    async handleTocImageUpload(event) {
      const files = event.target.files;
      if (!files || files.length === 0 || !this.activeCourse) return;

      this.isAutoMappingToc = true;
      this.clearBanners();
      this.showNotice('Menganalisis foto Daftar Isi BMP dengan AI Vision... Mohon tunggu.');

      try {
        const formData = new FormData();
        for (let i = 0; i < files.length; i++) {
          formData.append('tocImages', files[i]);
        }

        const res = await fetch(`/api/courses/${this.activeCourse.id}/auto-map-modules`, {
          method: 'POST',
          body: formData,
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.message || 'Gagal memetakan modul dari foto Daftar Isi.');
        }

        await this.openCourse(this.activeCourse.id);
        await this.loadCourses();
        this.showNotice(data.message || `Berhasil memetakan ${data.count} modul otomatis dari Daftar Isi BMP!`);
      } catch (err) {
        this.showError(err instanceof Error ? err.message : 'Gagal memetakan modul dari foto Daftar Isi.');
      } finally {
        this.isAutoMappingToc = false;
        event.target.value = '';
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

    get knowledgeGaps() {
      const progModules = this.courseProgress?.modules || [];
      return progModules.filter(
        (m) => m.status === 'needs_review' || (m.weakTopics && m.weakTopics.length > 0)
      );
    },

    get moduleNextStep() {
      const sourcesCount = this.activeModule?.sources?.length || 0;
      const packsCount = this.activeModule?.studyPacks?.length || 0;
      const attemptsCount = this.moduleProgress?.attemptCount || 0;
      const weakCount = this.moduleProgress?.weakTopics?.length || 0;

      if (sourcesCount === 0) {
        return 'Unggah foto halaman BMP (Rangkuman, Tes Formatif, atau Materi) untuk memulai.';
      }
      if (this.unreviewedSourcesCount > 0) {
        return `Periksa ${this.unreviewedSourcesCount} halaman hasil ekstraksi AI sebelum menyusun Study Pack.`;
      }
      if (packsCount === 0) {
        return 'Semua halaman sudah diverifikasi. Susun Study Pack dan kuis awal di tab Rangkuman.';
      }
      if (attemptsCount === 0) {
        return 'Study Pack siap dibaca. Kerjakan kuis awal di tab Kuis untuk menguji pemahaman.';
      }
      if (weakCount > 0) {
        return `Terdapat ${weakCount} topik dengan akurasi di bawah 75%. Tinjau progres atau susun latihan remedial.`;
      }
      return 'Materi modul ini sudah dipelajari dengan baik. Anda dapat mengulang kuis atau menambah latihan.';
    },

    sourceLabel(label) {
      const map = {
        rangkuman: 'Rangkuman',
        tes_formatif: 'Tes Formatif',
        materi: 'Materi',
      };
      return map[label] || label || 'Materi';
    },

    optionText(questionObj, optionKey) {
      if (!questionObj || !optionKey) return '-';
      const found = (questionObj.options || []).find((o) => o.key === optionKey);
      return found ? found.text : optionKey;
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
  }));
});
