// Student-facing API: everything under /api/l/:token/...
// The token in the link identifies the class (one permanent link per class). A student then
// picks their name (and enters a PIN if one is set) to get a session cookie.

import { HttpError, json, readJson, uuid } from './util.js';
import { effectiveStatus, readSchedule, todayIn } from './classes.js';
import { clearSessionCookie, createStudentSession, getStudentSession } from './auth.js';
import { abortUpload, completeUpload, deleteKeys, startUpload, streamFile, uploadPart } from './files.js';

async function loadClass(env, token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) throw new HttpError(404, 'Class not found');
  let cls = await env.DB.prepare('SELECT id, name, schedule, multi, auto_close_days FROM classes WHERE token = ?').bind(token).first();
  if (!cls) {
    // Links made before classes had one permanent link still open that class.
    cls = await env.DB.prepare(
      `SELECT c.id, c.name, c.schedule, c.multi, c.auto_close_days FROM lessons l JOIN classes c ON c.id = l.class_id WHERE l.token = ?`
    )
      .bind(token)
      .first();
  }
  if (!cls) throw new HttpError(404, 'Class not found');
  return cls;
}

const VISIBLE = `l.class_id = ? AND l.status != 'draft' AND (l.lesson_date <= ? OR EXISTS (SELECT 1 FROM materials m WHERE m.lesson_id = l.id))`;
const MAX_FILES = 10;

async function requireStudent(request, env, cls, today) {
  const s = await getStudentSession(request, env, cls.id, today);
  if (!s) throw new HttpError(401, 'Pick your name first');
  return s;
}

async function visibleLesson(env, cls, lessonId, today) {
  const l = await env.DB.prepare(`SELECT l.id, l.lesson_date, l.status FROM lessons l WHERE l.id = ? AND ${VISIBLE.replace('l.class_id = ?', 'l.class_id = ?')}`)
    .bind(String(lessonId || ''), cls.id, today)
    .first();
  if (!l) throw new HttpError(404, 'Lesson not found');
  return l;
}

