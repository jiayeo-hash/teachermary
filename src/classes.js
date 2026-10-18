// Class helpers shared by the teacher API, student API and the nightly job:
// today's date in the school's time zone, weekly schedules, and automatic lessons.

import { HttpError, randomToken, uuid } from './util.js';

export const HORIZON_DAYS = 14; // lessons are created this far ahead

export function todayIn(env, now = new Date()) {
  const tz = env.TIMEZONE || 'Australia/Sydney';
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function dowOf(iso) {
  return new Date(iso + 'T00:00:00Z').getUTCDay();
}

// [{dow: 0-6, time: "HH:MM"}] -> cleaned list (one entry per weekday), or throws.
export function cleanSchedule(input) {
  if (!Array.isArray(input) || input.length > 7) throw new HttpError(400, 'Bad schedule');
  const seen = new Set();
  const out = [];
  for (const e of input) {
    const dow = Number(e && e.dow);
    const time = String((e && e.time) || '');
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) throw new HttpError(400, 'Bad weekday');
    if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new HttpError(400, 'Bad time');
    if (seen.has(dow)) continue;
    seen.add(dow);
    out.push({ dow, time });
  }
  return out.sort((a, b) => a.dow - b.dow);
}

export function readSchedule(row) {
  try {
    return JSON.parse(row.schedule || '[]');
  } catch {
    return [];
  }
}

// Lesson is closed by hand, or the class closes lessons N days after their date.
export function effectiveStatus(lesson, cls, today) {
  if (lesson.status === 'closed') return 'closed';
  if (cls.auto_close_days != null && lesson.lesson_date < addDays(today, -Number(cls.auto_close_days))) return 'closed';
  return lesson.status;
}

// Create the lessons the weekly schedule calls for, up to HORIZON_DAYS ahead.
// Only dates after generated_until are considered, so a lesson Mary deleted stays deleted.
export async function ensureLessons(env, classId, { from } = {}) {
  const cls = await env.DB.prepare('SELECT id, schedule, generated_until FROM classes WHERE id = ?').bind(classId).first();
  if (!cls) return 0;
  const today = todayIn(env);
  const horizon = addDays(today, HORIZON_DAYS);
  const sched = readSchedule(cls);
  let start = from || (cls.generated_until ? addDays(cls.generated_until, 1) : today);
  if (start > horizon) return 0;
  let made = 0;
  if (sched.length) {
    const dows = new Set(sched.map((s) => s.dow));
    const have = new Set(
      (await env.DB.prepare('SELECT lesson_date FROM lessons WHERE class_id = ? AND lesson_date >= ?').bind(classId, start).all()).results.map((r) => r.lesson_date)
    );
    const stmts = [];
    for (let d = start; d <= horizon; d = addDays(d, 1)) {
      if (!dows.has(dowOf(d)) || have.has(d)) continue;
      stmts.push(
        env.DB.prepare("INSERT INTO lessons (id, class_id, token, lesson_date, status, auto) VALUES (?, ?, ?, ?, 'open', 1)").bind(
          uuid(), classId, randomToken(24), d
        )
      );
    }
    if (stmts.length) await env.DB.batch(stmts);
    made = stmts.length;
  }
  await env.DB.prepare('UPDATE classes SET generated_until = ? WHERE id = ?').bind(horizon, classId).run();
  return made;
}

export async function ensureAllLessons(env) {
  const all = await env.DB.prepare("SELECT id FROM classes WHERE schedule != '[]'").all();
  let made = 0;
  for (const c of all.results) made += await ensureLessons(env, c.id);
  return made;
}
