import express from 'express';
import { z } from 'zod';
import {
  listCourses,
  createCourse,
  getCourseById,
  updateCourse,
  archiveCourse,
  listModulesByCourse,
  createModule,
  getModuleDetail,
  updateModule,
  archiveModule,
} from '../services/courseModuleService.js';

const uuidSchema = z.string().uuid('Format ID tidak valid.');

function formatZodError(zodErr) {
  const issues = zodErr.issues || [];
  return issues.map((i) => i.message).join(' ') || 'Input tidak valid.';
}

export function createCourseRouter() {
  const router = express.Router();

  // GET /api/courses
  router.get('/courses', async (req, res) => {
    try {
      const includeArchived = req.query.includeArchived === 'true';
      const items = await listCourses({ includeArchived });
      return res.status(200).json({ courses: items });
    } catch (err) {
      return res.status(500).json({
        error: 'DB_ERROR',
        message: 'Gagal memuat daftar mata kuliah.',
      });
    }
  });

  // POST /api/courses
  router.post('/courses', async (req, res) => {
    try {
      const created = await createCourse(req.body || {});
      return res.status(201).json({ course: created });
    } catch (err) {
      if (err?.name === 'ZodError') {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: formatZodError(err),
        });
      }
      return res.status(500).json({
        error: 'DB_ERROR',
        message: 'Gagal menyimpan mata kuliah baru.',
      });
    }
  });

  // GET /api/courses/:courseId
  router.get('/courses/:courseId', async (req, res) => {
    const parsedId = uuidSchema.safeParse(req.params.courseId);
    if (!parsedId.success) {
      return res.status(400).json({
        error: 'INVALID_COURSE_ID',
        message: 'Format courseId tidak valid.',
      });
    }

    try {
      const includeArchivedModules = req.query.includeArchivedModules === 'true';
      const course = await getCourseById(parsedId.data, { includeArchivedModules });
      if (!course) {
        return res.status(404).json({
          error: 'COURSE_NOT_FOUND',
          message: 'Mata kuliah tidak ditemukan.',
        });
      }
      return res.status(200).json({ course });
    } catch (err) {
      return res.status(500).json({
        error: 'DB_ERROR',
        message: 'Gagal memuat detail mata kuliah.',
      });
    }
  });

  // PATCH /api/courses/:courseId
  router.patch('/courses/:courseId', async (req, res) => {
    const parsedId = uuidSchema.safeParse(req.params.courseId);
    if (!parsedId.success) {
      return res.status(400).json({
        error: 'INVALID_COURSE_ID',
        message: 'Format courseId tidak valid.',
      });
    }

    try {
      const updated = await updateCourse(parsedId.data, req.body || {});
      if (!updated) {
        return res.status(404).json({
          error: 'COURSE_NOT_FOUND',
          message: 'Mata kuliah tidak ditemukan.',
        });
      }
      return res.status(200).json({ course: updated });
    } catch (err) {
      if (err?.name === 'ZodError') {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: formatZodError(err),
        });
      }
      return res.status(500).json({
        error: 'DB_ERROR',
        message: 'Gagal memperbarui mata kuliah.',
      });
    }
  });

  // DELETE /api/courses/:courseId (soft archive)
  router.delete('/courses/:courseId', async (req, res) => {
    const parsedId = uuidSchema.safeParse(req.params.courseId);
    if (!parsedId.success) {
      return res.status(400).json({
        error: 'INVALID_COURSE_ID',
        message: 'Format courseId tidak valid.',
      });
    }

    try {
      const archived = await archiveCourse(parsedId.data);
      if (!archived) {
        return res.status(404).json({
          error: 'COURSE_NOT_FOUND',
          message: 'Mata kuliah tidak ditemukan.',
        });
      }
      return res.status(200).json({
        course: archived,
        message: 'Mata kuliah berhasil diarsipkan.',
      });
    } catch (err) {
      return res.status(500).json({
        error: 'DB_ERROR',
        message: 'Gagal mengarsipkan mata kuliah.',
      });
    }
  });

  // GET /api/courses/:courseId/modules
  router.get('/courses/:courseId/modules', async (req, res) => {
    const parsedId = uuidSchema.safeParse(req.params.courseId);
    if (!parsedId.success) {
      return res.status(400).json({
        error: 'INVALID_COURSE_ID',
        message: 'Format courseId tidak valid.',
      });
    }

    try {
      const includeArchived = req.query.includeArchived === 'true';
      const mods = await listModulesByCourse(parsedId.data, { includeArchived });
      if (!mods) {
        return res.status(404).json({
          error: 'COURSE_NOT_FOUND',
          message: 'Mata kuliah tidak ditemukan.',
        });
      }
      return res.status(200).json({ modules: mods });
    } catch (err) {
      return res.status(500).json({
        error: 'DB_ERROR',
        message: 'Gagal memuat daftar modul.',
      });
    }
  });

  // POST /api/courses/:courseId/modules
  router.post('/courses/:courseId/modules', async (req, res) => {
    const parsedId = uuidSchema.safeParse(req.params.courseId);
    if (!parsedId.success) {
      return res.status(400).json({
        error: 'INVALID_COURSE_ID',
        message: 'Format courseId tidak valid.',
      });
    }

    try {
      const created = await createModule(parsedId.data, req.body || {});
      return res.status(201).json({ module: created });
    } catch (err) {
      if (err?.name === 'ZodError') {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: formatZodError(err),
        });
      }
      if (err?.statusCode) {
        return res.status(err.statusCode).json({
          error: err.errorCode || 'REQUEST_ERROR',
          message: err.message,
        });
      }
      return res.status(500).json({
        error: 'DB_ERROR',
        message: 'Gagal menambahkan modul.',
      });
    }
  });

  // GET /api/modules/:moduleId
  router.get('/modules/:moduleId', async (req, res) => {
    const parsedId = uuidSchema.safeParse(req.params.moduleId);
    if (!parsedId.success) {
      return res.status(400).json({
        error: 'INVALID_MODULE_ID',
        message: 'Format moduleId tidak valid.',
      });
    }

    try {
      const mod = await getModuleDetail(parsedId.data);
      if (!mod) {
        return res.status(404).json({
          error: 'MODULE_NOT_FOUND',
          message: 'Modul tidak ditemukan.',
        });
      }
      return res.status(200).json({ module: mod });
    } catch (err) {
      return res.status(500).json({
        error: 'DB_ERROR',
        message: 'Gagal memuat detail modul.',
      });
    }
  });

  // PATCH /api/modules/:moduleId
  router.patch('/modules/:moduleId', async (req, res) => {
    const parsedId = uuidSchema.safeParse(req.params.moduleId);
    if (!parsedId.success) {
      return res.status(400).json({
        error: 'INVALID_MODULE_ID',
        message: 'Format moduleId tidak valid.',
      });
    }

    try {
      const updated = await updateModule(parsedId.data, req.body || {});
      if (!updated) {
        return res.status(404).json({
          error: 'MODULE_NOT_FOUND',
          message: 'Modul tidak ditemukan.',
        });
      }
      return res.status(200).json({ module: updated });
    } catch (err) {
      if (err?.name === 'ZodError') {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: formatZodError(err),
        });
      }
      if (err?.statusCode) {
        return res.status(err.statusCode).json({
          error: err.errorCode || 'REQUEST_ERROR',
          message: err.message,
        });
      }
      return res.status(500).json({
        error: 'DB_ERROR',
        message: 'Gagal memperbarui modul.',
      });
    }
  });

  // DELETE /api/modules/:moduleId (soft archive)
  router.delete('/modules/:moduleId', async (req, res) => {
    const parsedId = uuidSchema.safeParse(req.params.moduleId);
    if (!parsedId.success) {
      return res.status(400).json({
        error: 'INVALID_MODULE_ID',
        message: 'Format moduleId tidak valid.',
      });
    }

    try {
      const archived = await archiveModule(parsedId.data);
      if (!archived) {
        return res.status(404).json({
          error: 'MODULE_NOT_FOUND',
          message: 'Modul tidak ditemukan.',
        });
      }
      return res.status(200).json({
        module: archived,
        message: 'Modul berhasil diarsipkan.',
      });
    } catch (err) {
      return res.status(500).json({
        error: 'DB_ERROR',
        message: 'Gagal mengarsipkan modul.',
      });
    }
  });

  return router;
}
