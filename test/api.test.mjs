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
const me = await api('/api/teacher/me');
check('teacher /me works (dev login)', me.status === 200 && me.data.email);

const cA = await api('/api/teacher/classes', { method: 'POST', body: { name: 'Class A', students: ['Linh T.', 'Minh A.', 'An P.'] } });
check('create class A', cA.status === 201, cA);
const cB = await api('/api/teacher/classes', { method: 'POST', body: { name: 'Class B', students: ['Hà P.'] } });
const classA = cA.data.id;

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const L1 = await api(`/api/teacher/classes/${classA}/lessons`, { method: 'POST', body: { date: day(1) } });
check('create lesson, returns unguessable link', L1.status === 201 && /^\/l\/[A-Za-z0-9_-]{30,}$/.test(L1.data.link), L1.data);
const lessonA = L1.data.id;
const tokenA = L1.data.link.split('/')[2];
check('lesson roster has 3 students', L1.data.roster.length === 3);

const L2 = await api(`/api/teacher/classes/${cB.data.id}/lessons`, { method: 'POST', body: { date: day(1) } });
const tokenB = L2.data.link.split('/')[2];

// materials: 17 MB file => 3 parts
const mat = await upload(`/api/teacher/lessons/${lessonA}/materials/upload`, 'Reading.pdf', rand(17 * 1024 * 1024));
check('teacher uploads 17 MB reading in 3 chunks', mat.done?.status === 201, mat.done || mat);
const bad = await upload(`/api/teacher/lessons/${lessonA}/materials/upload`, 'evil.html', rand(100));
check('html upload is refused', bad.start?.status === 415, bad.start?.data);
const bigLie = await api(`/api/teacher/lessons/${lessonA}/materials/upload/start`, { method: 'POST', body: { filename: 'a.mp4', size: 5 * 1024 ** 3 } });
check('over 1 GB refused', bigLie.status === 413);

// ---------- origin / csrf ----------
const cross = await api('/api/teacher/classes', { method: 'POST', body: { name: 'x' }, headers: { origin: 'https://evil.example' } });
check('cross-origin write refused', cross.status === 403);

// ---------- student ----------
const info0 = await api(`/api/l/${tokenA}`);
check('student link shows class + roster, no files before sign-in', info0.status === 200 && info0.data.students.length === 3 && !info0.data.materials && !info0.data.me, info0.data);
check('bad token is 404', (await api('/api/l/' + 'x'.repeat(40))).status === 404);
check('draft lesson hidden', await (async () => {
  const d = await api(`/api/teacher/classes/${classA}/lessons`, { method: 'POST', body: { date: day(2), status: 'draft' } });
  return (await api(`/api/l/${d.data.link.split('/')[2]}`)).status === 404;
})());

const linh = info0.data.students.find((s) => s.name === 'Linh T.');
const minh = info0.data.students.find((s) => s.name === 'Minh A.');
check('no access without name', (await api(`/api/l/${tokenA}/materials/${'x'}/file`)).status === 401);

// PIN
const pinSet = await api(`/api/teacher/students/${linh.id}/pin`, { method: 'PUT', body: { pin: '4821' } });
check('teacher sets a PIN', pinSet.status === 200);
check('PIN must be digits', (await api(`/api/teacher/students/${linh.id}/pin`, { method: 'PUT', body: { pin: 'abcd' } })).status === 400);
check('roster shows hasPin', (await api(`/api/l/${tokenA}`)).data.students.find((s) => s.id === linh.id).hasPin === true);
const wrong = await api(`/api/l/${tokenA}/login`, { method: 'POST', body: { studentId: linh.id, pin: '0000' } });
check('wrong PIN rejected', wrong.status === 401);
let locked;
for (let i = 0; i < 5; i++) locked = await api(`/api/l/${tokenA}/login`, { method: 'POST', body: { studentId: linh.id, pin: '1111' } });
const afterLock = await api(`/api/l/${tokenA}/login`, { method: 'POST', body: { studentId: linh.id, pin: '4821' } });
check('5 wrong PINs lock the student out (even the right PIN)', afterLock.status === 429, afterLock.data);
await api(`/api/teacher/students/${linh.id}/pin`, { method: 'PUT', body: { pin: '4821' } }); // teacher reset clears lock
const good = await api(`/api/l/${tokenA}/login`, { method: 'POST', body: { studentId: linh.id, pin: '4821' } });
check('right PIN signs in and sets HttpOnly cookie', good.status === 200 && good.res.headers.get('set-cookie').includes('HttpOnly'), good.data);
const linhCookie = good.cookie;

const minhLogin = await api(`/api/l/${tokenA}/login`, { method: 'POST', body: { studentId: minh.id } });
check('student without PIN signs in by name', minhLogin.status === 200);
const minhCookie = minhLogin.cookie;

const info1 = await api(`/api/l/${tokenA}`, { cookie: linhCookie });
check('signed in: sees materials and no homework yet', info1.data.me?.name === 'Linh T.' && info1.data.materials.length === 1 && info1.data.mine === null, info1.data);

// download material with Range
const matId = info1.data.materials[0].id;
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

