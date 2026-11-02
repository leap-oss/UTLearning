import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { inArray } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { getDb, closeDb } from '../src/db/client.js';
import { courses } from '../src/db/schema.js';

const testCourseIds = [];

after(async () => {
  const db = getDb();
  if (testCourseIds.length > 0) {
    await db.delete(courses).where(inArray(courses.id, testCourseIds));
  }
  await closeDb();
});

async function withServer(run) {
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('Milestone 2: Two courses with flexible modules can be created, updated, reloaded, and archived', async () => {
  await withServer(async (baseUrl) => {
    // 1. Create Course 1
    const c1Res = await fetch(`${baseUrl}/api/courses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: 'msim4201',
        name: 'Sistem Operasi',
        semesterLabel: 'Semester 3',
        expectedModuleCount: 3,
      }),
    });
    assert.equal(c1Res.status, 201);
    const { course: c1 } = await c1Res.json();
    testCourseIds.push(c1.id);
    assert.equal(c1.code, 'MSIM4201');
    assert.equal(c1.expectedModuleCount, 3);

    // 2. Create Course 2
    const c2Res = await fetch(`${baseUrl}/api/courses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: 'MSIM4203',
        name: 'Algoritma dan Pemrograman',
        semesterLabel: 'Semester 3',
        expectedModuleCount: 9,
      }),
    });
    assert.equal(c2Res.status, 201);
    const { course: c2 } = await c2Res.json();
    testCourseIds.push(c2.id);

    // 3. Add non-sequential modules and a module beyond expectedModuleCount to Course 1
    const m1Res = await fetch(`${baseUrl}/api/courses/${c1.id}/modules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        moduleNumber: 1,
        title: 'Pengenalan Sistem Operasi',
      }),
    });
    assert.equal(m1Res.status, 201);
    const { module: m1 } = await m1Res.json();

    const m3Res = await fetch(`${baseUrl}/api/courses/${c1.id}/modules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        moduleNumber: 3,
        title: 'Penjadwalan CPU (Tanpa Modul 2)',
        status: 'in_progress',
      }),
    });
    assert.equal(m3Res.status, 201);

    const m5Res = await fetch(`${baseUrl}/api/courses/${c1.id}/modules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        moduleNumber: 5,
        title: 'Modul Tambahan Melebihi Expected Count',
      }),
    });
    assert.equal(m5Res.status, 201);

    // 4. Duplicate moduleNumber on same course returns 409
    const dupRes = await fetch(`${baseUrl}/api/courses/${c1.id}/modules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        moduleNumber: 1,
        title: 'Duplikat Modul 1',
      }),
    });
    assert.equal(dupRes.status, 409);

    // 5. Add module to Course 2 and verify Course 1 is untouched
    const c2m1Res = await fetch(`${baseUrl}/api/courses/${c2.id}/modules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        moduleNumber: 1,
        title: 'Dasar Algoritma',
        status: 'mastered',
      }),
    });
    assert.equal(c2m1Res.status, 201);

    // 6. Reload both courses via GET /api/courses
    const listRes = await fetch(`${baseUrl}/api/courses`);
    assert.equal(listRes.status, 200);
    const { courses: listed } = await listRes.json();
    const foundC1 = listed.find((c) => c.id === c1.id);
    const foundC2 = listed.find((c) => c.id === c2.id);
    assert.ok(foundC1);
    assert.ok(foundC2);
    assert.equal(foundC1.moduleCounts.total, 3);
    assert.equal(foundC1.moduleCounts.in_progress, 1);
    assert.equal(foundC2.moduleCounts.total, 1);
    assert.equal(foundC2.moduleCounts.mastered, 1);

    // 7. Update Module 1 status & title
    const patchModRes = await fetch(`${baseUrl}/api/modules/${m1.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Pengenalan Sistem Operasi (Edisi Revisi)',
        status: 'needs_review',
      }),
    });
    assert.equal(patchModRes.status, 200);

    const modDetailRes = await fetch(`${baseUrl}/api/modules/${m1.id}`);
    assert.equal(modDetailRes.status, 200);
    const { module: modDetail } = await modDetailRes.json();
    assert.equal(modDetail.status, 'needs_review');
    assert.equal(modDetail.course.id, c1.id);

    // 8. Soft archive Module 1 and Course 2
    const delModRes = await fetch(`${baseUrl}/api/modules/${m1.id}`, {
      method: 'DELETE',
    });
    assert.equal(delModRes.status, 200);

    const c1DetailAfterRes = await fetch(`${baseUrl}/api/courses/${c1.id}`);
    const { course: c1DetailAfter } = await c1DetailAfterRes.json();
    assert.equal(c1DetailAfter.modules.length, 2, 'Archived module hidden from active list');

    const delCourseRes = await fetch(`${baseUrl}/api/courses/${c2.id}`, {
      method: 'DELETE',
    });
    assert.equal(delCourseRes.status, 200);

    const activeListRes = await fetch(`${baseUrl}/api/courses`);
    const { courses: activeList } = await activeListRes.json();
    assert.equal(activeList.some((c) => c.id === c2.id), false);

    const allListRes = await fetch(`${baseUrl}/api/courses?includeArchived=true`);
    const { courses: allList } = await allListRes.json();
    assert.equal(allList.some((c) => c.id === c2.id), true);
  });
});
