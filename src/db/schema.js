import {
  pgTable,
  uuid,
  varchar,
  integer,
  boolean,
  text,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

export const courses = pgTable(
  'courses',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    code: varchar('code', { length: 32 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    semesterLabel: varchar('semester_label', { length: 64 }),
    expectedModuleCount: integer('expected_module_count').default(9),
    status: varchar('status', { length: 32 }).notNull().default('active'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('courses_status_idx').on(table.status)]
);

export const modules = pgTable(
  'modules',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    moduleNumber: integer('module_number').notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    status: varchar('status', { length: 32 }).notNull().default('empty'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('modules_course_module_num_uq').on(table.courseId, table.moduleNumber),
    index('modules_course_id_idx').on(table.courseId),
  ]
);

export const sourceAssets = pgTable(
  'source_assets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    moduleId: uuid('module_id')
      .notNull()
      .references(() => modules.id, { onDelete: 'cascade' }),
    label: varchar('label', { length: 64 }).notNull().default('materi'),
    fileName: varchar('file_name', { length: 255 }).notNull(),
    mimeType: varchar('mime_type', { length: 128 }).notNull(),
    fileSize: integer('file_size').notNull(),
    checksum: varchar('checksum', { length: 128 }).notNull(),
    pageOrder: integer('page_order').notNull().default(1),
    extractedContentJson: jsonb('extracted_content_json'),
    needsReview: boolean('needs_review').notNull().default(true),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('source_assets_module_id_idx').on(table.moduleId)]
);

export const studyPacks = pgTable(
  'study_packs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    moduleId: uuid('module_id')
      .notNull()
      .references(() => modules.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    summaryJson: jsonb('summary_json').notNull(),
    sourceRefsJson: jsonb('source_refs_json').notNull().default([]),
    schemaVersion: integer('schema_version').notNull().default(1),
    status: varchar('status', { length: 32 }).notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('study_packs_module_version_uq').on(table.moduleId, table.version),
    index('study_packs_module_id_idx').on(table.moduleId),
  ]
);

export const questionSets = pgTable(
  'question_sets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    moduleId: uuid('module_id').references(() => modules.id, { onDelete: 'cascade' }),
    courseId: uuid('course_id').references(() => courses.id, { onDelete: 'cascade' }),
    studyPackId: uuid('study_pack_id').references(() => studyPacks.id, { onDelete: 'set null' }),
    setType: varchar('set_type', { length: 64 }).notNull(),
    parentAttemptId: uuid('parent_attempt_id'),
    title: varchar('title', { length: 255 }).notNull(),
    metadataJson: jsonb('metadata_json').notNull().default({}),
    schemaVersion: integer('schema_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('question_sets_module_id_idx').on(table.moduleId),
    index('question_sets_course_id_idx').on(table.courseId),
  ]
);

export const questions = pgTable(
  'questions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    questionSetId: uuid('question_set_id')
      .notNull()
      .references(() => questionSets.id, { onDelete: 'cascade' }),
    moduleId: uuid('module_id').references(() => modules.id, { onDelete: 'set null' }),
    questionOrder: integer('question_order').notNull().default(1),
    topicLabel: varchar('topic_label', { length: 255 }).notNull(),
    prompt: text('prompt').notNull(),
    optionsJson: jsonb('options_json').notNull(),
    correctOption: varchar('correct_option', { length: 16 }).notNull(),
    explanation: text('explanation').notNull(),
    sourceRefsJson: jsonb('source_refs_json').notNull().default([]),
    difficulty: varchar('difficulty', { length: 32 }).notNull().default('medium'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('questions_question_set_id_idx').on(table.questionSetId)]
);

export const quizAttempts = pgTable(
  'quiz_attempts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    questionSetId: uuid('question_set_id')
      .notNull()
      .references(() => questionSets.id, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    score: integer('score').notNull().default(0),
    correctCount: integer('correct_count').notNull().default(0),
    totalCount: integer('total_count').notNull().default(0),
    status: varchar('status', { length: 32 }).notNull().default('submitted'),
  },
  (table) => [index('quiz_attempts_question_set_id_idx').on(table.questionSetId)]
);

export const attemptAnswers = pgTable(
  'attempt_answers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    attemptId: uuid('attempt_id')
      .notNull()
      .references(() => quizAttempts.id, { onDelete: 'cascade' }),
    questionId: uuid('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'cascade' }),
    selectedOption: varchar('selected_option', { length: 16 }).notNull(),
    isCorrect: boolean('is_correct').notNull(),
    answeredAt: timestamp('answered_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('attempt_answers_attempt_question_uq').on(table.attemptId, table.questionId),
    index('attempt_answers_attempt_id_idx').on(table.attemptId),
  ]
);

export const aiGenerationJobs = pgTable(
  'ai_generation_jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    idempotencyKey: varchar('idempotency_key', { length: 191 }).notNull(),
    cacheKey: varchar('cache_key', { length: 191 }).notNull(),
    operation: varchar('operation', { length: 64 }).notNull(),
    targetType: varchar('target_type', { length: 64 }).notNull(),
    targetId: uuid('target_id').notNull(),
    status: varchar('status', { length: 32 }).notNull().default('queued'),
    attemptCount: integer('attempt_count').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    requestHash: varchar('request_hash', { length: 128 }).notNull(),
    resultRefsJson: jsonb('result_refs_json'),
    lastErrorCode: varchar('last_error_code', { length: 128 }),
    lastErrorMessage: text('last_error_message'),
    retryAfter: timestamp('retry_after', { withTimezone: true }),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('ai_jobs_idempotency_key_uq').on(table.idempotencyKey),
    index('ai_jobs_cache_key_status_idx').on(table.cacheKey, table.status),
    index('ai_jobs_target_idx').on(table.targetType, table.targetId),
  ]
);

export const aiUsageEvents = pgTable(
  'ai_usage_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    jobId: uuid('job_id').references(() => aiGenerationJobs.id, { onDelete: 'set null' }),
    courseId: uuid('course_id').references(() => courses.id, { onDelete: 'set null' }),
    moduleId: uuid('module_id').references(() => modules.id, { onDelete: 'set null' }),
    model: varchar('model', { length: 128 }).notNull(),
    taskType: varchar('task_type', { length: 64 }).notNull(),
    status: varchar('status', { length: 32 }).notNull(),
    httpStatus: integer('http_status'),
    errorCode: varchar('error_code', { length: 128 }),
    errorMessage: text('error_message'),
    retryCount: integer('retry_count').notNull().default(0),
    durationMs: integer('duration_ms').notNull().default(0),
    promptTokens: integer('prompt_tokens'),
    outputTokens: integer('output_tokens'),
    thinkingTokens: integer('thinking_tokens'),
    toolUsePromptTokens: integer('tool_use_prompt_tokens'),
    cachedTokens: integer('cached_tokens'),
    totalTokens: integer('total_tokens'),
    usageMetadataJson: jsonb('usage_metadata_json'),
    searchGroundingUsed: boolean('search_grounding_used').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('ai_usage_events_job_id_idx').on(table.jobId),
    index('ai_usage_events_created_at_idx').on(table.createdAt),
  ]
);