// homework upload
const video = rand(9 * 1024 * 1024);
const up = await upload(`/api/l/${tokenA}/upload`, 'speaking.mp4', video, { cookie: linhCookie });
check('student uploads 9 MB video (2 chunks)', up.done?.status === 200 && up.done.data.replaced === false, up.done || up);
const info2 = await api(`/api/l/${tokenA}`, { cookie: linhCookie });
check('own homework shown', info2.data.mine?.name === 'speaking.mp4', info2.data.mine);

const up2 = await upload(`/api/l/${tokenA}/upload`, 'speaking2.mp4', rand(1024 * 1024), { cookie: linhCookie });
check('student replaces file', up2.done?.status === 200 && up2.done.data.replaced === true, up2.done);
const info3 = await api(`/api/l/${tokenA}`, { cookie: linhCookie });
check('only one submission, new name, replacedAt set', info3.data.mine.name === 'speaking2.mp4' && info3.data.mine.replacedAt);
check('replaced file is deleted from storage, new one kept', r2Exists(up.key) === false && r2Exists(up2.key) === true, { old: r2Exists(up.key), new: r2Exists(up2.key) });
const oldGone = await api(`/api/teacher/lessons/${lessonA}`);
check('teacher sees 1 submission, Minh & An not handed in', oldGone.data.submissions.length === 1 && oldGone.data.notHandedIn.join() === 'Minh A.,An P.', oldGone.data.notHandedIn);

// classmates can see work in same lesson, not feedback
const minhView = await api(`/api/l/${tokenA}`, { cookie: minhCookie });
check('classmate sees Linh\'s work in class work', minhView.data.classwork.length === 1 && minhView.data.classwork[0].studentName === 'Linh T.');
const subId = minhView.data.classwork[0].id;
const peek = await fetch(`${BASE}/api/l/${tokenA}/submissions/${subId}/file`, { headers: { cookie: minhCookie } });
check('classmate can play it', peek.status === 200 && peek.headers.get('content-type') === 'video/mp4');
await peek.arrayBuffer();

// other class cannot see it
const crossClass = await api(`/api/l/${tokenB}`, { cookie: minhCookie });
check('class A student has no session in class B lesson', crossClass.status === 200 && crossClass.data.me === null && !crossClass.data.classwork);
const crossFile = await api(`/api/l/${tokenB}/submissions/${subId}/file`, { cookie: minhCookie });
check('class B cannot fetch class A homework by id', crossFile.status === 401 || crossFile.status === 404, crossFile.status);
const crossUpload = await api(`/api/l/${tokenB}/upload/start`, { method: 'POST', body: { filename: 'a.pdf', size: 10 }, cookie: minhCookie });
check('class A student cannot upload into class B lesson', crossUpload.status === 401);

