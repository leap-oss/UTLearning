CREATE TABLE "ai_generation_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" varchar(191) NOT NULL,
	"cache_key" varchar(191) NOT NULL,
	"operation" varchar(64) NOT NULL,
	"target_type" varchar(64) NOT NULL,
	"target_id" uuid NOT NULL,
	"status" varchar(32) DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"request_hash" varchar(128) NOT NULL,
	"result_refs_json" jsonb,
	"last_error_code" varchar(128),
	"last_error_message" text,
	"retry_after" timestamp with time zone,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid,
	"course_id" uuid,
	"module_id" uuid,
	"model" varchar(128) NOT NULL,
	"task_type" varchar(64) NOT NULL,
	"status" varchar(32) NOT NULL,
	"http_status" integer,
	"error_code" varchar(128),
	"error_message" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"prompt_tokens" integer,
	"output_tokens" integer,
	"thinking_tokens" integer,
	"tool_use_prompt_tokens" integer,
	"cached_tokens" integer,
	"total_tokens" integer,
	"usage_metadata_json" jsonb,
	"search_grounding_used" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attempt_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"selected_option" varchar(16) NOT NULL,
	"is_correct" boolean NOT NULL,
	"answered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "courses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" varchar(255) NOT NULL,
	"semester_label" varchar(64),
	"expected_module_count" integer DEFAULT 9,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "modules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"module_number" integer NOT NULL,
	"title" varchar(255) NOT NULL,
	"status" varchar(32) DEFAULT 'empty' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"module_id" uuid,
	"course_id" uuid,
	"study_pack_id" uuid,
	"set_type" varchar(64) NOT NULL,
	"parent_attempt_id" uuid,
	"title" varchar(255) NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_set_id" uuid NOT NULL,
	"module_id" uuid,
	"question_order" integer DEFAULT 1 NOT NULL,
	"topic_label" varchar(255) NOT NULL,
	"prompt" text NOT NULL,
	"options_json" jsonb NOT NULL,
	"correct_option" varchar(16) NOT NULL,
	"explanation" text NOT NULL,
	"source_refs_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"difficulty" varchar(32) DEFAULT 'medium' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quiz_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_set_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"score" integer DEFAULT 0 NOT NULL,
	"correct_count" integer DEFAULT 0 NOT NULL,
	"total_count" integer DEFAULT 0 NOT NULL,
	"status" varchar(32) DEFAULT 'submitted' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"module_id" uuid NOT NULL,
	"label" varchar(64) DEFAULT 'materi' NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"mime_type" varchar(128) NOT NULL,
	"file_size" integer NOT NULL,
	"checksum" varchar(128) NOT NULL,
	"page_order" integer DEFAULT 1 NOT NULL,
	"extracted_content_json" jsonb,
	"needs_review" boolean DEFAULT true NOT NULL,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "study_packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"module_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" varchar(255) NOT NULL,
	"summary_json" jsonb NOT NULL,
	"source_refs_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_job_id_ai_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."ai_generation_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."modules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_answers" ADD CONSTRAINT "attempt_answers_attempt_id_quiz_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."quiz_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_answers" ADD CONSTRAINT "attempt_answers_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modules" ADD CONSTRAINT "modules_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_sets" ADD CONSTRAINT "question_sets_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_sets" ADD CONSTRAINT "question_sets_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_sets" ADD CONSTRAINT "question_sets_study_pack_id_study_packs_id_fk" FOREIGN KEY ("study_pack_id") REFERENCES "public"."study_packs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_question_set_id_question_sets_id_fk" FOREIGN KEY ("question_set_id") REFERENCES "public"."question_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."modules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_question_set_id_question_sets_id_fk" FOREIGN KEY ("question_set_id") REFERENCES "public"."question_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_assets" ADD CONSTRAINT "source_assets_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_packs" ADD CONSTRAINT "study_packs_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_jobs_idempotency_key_uq" ON "ai_generation_jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "ai_jobs_cache_key_status_idx" ON "ai_generation_jobs" USING btree ("cache_key","status");--> statement-breakpoint
CREATE INDEX "ai_jobs_target_idx" ON "ai_generation_jobs" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "ai_usage_events_job_id_idx" ON "ai_usage_events" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "ai_usage_events_created_at_idx" ON "ai_usage_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "attempt_answers_attempt_question_uq" ON "attempt_answers" USING btree ("attempt_id","question_id");--> statement-breakpoint
CREATE INDEX "attempt_answers_attempt_id_idx" ON "attempt_answers" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "courses_status_idx" ON "courses" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "modules_course_module_num_uq" ON "modules" USING btree ("course_id","module_number");--> statement-breakpoint
CREATE INDEX "modules_course_id_idx" ON "modules" USING btree ("course_id");--> statement-breakpoint
CREATE INDEX "question_sets_module_id_idx" ON "question_sets" USING btree ("module_id");--> statement-breakpoint
CREATE INDEX "question_sets_course_id_idx" ON "question_sets" USING btree ("course_id");--> statement-breakpoint
CREATE INDEX "questions_question_set_id_idx" ON "questions" USING btree ("question_set_id");--> statement-breakpoint
CREATE INDEX "quiz_attempts_question_set_id_idx" ON "quiz_attempts" USING btree ("question_set_id");--> statement-breakpoint
CREATE INDEX "source_assets_module_id_idx" ON "source_assets" USING btree ("module_id");--> statement-breakpoint
CREATE UNIQUE INDEX "study_packs_module_version_uq" ON "study_packs" USING btree ("module_id","version");--> statement-breakpoint
CREATE INDEX "study_packs_module_id_idx" ON "study_packs" USING btree ("module_id");