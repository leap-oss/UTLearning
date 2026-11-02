import { eq, and, asc, desc, ne } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import {
  courses,
  modules,
  sourceAssets,
  studyPacks,
  questionSets,
} from '../db/schema.js';

export const MODULE_STATUSES = ['empty', 'in_progress', 'needs_review', 'mastered'];

export const createCourseSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2, 'Kode mata kuliah minimal 2 karakter.')
    .max(32, 'Kode mata kuliah maksimal 32 karakter.'),
  name: z
    .string()
    .trim()
    .min(2, 'Nama mata kuliah minimal 2 karakter.')
    .max(255, 'Nama mata kuliah maksimal 255 karakter.'),
  semesterLabel: z
    .string()
    .trim()
    .max(64, 'Label semester maksimal 64 karakter.')
    .optional()
    .nullable()
    .transform((v) => (v && v.length > 0 ? v : null)),
  expectedModuleCount: z
    .union([z.number(), z.string(), z.null(), z.undefined()])
    .transform((val) => {
      if (val === null || val === undefined || String(val).trim() === '') return 9;
      const parsed = Number.parseInt(String(val), 10);
      return parsed;
    })
    .refine((n) => Number.isInteger(n) && n >= 1 && n <= 50, {
      message: 'Perkiraan jumlah modul harus angka bulat antara 1 dan 50.',
    }),
});

