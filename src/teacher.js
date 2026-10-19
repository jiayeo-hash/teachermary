// Teacher API: /api/teacher/... (protected by Cloudflare Access + JWT check in worker.js)

import { HttpError, STUDENT_COLORS, cleanName, isDate, json, randomToken, readJson, uuid } from './util.js';
import { abortUpload, completeUpload, deleteKeys, startUpload, streamFile, uploadPart } from './files.js';
import { setPin } from './student.js';
import { cleanSchedule, ensureLessons, readSchedule, todayIn, dowOf } from './classes.js';

const linkFor = (token) => `/l/${token}`;

async function addStudents(env, classId, names, fromDate) {
  const existing = await env.DB.prepare('SELECT COUNT(*) AS n FROM students WHERE class_id = ?').bind(classId).first();
  let i = existing.n;
  const stmts = [];
  for (const raw of names || []) {
    const name = cleanName(raw, 40);
    stmts.push(
      env.DB.prepare('INSERT INTO students (id, class_id, name, color, added_on) VALUES (?, ?, ?, ?, ?)').bind(
        uuid(),
        classId,
        name,
        STUDENT_COLORS[i++ % STUDENT_COLORS.length],
        fromDate
      )
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
  return stmts.length;
}

async function removeStudents(env, classId, ids, fromDate) {
  const stmts = (ids || []).map((id) =>
    env.DB.prepare('UPDATE students SET left_on = ? WHERE id = ? AND class_id = ? AND left_on IS NULL').bind(fromDate, String(id), classId)
  );
  if (stmts.length) await env.DB.batch(stmts);
}

async function activeRoster(env, classId, date) {
  const r = await env.DB.prepare(
    `SELECT id, name, color, pin_hash IS NOT NULL AS has_pin FROM students
     WHERE class_id = ? AND added_on <= ? AND (left_on IS NULL OR left_on > ?) ORDER BY rowid`
  )
    .bind(classId, date, date)
    .all();
  return r.results.map((s) => ({ id: s.id, name: s.name, color: s.color, hasPin: !!s.has_pin }));
}

async function lessonById(env, id) {
  const l = await env.DB.prepare('SELECT * FROM lessons WHERE id = ?').bind(id).first();
  if (!l) throw new HttpError(404, 'Lesson not found');
  return l;
}

export async function handleTeacher(request, env, url, email, rest) {
  const method = request.method;
  const [a, b, c, d] = rest;

  if (a === 'me' && method === 'GET') return json({ email });

  // ---- classes ----
  if (a === 'overview' && method === 'GET') {
    const classes = await env.DB.prepare(
      `SELECT c.id, c.name, c.token, c.schedule,
        (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id AND s.left_on IS NULL) AS students
       FROM classes c ORDER BY c.created_at`
    ).all();
    const out = [];
    for (const c of classes.results) {
      await ensureLessons(env, c.id);
      const next = await env.DB.prepare(
        `SELECT id, lesson_date, status FROM lessons WHERE class_id = ? AND lesson_date >= ? ORDER BY lesson_date LIMIT 1`
      )
        .bind(c.id, todayIn(env))
        .first();
      const toReview = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM submissions sub JOIN lessons l ON l.id = sub.lesson_id WHERE l.class_id = ? AND sub.reviewed = 0`
      )
        .bind(c.id)
        .first();
      out.push({
        id: c.id,
        name: c.name,
        students: c.students,
        toReview: toReview.n,
        link: linkFor(c.token),
        schedule: readSchedule(c),
        nextLesson: next ? { id: next.id, date: next.lesson_date, status: next.status } : null,
      });
    }
    return json({ classes: out });
  }

  // Newest homework that has not been marked as reviewed yet
  if (a === 'review-queue' && method === 'GET') {
    const r = await env.DB.prepare(
      `SELECT sub.id, sub.name, sub.uploaded_at, st.name AS student_name, l.id AS lesson_id, l.lesson_date, c.id AS class_id, c.name AS class_name
       FROM submissions sub JOIN students st ON st.id = sub.student_id JOIN lessons l ON l.id = sub.lesson_id JOIN classes c ON c.id = l.class_id
       WHERE sub.reviewed = 0 ORDER BY sub.uploaded_at DESC LIMIT 30`
    ).all();
    return json({
      items: r.results.map((x) => ({
        id: x.id, name: x.name, uploadedAt: x.uploaded_at, studentName: x.student_name,
        lessonId: x.lesson_id, date: x.lesson_date, classId: x.class_id, className: x.class_name,
      })),
    });
  }

  if (a === 'classes' && !b && method === 'POST') {
    const body = await readJson(request);
    const name = cleanName(body.name, 40);
    const id = uuid();
    const token = randomToken(24);
    const schedule = body.schedule === undefined ? [] : cleanSchedule(body.schedule);
    await env.DB.prepare('INSERT INTO classes (id, name, token, schedule, multi) VALUES (?, ?, ?, ?, ?)')
      .bind(id, name, token, JSON.stringify(schedule), body.multi ? 1 : 0)
      .run();
    await addStudents(env, id, body.students, '2000-01-01');
    const first = isDate(body.startDate) ? body.startDate : undefined;
    const made = await ensureLessons(env, id, { from: first });
    return json({ id, link: linkFor(token), lessonsCreated: made }, 201);
  }

  if (a === 'classes' && b && !c && method === 'GET') {
    const cls = await env.DB.prepare('SELECT id, name, token, schedule, multi, auto_close_days FROM classes WHERE id = ?').bind(b).first();
    if (!cls) throw new HttpError(404, 'Class not found');
    await ensureLessons(env, b);
    const lessons = await env.DB.prepare(
      `SELECT l.id, l.lesson_date, l.status, l.auto,
        (SELECT COUNT(*) FROM materials m WHERE m.lesson_id = l.id) AS materials,
        (SELECT COUNT(*) FROM submissions s WHERE s.lesson_id = l.id) AS submissions,
        (SELECT COUNT(*) FROM submissions s WHERE s.lesson_id = l.id AND s.reviewed = 0) AS to_review
       FROM lessons l WHERE l.class_id = ? ORDER BY l.lesson_date`
    )
      .bind(b)
      .all();
    return json({
      class: {
        id: cls.id, name: cls.name, link: linkFor(cls.token), schedule: readSchedule(cls),
        multi: !!cls.multi, autoCloseDays: cls.auto_close_days,
      },
      roster: await activeRoster(env, b, '9999-12-31'),
      lessons: lessons.results.map((l) => ({
        id: l.id, date: l.lesson_date, status: l.status, auto: !!l.auto,
        materials: l.materials, submissions: l.submissions, toReview: l.to_review,
      })),
    });
  }

  // Roster edit on its own
  if (a === 'classes' && b && c === 'roster' && method === 'POST') {
    const body = await readJson(request);
    const from = isDate(body.from) ? body.from : todayIn(env);
    await removeStudents(env, b, body.remove, from);
    await addStudents(env, b, body.add, from);
    return json({ roster: await activeRoster(env, b, '9999-12-31') });
  }

  // Extra lesson on a date outside the weekly schedule (a replacement class, say)
  if (a === 'classes' && b && c === 'lessons' && method === 'POST') {
    const body = await readJson(request);
    if (!isDate(body.date)) throw new HttpError(400, 'Pick a day');
    const cls = await env.DB.prepare('SELECT id FROM classes WHERE id = ?').bind(b).first();
    if (!cls) throw new HttpError(404, 'Class not found');
    const id = uuid();
    const status = body.status === 'draft' ? 'draft' : 'open';
    await env.DB.prepare('INSERT INTO lessons (id, class_id, token, lesson_date, status, auto) VALUES (?, ?, ?, ?, ?, 0)')
      .bind(id, b, randomToken(24), body.date, status)
      .run();
    return json({ id, date: body.date }, 201);
  }

  // Class settings: name, weekly schedule, several files, auto-close
  if (a === 'classes' && b && !c && method === 'PATCH') {
    const body = await readJson(request);
    const cls = await env.DB.prepare('SELECT id, name FROM classes WHERE id = ?').bind(b).first();
    if (!cls) throw new HttpError(404, 'Class not found');
    if (body.name !== undefined) await env.DB.prepare('UPDATE classes SET name = ? WHERE id = ?').bind(cleanName(body.name, 40), b).run();
    if (body.multi !== undefined) await env.DB.prepare('UPDATE classes SET multi = ? WHERE id = ?').bind(body.multi ? 1 : 0, b).run();
    if (body.autoCloseDays !== undefined) {
      const n = body.autoCloseDays === null ? null : Number(body.autoCloseDays);
      if (n !== null && (!Number.isInteger(n) || n < 0 || n > 365)) throw new HttpError(400, 'Bad number of days');
      await env.DB.prepare('UPDATE classes SET auto_close_days = ? WHERE id = ?').bind(n, b).run();
    }
    if (body.schedule !== undefined) {
      const schedule = cleanSchedule(body.schedule);
      await env.DB.prepare('UPDATE classes SET schedule = ? WHERE id = ?').bind(JSON.stringify(schedule), b).run();
      // Future lessons the schedule made, that are still empty and no longer on a class day, are removed.
      const dows = new Set(schedule.map((x) => x.dow));
      const today = todayIn(env);
      const future = await env.DB.prepare(
        `SELECT l.id, l.lesson_date FROM lessons l WHERE l.class_id = ? AND l.auto = 1 AND l.lesson_date >= ?
         AND NOT EXISTS (SELECT 1 FROM materials m WHERE m.lesson_id = l.id) AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.lesson_id = l.id)`
      ).bind(b, today).all();
      const drop = future.results.filter((l) => !dows.has(dowOf(l.lesson_date)));
      if (drop.length) await env.DB.batch(drop.map((l) => env.DB.prepare('DELETE FROM lessons WHERE id = ?').bind(l.id)));
      await ensureLessons(env, b, { from: today });
    }
    return json({ ok: true });
  }

  // Storage use, per class and lesson, so Mary can see what to clear
  if (a === 'storage' && method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT c.id AS class_id, c.name AS class_name, l.id AS lesson_id, l.lesson_date,
        COALESCE((SELECT SUM(size_bytes) FROM materials m WHERE m.lesson_id = l.id), 0) AS material_bytes,
        COALESCE((SELECT SUM(size_bytes) FROM submissions s WHERE s.lesson_id = l.id), 0) AS homework_bytes,
        (SELECT COUNT(*) FROM submissions s WHERE s.lesson_id = l.id) AS homework_count
       FROM lessons l JOIN classes c ON c.id = l.class_id ORDER BY c.name, l.lesson_date`
    ).all();
    const total = rows.results.reduce((n, r) => n + r.material_bytes + r.homework_bytes, 0);
    return json({
      totalBytes: total,
      lessons: rows.results.map((r) => ({
        classId: r.class_id, className: r.class_name, lessonId: r.lesson_id, date: r.lesson_date,
        materialBytes: r.material_bytes, homeworkBytes: r.homework_bytes, homeworkCount: r.homework_count,
      })),
    });
  }

  // Delete a whole class: its lessons, students, files and homework. Needs the class name typed back.
  if (a === 'classes' && b && !c && method === 'DELETE') {
    const body = await readJson(request);
    const cls = await env.DB.prepare('SELECT id, name FROM classes WHERE id = ?').bind(b).first();
    if (!cls) throw new HttpError(404, 'Class not found');
    if (body.confirm !== cls.name) throw new HttpError(400, 'Type the class name to confirm');
    const keys = (
      await env.DB.prepare(
        `SELECT r2_key FROM materials WHERE lesson_id IN (SELECT id FROM lessons WHERE class_id = ?)
         UNION ALL SELECT r2_key FROM submissions WHERE lesson_id IN (SELECT id FROM lessons WHERE class_id = ?)`
      )
        .bind(b, b)
        .all()
    ).results.map((r) => r.r2_key);
    await env.DB.prepare('DELETE FROM classes WHERE id = ?').bind(b).run(); // cascades
    await deleteKeys(env, keys);
    return json({ ok: true, filesRemoved: keys.length });
  }

  // ---- lessons ----
  if (a === 'lessons' && b && !c && method === 'GET') {
    const l = await lessonById(env, b);
    const clsRow = await env.DB.prepare('SELECT token FROM classes WHERE id = ?').bind(l.class_id).first();
    const mats = await env.DB.prepare('SELECT id, name, size_bytes, content_type FROM materials WHERE lesson_id = ? ORDER BY created_at').bind(b).all();
    const subs = await env.DB.prepare(
      `SELECT sub.*, st.name AS student_name FROM submissions sub JOIN students st ON st.id = sub.student_id
       WHERE sub.lesson_id = ? ORDER BY sub.uploaded_at DESC`
    )
      .bind(b)
      .all();
    const roster = await activeRoster(env, l.class_id, l.lesson_date);
    const handed = new Set(subs.results.map((s) => s.student_id));
    return json({
      lesson: { id: l.id, classId: l.class_id, date: l.lesson_date, status: l.status, scoresShared: !!l.scores_shared, link: linkFor(clsRow.token) },
      materials: mats.results.map((m) => ({ id: m.id, name: m.name, size: m.size_bytes, contentType: m.content_type })),
      submissions: subs.results.map((s) => ({
        id: s.id, studentId: s.student_id, studentName: s.student_name, name: s.name, size: s.size_bytes,
        contentType: s.content_type, uploadedAt: s.uploaded_at, replacedAt: s.replaced_at,
        reviewed: !!s.reviewed, feedback: s.feedback,
      })),
      notHandedIn: roster.filter((s) => !handed.has(s.id)).map((s) => s.name),
      roster,
    });
  }

  if (a === 'lessons' && b && !c && method === 'PATCH') {
    const l = await lessonById(env, b);
    const body = await readJson(request);
    const date = body.date === undefined ? l.lesson_date : body.date;
    const status = body.status === undefined ? l.status : body.status;
    if (!isDate(date)) throw new HttpError(400, 'Bad date');
    if (!['draft', 'open', 'closed'].includes(status)) throw new HttpError(400, 'Bad status');
    await env.DB.prepare('UPDATE lessons SET lesson_date = ?, status = ? WHERE id = ?').bind(date, status, b).run();
    if (body.scoresShared !== undefined) await env.DB.prepare('UPDATE lessons SET scores_shared = ? WHERE id = ?').bind(body.scoresShared ? 1 : 0, b).run();
    return json({ ok: true });
  }

  if (a === 'lessons' && b && !c && method === 'DELETE') {
    await lessonById(env, b);
    const keys = [
      ...(await env.DB.prepare('SELECT r2_key FROM materials WHERE lesson_id = ?').bind(b).all()).results,
      ...(await env.DB.prepare('SELECT r2_key FROM submissions WHERE lesson_id = ?').bind(b).all()).results,
    ].map((r) => r.r2_key);
    await env.DB.prepare('DELETE FROM lessons WHERE id = ?').bind(b).run(); // cascades to rows
    await deleteKeys(env, keys);
    return json({ ok: true });
  }

  // Clear the homework of one lesson but keep the lesson and its reading
  if (a === 'lessons' && b && c === 'submissions' && method === 'DELETE') {
    await lessonById(env, b);
    const keys = (await env.DB.prepare('SELECT r2_key FROM submissions WHERE lesson_id = ?').bind(b).all()).results.map((r) => r.r2_key);
    await env.DB.prepare('DELETE FROM submissions WHERE lesson_id = ?').bind(b).run();
    await deleteKeys(env, keys);
    return json({ ok: true, filesRemoved: keys.length });
  }

  // ---- scores (the class report card Mary fills in during a lesson) ----
  if (a === 'lessons' && b && c === 'scores' && !d && method === 'GET') {
    const l = await lessonById(env, b);
    const roster = await activeRoster(env, l.class_id, l.lesson_date);
    const rows = (await env.DB.prepare('SELECT * FROM lesson_scores WHERE lesson_id = ?').bind(b).all()).results;
    const handed = new Set((await env.DB.prepare('SELECT DISTINCT student_id FROM submissions WHERE lesson_id = ?').bind(b).all()).results.map((r) => r.student_id));
    const byStudent = new Map(rows.map((r) => [r.student_id, r]));
    // include students who left but already have a score for this lesson
    const extra = rows.filter((r) => !roster.some((s) => s.id === r.student_id));
    const names = extra.length
      ? (await env.DB.prepare(`SELECT id, name FROM students WHERE id IN (${extra.map(() => '?').join(',')})`).bind(...extra.map((r) => r.student_id)).all()).results
      : [];
    const all = [...roster.map((s) => ({ id: s.id, name: s.name })), ...names];
    return json({
      shared: !!l.scores_shared,
      date: l.lesson_date,
      rows: all.map((s) => {
        const r = byStudent.get(s.id) || {};
        return {
          studentId: s.id, name: s.name, handedIn: handed.has(s.id),
          participation: r.participation ?? null, behavior: r.behavior ?? null,
          homework: r.homework === undefined || r.homework === null ? null : !!r.homework,
          activity: r.activity ?? null, understanding: r.understanding ?? null, comment: r.comment || '',
        };
      }),
    });
  }

  if (a === 'lessons' && b && c === 'scores' && d && method === 'PUT') {
    const l = await lessonById(env, b);
    const st = await env.DB.prepare('SELECT id FROM students WHERE id = ? AND class_id = ?').bind(d, l.class_id).first();
    if (!st) throw new HttpError(404, 'Student not found');
    const body = await readJson(request);
    const sets = [];
    const vals = [];
    for (const f of ['participation', 'behavior', 'activity', 'understanding']) {
      if (body[f] === undefined) continue;
      const v = body[f] === null ? null : Number(body[f]);
      if (v !== null && (!Number.isInteger(v) || v < 1 || v > 5)) throw new HttpError(400, 'Scores are 1 to 5');
      sets.push(f); vals.push(v);
    }
    if (body.homework !== undefined) {
      if (body.homework !== null && typeof body.homework !== 'boolean') throw new HttpError(400, 'Homework is yes or no');
      sets.push('homework'); vals.push(body.homework === null ? null : body.homework ? 1 : 0);
    }
    if (body.comment !== undefined) {
      sets.push('comment'); vals.push(String(body.comment ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 500));
    }
    if (!sets.length) throw new HttpError(400, 'Nothing to save');
    await env.DB.prepare('INSERT OR IGNORE INTO lesson_scores (lesson_id, student_id) VALUES (?, ?)').bind(b, d).run();
    await env.DB.prepare(`UPDATE lesson_scores SET ${sets.map((f) => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE lesson_id = ? AND student_id = ?`).bind(...vals, b, d).run();
    return json({ ok: true });
  }

  // Materials upload for a lesson
  if (a === 'lessons' && b && c === 'materials' && d === 'upload') {
    await lessonById(env, b);
    const prefix = `materials/${b}`;
    const step = rest[4];
    if (step === 'start' && method === 'POST') {
      const body = await readJson(request);
      return json(await startUpload(env, prefix, body.filename, Number(body.size)));
    }
    if (step === 'part' && method === 'PUT') return json(await uploadPart(env, request, prefix, url));
    if (step === 'abort' && method === 'POST') {
      await abortUpload(env, prefix, await readJson(request));
      return json({ ok: true });
    }
    if (step === 'complete' && method === 'POST') {
      const f = await completeUpload(env, prefix, await readJson(request));
      const id = uuid();
      await env.DB.prepare('INSERT INTO materials (id, lesson_id, name, r2_key, size_bytes, content_type) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, b, f.name, f.key, f.size, f.contentType)
        .run();
      return json({ id }, 201);
    }
  }

  if (a === 'materials' && b && !c && method === 'DELETE') {
    const m = await env.DB.prepare('SELECT r2_key FROM materials WHERE id = ?').bind(b).first();
    if (!m) throw new HttpError(404, 'File not found');
    await env.DB.prepare('DELETE FROM materials WHERE id = ?').bind(b).run();
    await deleteKeys(env, [m.r2_key]);
    return json({ ok: true });
  }

  if (a === 'materials' && b && c === 'file' && method === 'GET') {
    const m = await env.DB.prepare('SELECT r2_key, name, content_type FROM materials WHERE id = ?').bind(b).first();
    if (!m) throw new HttpError(404, 'File not found');
    return streamFile(env, request, m.r2_key, { name: m.name, contentType: m.content_type, download: url.searchParams.has('download') });
  }

  // ---- homework ----
  if (a === 'submissions' && b && c === 'file' && method === 'GET') {
    const s = await env.DB.prepare('SELECT r2_key, name, content_type FROM submissions WHERE id = ?').bind(b).first();
    if (!s) throw new HttpError(404, 'File not found');
    return streamFile(env, request, s.r2_key, { name: s.name, contentType: s.content_type, download: url.searchParams.has('download') });
  }

  if (a === 'submissions' && b && !c && method === 'PATCH') {
    const body = await readJson(request);
    const sub = await env.DB.prepare('SELECT id FROM submissions WHERE id = ?').bind(b).first();
    if (!sub) throw new HttpError(404, 'Not found');
    const fields = [];
    const vals = [];
    if (body.reviewed !== undefined) { fields.push('reviewed = ?'); vals.push(body.reviewed ? 1 : 0); }
    if (body.feedback !== undefined) { fields.push('feedback = ?'); vals.push(String(body.feedback).slice(0, 2000)); }
    if (fields.length) await env.DB.prepare(`UPDATE submissions SET ${fields.join(', ')} WHERE id = ?`).bind(...vals, b).run();
    return json({ ok: true });
  }

  // ---- student PINs ----
  if (a === 'students' && b && c === 'pin' && method === 'PUT') {
    const body = await readJson(request);
    const st = await env.DB.prepare('SELECT id FROM students WHERE id = ?').bind(b).first();
    if (!st) throw new HttpError(404, 'Student not found');
    await setPin(env, b, body.pin ?? null);
    return json({ ok: true });
  }

  throw new HttpError(404, 'Not found');
}
