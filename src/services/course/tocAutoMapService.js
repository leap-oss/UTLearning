import fs from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../db/client.js';
import { courses, modules } from '../../db/schema.js';
import { generateStructuredContent } from '../geminiClient.js';
import { validateAndPrepareUploadedImages } from '../extractionService.js';
import { recordAiUsageEvent } from '../aiJobRepository.js';

export async function autoMapModulesFromImages({ courseId, files = [] }) {
  const db = getDb();

  const [course] = await db
    .select()
    .from(courses)
    .where(eq(courses.id, courseId))
    .limit(1);

  if (!course || course.status === 'archived') {
    const err = new Error('Mata kuliah tidak ditemukan atau sudah diarsipkan.');
    err.statusCode = 404;
    err.errorCode = 'COURSE_NOT_FOUND';
    throw err;
  }

  if (!files || files.length === 0) {
    const err = new Error('Silakan unggah minimal 1 foto/gambar halaman Daftar Isi BMP.');
    err.statusCode = 400;
    err.errorCode = 'NO_FILES';
    throw err;
  }

  const preparedFiles = await validateAndPrepareUploadedImages(files);

  const contents = [
    {
      text:
        'Berikut adalah foto halaman Daftar Isi dari Buku Materi Pokok (BMP) Universitas Terbuka.\n' +
        'Tugas Anda:\n' +
        '1. Ekstrak seluruh nomor modul (moduleNumber: integer) dan judul modul resmi (title: string).\n' +
        '2. Ekstrak daftar Kegiatan Belajar (kegiatanBelajar: array of string) di bawah setiap modul bila ada.\n' +
        '3. Bersihkan judul modul dari prefiks seperti "MODUL 1", "Modul 01", "MODUL 2 :", dll. Ambil nama/tema topik resmi modulnya saja.\n' +
        '4. Kembalikan HANYA JSON berformat objek dengan properti "modules":\n' +
        '{\n' +
        '  "modules": [\n' +
        '    {\n' +
        '      "moduleNumber": 1,\n' +
        '      "title": "Judul Modul",\n' +
        '      "kegiatanBelajar": ["KB 1: ...", "KB 2: ..."]\n' +
        '    }\n' +
        '  ]\n' +
        '}',
    },
  ];

  for (const item of preparedFiles) {
    const buffer = await fs.readFile(item.tempPath);
    contents.push({
      inlineData: {
        mimeType: item.mimeType,
        data: buffer.toString('base64'),
      },
    });
  }

  const tocSchema = z.object({
    courseTitle: z.string().optional().default(''),
    modules: z.array(
      z.object({
        moduleNumber: z.coerce.number(),
        title: z.string().trim(),
        kegiatanBelajar: z.array(z.string()).optional().default([]),
      })
    ),
  });

  const tocResponseSchema = {
    type: 'OBJECT',
    required: ['modules'],
    properties: {
      courseTitle: { type: 'STRING' },
      modules: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          required: ['moduleNumber', 'title'],
          properties: {
            moduleNumber: { type: 'INTEGER' },
            title: { type: 'STRING' },
            kegiatanBelajar: {
              type: 'ARRAY',
              items: { type: 'STRING' },
            },
          },
        },
      },
    },
  };

  const startedAtMs = Date.now();
  let aiResult;
  try {
    aiResult = await generateStructuredContent({
      taskType: 'extract_toc_modules',
      contents,
      responseSchema: tocResponseSchema,
      zodSchema: tocSchema,
    });
    await recordAiUsageEvent({
      courseId,
      model: aiResult?.model || 'gemini-3.5-flash',
      taskType: 'extract_toc_modules',
      status: 'succeeded',
      httpStatus: 200,
      durationMs: Date.now() - startedAtMs,
      usageMetadata: aiResult?.usageMetadata || null,
    }).catch(() => {});
  } catch (aiErr) {
    await recordAiUsageEvent({
      courseId,
      model: 'gemini-3.5-flash',
      taskType: 'extract_toc_modules',
      status: 'failed',
      httpStatus: Number(aiErr?.status || aiErr?.statusCode) || 500,
      errorCode: aiErr?.errorCode || 'AUTO_MAP_AI_ERROR',
      errorMessage: aiErr?.message || 'Gagal memetakan Daftar Isi',
      durationMs: Date.now() - startedAtMs,
      usageMetadata: aiErr?.usageMetadata || null,
    }).catch(() => {});
    throw aiErr;
  }

  const extractedModules = aiResult?.data?.modules || [];
  if (extractedModules.length === 0) {
    const err = new Error('Tidak ada modul yang berhasil diekstrak dari foto Daftar Isi.');
    err.statusCode = 422;
    err.errorCode = 'NO_MODULES_DETECTED';
    throw err;
  }

  extractedModules.sort((a, b) => a.moduleNumber - b.moduleNumber);

  const existingModules = await db
    .select()
    .from(modules)
    .where(eq(modules.courseId, courseId));

  const existingMap = new Map(existingModules.map((m) => [m.moduleNumber, m]));
  const now = new Date();
  const upserted = [];

  for (const item of extractedModules) {
    const existing = existingMap.get(item.moduleNumber);
    if (existing) {
      const [updated] = await db
        .update(modules)
        .set({
          title: item.title,
          status: existing.status === 'archived' ? 'empty' : existing.status,
          archivedAt: null,
          updatedAt: now,
        })
        .where(eq(modules.id, existing.id))
        .returning();
      upserted.push({ ...updated, kegiatanBelajar: item.kegiatanBelajar });
    } else {
      const [created] = await db
        .insert(modules)
        .values({
          courseId,
          moduleNumber: item.moduleNumber,
          title: item.title,
          status: 'empty',
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      upserted.push({ ...created, kegiatanBelajar: item.kegiatanBelajar });
    }
  }

  const maxModCount = Math.max(course.expectedModuleCount || 9, extractedModules.length);
  await db
    .update(courses)
    .set({
      expectedModuleCount: maxModCount,
      updatedAt: now,
    })
    .where(eq(courses.id, courseId));

  return {
    courseId,
    modules: upserted,
  };
}
