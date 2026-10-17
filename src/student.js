// Student-facing API: everything under /api/l/:token/...
// The token in the link identifies the lesson. A student then picks their name
// (and enters a PIN if one is set) to get a session cookie.

import { HttpError, json, readJson, uuid } from './util.js';
import { clearSessionCookie, createStudentSession, getStudentSession } from './auth.js';
import { abortUpload, completeUpload, deleteKeys, startUpload, streamFile, uploadPart } from './files.js';

async function loadLesson(env, token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) throw new HttpError(404, 'Lesson not found');
  const lesson = await env.DB.prepare(
    `SELECT l.id, l.class_id, l.lesson_date, l.status, c.name AS class_name
     FROM lessons l JOIN classes c ON c.id = l.class_id
     WHERE l.token = ? AND l.status != 'draft'`
  )
    .bind(token)
    .first();
  if (!lesson) throw new HttpError(404, 'Lesson not found');
  return lesson;
}

async function requireStudent(request, env, lesson) {
  const s = await getStudentSession(request, env, lesson.id);
  if (!s) throw new HttpError(401, 'Pick your name first');
  return s;
}

function requireOpen(lesson) {
  if (lesson.status !== 'open') throw new HttpError(409, 'This lesson is closed, so work cannot be changed.');
}

async function hashPin(pin, salt) {
  const data = new TextEncoder().encode(`${salt}:${pin}`);
  const d = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function setPin(env, studentId, pin) {
  if (pin === null || pin === '') {
    await env.DB.prepare('UPDATE students SET pin_hash = NULL, pin_fails = 0, locked_until = NULL WHERE id = ?').bind(studentId).run();
    return;
  }
  if (!/^\d{4,6}$/.test(String(pin))) throw new HttpError(400, 'A PIN is 4 to 6 digits');
  const salt = uuid();
  await env.DB.prepare('UPDATE students SET pin_hash = ?, pin_fails = 0, locked_until = NULL WHERE id = ?')
    .bind(`${salt}:${await hashPin(pin, salt)}`, studentId)
    .run();
}

const submissionOut = (r) => ({
  id: r.id,
  name: r.name,
  size: r.size_bytes,
  contentType: r.content_type,
  uploadedAt: r.uploaded_at,
  replacedAt: r.replaced_at,
});

export async function handleStudent(request, env, url, token, rest) {
  const method = request.method;
  const lesson = await loadLesson(env, token);
  const prefixFor = (studentId) => `submissions/${lesson.id}/${studentId}`;

  // GET /api/l/:token  -> lesson info, roster, and (if signed in) own + class work
  if (rest.length === 0 && method === 'GET') {
    const students = await env.DB.prepare(
      `SELECT id, name, color, pin_hash IS NOT NULL AS has_pin FROM students
       WHERE class_id = ? AND added_on <= ? AND (left_on IS NULL OR left_on > ?)
       ORDER BY rowid`
    )
      .bind(lesson.class_id, lesson.lesson_date, lesson.lesson_date)
      .all();
    const out = {
      className: lesson.class_name,
      date: lesson.lesson_date,
      status: lesson.status,
      students: students.results.map((s) => ({ id: s.id, name: s.name, color: s.color, hasPin: !!s.has_pin })),
      me: null,
    };
    const sess = await getStudentSession(request, env, lesson.id);
    if (sess) {
      const me = out.students.find((s) => s.id === sess.studentId);
      if (me) {
        out.me = { id: me.id, name: me.name };
        const mats = await env.DB.prepare('SELECT id, name, size_bytes, content_type FROM materials WHERE lesson_id = ? ORDER BY created_at').bind(lesson.id).all();
        out.materials = mats.results.map((m) => ({ id: m.id, name: m.name, size: m.size_bytes, contentType: m.content_type }));
        const subs = await env.DB.prepare(
          `SELECT sub.*, st.name AS student_name FROM submissions sub JOIN students st ON st.id = sub.student_id
           WHERE sub.lesson_id = ? ORDER BY sub.uploaded_at DESC`
        )
          .bind(lesson.id)
          .all();
        const mine = subs.results.find((r) => r.student_id === me.id);
        out.mine = mine ? { ...submissionOut(mine), reviewed: !!mine.reviewed, feedback: mine.reviewed ? mine.feedback : null } : null;
        out.classwork = subs.results
          .filter((r) => r.student_id !== me.id)
          .map((r) => ({ ...submissionOut(r), studentName: r.student_name }));
      }
    }
    return json(out);
  }

  // POST /api/l/:token/login {studentId, pin}
  if (rest[0] === 'login' && method === 'POST') {
    const body = await readJson(request);
    const st = await env.DB.prepare(
      `SELECT id, pin_hash, pin_fails, locked_until FROM students
       WHERE id = ? AND class_id = ? AND added_on <= ? AND (left_on IS NULL OR left_on > ?)`
    )
      .bind(String(body.studentId || ''), lesson.class_id, lesson.lesson_date, lesson.lesson_date)
      .first();
    if (!st) throw new HttpError(404, 'Student not found');
    const now = new Date().toISOString();
    if (st.locked_until && st.locked_until > now) {
      throw new HttpError(429, 'Too many tries. Please wait a few minutes and try again.');
    }
    if (st.pin_hash) {
      const [salt, hash] = st.pin_hash.split(':');
      const ok = body.pin && (await hashPin(String(body.pin), salt)) === hash;
      if (!ok) {
        const fails = st.pin_fails + 1;
        const lock = fails >= 5 ? new Date(Date.now() + 10 * 60 * 1000).toISOString() : null;
        await env.DB.prepare('UPDATE students SET pin_fails = ?, locked_until = ? WHERE id = ?')
          .bind(lock ? 0 : fails, lock, st.id)
          .run();
        throw new HttpError(401, 'That PIN is not right');
      }
      await env.DB.prepare('UPDATE students SET pin_fails = 0, locked_until = NULL WHERE id = ?').bind(st.id).run();
    }
    const cookie = await createStudentSession(env, st.id, lesson.id, url);
    return json({ ok: true }, 200, { 'set-cookie': cookie });
  }

  if (rest[0] === 'logout' && method === 'POST') {
    const sess = await getStudentSession(request, env, lesson.id);
    if (sess) await env.DB.prepare('DELETE FROM student_sessions WHERE token_hash = ?').bind(sess.tokenHash).run();
    return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie(url) });
  }

  // From here on a signed-in student is required.
  const sess = await requireStudent(request, env, lesson);

  // GET /api/l/:token/materials/:id/file
  if (rest[0] === 'materials' && rest[2] === 'file' && method === 'GET') {
    const m = await env.DB.prepare('SELECT r2_key, name, content_type FROM materials WHERE id = ? AND lesson_id = ?').bind(rest[1], lesson.id).first();
    if (!m) throw new HttpError(404, 'File not found');
    return streamFile(env, request, m.r2_key, { name: m.name, contentType: m.content_type, download: url.searchParams.has('download') });
  }

  // GET /api/l/:token/submissions/:id/file  (own or classmates', same lesson only)
  if (rest[0] === 'submissions' && rest[2] === 'file' && method === 'GET') {
    const s = await env.DB.prepare('SELECT r2_key, name, content_type FROM submissions WHERE id = ? AND lesson_id = ?').bind(rest[1], lesson.id).first();
    if (!s) throw new HttpError(404, 'File not found');
    return streamFile(env, request, s.r2_key, { name: s.name, contentType: s.content_type, download: url.searchParams.has('download') });
  }

  // Uploads: start / part / complete / abort
  if (rest[0] === 'upload') {
    requireOpen(lesson);
    const prefix = prefixFor(sess.studentId);
    if (rest[1] === 'start' && method === 'POST') {
      const b = await readJson(request);
      return json(await startUpload(env, prefix, b.filename, Number(b.size)));
    }
    if (rest[1] === 'part' && method === 'PUT') return json(await uploadPart(env, request, prefix, url));
    if (rest[1] === 'abort' && method === 'POST') {
      await abortUpload(env, prefix, await readJson(request));
      return json({ ok: true });
    }
    if (rest[1] === 'complete' && method === 'POST') {
      const f = await completeUpload(env, prefix, await readJson(request));
      const old = await env.DB.prepare('SELECT id, r2_key FROM submissions WHERE lesson_id = ? AND student_id = ?').bind(lesson.id, sess.studentId).first();
      if (old) {
        await env.DB.prepare(
          `UPDATE submissions SET name = ?, r2_key = ?, size_bytes = ?, content_type = ?, uploaded_at = datetime('now'),
           replaced_at = datetime('now'), reviewed = 0, feedback = NULL WHERE id = ?`
        )
          .bind(f.name, f.key, f.size, f.contentType, old.id)
          .run();
        await deleteKeys(env, [old.r2_key]);
      } else {
        await env.DB.prepare(
          'INSERT INTO submissions (id, lesson_id, student_id, name, r2_key, size_bytes, content_type) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
          .bind(uuid(), lesson.id, sess.studentId, f.name, f.key, f.size, f.contentType)
          .run();
      }
      return json({ ok: true, replaced: !!old });
    }
  }

  // DELETE /api/l/:token/submission
  if (rest[0] === 'submission' && method === 'DELETE') {
    requireOpen(lesson);
    const old = await env.DB.prepare('SELECT id, r2_key FROM submissions WHERE lesson_id = ? AND student_id = ?').bind(lesson.id, sess.studentId).first();
    if (old) {
      await env.DB.prepare('DELETE FROM submissions WHERE id = ?').bind(old.id).run();
      await deleteKeys(env, [old.r2_key]);
    }
    return json({ ok: true });
  }

  throw new HttpError(404, 'Not found');
}
