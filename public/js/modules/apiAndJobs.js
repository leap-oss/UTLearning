window.AppModules = window.AppModules || {};

window.AppModules.apiAndJobs = {
  async fetchJson(url, options = {}, retryCount = 1) {
    const method = (options.method || 'GET').toUpperCase();
    const fetchOpts = { cache: 'no-store', ...options };
    for (let attempt = 0; attempt <= retryCount; attempt += 1) {
      try {
        const res = await fetch(url, fetchOpts);
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

  startAiJobFeedback(label, status = 'Sedang diproses di server…', maxAttempts = 3) {
    this.activeAiJob = {
      jobId: 'pending',
      label,
      status,
      attemptCount: 1,
      maxAttempts,
    };
  },

  clearPendingAiJobFeedback() {
    if (this.activeAiJob && this.activeAiJob.jobId === 'pending') {
      this.activeAiJob = null;
    }
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

  async pollAiJobUntilDone(jobId, label, onSuccess, onProgress = null) {
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }

    const sessionId = (this._pollSessionId || 0) + 1;
    this._pollSessionId = sessionId;
    let consecutiveErrors = 0;

    this.activeAiJob = {
      jobId,
      label,
      status: this.activeAiJob?.status || 'Menunggu antrian…',
      attemptCount: this.activeAiJob?.attemptCount || 1,
      maxAttempts: 3,
    };

    const pollOnce = async () => {
      if (this._pollSessionId !== sessionId) return;

      try {
        const res = await fetch(`/api/ai/jobs/${jobId}`, {
          headers: { Accept: 'application/json' },
        });
        if (this._pollSessionId !== sessionId) return;

        if (!res.ok) {
          throw new Error(`Gagal memeriksa status job (${res.status})`);
        }
        consecutiveErrors = 0;
        const job = await res.json();
        if (this._pollSessionId !== sessionId) return;

        const statusLabel = {
          queued: 'Menunggu antrian…',
          running: 'Sedang diproses…',
          processing: 'Sedang diproses…',
          retrying: 'Mencoba ulang…',
        }[job.status] || job.status;
        this.activeAiJob = {
          ...this.activeAiJob,
          status: statusLabel,
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

        if (onProgress) {
          try { await onProgress(); } catch (_) { /* silent */ }
        }
        if (this._pollSessionId === sessionId) {
          this.pollingTimer = setTimeout(pollOnce, 1200);
        }
      } catch (err) {
        if (this._pollSessionId !== sessionId) return;
        consecutiveErrors += 1;
        if (consecutiveErrors <= 3) {
          this.pollingTimer = setTimeout(pollOnce, 1500);
          return;
        }
        this.activeAiJob = null;
        this.showError(err instanceof Error ? err.message : 'Gagal memantau status job AI.');
      }
    };

    await pollOnce();
  },

  get isBusy() {
    return Boolean(
      this.loadingCourses ||
        this.loadingCourseDetail ||
        this.loadingModuleDetail ||
        this.submittingQuiz ||
        this.isAutoMappingToc ||
        this.savingCourse ||
        this.savingModule ||
        this.savingSourceEdit ||
        this.activeAiJob
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
};