export const updateCourseSchema = z
  .object({
    code: z.string().trim().min(2).max(32).optional(),
    name: z.string().trim().min(2).max(255).optional(),
    semesterLabel: z
      .string()
      .trim()
      .max(64)
      .optional()
      .nullable()
      .transform((v) => (v === undefined ? undefined : v && v.length > 0 ? v : null)),
    expectedModuleCount: z
      .union([z.number(), z.string()])
      .transform((val) => Number.parseInt(String(val), 10))
      .refine((n) => Number.isInteger(n) && n >= 1 && n <= 50, {
        message: 'Perkiraan jumlah modul harus antara 1 dan 50.',
      })
      .optional(),
    status: z.enum(['active', 'archived']).optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, {
    message: 'Minimal satu field harus diubah.',
  });

export const createModuleSchema = z.object({
  moduleNumber: z
    .union([z.number(), z.string()])
    .transform((val) => Number.parseInt(String(val), 10))
    .refine((n) => Number.isInteger(n) && n >= 1 && n <= 200, {
      message: 'Nomor modul harus angka bulat minimal 1.',
    }),
  title: z
    .string()
    .trim()
    .min(2, 'Judul modul minimal 2 karakter.')
    .max(255, 'Judul modul maksimal 255 karakter.'),
  status: z.enum(MODULE_STATUSES).optional().default('empty'),
});

export const updateModuleSchema = z
  .object({
    moduleNumber: z
      .union([z.number(), z.string()])
      .transform((val) => Number.parseInt(String(val), 10))
      .refine((n) => Number.isInteger(n) && n >= 1 && n <= 200, {
        message: 'Nomor modul harus angka bulat minimal 1.',
      })
      .optional(),
    title: z.string().trim().min(2).max(255).optional(),
    status: z.enum([...MODULE_STATUSES, 'archived']).optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, {
    message: 'Minimal satu field harus diubah.',
  });

function summarizeCourseModules(courseModules) {
  const activeModules = courseModules.filter((m) => m.status !== 'archived');
  const counts = {
    total: activeModules.length,
    empty: 0,
    in_progress: 0,
    needs_review: 0,
    mastered: 0,
  };

  let lastActivityAt = null;
  for (const mod of activeModules) {
    if (counts[mod.status] !== undefined) {
      counts[mod.status] += 1;
    }
    const modTime = mod.updatedAt ? new Date(mod.updatedAt).getTime() : 0;
    if (modTime && (!lastActivityAt || modTime > new Date(lastActivityAt).getTime())) {
      lastActivityAt = mod.updatedAt;
    }
  }

  return { counts, lastActivityAt };
}

export async function listCourses({ includeArchived = false } = {}) {
  const db = getDb();

  const courseRows = includeArchived
    ? await db.select().from(courses).orderBy(desc(courses.updatedAt))
    : await db
        .select()
        .from(courses)
        .where(eq(courses.status, 'active'))
        .orderBy(desc(courses.updatedAt));

  if (courseRows.length === 0) {
    return [];
  }

  const allModules = await db
    .select()
    .from(modules)
    .orderBy(asc(modules.moduleNumber));

  const modulesByCourse = new Map();
  for (const mod of allModules) {
    if (!includeArchived && mod.status === 'archived') continue;
    const list = modulesByCourse.get(mod.courseId) || [];
    list.push(mod);
    modulesByCourse.set(mod.courseId, list);
  }

  return courseRows.map((c) => {
    const courseModules = modulesByCourse.get(c.id) || [];
    const { counts, lastActivityAt } = summarizeCourseModules(courseModules);
    const latestAt =
      lastActivityAt && new Date(lastActivityAt) > new Date(c.updatedAt)
        ? lastActivityAt
        : c.updatedAt;

    return {
      ...c,
      moduleCounts: counts,
      lastActivityAt: latestAt,
      modules: courseModules,
    };
  });
}

export async function createCourse(input) {
  const data = createCourseSchema.parse(input);
  const db = getDb();
  const now = new Date();

  const [created] = await db
    .insert(courses)
    .values({
      code: data.code.toUpperCase(),
      name: data.name,
      semesterLabel: data.semesterLabel,
      expectedModuleCount: data.expectedModuleCount,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return {
    ...created,
    moduleCounts: {
      total: 0,
      empty: 0,
      in_progress: 0,
      needs_review: 0,
      mastered: 0,
    },
    lastActivityAt: created.updatedAt,
    modules: [],
  };
}

export async function getCourseById(courseId, { includeArchivedModules = false } = {}) {
  const db = getDb();
  const [course] = await db
    .select()
    .from(courses)
    .where(eq(courses.id, courseId))
    .limit(1);

  if (!course) {
    return null;
  }

  const modRows = await db
    .select()
    .from(modules)
    .where(eq(modules.courseId, courseId))
    .orderBy(asc(modules.moduleNumber));

  const visibleModules = includeArchivedModules
    ? modRows
    : modRows.filter((m) => m.status !== 'archived');

  const { counts, lastActivityAt } = summarizeCourseModules(visibleModules);
  const latestAt =
    lastActivityAt && new Date(lastActivityAt) > new Date(course.updatedAt)
      ? lastActivityAt
      : course.updatedAt;

  return {
    ...course,
    moduleCounts: counts,
    lastActivityAt: latestAt,
    modules: visibleModules,
  };
}

export async function updateCourse(courseId, input) {
  const data = updateCourseSchema.parse(input);
  const db = getDb();
  const existing = await getCourseById(courseId, { includeArchivedModules: true });
  if (!existing) {
    return null;
  }

  const now = new Date();
  const patch = {
    updatedAt: now,
  };
  if (data.code !== undefined) patch.code = data.code.toUpperCase();
  if (data.name !== undefined) patch.name = data.name;
  if (data.semesterLabel !== undefined) patch.semesterLabel = data.semesterLabel;
  if (data.expectedModuleCount !== undefined) patch.expectedModuleCount = data.expectedModuleCount;
  if (data.status !== undefined) {
    patch.status = data.status;
    patch.archivedAt = data.status === 'archived' ? now : null;
  }

  await db.update(courses).set(patch).where(eq(courses.id, courseId));
  return getCourseById(courseId);
}

export async function archiveCourse(courseId) {
  const db = getDb();
  const existing = await getCourseById(courseId, { includeArchivedModules: true });
  if (!existing) {
    return null;
  }

  const now = new Date();
  const [archived] = await db
    .update(courses)
    .set({
      status: 'archived',
      archivedAt: now,
      updatedAt: now,
    })
    .where(eq(courses.id, courseId))
    .returning();

  return archived;
}

export async function listModulesByCourse(courseId, { includeArchived = false } = {}) {
  const db = getDb();
  const [course] = await db
    .select()
    .from(courses)
    .where(eq(courses.id, courseId))
    .limit(1);

  if (!course) {
    return null;
  }

  const rows = await db
    .select()
    .from(modules)
    .where(eq(modules.courseId, courseId))
    .orderBy(asc(modules.moduleNumber));

  return includeArchived ? rows : rows.filter((m) => m.status !== 'archived');
}

export async function createModule(courseId, input) {
  const data = createModuleSchema.parse(input);
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

  const [existingMod] = await db
    .select()
    .from(modules)
    .where(and(eq(modules.courseId, courseId), eq(modules.moduleNumber, data.moduleNumber)))
    .limit(1);

  const now = new Date();

  if (existingMod) {
    if (existingMod.status === 'archived') {
      // Unarchive and update if user re-creates an archived module number
      const [restored] = await db
        .update(modules)
        .set({
          title: data.title,
          status: data.status || 'empty',
          archivedAt: null,
          updatedAt: now,
        })
        .where(eq(modules.id, existingMod.id))
        .returning();

      await db.update(courses).set({ updatedAt: now }).where(eq(courses.id, courseId));
      return restored;
    }

    const err = new Error(`Modul ${data.moduleNumber} sudah ada pada mata kuliah ini.`);
    err.statusCode = 409;
    err.errorCode = 'MODULE_NUMBER_EXISTS';
    throw err;
  }

  const [created] = await db
    .insert(modules)
    .values({
      courseId,
      moduleNumber: data.moduleNumber,
      title: data.title,
      status: data.status || 'empty',
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  await db.update(courses).set({ updatedAt: now }).where(eq(courses.id, courseId));

  return created;
}

export async function getModuleDetail(moduleId) {
  const db = getDb();
  const [mod] = await db
    .select()
    .from(modules)
    .where(eq(modules.id, moduleId))
    .limit(1);

  if (!mod) {
    return null;
  }

  const [course] = await db
    .select()
    .from(courses)
    .where(eq(courses.id, mod.courseId))
    .limit(1);

  const sources = await db
    .select()
    .from(sourceAssets)
    .where(eq(sourceAssets.moduleId, moduleId))
    .orderBy(asc(sourceAssets.pageOrder), asc(sourceAssets.createdAt));

  const packs = await db
    .select()
    .from(studyPacks)
    .where(eq(studyPacks.moduleId, moduleId))
    .orderBy(desc(studyPacks.version));

  const qSets = await db
    .select()
    .from(questionSets)
    .where(eq(questionSets.moduleId, moduleId))
    .orderBy(desc(questionSets.createdAt));

  return {
    ...mod,
    course: course || null,
    sources,
    studyPacks: packs,
    questionSets: qSets,
  };
}

export async function updateModule(moduleId, input) {
  const data = updateModuleSchema.parse(input);
  const db = getDb();

  const [existing] = await db
    .select()
    .from(modules)
    .where(eq(modules.id, moduleId))
    .limit(1);

  if (!existing) {
    return null;
  }

  if (data.moduleNumber !== undefined && data.moduleNumber !== existing.moduleNumber) {
    const [duplicate] = await db
      .select()
      .from(modules)
      .where(
        and(
          eq(modules.courseId, existing.courseId),
          eq(modules.moduleNumber, data.moduleNumber),
          ne(modules.id, moduleId)
        )
      )
      .limit(1);

    if (duplicate) {
      const err = new Error(`Nomor modul ${data.moduleNumber} sudah dipakai di mata kuliah ini.`);
      err.statusCode = 409;
      err.errorCode = 'MODULE_NUMBER_EXISTS';
      throw err;
    }
  }

  const now = new Date();
  const patch = { updatedAt: now };
  if (data.moduleNumber !== undefined) patch.moduleNumber = data.moduleNumber;
  if (data.title !== undefined) patch.title = data.title;
  if (data.status !== undefined) {
    patch.status = data.status;
    patch.archivedAt = data.status === 'archived' ? now : null;
  }

  const [updated] = await db
    .update(modules)
    .set(patch)
    .where(eq(modules.id, moduleId))
    .returning();

  await db.update(courses).set({ updatedAt: now }).where(eq(courses.id, existing.courseId));

  return updated;
}

export async function archiveModule(moduleId) {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(modules)
    .where(eq(modules.id, moduleId))
    .limit(1);

  if (!existing) {
    return null;
  }

  const now = new Date();
  const [archived] = await db
    .update(modules)
    .set({
      status: 'archived',
      archivedAt: now,
      updatedAt: now,
    })
    .where(eq(modules.id, moduleId))
    .returning();

  await db.update(courses).set({ updatedAt: now }).where(eq(courses.id, existing.courseId));

  return archived;
}
