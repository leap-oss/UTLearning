window.AppModules = window.AppModules || {};

window.AppModules.quizAndRemedial = {
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

      this.activeAttemptReview = data.attempt;
      this.currentView = 'attempt_review';
      this.showNotice(`Kuis selesai dinilai di server! Skor Anda: ${data.attempt.score}%`);
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
