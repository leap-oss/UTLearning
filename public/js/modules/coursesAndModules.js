window.AppModules = window.AppModules || {};

window.AppModules.coursesAndModules = {
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

    const denom = Math.max(total, expected, 1);
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
    const isEdit = Boolean(this.editingCourseId);
    this.startAiJobFeedback(
      isEdit ? 'Menyimpan perubahan mata kuliah...' : 'Menambahkan mata kuliah baru...',
      'Menyimpan ke server…',
      1
    );

    try {
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
      this.clearPendingAiJobFeedback();
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
    this.startAiJobFeedback(`Memulihkan mata kuliah ${course.code}...`, 'Memperbarui status di server…', 1);
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
    } finally {
      this.clearPendingAiJobFeedback();
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
    const isEdit = Boolean(this.editingModuleId);
    this.startAiJobFeedback(
      isEdit ? 'Menyimpan perubahan modul...' : `Menambahkan Modul ${this.moduleForm.moduleNumber}...`,
      'Menyimpan ke server…',
      1
    );

    try {
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
      this.clearPendingAiJobFeedback();
    }
  },

  async handleTocImageUpload(event) {
    const files = event.target.files;
    if (!files || files.length === 0 || !this.activeCourse) return;

    this.isAutoMappingToc = true;
    this.clearBanners();
    this.startAiJobFeedback(
      `Menganalisis ${files.length} foto Daftar Isi BMP dengan AI Vision...`,
      'Memetakan nomor & judul modul otomatis…'
    );

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
      this.clearPendingAiJobFeedback();
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
    this.startAiJobFeedback(
      `${this.confirmDialog.title || 'Memproses konfirmasi'}...`,
      'Sedang memproses di server…',
      1
    );
    try {
      await this.confirmDialog.onConfirm();
      this.confirmDialog.open = false;
    } catch (err) {
      this.showError(err instanceof Error ? err.message : 'Operasi gagal.');
      this.confirmDialog.open = false;
    } finally {
      this.confirmDialog.processing = false;
      this.clearPendingAiJobFeedback();
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

  statusSegments(counts, expectedCount = null) {
    const c = counts || {};
    const total = c.total || 0;
    const denom = Math.max(total, Number(expectedCount) || 0);
    const pct = (n) => (total > 0 && denom > 0 ? Math.round(((n || 0) / denom) * 1000) / 10 : 0);
    return {
      total,
      expected: denom,
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
      (m) =>
        m.status === 'needs_review' ||
        (m.status !== 'mastered' && m.weakTopics && m.weakTopics.length > 0)
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
      return 'Study Pack siap dibaca. Kerjakan kuis awal di tab Kuis (minimal skor 80% untuk menguasai modul).';
    }
    if (this.activeModule?.status === 'mastered') {
      if (weakCount > 0) {
        return `Modul ini sudah dikuasai (skor kuis ≥ 80%). Terdapat ${weakCount} sub-topik yang masih bisa diperkuat lewat latihan tambahan.`;
      }
      return 'Modul ini telah dikuasai (skor kuis ≥ 80%). Anda dapat menambah latihan adaptif kapan saja.';
    }
    if (weakCount > 0) {
      return `Terdapat ${weakCount} topik dengan akurasi di bawah 75%. Susun remedial atau latihan tambahan dan capai skor minimal 80% untuk menguasai modul.`;
    }
    return 'Capai skor minimal 80% pada kuis atau latihan untuk menuntaskan penguasaan modul ini.';
  },
};