function requireOpen(lesson, cls, today) {
  if (effectiveStatus(lesson, cls, today) !== 'open') throw new HttpError(409, 'This lesson is closed, so work cannot be changed.');
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
  const cls = await loadClass(env, token);
  const today = todayIn(env);

  // GET /api/l/:token  -> class info, roster, and (if signed in) the lesson list
  if (rest.length === 0 && method === 'GET') {
    const students = await env.DB.prepare(
      `SELECT id, name, color, pin_hash IS NOT NULL AS has_pin FROM students
       WHERE class_id = ? AND added_on <= ? AND (left_on IS NULL OR left_on > ?) ORDER BY rowid`
    )
      .bind(cls.id, today, today)
      .all();
    const out = {
      className: cls.name,
      today,
      multi: !!cls.multi,
      maxFiles: MAX_FILES,
      schedule: readSchedule(cls),
      students: students.results.map((s) => ({ id: s.id, name: s.name, color: s.color, hasPin: !!s.has_pin })),
      me: null,
    };
    const sess = await getStudentSession(request, env, cls.id, today);
    const me = sess && out.students.find((s) => s.id === sess.studentId);
    if (me) {
      out.me = { id: me.id, name: me.name };
      const rows = await env.DB.prepare(
        `SELECT l.id, l.lesson_date, l.status,
           (SELECT COUNT(*) FROM materials m WHERE m.lesson_id = l.id) AS materials,
           (SELECT COUNT(*) FROM submissions s WHERE s.lesson_id = l.id AND s.student_id = ?) AS mine
         FROM lessons l WHERE ${VISIBLE} ORDER BY l.lesson_date DESC, l.created_at DESC`
      )
        .bind(me.id, cls.id, today)
        .all();
      out.lessons = rows.results.map((l) => ({
        id: l.id, date: l.lesson_date, status: effectiveStatus(l, cls, today), materials: l.materials, mine: l.mine,
      }));
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
      .bind(String(body.studentId || ''), cls.id, today, today)
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
    const cookie = await createStudentSession(env, st.id, cls.id, url);
    return json({ ok: true }, 200, { 'set-cookie': cookie });
  }

  if (rest[0] === 'logout' && method === 'POST') {
    const sess = await getStudentSession(request, env, cls.id, today);
    if (sess) await env.DB.prepare('DELETE FROM student_sessions WHERE token_hash = ?').bind(sess.tokenHash).run();
    return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie(url) });
  }

  // From here on a signed-in student is required.
  const sess = await requireStudent(request, env, cls, today);

  // GET /api/l/:token/lessons/:id  -> reading, my files, classmates' files
  if (rest[0] === 'lessons' && rest[1] && rest.length === 2 && method === 'GET') {
    const lesson = await visibleLesson(env, cls, rest[1], today);
    const mats = await env.DB.prepare('SELECT id, name, size_bytes, content_type FROM materials WHERE lesson_id = ? ORDER BY created_at').bind(lesson.id).all();
    const subs = await env.DB.prepare(
      `SELECT sub.*, st.name AS student_name FROM submissions sub JOIN students st ON st.id = sub.student_id
       WHERE sub.lesson_id = ? ORDER BY sub.uploaded_at DESC`
    )
      .bind(lesson.id)
      .all();
    return json({
      id: lesson.id,
      date: lesson.lesson_date,
      status: effectiveStatus(lesson, cls, today),
      materials: mats.results.map((m) => ({ id: m.id, name: m.name, size: m.size_bytes, contentType: m.content_type })),
      mine: subs.results
        .filter((r) => r.student_id === sess.studentId)
        .map((r) => ({ ...submissionOut(r), reviewed: !!r.reviewed, feedback: r.reviewed ? r.feedback : null })),
      classwork: subs.results
        .filter((r) => r.student_id !== sess.studentId)
        .map((r) => ({ ...submissionOut(r), studentName: r.student_name })),
    });
  }

  // GET /api/l/:token/materials/:id/file
  if (rest[0] === 'materials' && rest[2] === 'file' && method === 'GET') {
    const m = await env.DB.prepare(
      `SELECT m.r2_key, m.name, m.content_type FROM materials m JOIN lessons l ON l.id = m.lesson_id
       WHERE m.id = ? AND ${VISIBLE}`
    )
      .bind(rest[1], cls.id, today)
      .first();
    if (!m) throw new HttpError(404, 'File not found');
    return streamFile(env, request, m.r2_key, { name: m.name, contentType: m.content_type, download: url.searchParams.has('download') });
  }

  // GET /api/l/:token/submissions/:id/file  (own or classmates', same class)
  if (rest[0] === 'submissions' && rest[2] === 'file' && method === 'GET') {
    const s = await env.DB.prepare(
      `SELECT sub.r2_key, sub.name, sub.content_type FROM submissions sub JOIN lessons l ON l.id = sub.lesson_id
       WHERE sub.id = ? AND ${VISIBLE}`
    )
      .bind(rest[1], cls.id, today)
      .first();
    if (!s) throw new HttpError(404, 'File not found');
    return streamFile(env, request, s.r2_key, { name: s.name, contentType: s.content_type, download: url.searchParams.has('download') });
  }

  // Everything below changes one lesson: /api/l/:token/lessons/:lessonId/...
  if (rest[0] === 'lessons' && rest[1]) {
    const lesson = await visibleLesson(env, cls, rest[1], today);
    const prefix = `submissions/${lesson.id}/${sess.studentId}`;

    // Uploads: upload/start | part | complete | abort
    if (rest[2] === 'upload') {
      requireOpen(lesson, cls, today);
      if (rest[3] === 'start' && method === 'POST') {
        if (cls.multi) {
          const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM submissions WHERE lesson_id = ? AND student_id = ?').bind(lesson.id, sess.studentId).first();
          if (n.n >= MAX_FILES) throw new HttpError(409, `You can hand in up to ${MAX_FILES} files. Delete one to add another.`);
        }
        const b = await readJson(request);
        return json(await startUpload(env, prefix, b.filename, Number(b.size)));
      }
      if (rest[3] === 'part' && method === 'PUT') return json(await uploadPart(env, request, prefix, url));
      if (rest[3] === 'abort' && method === 'POST') {
        await abortUpload(env, prefix, await readJson(request));
        return json({ ok: true });
      }
      if (rest[3] === 'complete' && method === 'POST') {
        const f = await completeUpload(env, prefix, await readJson(request));
        let replaced = false;
        if (!cls.multi) {
          // one file per lesson: the new file replaces any earlier one
          const old = await env.DB.prepare('SELECT id, r2_key FROM submissions WHERE lesson_id = ? AND student_id = ?').bind(lesson.id, sess.studentId).all();
          if (old.results.length) {
            replaced = true;
            await env.DB.batch(old.results.map((o) => env.DB.prepare('DELETE FROM submissions WHERE id = ?').bind(o.id)));
            await deleteKeys(env, old.results.map((o) => o.r2_key));
          }
        }
        await env.DB.prepare(
          'INSERT INTO submissions (id, lesson_id, student_id, name, r2_key, size_bytes, content_type, replaced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
          .bind(uuid(), lesson.id, sess.studentId, f.name, f.key, f.size, f.contentType, replaced ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null)
          .run();
        return json({ ok: true, replaced });
      }
    }

    // DELETE /api/l/:token/lessons/:lessonId/submissions/:id  (own files only)
    if (rest[2] === 'submissions' && rest[3] && method === 'DELETE') {
      requireOpen(lesson, cls, today);
      const old = await env.DB.prepare('SELECT id, r2_key FROM submissions WHERE id = ? AND lesson_id = ? AND student_id = ?')
        .bind(rest[3], lesson.id, sess.studentId)
        .first();
      if (old) {
        await env.DB.prepare('DELETE FROM submissions WHERE id = ?').bind(old.id).run();
        await deleteKeys(env, [old.r2_key]);
      }
      return json({ ok: true });
    }
  }

  throw new HttpError(404, 'Not found');
}
