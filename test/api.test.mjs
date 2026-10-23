// End-to-end API test against `wrangler dev --local` (http://localhost:8787).
// Run: npm run dev  (in another terminal), then npm test

import { execSync } from 'node:child_process';

const BASE = process.env.BASE || 'http://localhost:8787';
// Is this key still in the local R2 bucket? (uses wrangler against the same local state)
const r2Exists = (key) => {
  try {
    execSync(`npx wrangler r2 object get teachermary-files/${key} --local --file /dev/null`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};
let failures = 0;
const check = (label, ok, extra) => {
  if (!ok) failures++;
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (!ok && extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
};

async function api(path, { method = 'GET', body, cookie, headers = {}, raw } = {}) {
  const h = { origin: BASE, ...headers };
  let payload = raw;
  if (body !== undefined) {
    h['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (cookie) h.cookie = cookie;
  // execSync (r2Exists) can stall the event loop long enough for a kept-alive socket to be closed; retry once.
  let res;
  try {
    res = await fetch(BASE + path, { method, headers: h, body: payload });
  } catch {
    res = await fetch(BASE + path, { method, headers: h, body: payload });
  }
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) data = await res.json();
  return { res, status: res.status, data, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

// Upload through the same chunked flow the browser will use.
async function upload(base, filename, bytes, { cookie, completeExtra = {} } = {}) {
  const start = await api(`${base}/start`, { method: 'POST', body: { filename, size: bytes.length }, cookie });
  if (start.status !== 200) return { start };
  const { uploadId, key, partSize } = start.data;
  const parts = [];
  for (let i = 0, n = 1; i < bytes.length; i += partSize, n++) {
    const chunk = bytes.subarray(i, Math.min(i + partSize, bytes.length));
    const r = await api(`${base}/part?uploadId=${encodeURIComponent(uploadId)}&key=${encodeURIComponent(key)}&n=${n}`, {
      method: 'PUT', raw: chunk, cookie, headers: { 'content-type': 'application/octet-stream' },
    });
    if (r.status !== 200) return { start, part: r };
    parts.push(r.data);
  }
  const done = await api(`${base}/complete`, { method: 'POST', body: { key, uploadId, parts, filename, size: bytes.length, ...completeExtra }, cookie });
  return { start, done, key };
}

const rand = (n) => { const b = new Uint8Array(n); for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(i + 65536, n))); return b; };

// ---------- teacher: set up ----------
const sydToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addD = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dow = (iso) => new Date(iso + 'T00:00:00Z').getUTCDay();
const today = sydToday();

const me = await api('/api/teacher/me');
check('teacher /me works (dev login)', me.status === 200 && me.data.email);

// ---------- recurring class ----------
const cA = await api('/api/teacher/classes', {
  method: 'POST',
  body: { name: 'Class A', students: ['Linh T.', 'Minh A.', 'An P.'], schedule: [{ dow: 2, time: '19:00' }, { dow: 6, time: '19:00' }] },
});
check('create class A with a Tue + Sat schedule', cA.status === 201 && /^\/l\/[A-Za-z0-9_-]{30,}$/.test(cA.data.link) && cA.data.lessonsCreated >= 4, cA.data);
const classA = cA.data.id;
const tokenA = cA.data.link.split('/')[2];
let clsA = await api(`/api/teacher/classes/${classA}`);
check('lessons were made only on Tue and Sat, within 2 weeks', clsA.data.lessons.length === cA.data.lessonsCreated && clsA.data.lessons.every((l) => [2, 6].includes(dow(l.date)) && l.date <= addD(today, 14) && l.date >= today && l.auto), clsA.data.lessons.map((l) => l.date));
check('class link is permanent and shown on the class', clsA.data.class.link === cA.data.link);
const n0 = clsA.data.lessons.length;
clsA = await api(`/api/teacher/classes/${classA}`);
check('opening the class again does not duplicate lessons', clsA.data.lessons.length === n0);
const gone = clsA.data.lessons[0];
await api(`/api/teacher/lessons/${gone.id}`, { method: 'DELETE' });
clsA = await api(`/api/teacher/classes/${classA}`);
check('a lesson Mary deleted (day off) does not come back', clsA.data.lessons.length === n0 - 1 && !clsA.data.lessons.some((l) => l.date === gone.date));
const sat = await api(`/api/teacher/classes/${classA}`, { method: 'PATCH', body: { schedule: [{ dow: 2, time: '19:00' }] } });
clsA = await api(`/api/teacher/classes/${classA}`);
check('dropping Saturday removes its empty future lessons', sat.status === 200 && clsA.data.lessons.every((l) => dow(l.date) === 2), clsA.data.lessons.map((l) => l.date));
await api(`/api/teacher/classes/${classA}`, { method: 'PATCH', body: { schedule: [{ dow: 2, time: '19:00' }, { dow: 6, time: '19:00' }] } });
clsA = await api(`/api/teacher/classes/${classA}`);
check('adding Saturday back creates them again', clsA.data.lessons.some((l) => dow(l.date) === 6));
check('bad schedule refused', (await api(`/api/teacher/classes/${classA}`, { method: 'PATCH', body: { schedule: [{ dow: 9, time: '19:00' }] } })).status === 400);

// A one-off (replacement) lesson yesterday, so students can see it; plus a future one without reading
const L1 = await api(`/api/teacher/classes/${classA}/lessons`, { method: 'POST', body: { date: addD(today, -1) } });
check('extra lesson on another date', L1.status === 201, L1.data);
const lessonA = L1.data.id;
const future = await api(`/api/teacher/classes/${classA}/lessons`, { method: 'POST', body: { date: addD(today, 20) } });
const draft = await api(`/api/teacher/classes/${classA}/lessons`, { method: 'POST', body: { date: addD(today, -2), status: 'draft' } });

// materials: 17 MB file => 3 parts
const mat = await upload(`/api/teacher/lessons/${lessonA}/materials/upload`, 'Reading.pdf', rand(17 * 1024 * 1024));
check('teacher uploads 17 MB reading in 3 chunks', mat.done?.status === 201, mat.done || mat);
const bad = await upload(`/api/teacher/lessons/${lessonA}/materials/upload`, 'evil.html', rand(100));
check('html upload is refused', bad.start?.status === 415, bad.start?.data);
const ppt = await upload(`/api/teacher/lessons/${draft.data.id}/materials/upload`, 'Slides.pptx', rand(3000));
check('PowerPoint (.pptx) upload is accepted', ppt.done?.status === 201, ppt.done || ppt.start);
const bigLie = await api(`/api/teacher/lessons/${lessonA}/materials/upload/start`, { method: 'POST', body: { filename: 'a.mp4', size: 5 * 1024 ** 3 } });
check('over 1 GB refused', bigLie.status === 413);

const cB = await api('/api/teacher/classes', { method: 'POST', body: { name: 'Class B', students: ['Hà P.'] } });
const tokenB = cB.data.link.split('/')[2];
check('every class has its own link', tokenA !== tokenB);

// ---------- origin / csrf ----------
const cross = await api('/api/teacher/classes', { method: 'POST', body: { name: 'x' }, headers: { origin: 'https://evil.example' } });
check('cross-origin write refused', cross.status === 403);

// ---------- student ----------
const info0 = await api(`/api/l/${tokenA}`);
check('class link shows class + roster, no lessons before sign-in', info0.status === 200 && info0.data.students.length === 3 && !info0.data.lessons && !info0.data.me, info0.data);
check('bad token is 404', (await api('/api/l/' + 'x'.repeat(40))).status === 404);

const linh = info0.data.students.find((s) => s.name === 'Linh T.');
const minh = info0.data.students.find((s) => s.name === 'Minh A.');
check('no access without name', (await api(`/api/l/${tokenA}/lessons/${lessonA}`)).status === 401);

// PIN
const pinSet = await api(`/api/teacher/students/${linh.id}/pin`, { method: 'PUT', body: { pin: '4821' } });
check('teacher sets a PIN', pinSet.status === 200);
check('PIN must be digits', (await api(`/api/teacher/students/${linh.id}/pin`, { method: 'PUT', body: { pin: 'abcd' } })).status === 400);
check('roster shows hasPin', (await api(`/api/l/${tokenA}`)).data.students.find((s) => s.id === linh.id).hasPin === true);
const wrong = await api(`/api/l/${tokenA}/login`, { method: 'POST', body: { studentId: linh.id, pin: '0000' } });
check('wrong PIN rejected', wrong.status === 401);
for (let i = 0; i < 5; i++) await api(`/api/l/${tokenA}/login`, { method: 'POST', body: { studentId: linh.id, pin: '1111' } });
const afterLock = await api(`/api/l/${tokenA}/login`, { method: 'POST', body: { studentId: linh.id, pin: '4821' } });
check('5 wrong PINs lock the student out (even the right PIN)', afterLock.status === 429, afterLock.data);
await api(`/api/teacher/students/${linh.id}/pin`, { method: 'PUT', body: { pin: '4821' } });
const good = await api(`/api/l/${tokenA}/login`, { method: 'POST', body: { studentId: linh.id, pin: '4821' } });
check('right PIN signs in and sets HttpOnly cookie', good.status === 200 && good.res.headers.get('set-cookie').includes('HttpOnly'), good.data);
let linhCookie = good.cookie;
const minhLogin = await api(`/api/l/${tokenA}/login`, { method: 'POST', body: { studentId: minh.id } });
check('student without PIN signs in by name', minhLogin.status === 200);
const minhCookie = minhLogin.cookie;

// ---- scores ----
const sBase = `/api/teacher/lessons/${lessonA}/scores`;
const sg0 = await api(sBase);
check('scores list has the roster', sg0.status === 200 && sg0.data.rows.length === 3 && sg0.data.shared === false, sg0.data);
check('score out of range rejected', (await api(`${sBase}/${linh.id}`, { method: 'PUT', body: { participation: 6 } })).status === 400);
check('score must be whole', (await api(`${sBase}/${linh.id}`, { method: 'PUT', body: { behavior: 3.5 } })).status === 400);
check('homework must be yes/no', (await api(`${sBase}/${linh.id}`, { method: 'PUT', body: { homework: 'maybe' } })).status === 400);
check('unknown student rejected', (await api(`${sBase}/nope`, { method: 'PUT', body: { behavior: 3 } })).status === 404);
check('Linh scored', (await api(`${sBase}/${linh.id}`, { method: 'PUT', body: { participation: 5, behavior: 4, homework: true, activity: 3, understanding: 5, comment: 'Great reading today' } })).status === 200);
check('Minh scored', (await api(`${sBase}/${minh.id}`, { method: 'PUT', body: { participation: 2, homework: false } })).status === 200);
check('partial update keeps other fields', (await api(`${sBase}/${linh.id}`, { method: 'PUT', body: { behavior: 5 } })).status === 200 && (await api(sBase)).data.rows.find((r) => r.studentId === linh.id).participation === 5);
check('score can be cleared (N/A)', (await api(`${sBase}/${linh.id}`, { method: 'PUT', body: { activity: null } })).status === 200 && (await api(sBase)).data.rows.find((r) => r.studentId === linh.id).activity === null);
const hidden = await api(`/api/l/${tokenA}/scores`, { cookie: linhCookie });
check('scores hidden until shared', hidden.status === 200 && hidden.data.scores.length === 0, hidden.data);
check('share scores', (await api(`/api/teacher/lessons/${lessonA}`, { method: 'PATCH', body: { scoresShared: true } })).status === 200);
const mine = await api(`/api/l/${tokenA}/scores`, { cookie: linhCookie });
check('PIN student sees own shared scores only', mine.data.scores.length === 1 && mine.data.scores[0].participation === 5 && mine.data.scores[0].behavior === 5 && mine.data.scores[0].homework === true && mine.data.scores[0].comment === 'Great reading today', mine.data);
check('no classmates in the payload', !JSON.stringify(mine.data).includes('Minh'));
const noPin = await api(`/api/l/${tokenA}/scores`, { cookie: minhCookie });
check('student without PIN cannot see scores', noPin.data.needsPin === true && noPin.data.scores.length === 0, noPin.data);
check('scores need sign-in', (await api(`/api/l/${tokenA}/scores`)).status === 401);
check('unsharing hides again', (await api(`/api/teacher/lessons/${lessonA}`, { method: 'PATCH', body: { scoresShared: false } })).status === 200 && (await api(`/api/l/${tokenA}/scores`, { cookie: linhCookie })).data.scores.length === 0);
await api(`/api/teacher/lessons/${lessonA}`, { method: 'PATCH', body: { scoresShared: true } });
await api(`/api/teacher/students/${linh.id}/pin`, { method: 'PUT', body: { pin: '4821' } });
check('changing PIN signs out old sessions', (await api(`/api/l/${tokenA}/scores`, { cookie: linhCookie })).status === 401);
const relog = await api(`/api/l/${tokenA}/login`, { method: 'POST', body: { studentId: linh.id, pin: '4821' } });
check('can sign in again after PIN change', relog.status === 200);
linhCookie = relog.cookie;


const info1 = await api(`/api/l/${tokenA}`, { cookie: linhCookie });
const ids1 = info1.data.lessons?.map((l) => l.id) || [];
check('signed in: sees the past lesson with reading', info1.data.me?.name === 'Linh T.' && ids1.includes(lessonA) && info1.data.lessons.find((l) => l.id === lessonA).materials === 1, info1.data.lessons);
check('lessons are newest first', info1.data.lessons.every((l, i, a) => i === 0 || a[i - 1].date >= l.date));
check('draft lessons are hidden', !ids1.includes(draft.data.id));
check('future lesson with no reading is hidden', !ids1.includes(future.data.id));
check('the 2-week auto lessons without reading are hidden', info1.data.lessons.every((l) => l.date <= today || l.materials > 0));
await upload(`/api/teacher/lessons/${future.data.id}/materials/upload`, 'Next week.pdf', rand(500));
check('future lesson appears once reading is added', (await api(`/api/l/${tokenA}`, { cookie: linhCookie })).data.lessons.some((l) => l.id === future.data.id));
check('draft lesson cannot be opened by id', (await api(`/api/l/${tokenA}/lessons/${draft.data.id}`, { cookie: linhCookie })).status === 404);

const det = await api(`/api/l/${tokenA}/lessons/${lessonA}`, { cookie: linhCookie });
check('lesson detail has reading, no homework yet', det.data.materials.length === 1 && det.data.mine.length === 0 && det.data.status === 'open', det.data);

// download material with Range
const matId = det.data.materials[0].id;
const full = await fetch(`${BASE}/api/l/${tokenA}/materials/${matId}/file`, { headers: { cookie: linhCookie } });
check('material download works', full.status === 200 && Number(full.headers.get('content-length')) === 17 * 1024 * 1024 && /script-src 'none'|sandbox/.test(full.headers.get('content-security-policy')));
await full.arrayBuffer();
const part = await fetch(`${BASE}/api/l/${tokenA}/materials/${matId}/file`, { headers: { cookie: linhCookie, range: 'bytes=100-199' } });
const partBytes = new Uint8Array(await part.arrayBuffer());
check('Range request returns 206 with exact bytes', part.status === 206 && partBytes.length === 100 && part.headers.get('content-range') === `bytes 100-199/${17 * 1024 * 1024}`);
const suffix = await fetch(`${BASE}/api/l/${tokenA}/materials/${matId}/file`, { headers: { cookie: linhCookie, range: 'bytes=-10' } });
check('suffix range works', suffix.status === 206 && (await suffix.arrayBuffer()).byteLength === 10);
const badRange = await fetch(`${BASE}/api/l/${tokenA}/materials/${matId}/file`, { headers: { cookie: linhCookie, range: 'bytes=99999999999-' } });
check('out of range gives 416', badRange.status === 416);

// homework upload (one file per lesson by default)
const UP = (lid) => `/api/l/${tokenA}/lessons/${lid}/upload`;
const video = rand(9 * 1024 * 1024);
const up = await upload(UP(lessonA), 'speaking.mp4', video, { cookie: linhCookie });
check('student uploads 9 MB video (2 chunks)', up.done?.status === 200 && up.done.data.replaced === false, up.done || up);
const up2 = await upload(UP(lessonA), 'speaking2.mp4', rand(1024 * 1024), { cookie: linhCookie });
check('single-file class: new upload replaces the old one', up2.done?.status === 200 && up2.done.data.replaced === true, up2.done);
const d2 = await api(`/api/l/${tokenA}/lessons/${lessonA}`, { cookie: linhCookie });
check('only the new file is listed', d2.data.mine.length === 1 && d2.data.mine[0].name === 'speaking2.mp4' && d2.data.mine[0].replacedAt);
check('replaced file is deleted from storage, new one kept', r2Exists(up.key) === false && r2Exists(up2.key) === true);

// multiple files switched on by Mary
const on = await api(`/api/teacher/classes/${classA}`, { method: 'PATCH', body: { multi: true } });
check('teacher turns on several files', on.status === 200 && (await api(`/api/l/${tokenA}`)).data.multi === true);
const up3 = await upload(UP(lessonA), 'page2.pdf', rand(2000), { cookie: linhCookie });
const d3 = await api(`/api/l/${tokenA}/lessons/${lessonA}`, { cookie: linhCookie });
check('several files: second file is added, first kept', up3.done?.status === 200 && d3.data.mine.length === 2 && r2Exists(up2.key), d3.data.mine);
const keys = [up2.key, up3.key];
for (let i = 0; i < 8; i++) { const u = await upload(UP(lessonA), `extra${i}.pdf`, rand(100), { cookie: linhCookie }); keys.push(u.key); }
const over = await api(`${UP(lessonA)}/start`, { method: 'POST', body: { filename: 'one-too-many.pdf', size: 10 }, cookie: linhCookie });
check('a student can hand in at most 10 files per lesson', over.status === 409, over.data);
const d4 = await api(`/api/l/${tokenA}/lessons/${lessonA}`, { cookie: linhCookie });
check('10 files stored', d4.data.mine.length === 10);

// delete one of several; cannot delete someone else's
const victim = d4.data.mine.find((m) => m.name === 'page2.pdf');
const minhTry = await api(`/api/l/${tokenA}/lessons/${lessonA}/submissions/${victim.id}`, { method: 'DELETE', cookie: minhCookie });
check("a classmate cannot delete someone else's file", (await api(`/api/l/${tokenA}/lessons/${lessonA}`, { cookie: linhCookie })).data.mine.length === 10, minhTry.status);
const del1 = await api(`/api/l/${tokenA}/lessons/${lessonA}/submissions/${victim.id}`, { method: 'DELETE', cookie: linhCookie });
check('student deletes one of their files; its storage is freed', del1.status === 200 && r2Exists(up3.key) === false && r2Exists(up2.key) === true);
for (const m of (await api(`/api/l/${tokenA}/lessons/${lessonA}`, { cookie: linhCookie })).data.mine.filter((m) => m.name !== 'speaking2.mp4')) {
  await api(`/api/l/${tokenA}/lessons/${lessonA}/submissions/${m.id}`, { method: 'DELETE', cookie: linhCookie });
}
await api(`/api/teacher/classes/${classA}`, { method: 'PATCH', body: { multi: false } });
const oldGone = await api(`/api/teacher/lessons/${lessonA}`);
check('teacher sees 1 submission, Minh & An not handed in', oldGone.data.submissions.length === 1 && oldGone.data.notHandedIn.join() === 'Minh A.,An P.', oldGone.data.notHandedIn);

// classmates can see work in same lesson, not feedback
const minhView = await api(`/api/l/${tokenA}/lessons/${lessonA}`, { cookie: minhCookie });
check("classmate sees Linh's work in class work", minhView.data.classwork.length === 1 && minhView.data.classwork[0].studentName === 'Linh T.');
const subId = minhView.data.classwork[0].id;
const peek = await fetch(`${BASE}/api/l/${tokenA}/submissions/${subId}/file`, { headers: { cookie: minhCookie } });
check('classmate can play it', peek.status === 200 && peek.headers.get('content-type') === 'video/mp4');
await peek.arrayBuffer();

// other class cannot see it
const crossClass = await api(`/api/l/${tokenB}`, { cookie: minhCookie });
check('class A student has no session in class B', crossClass.status === 200 && crossClass.data.me === null && !crossClass.data.lessons);
const crossFile = await api(`/api/l/${tokenB}/submissions/${subId}/file`, { cookie: minhCookie });
check('class B cannot fetch class A homework by id', crossFile.status === 401 || crossFile.status === 404, crossFile.status);
const crossUpload = await api(`/api/l/${tokenB}/lessons/${lessonA}/upload/start`, { method: 'POST', body: { filename: 'a.pdf', size: 10 }, cookie: minhCookie });
check('class A student cannot upload into class B', crossUpload.status === 401);

// student can't use someone else's key prefix
const startM = await api(`${UP(lessonA)}/start`, { method: 'POST', body: { filename: 'a.pdf', size: 10 }, cookie: minhCookie });
const forged = await api(`${UP(lessonA)}/complete`, {
  method: 'POST', cookie: minhCookie,
  body: { key: startM.data.key.replace(minh.id, linh.id), uploadId: startM.data.uploadId, parts: [{ partNumber: 1, etag: 'x' }], filename: 'a.pdf', size: 10 },
});
check("student cannot write into another student's folder", forged.status === 400, forged.data);

// ---------- teacher review ----------
const sub = oldGone.data.submissions[0];
const tv = await fetch(`${BASE}/api/teacher/submissions/${sub.id}/file`, { headers: { range: 'bytes=0-1023' } });
check('teacher streams video with Range', tv.status === 206 && tv.headers.get('content-disposition').startsWith('inline'));
await tv.arrayBuffer();
const rv = await api(`/api/teacher/submissions/${sub.id}`, { method: 'PATCH', body: { reviewed: true, feedback: 'Great speaking!' } });
check('teacher marks reviewed with feedback', rv.status === 200);
const afterReview = await api(`/api/l/${tokenA}/lessons/${lessonA}`, { cookie: linhCookie });
check('student sees feedback once reviewed', afterReview.data.mine[0].reviewed === true && afterReview.data.mine[0].feedback === 'Great speaking!');
const ov = await api('/api/teacher/overview');
const ovA = ov.data.classes.find((c) => c.id === classA);
check('overview lists the class link, schedule and next lesson', ovA && ovA.students === 3 && ovA.link === cA.data.link && ovA.schedule.length === 2 && ovA.nextLesson, ovA);

// ---------- close / auto-close ----------
await api(`/api/teacher/lessons/${lessonA}`, { method: 'PATCH', body: { status: 'closed' } });
const fid = afterReview.data.mine[0].id;
const blocked = await api(`/api/l/${tokenA}/lessons/${lessonA}/submissions/${fid}`, { method: 'DELETE', cookie: linhCookie });
check('closed lesson: student cannot delete', blocked.status === 409);
const blockedUp = await api(`${UP(lessonA)}/start`, { method: 'POST', body: { filename: 'a.pdf', size: 10 }, cookie: linhCookie });
check('closed lesson: student cannot upload', blockedUp.status === 409);
const stillView = await api(`/api/l/${tokenA}/lessons/${lessonA}`, { cookie: linhCookie });
check('closed lesson still readable, shown as closed', stillView.status === 200 && stillView.data.mine.length === 1 && stillView.data.status === 'closed');
await api(`/api/teacher/lessons/${lessonA}`, { method: 'PATCH', body: { status: 'open' } });
await api(`/api/teacher/classes/${classA}`, { method: 'PATCH', body: { autoCloseDays: 0 } });
const auto = await api(`/api/l/${tokenA}/lessons/${lessonA}`, { cookie: linhCookie });
check('auto-close: a lesson older than the limit counts as closed', auto.data.status === 'closed' && (await api(`/api/l/${tokenA}`, { cookie: linhCookie })).data.lessons.find((l) => l.id === lessonA).status === 'closed');
check('auto-close: uploads refused', (await api(`${UP(lessonA)}/start`, { method: 'POST', body: { filename: 'a.pdf', size: 10 }, cookie: linhCookie })).status === 409);
await api(`/api/teacher/classes/${classA}`, { method: 'PATCH', body: { autoCloseDays: null } });
const del = await api(`/api/l/${tokenA}/lessons/${lessonA}/submissions/${fid}`, { method: 'DELETE', cookie: linhCookie });
check('student deletes own homework', del.status === 200 && (await api(`/api/l/${tokenA}/lessons/${lessonA}`, { cookie: linhCookie })).data.mine.length === 0);
check('deleting frees the file in storage', r2Exists(up2.key) === false);

// ---------- rename the class ----------
const rn = await api(`/api/teacher/classes/${classA}`, { method: 'PATCH', body: { name: 'Class A2' } });
check('teacher renames the class', rn.status === 200 && (await api(`/api/l/${tokenA}`)).data.className === 'Class A2');
check('blank class name refused', (await api(`/api/teacher/classes/${classA}`, { method: 'PATCH', body: { name: '  ' } })).status === 400);
await api(`/api/teacher/classes/${classA}`, { method: 'PATCH', body: { name: 'Class A' } });

// ---------- roster changes ----------
const minhUp = await upload(UP(lessonA), 'minh.pdf', rand(2000), { cookie: minhCookie });
check('Minh hands in', minhUp.done?.status === 200);
const rost = await api(`/api/teacher/classes/${classA}/roster`, { method: 'POST', body: { add: ['Lan V.'], remove: [minh.id] } });
check('roster edit: add Lan, remove Minh', rost.status === 200 && rost.data.roster.map((s) => s.name).join() === 'Linh T.,An P.,Lan V.', rost.data.roster.map((s) => s.name));
const newList = await api(`/api/l/${tokenA}`);
check('link now lists the current students', newList.data.students.map((s) => s.name).join() === 'Linh T.,An P.,Lan V.');
check('removed student can no longer use the link', (await api(`/api/l/${tokenA}`, { cookie: minhCookie })).data.me === null);
const lanView = await api(`/api/l/${tokenA}/lessons/${lessonA}`, { cookie: linhCookie });
check("Minh's earlier work stays visible to classmates", lanView.data.classwork.some((c) => c.studentName === 'Minh A.'));

// ---------- delete lesson ----------
check('stored before lesson delete', r2Exists(mat.key) && r2Exists(minhUp.key));
const delLesson = await api(`/api/teacher/lessons/${lessonA}`, { method: 'DELETE' });
check('teacher deletes lesson', delLesson.status === 200);
check('deleted lesson disappears for students', (await api(`/api/l/${tokenA}/lessons/${lessonA}`, { cookie: linhCookie })).status === 404);
check('its files are gone from storage', r2Exists(mat.key) === false && r2Exists(minhUp.key) === false);

// ---------- keeping storage clean ----------
const cC = await api('/api/teacher/classes', { method: 'POST', body: { name: 'Class C', students: ['Bo K.'] } });
const classC = cC.data.id;
const tokC = cC.data.link.split('/')[2];
const old = await api(`/api/teacher/classes/${classC}/lessons`, { method: 'POST', body: { date: addD(today, -10) } });
const oldMat = await upload(`/api/teacher/lessons/${old.data.id}/materials/upload`, 'Old reading.pdf', rand(5000));
const bo = (await api(`/api/l/${tokC}`)).data.students[0];
const boCookie = (await api(`/api/l/${tokC}/login`, { method: 'POST', body: { studentId: bo.id } })).cookie;
const oldHw = await upload(`/api/l/${tokC}/lessons/${old.data.id}/upload`, 'old-homework.mp4', rand(4000), { cookie: boCookie });
check('set up an old lesson with reading and homework', oldMat.done?.status === 201 && oldHw.done?.status === 200);

const st = await api('/api/teacher/storage');
const oldRow = st.data.lessons.find((l) => l.lessonId === old.data.id);
check('storage report shows sizes per lesson', st.status === 200 && st.data.totalBytes > 0 && oldRow.homeworkBytes === 4000 && oldRow.materialBytes === 5000 && oldRow.homeworkCount === 1, oldRow);

await fetch(`${BASE}/cdn-cgi/handler/scheduled`).then((r) => r.text());
await new Promise((r) => setTimeout(r, 1500));
const afterSweep = await api(`/api/teacher/lessons/${old.data.id}`);
check('retention sweep removes old homework but keeps lesson and reading', afterSweep.status === 200 && afterSweep.data.submissions.length === 0 && afterSweep.data.materials.length === 1);
check('retention sweep deleted the homework file, kept the reading', r2Exists(oldHw.key) === false && r2Exists(oldMat.key) === true);

const fresh = await api(`/api/teacher/classes/${classC}/lessons`, { method: 'POST', body: { date: today } });
const freshHw = await upload(`/api/l/${tokC}/lessons/${fresh.data.id}/upload`, 'hw.mp4', rand(3000), { cookie: boCookie });
await fetch(`${BASE}/cdn-cgi/handler/scheduled`).then((r) => r.text());
await new Promise((r) => setTimeout(r, 1500));
check('sweep leaves recent homework alone', (await api(`/api/teacher/lessons/${fresh.data.id}`)).data.submissions.length === 1);
const cleared = await api(`/api/teacher/lessons/${fresh.data.id}/submissions`, { method: 'DELETE' });
check("teacher clears one lesson's homework", cleared.status === 200 && cleared.data.filesRemoved === 1 && r2Exists(freshHw.key) === false);

const wrongConfirm = await api(`/api/teacher/classes/${classC}`, { method: 'DELETE', body: { confirm: 'class c' } });
check('deleting a class needs its exact name', wrongConfirm.status === 400);
const delClass = await api(`/api/teacher/classes/${classC}`, { method: 'DELETE', body: { confirm: 'Class C' } });
check('delete class removes everything', delClass.status === 200 && r2Exists(oldMat.key) === false && (await api(`/api/l/${tokC}`)).status === 404, delClass.data);

// the nightly job fills in lessons for classes with a schedule
const before = (await api(`/api/teacher/classes/${classA}`)).data.lessons.length;
check('nightly job leaves a full schedule alone', (await api(`/api/teacher/classes/${classA}`)).data.lessons.length === before);

// ---------- pages ----------
const page = await fetch(`${BASE}/l/${tokenB}`);
check('/l/<token> serves the student page with noindex', page.status === 200 && page.headers.get('x-robots-tag').includes('noindex'));
check('unknown api route 404', (await api('/api/nope')).status === 404);



// ---- teacher deletes one homework file ----
const dlLesson = await api(`/api/teacher/classes/${classA}/lessons`, { method: 'POST', body: { date: today } });
const dlId = dlLesson.data?.id || (await api(`/api/teacher/classes/${classA}`)).data.lessons.find((l) => l.date === today)?.id;
const hwUp = await upload(`/api/l/${tokenA}/lessons/${dlId}/upload`, 'hamster.png', rand(2000), { cookie: linhCookie });
check('uploaded a file to delete', hwUp.done?.status === 200, hwUp.done || hwUp);
const hwDl0 = await api(`/api/teacher/lessons/${dlId}`);
const hwVictim = hwDl0.data.submissions[0];
if (hwVictim) {
  const del = await api(`/api/teacher/submissions/${hwVictim.id}`, { method: 'DELETE' });
  check('teacher can delete one homework file', del.status === 200, del.data);
  check('deleted file is gone from storage', r2Exists(hwUp.key) === false);
  const after = await api(`/api/teacher/lessons/${dlId}`);
  check('deleted file is gone from the lesson', !after.data.submissions.some((x) => x.id === hwVictim.id));
  check('deleting twice is 404', (await api(`/api/teacher/submissions/${hwVictim.id}`, { method: 'DELETE' })).status === 404);
} else check('had a submission to delete', false, hwDl0.data);

console.log(failures === 0 ? '\nALL API CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
