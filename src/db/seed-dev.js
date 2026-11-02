import { eq, and } from 'drizzle-orm';
import { getDb, closeDb } from './client.js';
import { courses, modules } from './schema.js';

export async function seedDevData() {
  const db = getDb();

  const existing = await db
    .select()
    .from(courses)
    .where(and(eq(courses.code, 'MSIM4201'), eq(courses.status, 'active')));

  let course = existing[0];
  if (!course) {
    const [inserted] = await db
      .insert(courses)
      .values({
        code: 'MSIM4201',
        name: 'Sistem Operasi (Demo Dev)',
        semesterLabel: 'Semester 3',
        expectedModuleCount: 9,
        status: 'active',
      })
      .returning();
    course = inserted;
  }

  const existingModules = await db
    .select()
    .from(modules)
    .where(eq(modules.courseId, course.id));

  if (existingModules.length === 0) {
    await db.insert(modules).values([
      {
        courseId: course.id,
        moduleNumber: 1,
        title: 'Pengenalan Sistem Operasi',
        status: 'empty',
      },
      {
        courseId: course.id,
        moduleNumber: 2,
        title: 'Proses dan Thread',
        status: 'empty',
      },
    ]);
  }

  return { courseId: course.id, code: course.code };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedDevData()
    .then((res) => {
      console.log(`[db:seed:dev] Seeded development demo course: ${res.code} (${res.courseId})`);
      return closeDb();
    })
    .catch((err) => {
      console.error('[db:seed:dev] Failed:', err.message);
      closeDb().finally(() => process.exit(1));
    });
}
