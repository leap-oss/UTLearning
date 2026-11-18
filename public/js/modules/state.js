window.AppModules = window.AppModules || {};

window.AppModules.state = {
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
  stagedFiles: [], // { id, file, previewUrl, pageOrder }
  isSourceDragOver: false,
  isTocDragOver: false,
  editingSourceId: null,
  sourceEditForm: {
    label: 'materi',
    pageOrder: 1,
    pageTitle: '',
    extractedText: '',
    formulasText: '',
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
  quizCurrentPage: 0,
  quizPageSize: 10,
  quizSelections: {}, // { [questionId]: 'A' | 'B' | 'C' | 'D' }
  submittingQuiz: false,
  activeAttemptReview: null,

  // Exam Simulation form
  examSimForm: {
    selectedModuleIds: [],
    questionCount: 40,
    difficulty: 'mixed',
  },

  // Feedback banners
  noticeMessage: null,
  errorMessage: null,
  liveAnnouncement: '',

  // Daily focus, readiness, UAS target & retention state
  dailyFocus: null,
  loadingDailyFocus: false,
  uasExamDate: '',
  soundEnabled: true,

  // Flashcard active recall state
  flashcardSession: {
    active: false,
    cards: [],
    index: 0,
    revealed: false,
    rememberedCount: 0,
    totalUnique: 0,
  },

  // Instant-check & celebratory review state
  instantCheckMode: false,
  questionChecks: {},
  sessionCorrectStreak: 0,
  bestSessionStreak: 0,
  reviewDisplayScore: 0,
  celebrationParticles: [],
  celebrationActive: false,

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
    try {
      const savedExamDate = window.localStorage?.getItem('ut-uas-exam-date') || '';
      if (/^\d{4}-\d{2}-\d{2}$/.test(savedExamDate)) {
        this.uasExamDate = savedExamDate;
      }
      const savedSound = window.localStorage?.getItem('ut-sound-enabled');
      if (savedSound === 'false') {
        this.soundEnabled = false;
      }
    } catch {
      // Ignore storage failures
    }

    this.$watch('currentView', (view) => {
      this.focusViewTitle();
      if (view !== 'module' && this.flashcardSession?.active) {
        this.flashcardSession.active = false;
      }
      if (view === 'module' && this.moduleTab === 'study') {
        this.$nextTick(() => {
          this.setupTopicScrollSpy();
          this.refreshActiveTopic();
        });
      }
    });
    this.$watch('moduleTab', (tab) => {
      if (tab !== 'study' && this.flashcardSession?.active) {
        this.flashcardSession.active = false;
      }
      if (tab === 'study') {
        this.$nextTick(() => {
          this.setupTopicScrollSpy();
          this.refreshActiveTopic();
        });
      }
    });
    this.$watch('selectedStudyPackVersion', () => {
      if (this.flashcardSession?.active) {
        this.flashcardSession.active = false;
      }
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
    this.setupScrollTopObserver?.();
    if (!this._pasteListenerAttached) {
      this._pasteListenerAttached = true;
      window.addEventListener('paste', (event) => this.handleGlobalImagePaste(event));
    }
    await Promise.all([this.loadCourses(), this.loadDailyFocus?.()]);
    this.refreshSystemStatus(this.currentView === 'system');
  },
};
