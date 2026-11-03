import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { z } from 'zod';
import { getEnvConfig } from '../config/env.js';
import {
  enqueueSourceExtraction,
  updateSourceAsset,
  deleteSourceAsset,
  safeCleanupTempFiles,
} from '../services/extractionService.js';
import {
  enqueueStudyPackSynthesis,
  enqueueAdditionalQuestionSet,
} from '../services/studyPackService.js';
import {
  getQuestionSetWithoutAnswerKey,
  submitQuizAttempt,
  getAttemptReviewById,
  enqueueRemedialGeneration,
  enqueueCourseExamSimulation,
  getModuleProgress,
  getCourseProgress,
} from '../services/quizAndRemedialService.js';

const uploadTmpDir = path.join(os.tmpdir(), 'ut-learning-uploads');

const uuidSchema = z.string().uuid('Format ID tidak valid.');

function formatZodError(zodErr) {
  const issues = zodErr.issues || [];
  return issues.map((i) => i.message).join(' ') || 'Input tidak valid.';
}

function getIdempotencyKey(req) {
  const headerKey = req.get('Idempotency-Key') || req.get('X-Idempotency-Key');
  const bodyKey = req.body?.idempotencyKey;
  return String(headerKey || bodyKey || '').trim();
}

export function createLearningRouter({
  aiQueue,
  extractorFn,
  synthesizerFn,
  practiceGeneratorFn,
  remedialGeneratorFn,
  examSimulationGeneratorFn,
} = {}) {
  const router = express.Router();
  const config = getEnvConfig();

  const upload = multer({
    dest: uploadTmpDir,
    limits: {
      files: config.aiMaxImagesPerBatch,
      fileSize: config.aiMaxImageBytes,
    },
  });

  const handleMultipartUpload = (req, res, next) => {
    try {
      fs.mkdirSync(uploadTmpDir, { recursive: true });
    } catch {
      // Ignore if already exists
    }
    const middleware = upload.array('images', config.aiMaxImagesPerBatch);
    middleware(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        let message = `Kesalahan unggah file: ${err.message}`;
        if (err.code === 'LIMIT_FILE_SIZE') {
          message = `Ukuran salah satu gambar melebihi batas maksimal (${Math.round(config.aiMaxImageBytes / 1_000_000)} MB).`;
        } else if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
          message = `Jumlah gambar melebihi batas maksimal ${config.aiMaxImagesPerBatch} file per batch.`;
        }
        return res.status(400).json({
          error: err.code,
          message,
        });
      }
      return res.status(400).json({
        error: 'UPLOAD_ERROR',
        message: err.message || 'Gagal memproses file unggahan.',
      });
    });
  };

  // POST /api/modules/:moduleId/sources/extract
  router.post('/modules/:moduleId/sources/extract', handleMultipartUpload, async (req, res) => {
    const parsedId = uuidSchema.safeParse(req.params.moduleId);
    if (!parsedId.success) {
      await safeCleanupTempFiles(req.files || []);
      return res.status(400).json({
        error: 'INVALID_MODULE_ID',
        message: 'Format moduleId tidak valid.',
      });
    }

    const idempotencyKey = getIdempotencyKey(req);
    if (!idempotencyKey) {
      await safeCleanupTempFiles(req.files || []);
      return res.status(400).json({
        error: 'MISSING_IDEMPOTENCY_KEY',
        message: 'Header Idempotency-Key atau field idempotencyKey wajib disertakan.',
      });
    }

    try {
      const result = await enqueueSourceExtraction({
        moduleId: parsedId.data,
        files: req.files || [],
        metadata: {
          labels: req.body?.labels,
          pageOrders: req.body?.pageOrders,
        },
        idempotencyKey,
        regenerate: req.body?.regenerate === 'true' || req.body?.regenerate === true,
        overrideBudget: req.body?.overrideBudget === 'true' || req.body?.overrideBudget === true,
        aiQueue,
        ...(extractorFn ? { extractorFn } : {}),
      });

      return res.status(202).json({
        jobId: result.job.id,
        status: result.job.status,
        deduplicated: result.deduplicated,
        reusedCache: result.reusedCache,
        sourceIds: result.sourceIds,
        resultRefs: result.job.resultRefsJson || null,
      });
    } catch (err) {
      await safeCleanupTempFiles(req.files || []);
      if (err?.statusCode) {
        return res.status(err.statusCode).json({
          error: err.errorCode || 'EXTRACTION_ERROR',
          message: err.message,
          details: err.details || undefined,
        });
      }
      return res.status(500).json({
        error: 'SERVER_ERROR',
        message: err.message || 'Gagal mengantrekan ekstraksi sumber.',
      });
    }
  });

  // PATCH /api/sources/:sourceId
  router.patch('/sources/:sourceId', async (req, res) => {
    const parsedId = uuidSchema.safeParse(req.params.sourceId);
    if (!parsedId.success) {
      return res.status(400).json({
        error: 'INVALID_SOURCE_ID',
        message: 'Format sourceId tidak valid.',
      });
    }

    try {
      const updated = await updateSourceAsset(parsedId.data, req.body || {});
      if (!updated) {
        return res.status(404).json({
          error: 'SOURCE_NOT_FOUND',
          message: 'Sumber tidak ditemukan.',
        });
      }
      return res.status(200).json({ source: updated });
    } catch (err) {
      if (err?.name === 'ZodError') {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: formatZodError(err),
        });
      }
      return res.status(500).json({
        error: 'DB_ERROR',
        message: 'Gagal menyimpan perubahan ekstraksi sumber.',
      });
    }
  });

  // DELETE /api/sources/:sourceId
  router.delete('/sources/:sourceId', async (req, res) => {
    const parsedId = uuidSchema.safeParse(req.params.sourceId);
    if (!parsedId.success) {
      return res.status(400).json({
        error: 'INVALID_SOURCE_ID',
        message: 'Format sourceId tidak valid.',
      });
    }

    try {
      const deleted = await deleteSourceAsset(parsedId.data);
      if (!deleted) {
        return res.status(404).json({
          error: 'SOURCE_NOT_FOUND',
          message: 'Sumber tidak ditemukan.',
        });
      }
      return res.status(200).json({
        deletedId: deleted.id,
        message: 'Sumber berhasil dihapus.',
      });
    } catch (err) {
      return res.status(500).json({
        error: 'DB_ERROR',
        message: 'Gagal menghapus sumber.',
      });
    }
  });

  // POST /api/modules/:moduleId/study-packs
  router.post('/modules/:moduleId/study-packs', async (req, res) => {
    const parsedId = uuidSchema.safeParse(req.params.moduleId);
    if (!parsedId.success) {
      return res.status(400).json({
        error: 'INVALID_MODULE_ID',
        message: 'Format moduleId tidak valid.',
      });
    }

    const idempotencyKey = getIdempotencyKey(req);
    if (!idempotencyKey) {
      return res.status(400).json({
        error: 'MISSING_IDEMPOTENCY_KEY',
        message: 'Idempotency-Key wajib disertakan.',
      });
    }

    try {
      const result = await enqueueStudyPackSynthesis({
        moduleId: parsedId.data,
        idempotencyKey,
        questionCount: req.body?.questionCount,
        regenerate: Boolean(req.body?.regenerate),
        overrideBudget: Boolean(req.body?.overrideBudget),
        aiQueue,
        ...(synthesizerFn ? { synthesizerFn } : {}),
      });

      return res.status(202).json({
        jobId: result.job.id,
        status: result.job.status,
        deduplicated: result.deduplicated,
        reusedCache: result.reusedCache,
        resultRefs: result.job.resultRefsJson || null,
      });
    } catch (err) {
      if (err?.statusCode) {
        return res.status(err.statusCode).json({
          error: err.errorCode || 'STUDY_PACK_ERROR',
          message: err.message,
          details: err.details || undefined,
        });
      }
      return res.status(500).json({
        error: 'SERVER_ERROR',
        message: err.message || 'Gagal mengantrekan pembuatan Study Pack.',
      });
    }
  });

  // POST /api/modules/:moduleId/question-sets
  router.post('/modules/:moduleId/question-sets', async (req, res) => {
    const parsedId = uuidSchema.safeParse(req.params.moduleId);
    if (!parsedId.success) {
      return res.status(400).json({
        error: 'INVALID_MODULE_ID',
        message: 'Format moduleId tidak valid.',
      });
    }

    const idempotencyKey = getIdempotencyKey(req);
    if (!idempotencyKey) {
      return res.status(400).json({
        error: 'MISSING_IDEMPOTENCY_KEY',
        message: 'Idempotency-Key wajib disertakan.',
      });
    }

    try {
      const result = await enqueueAdditionalQuestionSet({
        moduleId: parsedId.data,
        idempotencyKey,
        questionCount: req.body?.questionCount,
        overrideBudget: Boolean(req.body?.overrideBudget),
        aiQueue,
        ...(practiceGeneratorFn ? { generatorFn: practiceGeneratorFn } : {}),
      });

      return res.status(202).json({
        jobId: result.job.id,
        status: result.job.status,
        deduplicated: result.deduplicated,
        reusedCache: result.reusedCache,
        resultRefs: result.job.resultRefsJson || null,
      });
    } catch (err) {
      if (err?.statusCode) {
        return res.status(err.statusCode).json({
          error: err.errorCode || 'QUESTION_SET_ERROR',
          message: err.message,
        });
      }
      return res.status(500).json({
        error: 'SERVER_ERROR',
        message: 'Gagal mengantrekan pembuatan set soal tambahan.',
      });
    }
  });

  // GET /api/question-sets/:questionSetId
  router.get('/question-sets/:questionSetId', async (req, res) => {
    const parsedId = uuidSchema.safeParse(req.params.questionSetId);
    if (!parsedId.success) {
      return res.status(400).json({
        error: 'INVALID_QUESTION_SET_ID',
        message: 'Format questionSetId tidak valid.',
      });
    }

    try {
      const qSet = await getQuestionSetWithoutAnswerKey(parsedId.data);
      if (!qSet) {
        return res.status(404).json({
          error: 'QUESTION_SET_NOT_FOUND',
          message: 'Question set tidak ditemukan.',
        });
      }
      return res.status(200).json({ questionSet: qSet });
    } catch (err) {
      return res.status(500).json({
        error: 'DB_ERROR',
        message: 'Gagal memuat soal kuis.',
      });
    }
  });

  // POST /api/question-sets/:questionSetId/attempts
  router.post('/question-sets/:questionSetId/attempts', async (req, res) => {
    const parsedId = uuidSchema.safeParse(req.params.questionSetId);
    if (!parsedId.success) {
      return res.status(400).json({
        error: 'INVALID_QUESTION_SET_ID',
        message: 'Format questionSetId tidak valid.',
      });
    }

    try {
      const attemptReview = await submitQuizAttempt(parsedId.data, req.body || {});
      return res.status(201).json({ attempt: attemptReview });
    } catch (err) {
      if (err?.name === 'ZodError') {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: formatZodError(err),
        });
      }
      if (err?.statusCode) {
        return res.status(err.statusCode).json({
          error: err.errorCode || 'SUBMISSION_ERROR',
          message: err.message,
        });
      }
      return res.status(500).json({
        error: 'DB_ERROR',
        message: 'Gagal menilai dan menyimpan hasil kuis.',
      });
    }
  });

  // POST /api/question-sets/:questionSetId/draft
  router.post('/question-sets/:questionSetId/draft', async (req, res) => {
    const parsedId = uuidSchema.safeParse(req.params.questionSetId);
    if (!parsedId.success) {
      return res.status(400).json({
        error: 'INVALID_QUESTION_SET_ID',
        message: 'Format questionSetId tidak valid.',
      });
    }

    try {
      const { saveQuizDraft } = await import('../services/quizAndRemedialService.js');
      const draft = await saveQuizDraft(parsedId.data, req.body || {});
      return res.status(200).json({ draft });
    } catch (err) {
      return res.status(500).json({
        error: 'DB_ERROR',
        message: 'Gagal menyimpan draf kuis.',
      });
    }
  });

  // GET /api/attempts/:attemptId
  router.get('/attempts/:attemptId', async (req, res) => {
    const parsedId = uuidSchema.safeParse(req.params.attemptId);
    if (!parsedId.success) {
      return res.status(400).json({
        error: 'INVALID_ATTEMPT_ID',
        message: 'Format attemptId tidak valid.',
      });
    }

    try {
      const review = await getAttemptReviewById(parsedId.data);
      if (!review) {
        return res.status(404).json({
          error: 'ATTEMPT_NOT_FOUND',
          message: 'Hasil pengerjaan kuis tidak ditemukan.',
        });
      }
      return res.status(200).json({ attempt: review });
    } catch (err) {
      return res.status(500).json({
        error: 'DB_ERROR',
        message: 'Gagal memuat pembahasan attempt.',
      });
    }
  });

  // POST /api/attempts/:attemptId/remedial
  router.post('/attempts/:attemptId/remedial', async (req, res) => {
    const parsedId = uuidSchema.safeParse(req.params.attemptId);
    if (!parsedId.success) {
      return res.status(400).json({
        error: 'INVALID_ATTEMPT_ID',
        message: 'Format attemptId tidak valid.',
      });
    }

    const idempotencyKey = getIdempotencyKey(req);
    if (!idempotencyKey) {
      return res.status(400).json({
        error: 'MISSING_IDEMPOTENCY_KEY',
        message: 'Idempotency-Key wajib disertakan.',
      });
    }

    try {
      const result = await enqueueRemedialGeneration({
        attemptId: parsedId.data,
        idempotencyKey,
        questionCount: req.body?.questionCount,
        regenerate: Boolean(req.body?.regenerate),
        overrideBudget: Boolean(req.body?.overrideBudget),
        aiQueue,
        ...(remedialGeneratorFn ? { generatorFn: remedialGeneratorFn } : {}),
      });

      return res.status(202).json({
        jobId: result.job.id,
        status: result.job.status,
        deduplicated: result.deduplicated,
        reusedCache: result.reusedCache,
        resultRefs: result.job.resultRefsJson || null,
      });
    } catch (err) {
      if (err?.statusCode) {
        return res.status(err.statusCode).json({
          error: err.errorCode || 'REMEDIAL_ERROR',
          message: err.message,
        });
      }
      return res.status(500).json({
        error: 'SERVER_ERROR',
        message: 'Gagal mengantrekan pembuatan remedial.',
      });
    }
  });

  // POST /api/courses/:courseId/exam-simulations
  router.post('/courses/:courseId/exam-simulations', async (req, res) => {
    const parsedId = uuidSchema.safeParse(req.params.courseId);
    if (!parsedId.success) {
      return res.status(400).json({
        error: 'INVALID_COURSE_ID',
        message: 'Format courseId tidak valid.',
      });
    }

    const idempotencyKey = getIdempotencyKey(req);
    if (!idempotencyKey) {
      return res.status(400).json({
        error: 'MISSING_IDEMPOTENCY_KEY',
        message: 'Idempotency-Key wajib disertakan.',
      });
    }

    try {
      const result = await enqueueCourseExamSimulation({
        courseId: parsedId.data,
        moduleIds: req.body?.moduleIds || null,
        questionCount: req.body?.questionCount,
        difficulty: req.body?.difficulty || 'mixed',
        idempotencyKey,
        regenerate: Boolean(req.body?.regenerate),
        overrideBudget: Boolean(req.body?.overrideBudget),
        aiQueue,
        ...(examSimulationGeneratorFn ? { generatorFn: examSimulationGeneratorFn } : {}),
      });

      return res.status(202).json({
        jobId: result.job.id,
        status: result.job.status,
        deduplicated: result.deduplicated,
        reusedCache: result.reusedCache,
        resultRefs: result.job.resultRefsJson || null,
      });
    } catch (err) {
      if (err?.statusCode) {
        return res.status(err.statusCode).json({
          error: err.errorCode || 'EXAM_SIMULATION_ERROR',
          message: err.message,
        });
      }
      return res.status(500).json({
        error: 'SERVER_ERROR',
        message: 'Gagal mengantrekan pembuatan Simulasi UAS.',
      });
    }
  });

  // GET /api/modules/:moduleId/progress
  router.get('/modules/:moduleId/progress', async (req, res) => {
    const parsedId = uuidSchema.safeParse(req.params.moduleId);
    if (!parsedId.success) {
      return res.status(400).json({
        error: 'INVALID_MODULE_ID',
        message: 'Format moduleId tidak valid.',
      });
    }

    try {
      const progress = await getModuleProgress(parsedId.data);
      if (!progress) {
        return res.status(404).json({
          error: 'MODULE_NOT_FOUND',
          message: 'Modul tidak ditemukan.',
        });
      }
      return res.status(200).json({ progress });
    } catch (err) {
      return res.status(500).json({
        error: 'DB_ERROR',
        message: 'Gagal memuat progres modul.',
      });
    }
  });

  // GET /api/courses/:courseId/progress
  router.get('/courses/:courseId/progress', async (req, res) => {
    const parsedId = uuidSchema.safeParse(req.params.courseId);
    if (!parsedId.success) {
      return res.status(400).json({
        error: 'INVALID_COURSE_ID',
        message: 'Format courseId tidak valid.',
      });
    }

    try {
      const progress = await getCourseProgress(parsedId.data);
      if (!progress) {
        return res.status(404).json({
          error: 'COURSE_NOT_FOUND',
          message: 'Mata kuliah tidak ditemukan.',
        });
      }
      return res.status(200).json({ progress });
    } catch (err) {
      return res.status(500).json({
        error: 'DB_ERROR',
        message: 'Gagal memuat progres mata kuliah.',
      });
    }
  });

  return router;
}