// student can't use someone else's key prefix
const startM = await api(`/api/l/${tokenA}/upload/start`, { method: 'POST', body: { filename: 'a.pdf', size: 10 }, cookie: minhCookie });
const forged = await api(`/api/l/${tokenA}/upload/complete`, {
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
const afterReview = await api(`/api/l/${tokenA}`, { cookie: linhCookie });
check('student sees feedback once reviewed', afterReview.data.mine.reviewed === true && afterReview.data.mine.feedback === 'Great speaking!');
const ov = await api('/api/teacher/overview');
const ovA = ov.data.classes.find((c) => c.id === classA);
check('overview lists the class with its next lesson link', ovA && ovA.students === 3 && ovA.nextLesson?.link.startsWith('/l/'), ovA);

// ---------- close / delete ----------
await api(`/api/teacher/lessons/${lessonA}`, { method: 'PATCH', body: { status: 'closed' } });
const blocked = await api(`/api/l/${tokenA}/submission`, { method: 'DELETE', cookie: linhCookie });
check('closed lesson: student cannot delete', blocked.status === 409);
const blockedUp = await api(`/api/l/${tokenA}/upload/start`, { method: 'POST', body: { filename: 'a.pdf', size: 10 }, cookie: linhCookie });
check('closed lesson: student cannot upload', blockedUp.status === 409);
const stillView = await api(`/api/l/${tokenA}`, { cookie: linhCookie });
check('closed lesson still readable', stillView.status === 200 && stillView.data.mine);
await api(`/api/teacher/lessons/${lessonA}`, { method: 'PATCH', body: { status: 'open' } });
const del = await api(`/api/l/${tokenA}/submission`, { method: 'DELETE', cookie: linhCookie });
check('student deletes own homework', del.status === 200 && (await api(`/api/l/${tokenA}`, { cookie: linhCookie })).data.mine === null);

// ---------- roster carry-over ----------
const L3 = await api(`/api/teacher/classes/${classA}/lessons`, { method: 'POST', body: { date: day(8), add: ['Lan V.'], remove: [minh.id] } });
check('new lesson: roster edits apply and carry forward', L3.data.roster.map((s) => s.name).join() === 'Linh T.,An P.,Lan V.', L3.data.roster.map((s) => s.name));
const oldRoster = await api(`/api/l/${tokenA}`);
check('earlier lesson keeps its original roster', oldRoster.data.students.map((s) => s.name).join() === 'Linh T.,Minh A.,An P.', oldRoster.data.students.map((s) => s.name));
const L4 = await api(`/api/teacher/classes/${classA}/lessons`, { method: 'POST', body: { date: day(15) } });
check('next lesson inherits the edited roster', L4.data.roster.map((s) => s.name).join() === 'Linh T.,An P.,Lan V.');

// ---------- delete lesson ----------
check('student deletion removed the file from storage', r2Exists(up2.key) === false);
const minhUp = await upload(`/api/l/${tokenA}/upload`, 'minh.pdf', rand(2000), { cookie: minhCookie });
check('student removed from later lessons can still use the earlier lesson', minhUp.done?.status === 200, minhUp.done);
const keysBefore = { mat: mat.key, sub: minhUp.key };
check('stored before lesson delete', r2Exists(keysBefore.mat) && r2Exists(keysBefore.sub));
const delLesson = await api(`/api/teacher/lessons/${lessonA}`, { method: 'DELETE' });
check('teacher deletes lesson', delLesson.status === 200);
check('deleted lesson link stops working', (await api(`/api/l/${tokenA}`)).status === 404);
check('its files are gone from storage', r2Exists(keysBefore.mat) === false && r2Exists(keysBefore.sub) === false);


// ---------- keeping storage clean ----------
const cC = await api('/api/teacher/classes', { method: 'POST', body: { name: 'Class C', students: ['Bo K.'] } });
const classC = cC.data.id;
const old = await api(`/api/teacher/classes/${classC}/lessons`, { method: 'POST', body: { date: day(-10) } });
const oldTok = old.data.link.split('/')[2];
const oldMat = await upload(`/api/teacher/lessons/${old.data.id}/materials/upload`, 'Old reading.pdf', rand(5000));
const bo = (await api(`/api/l/${oldTok}`)).data.students[0];
const boCookie = (await api(`/api/l/${oldTok}/login`, { method: 'POST', body: { studentId: bo.id } })).cookie;
const oldHw = await upload(`/api/l/${oldTok}/upload`, 'old-homework.mp4', rand(4000), { cookie: boCookie });
check('set up an old lesson with reading and homework', oldMat.done?.status === 201 && oldHw.done?.status === 200);

const st = await api('/api/teacher/storage');
const oldRow = st.data.lessons.find((l) => l.lessonId === old.data.id);
check('storage report shows sizes per lesson', st.status === 200 && st.data.totalBytes > 0 && oldRow.homeworkBytes === 4000 && oldRow.materialBytes === 5000 && oldRow.homeworkCount === 1, oldRow);

const sched = await fetch(`${BASE}/cdn-cgi/handler/scheduled`);
await sched.text();
await new Promise((r) => setTimeout(r, 1500));
const afterSweep = await api(`/api/teacher/lessons/${old.data.id}`);
check('retention sweep removes old homework but keeps lesson and reading', afterSweep.status === 200 && afterSweep.data.submissions.length === 0 && afterSweep.data.materials.length === 1);
check('retention sweep deleted the homework file, kept the reading', r2Exists(oldHw.key) === false && r2Exists(oldMat.key) === true);

const fresh = await api(`/api/teacher/classes/${classC}/lessons`, { method: 'POST', body: { date: day(2) } });
const freshTok = fresh.data.link.split('/')[2];
const boCookie2 = (await api(`/api/l/${freshTok}/login`, { method: 'POST', body: { studentId: bo.id } })).cookie;
const freshHw = await upload(`/api/l/${freshTok}/upload`, 'hw.mp4', rand(3000), { cookie: boCookie2 });
await fetch(`${BASE}/cdn-cgi/handler/scheduled`).then((r) => r.text());
await new Promise((r) => setTimeout(r, 1500));
check('sweep leaves recent homework alone', (await api(`/api/teacher/lessons/${fresh.data.id}`)).data.submissions.length === 1);
const cleared = await api(`/api/teacher/lessons/${fresh.data.id}/submissions`, { method: 'DELETE' });
check('teacher clears one lesson\'s homework', cleared.status === 200 && cleared.data.filesRemoved === 1 && r2Exists(freshHw.key) === false);

const wrongConfirm = await api(`/api/teacher/classes/${classC}`, { method: 'DELETE', body: { confirm: 'class c' } });
check('deleting a class needs its exact name', wrongConfirm.status === 400);
const delClass = await api(`/api/teacher/classes/${classC}`, { method: 'DELETE', body: { confirm: 'Class C' } });
check('delete class removes everything', delClass.status === 200 && r2Exists(oldMat.key) === false && (await api(`/api/l/${oldTok}`)).status === 404, delClass.data);

// ---------- pages ----------
const page = await fetch(`${BASE}/l/${tokenB}`);
check('/l/<token> serves the student page with noindex', page.status === 200 && page.headers.get('x-robots-tag').includes('noindex'));
check('unknown api route 404', (await api('/api/nope')).status === 404);

console.log(failures === 0 ? '\nALL API CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
