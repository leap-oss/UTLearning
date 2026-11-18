window.AppModules = window.AppModules || {};

window.AppModules.quizAndRemedial = {
  prefersReducedMotion() {
    return (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  },

  playFeedbackChime(kind = 'correct') {
    if (!this.soundEnabled || typeof window === 'undefined') return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    try {
      if (!this._audioCtx || this._audioCtx.state === 'closed') {
        this._audioCtx = new AudioCtx();
      }
      const ctx = this._audioCtx;
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }

      const now = ctx.currentTime;
      const notes =
        kind === 'mastered'
          ? [
              { freq: 523.25, start: 0, dur: 0.14, gain: 0.035 },
              { freq: 659.25, start: 0.09, dur: 0.16, gain: 0.035 },
              { freq: 783.99, start: 0.18, dur: 0.26, gain: 0.04 },
            ]
          : kind === 'wrong'
            ? [{ freq: 246.94, start: 0, dur: 0.14, gain: 0.025 }]
            : [
                { freq: 523.25, start: 0, dur: 0.11, gain: 0.03 },
                { freq: 659.25, start: 0.07, dur: 0.15, gain: 0.03 },
              ];

      for (const n of notes) {
        const osc = ctx.createOscillator();
        const amp = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(n.freq, now + n.start);
        amp.gain.setValueAtTime(0.0001, now + n.start);
        amp.gain.exponentialRampToValueAtTime(n.gain, now + n.start + 0.015);
        amp.gain.exponentialRampToValueAtTime(0.0001, now + n.start + n.dur);
        osc.connect(amp);
        amp.connect(ctx.destination);
        osc.start(now + n.start);
        osc.stop(now + n.start + n.dur + 0.02);
      }
    } catch {
      // Ignore blocked AudioContext
    }
  },

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
      this.quizCurrentPage = 0;
      this.questionChecks = {};
      this.sessionCorrectStreak = 0;
      this.bestSessionStreak = 0;
      this.celebrationActive = false;
      this.celebrationParticles = [];
      if (data.questionSet?.setType === 'exam_simulation') {
        this.instantCheckMode = false;
      } else if (data.questionSet?.setType === 'warmup') {
        this.instantCheckMode = true;
      }

      const meta = data.questionSet?.metadata || data.questionSet?.metadataJson || {};
      const hasDiagnostics = Boolean(meta.diagnosticFeedback?.topicDiagnostics?.length > 0);
      if (data.questionSet?.setType === 'remedial' && hasDiagnostics) {
        this.remedialRunnerStep = 'study';
      } else {
        this.remedialRunnerStep = 'quiz';
      }

      const inProgressDraft = (data.questionSet.attempts || []).find((a) => a.status === 'in_progress');
      if (inProgressDraft && inProgressDraft.answersJson) {
        this.quizSelections = { ...inProgressDraft.answersJson };
        const allQs = data.questionSet?.questions || [];
        const firstUnansweredIdx = allQs.findIndex((q) => !this.quizSelections[q.id]);
        if (firstUnansweredIdx >= 0) {
          this.quizCurrentPage = Math.floor(firstUnansweredIdx / this.quizPageSize);
        } else if (allQs.length > 0) {
          this.quizCurrentPage = Math.max(0, Math.ceil(allQs.length / this.quizPageSize) - 1);
        }
        this.showNotice('Melanjutkan sesi pengerjaan kuis yang tersimpan.');
      }

      this.activeAttemptReview = null;
      this.currentView = 'quiz_runner';
    } catch (err) {
      this.showError(err instanceof Error ? err.message : 'Gagal membuka kuis.');
    }
  },

  async startWarmupQuiz(moduleId) {
    if (!moduleId) return;
    this.clearBanners();
    try {
      const { ok, status, data } = await this.fetchJson(`/api/modules/${moduleId}/warmup-quiz`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ maxQuestions: 5 }),
      });
      if (!ok || !data?.questionSet) {
        throw new Error(this.extractApiErrorMessage(data, status, 'Gagal menyusun kuis pemanasan.'));
      }
      this.activeQuestionSet = data.questionSet;
      this.quizSelections = {};
      this.quizCurrentPage = 0;
      this.questionChecks = {};
      this.sessionCorrectStreak = 0;
      this.bestSessionStreak = 0;
      this.instantCheckMode = true;
      this.remedialRunnerStep = 'quiz';
      this.activeAttemptReview = null;
      this.currentView = 'quiz_runner';
      this.showNotice('Kuis Pemanasan Kilat (5 soal · 0 kuota AI) siap dikerjakan.');
    } catch (err) {
      this.showError(err instanceof Error ? err.message : 'Gagal membuka kuis pemanasan.');
    }
  },

  toggleInstantCheckMode() {
    if (this.activeQuestionSet?.setType === 'exam_simulation') {
      this.instantCheckMode = false;
      this.showError('Cek langsung dinonaktifkan pada Simulasi UAS agar sesuai kondisi ujian.');
      return;
    }
    this.instantCheckMode = !this.instantCheckMode;
    this.announcePolite?.(
      this.instantCheckMode
        ? 'Mode cek langsung per soal diaktifkan.'
        : 'Mode cek langsung per soal dimatikan.'
    );
  },

  onQuizOptionChanged(questionId) {
    if (this.questionChecks && this.questionChecks[questionId] && !this.questionChecks[questionId].checking) {
      delete this.questionChecks[questionId];
    }
    this.saveDraftProgress();
  },

  async checkSingleQuestion(questionId) {
    if (!this.activeQuestionSet?.id || !questionId) return;
    if (this.activeQuestionSet.setType === 'exam_simulation') return;

    const selectedOption = this.quizSelections?.[questionId];
    if (!selectedOption) {
      this.showError('Pilih salah satu opsi jawaban terlebih dahulu sebelum memeriksa soal ini.');
      return;
    }

    this.questionChecks = {
      ...this.questionChecks,
      [questionId]: { checking: true },
    };

    try {
      const { ok, status, data } = await this.fetchJson(
        `/api/question-sets/${this.activeQuestionSet.id}/check-question`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ questionId, selectedOption }),
        }
      );
      if (!ok || !data?.check) {
        throw new Error(this.extractApiErrorMessage(data, status, 'Gagal memeriksa soal.'));
      }

      const check = data.check;
      this.questionChecks = {
        ...this.questionChecks,
        [questionId]: { checking: false, ...check },
      };

      if (check.isCorrect) {
        this.sessionCorrectStreak += 1;
        if (this.sessionCorrectStreak > this.bestSessionStreak) {
          this.bestSessionStreak = this.sessionCorrectStreak;
        }
        this.playFeedbackChime('correct');
        this.announcePolite?.(
          `Jawaban ${check.correctOption} benar. Rangkaian benar: ${this.sessionCorrectStreak}.`
        );
      } else {
        this.sessionCorrectStreak = 0;
        this.playFeedbackChime('wrong');
        this.announcePolite?.(
          `Jawaban belum tepat. Kunci benar adalah ${check.correctOption}.`
        );
      }
      this.saveDraftProgress();
    } catch (err) {
      const nextChecks = { ...this.questionChecks };
      delete nextChecks[questionId];
      this.questionChecks = nextChecks;
      this.showError(err instanceof Error ? err.message : 'Gagal memeriksa jawaban soal.');
    }
  },

  get quizTotalPages() {
    const total = this.activeQuestionSet?.questions?.length || 0;
    return Math.max(1, Math.ceil(total / this.quizPageSize));
  },

  get quizPageStartIndex() {
    return this.quizCurrentPage * this.quizPageSize;
  },

  get quizPageEndIndex() {
    const total = this.activeQuestionSet?.questions?.length || 0;
    return Math.min(total, (this.quizCurrentPage + 1) * this.quizPageSize);
  },

  get currentQuizPageQuestions() {
    const allQs = this.activeQuestionSet?.questions || [];
    return allQs.slice(this.quizPageStartIndex, this.quizPageEndIndex);
  },

  get currentQuizPageAnsweredCount() {
    return this.currentQuizPageQuestions.filter((q) => Boolean(this.quizSelections[q.id])).length;
  },

  get isCurrentQuizPageComplete() {
    const pageQs = this.currentQuizPageQuestions;
    return pageQs.length > 0 && this.currentQuizPageAnsweredCount === pageQs.length;
  },

  nextQuizPage() {
    const pageQs = this.currentQuizPageQuestions;
    const firstUnanswered = pageQs.find((q) => !this.quizSelections[q.id]);
    if (firstUnanswered) {
      const remaining = pageQs.length - this.currentQuizPageAnsweredCount;
      this.showError(`Jawab ${remaining} soal yang tersisa di tahap ini terlebih dahulu sebelum lanjut.`);
      const card = document.getElementById(`question-card-${firstUnanswered.id}`);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }
    this.clearBanners();
    if (this.quizCurrentPage < this.quizTotalPages - 1) {
      this.quizCurrentPage += 1;
      this.$nextTick(() => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }
  },

  prevQuizPage() {
    this.clearBanners();
    if (this.quizCurrentPage > 0) {
      this.quizCurrentPage -= 1;
      this.$nextTick(() => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
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

  get answeredPct() {
    const total = this.activeQuestionSet?.questions?.length || 0;
    return total > 0 ? Math.round((this.answeredCount / total) * 100) : 0;
  },

  optionText(questionObj, optionKey) {
    if (!questionObj || !optionKey) return '-';
    const found = (questionObj.options || []).find((o) => o.key === optionKey);
    return found ? found.text : optionKey;
  },

  get attemptOutcomeFeedback() {
    const rev = this.activeAttemptReview;
    if (!rev) return null;
    const score = Number(rev.score) || 0;

    if (rev.newlyMastered) {
      return {
        tone: 'ok',
        badge: 'Baru Dikuasai',
        headline: 'Penguasaan modul berhasil dikunci',
        body: `Anda menembus ambang batas 80% dengan skor ${score}%. Modul ini sekarang berstatus Dikuasai — tinggal jaga ritme pemanasan berkala menjelang UAS.`,
      };
    }
    if (score === 100) {
      return {
        tone: 'ok',
        badge: 'Sempurna · 100%',
        headline: 'Seluruh konsep terjawab tepat',
        body: 'Pemahaman Anda pada seluruh butir soal di sesi ini sangat solid dan akurat.',
      };
    }
    if (score >= 80) {
      return {
        tone: 'ok',
        badge: 'Tuntas >= 80%',
        headline: 'Target penguasaan modul tercapai',
        body: 'Pertahankan konsistensi ini dan periksa kembali butir yang masih ragu bila ada di bawah.',
      };
    }
    if (score >= 60) {
      const gap = Math.max(1, 80 - score);
      return {
        tone: 'review',
        badge: 'Hampir Tuntas',
        headline: `Kurang ${gap} poin lagi menuju ambang 80%`,
        body: 'Fondasi Anda sudah terbentuk. Fokuskan 1 sesi remedial pada topik berakurasi < 75% agar penguasaan modul cepat terkunci.',
      };
    }
    return {
      tone: 'bad',
      badge: 'Perlu Ulas Ulang',
      headline: 'Jangan terburu-buru — perkuat dari akar konsep',
      body: 'Gunakan pembahasan & analisis miskonsepsi di bawah, lalu baca kembali topik yang merah di Study Pack sebelum mengulang kuis.',
    };
  },

  triggerCelebrationBurst() {
    if (this.prefersReducedMotion()) {
      this.celebrationActive = false;
      this.celebrationParticles = [];
      return;
    }
    const tones = ['accent', 'ok', 'chalk', 'review'];
    const particles = [];
    const count = 16;
    for (let i = 0; i < count; i += 1) {
      const angle = ((Math.PI * 2) / count) * i + (i % 2 === 0 ? 0.14 : -0.14);
      const dist = 56 + (i % 3) * 28;
      particles.push({
        id: `p-${i}`,
        tx: `${Math.round(Math.cos(angle) * dist)}px`,
        ty: `${Math.round(Math.sin(angle) * dist - 14)}px`,
        rot: `${(i % 2 === 0 ? 1 : -1) * (65 + i * 14)}deg`,
        delay: `${(i % 4) * 35}ms`,
        tone: tones[i % tones.length],
      });
    }
    this.celebrationParticles = particles;
    this.celebrationActive = true;
    clearTimeout(this._celebrationTimer);
    this._celebrationTimer = setTimeout(() => {
      this.celebrationActive = false;
    }, 1500);
  },

  animateAttemptReviewEntrance(attempt) {
    const targetScore = Math.max(0, Math.min(100, Number(attempt?.score) || 0));
    this.celebrationActive = false;
    this.celebrationParticles = [];

    if (this.prefersReducedMotion() || typeof window === 'undefined' || !window.requestAnimationFrame) {
      this.reviewDisplayScore = targetScore;
    } else {
      this.reviewDisplayScore = 0;
      const durationMs = 560;
      const startTime = performance.now();
      const step = (now) => {
        const progress = Math.min(1, (now - startTime) / durationMs);
        const eased = 1 - Math.pow(1 - progress, 3);
        this.reviewDisplayScore = Math.round(eased * targetScore);
        if (progress < 1) {
          window.requestAnimationFrame(step);
        } else {
          this.reviewDisplayScore = targetScore;
        }
      };
      window.requestAnimationFrame(step);
    }

    if (attempt?.newlyMastered || targetScore >= 80) {
      this.playFeedbackChime('mastered');
      if (attempt?.newlyMastered || targetScore >= 90) {
        this.triggerCelebrationBurst();
      }
    }

    const fb = this.attemptOutcomeFeedback;
    if (fb) {
      this.announcePolite?.(`Hasil kuis: ${targetScore}%. ${fb.headline}.`);
    }
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
    this.startAiJobFeedback(
      `Menilai jawaban kuis (${totalQ} soal) & memperbarui penguasaan topik...`,
      'Sedang memeriksa jawaban di server…',
      1
    );

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

      this.activeQuestionSet = null;
      this.activeAttemptReview = data.attempt;
      this.currentView = 'attempt_review';
      this.animateAttemptReviewEntrance(data.attempt);
      this.loadDailyFocus?.();
      this.showNotice(
        data.attempt?.newlyMastered
          ? `Selamat! Modul ini baru saja Dikuasai dengan skor ${data.attempt.score}%!`
          : `Kuis selesai dinilai! Skor Anda: ${data.attempt.score}%`
      );
    } catch (err) {
      this.showError(err instanceof Error ? err.message : 'Gagal menilai kuis.');
    } finally {
      this.submittingQuiz = false;
      this.clearPendingAiJobFeedback();
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
      this.activeQuestionSet = null;
      this.activeAttemptReview = data.attempt;
      this.celebrationActive = false;
      this.celebrationParticles = [];
      this.reviewDisplayScore = Number(data.attempt?.score) || 0;
      this.currentView = 'attempt_review';
    } catch (err) {
      this.showError(err instanceof Error ? err.message : 'Gagal membuka pembahasan.');
    }
  },

  async generateRemedialFromAttempt(attemptId, questionCount = 5) {
    this.clearBanners();
    const qCount = Number(questionCount) || 5;
    const jobLabel = `Menganalisis pola kesalahan konsep & menyusun ${qCount} soal remedial terfokus...`;
    this.startAiJobFeedback(jobLabel, 'Mendiagnosis titik kecohan & menyusun soal…');

    const idemKey = this.generateIdempotencyKey('remedial');
    try {
      const res = await fetch(`/api/attempts/${attemptId}/remedial`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idemKey,
          Accept: 'application/json',
        },
        body: JSON.stringify({ questionCount: qCount }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || 'Gagal memulai pembuatan remedial.');
      }

      await this.pollAiJobUntilDone(
        data.jobId,
        jobLabel,
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
      this.clearPendingAiJobFeedback();
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

    const qCount = Number(this.examSimForm.questionCount) || 40;
    const modCount = this.examSimForm.selectedModuleIds.length;
    const jobLabel = `Menyusun ${qCount} soal Simulasi UAS komprehensif lintas ${modCount} modul...`;
    this.startAiJobFeedback(jobLabel, 'Menyusun paket soal ujian akhir…');

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
          questionCount: qCount,
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
        jobLabel,
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
      this.clearPendingAiJobFeedback();
      this.showError(err instanceof Error ? err.message : 'Gagal membuat Simulasi UAS.');
    }
  },
};
