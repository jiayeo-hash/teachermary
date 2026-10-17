// Teacher auth: Cloudflare Access puts a signed JWT in Cf-Access-Jwt-Assertion.
// We verify it ourselves too, so the API is safe even if the Access rule is
// ever changed by mistake. Student auth: a random session cookie.

import { HttpError, parseCookies, randomToken, sha256hex } from './util.js';

const jwksCache = new Map(); // team domain -> { keys, fetchedAt }

function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function decodePart(s) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

async function getKeys(team) {
  const hit = jwksCache.get(team);
  if (hit && Date.now() - hit.fetchedAt < 60 * 60 * 1000) return hit.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new HttpError(503, 'Cannot reach login service');
  const { keys } = await res.json();
  jwksCache.set(team, { keys, fetchedAt: Date.now() });
  return keys;
}

// Returns the teacher's email, or throws 401/403.
export async function requireTeacher(request, env) {
  // Local development only: set DEV_TEACHER_EMAIL in .dev.vars. Never set in production.
  if (env.DEV_TEACHER_EMAIL) return env.DEV_TEACHER_EMAIL.toLowerCase();

  const team = env.ACCESS_TEAM_DOMAIN; // e.g. "myteam.cloudflareaccess.com"
  const aud = env.ACCESS_AUD;
  const allowed = String(env.TEACHER_EMAILS || '')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!team || !aud || allowed.length === 0) throw new HttpError(503, 'Teacher login is not configured');

  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) throw new HttpError(401, 'Sign in required');
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) throw new HttpError(401, 'Bad token');

  let header, payload;
  try {
    header = decodePart(h);
    payload = decodePart(p);
  } catch {
    throw new HttpError(401, 'Bad token');
  }
  if (header.alg !== 'RS256') throw new HttpError(401, 'Bad token');

  const keys = await getKeys(team);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new HttpError(401, 'Unknown key');
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(s),
    new TextEncoder().encode(`${h}.${p}`)
  );
  if (!ok) throw new HttpError(401, 'Bad signature');

  const now = Math.floor(Date.now() / 1000);
  const audList = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.exp && payload.exp < now) throw new HttpError(401, 'Session expired');
  if (!audList.includes(aud)) throw new HttpError(403, 'Wrong application');
  if (payload.iss !== `https://${team}`) throw new HttpError(403, 'Wrong issuer');
  const email = String(payload.email || '').toLowerCase();
  if (!allowed.includes(email)) throw new HttpError(403, 'Not allowed');
  return email;
}

// ---- Students ----

const SESSION_COOKIE = 'tm_s';
const SESSION_DAYS = 30;

export async function createStudentSession(env, studentId, lessonId, url) {
  const token = randomToken(32);
  const hash = await sha256hex(token);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400 * 1000).toISOString();
  await env.DB.prepare(
    'INSERT INTO student_sessions (token_hash, student_id, lesson_id, expires_at) VALUES (?, ?, ?, ?)'
  )
    .bind(hash, studentId, lessonId, expires)
    .run();
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}

// Returns { studentId } for a valid session on this lesson, else null.
export async function getStudentSession(request, env, lessonId) {
  const token = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE];
  if (!token) return null;
  const hash = await sha256hex(token);
  const row = await env.DB.prepare(
    'SELECT student_id, lesson_id, expires_at FROM student_sessions WHERE token_hash = ?'
  )
    .bind(hash)
    .first();
  if (!row || row.expires_at < new Date().toISOString()) return null;
  // A session is tied to one student, who may only use lessons of their own class.
  const ok = await env.DB.prepare(
    `SELECT 1 AS ok FROM lessons l JOIN students s ON s.class_id = l.class_id
     WHERE l.id = ? AND s.id = ? AND s.added_on <= l.lesson_date AND (s.left_on IS NULL OR s.left_on > l.lesson_date)`
  )
    .bind(lessonId, row.student_id)
    .first();
  return ok ? { studentId: row.student_id, tokenHash: hash } : null;
}

export function clearSessionCookie(url) {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}
