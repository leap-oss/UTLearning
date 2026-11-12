export {
  submitAttemptPayloadSchema,
  remedialBatchOutputSchema,
  REMEDIAL_BATCH_JSON_SCHEMA,
  examSimulationQuestionSchema,
  examSimulationOutputSchema,
  EXAM_SIMULATION_JSON_SCHEMA,
} from './quiz/quizSchemas.js';

export {
  WEAK_TOPIC_THRESHOLD,
  MASTERY_SCORE_THRESHOLD,
  normalizeTopicKey,
  resolveCanonicalTopicLabel,
  computeTopicProgressFromAnswers,
  evaluateAndUpdateModuleStatus,
  getModuleProgress,
  getCourseProgress,
} from './quiz/topicMastery.js';

export {
  getQuestionSetWithoutAnswerKey,
  submitQuizAttempt,
  saveQuizDraft,
  getAttemptReviewById,
} from './quiz/quizGradingService.js';

export {
  defaultRemedialGenerator,
  enqueueRemedialGeneration,
  defaultExamSimulationGenerator,
  enqueueCourseExamSimulation,
} from './quiz/remedialAndExamService.js';
