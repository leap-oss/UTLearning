window.AppModules = window.AppModules || {};

window.AppModules.studyPackAndReader = {
  get activeStudyPack() {
    const packs = this.activeModule?.studyPacks || [];
    if (packs.length === 0) return null;
    if (this.selectedStudyPackVersion != null) {
      const found = packs.find((p) => Number(p.version) === Number(this.selectedStudyPackVersion));
      if (found) return found;
    }
    return packs[0];
  },

  get visibleModuleQuestionSets() {
    const allSets = this.activeModule?.questionSets || [];
    if (allSets.length === 0) return [];
    const activePackId = this.activeStudyPack?.id || this.activeModule?.studyPacks?.[0]?.id || null;
    const latestInitial = allSets.find((qs) => qs.setType === 'initial');
    return allSets.filter((qs) => {
      if (qs.setType === 'initial') {
        if (activePackId && qs.studyPackId) {
          return qs.studyPackId === activePackId;
        }
        if (latestInitial) {
          return qs.id === latestInitial.id;
        }
      }
      return true;
    });
  },

  get detectedModuleKbCount() {
    const packKbs =
      this.activeStudyPack?.summaryJson?.coverageReport?.totalKbsDetected ||
      this.activeStudyPack?.summaryJson?.topics?.length;
    if (packKbs && packKbs >= 1) return packKbs;

    const sources = this.activeModule?.sources || [];
    if (sources.length === 0) return 1;
    const kbNums = new Set();
    for (const s of sources) {
      const text = `${s.extractedContentJson?.extractedText || ''} ${s.extractedContentJson?.pageTitle || ''}`;
      const kbMatch = text.match(/(?:kegiatan\s*belajar|kb|tes\s*formatif|formatif)\s*([0-9]+)/i);
      if (kbMatch) kbNums.add(Number.parseInt(kbMatch[1], 10));
    }
    if (kbNums.size >= 1) return kbNums.size;
    const formatifCount = sources.filter((s) => s.label === 'tes_formatif').length;
    return Math.max(1, formatifCount);
  },

  get moduleFixedQuestionCount() {
    const kbCount = this.detectedModuleKbCount;
    if (kbCount >= 3) return 25;
    if (kbCount === 2) return 20;
    return 10;
  },

  get moduleKbCountLabel() {
    const kbCount = Math.min(3, Math.max(1, this.detectedModuleKbCount));
    return `${kbCount} KB`;
  },

  async generateStudyPackAndQuiz(regenerate = false) {
    if (!this.activeModule) return;
    const targetModuleId = this.activeModule.id;
    this.clearBanners();

    const jobLabel = regenerate
      ? 'Menyusun ulang Study Pack & Kuis Awal...'
      : 'Menyusun Study Pack (Rangkuman BMP, Istilah, Penjelasan AI) & Kuis Awal...';
    this.startAiJobFeedback(jobLabel, 'Menyusun rangkuman per KB & paket kuis…');

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
          regenerate,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || 'Gagal memulai pembuatan Study Pack.');
      }

      await this.pollAiJobUntilDone(
        data.jobId,
        jobLabel,
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
      this.clearPendingAiJobFeedback();
      this.showError(err instanceof Error ? err.message : 'Gagal membuat Study Pack.');
    }
  },

  async generateExtraPracticeSet() {
    if (!this.activeModule) return;
    const targetModuleId = this.activeModule.id;
    this.clearBanners();

    const jobLabel = `Membuat ${this.moduleFixedQuestionCount} soal latihan adaptif (${this.moduleKbCountLabel})...`;
    this.startAiJobFeedback(jobLabel, 'Menyusun soal latihan dari Study Pack…');

    const idemKey = this.generateIdempotencyKey('practice');
    try {
      const res = await fetch(`/api/modules/${targetModuleId}/question-sets`, {
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
        throw new Error(data.message || 'Gagal membuat set latihan tambahan.');
      }

      await this.pollAiJobUntilDone(
        data.jobId,
        jobLabel,
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
      this.clearPendingAiJobFeedback();
      this.showError(err instanceof Error ? err.message : 'Gagal membuat soal tambahan.');
    }
  },

  refreshActiveTopic() {
    const sections = Array.from(
      document.querySelectorAll('.reader section.topic, .reader section#formulas-procedures, .reader section#glossary')
    );
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
      const sections = Array.from(
        document.querySelectorAll('.reader section.topic, .reader section#formulas-procedures, .reader section#glossary')
      );
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
};
