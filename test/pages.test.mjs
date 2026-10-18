// Loads the real pages in jsdom against `wrangler dev --local` and clicks through them.
import { JSDOM, VirtualConsole } from 'jsdom';

const BASE = process.env.BASE || 'http://localhost:8787';
let failures = 0;
const check = (label, ok, extra) => {
  if (!ok) failures++;
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (!ok && extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tapi(path, { method = 'GET', body, raw } = {}) {
  const headers = { origin: BASE };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : raw });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, data: ct.includes('json') ? await res.json() : null };
}
async function tupload(base, filename, bytes) {
  const s = await tapi(`${base}/start`, { method: 'POST', body: { filename, size: bytes.length } });
  const p = await tapi(`${base}/part?uploadId=${encodeURIComponent(s.data.uploadId)}&key=${encodeURIComponent(s.data.key)}&n=1`, { method: 'PUT', raw: bytes });
  return tapi(`${base}/complete`, { method: 'POST', body: { key: s.data.key, uploadId: s.data.uploadId, parts: [p.data], filename, size: bytes.length } });
}

// Open a page in jsdom with a cookie-aware fetch.
export async function openPage(path, { onLog } = {}) {
  const jar = new Map();
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String(e.detail || e.message)));
  vc.on('error', (e) => errors.push(String(e)));
  const dom = await JSDOM.fromURL(BASE + path, {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.fetch = async (u, init = {}) => {
        const url = new URL(u, BASE).href;
        const headers = { ...(init.headers || {}), origin: BASE };
        if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
        let body = init.body;
        if (body && typeof body === 'object' && typeof body.size === 'number' && body.constructor.name === 'Blob') {
          body = await new Promise((ok) => { const fr = new w.FileReader(); fr.onload = () => ok(Buffer.from(fr.result)); fr.readAsArrayBuffer(body); });
        }
        const res = await fetch(url, { ...init, body, headers });
        for (const c of res.headers.getSetCookie?.() || []) {
          const [kv] = c.split(';');
          const i = kv.indexOf('=');
          if (/max-age=0|expires=thu, 01 jan 1970/i.test(c) || kv.slice(i + 1) === '') jar.delete(kv.slice(0, i));
          else jar.set(kv.slice(0, i), kv.slice(i + 1));
        }
        return res;
      };
      w.confirm = () => true;
      w.navigator.clipboard = { writeText: async () => {} };
    },
  });
  const w = dom.window;
  await new Promise((r) => (w.document.readyState === 'complete' ? r() : w.addEventListener('load', r)));
  if (w.TM) w.TM.testMode = true;
  return { dom, w, errors, jar, text: () => { const root = (w.document.querySelector('x-dc') || w.document.getElementById('app') || w.document.body).cloneNode(true); root.querySelectorAll('script,style').forEach((n) => n.remove()); return root.textContent.replace(/\s+/g, ' '); }, };
}
export const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
export const btn = (w, label) => [...(w.document || w).querySelectorAll('button,a,label')].find((b) => b.textContent.trim().startsWith(label));
export async function until(fn, ms = 4000) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { if (fn()) return true; } catch {} await sleep(40); }
  return false;
}
export { tapi, tupload, check, sleep };

if (process.argv[1].endsWith('pages.test.mjs')) {
  const sydToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const addD = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const today = sydToday();
  const tag = Date.now().toString(36);
  const realErrs = (e) => e.filter((x) => !/fonts\.googleapis/.test(x));
  const setVal = (w, el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); el.dispatchEvent(new w.Event('change', { bubbles: true })); };
  const fire = (w, input, files) => { Object.defineProperty(input, 'files', { value: files, configurable: true }); input.dispatchEvent(new w.Event('change', { bubbles: true })); };
  const mkfile = (w, name, type, n = 600) => new w.File([new Uint8Array(n).fill(7)], name, { type });

  const cls = await tapi('/api/teacher/classes', { method: 'POST', body: { name: 'PT ' + tag, students: ['Linh T.', 'Minh A.', 'An P.'] } });
  const token = cls.data.link.split('/')[2];
  const classId = cls.data.id;
  const L = await tapi(`/api/teacher/classes/${classId}/lessons`, { method: 'POST', body: { date: today } });
  const lessonId = L.data.id;
  await tupload(`/api/teacher/lessons/${lessonId}/materials/upload`, 'Reading 12.pdf', new TextEncoder().encode('%PDF-1.4 fake'));
  // older lessons: one with reading, plus seven more so "show older" is needed
  const oldL = await tapi(`/api/teacher/classes/${classId}/lessons`, { method: 'POST', body: { date: addD(today, -3) } });
  await tupload(`/api/teacher/lessons/${oldL.data.id}/materials/upload`, 'Old reading.pdf', new TextEncoder().encode('%PDF-1.4 old'));
  for (let k = 5; k < 12; k++) await tapi(`/api/teacher/classes/${classId}/lessons`, { method: 'POST', body: { date: addD(today, -k) } });
  const roster = (await tapi(`/api/teacher/classes/${classId}`)).data.roster;
  const minh = roster.find((s) => s.name === 'Minh A.');
  await tapi(`/api/teacher/students/${minh.id}/pin`, { method: 'PUT', body: { pin: '1234' } });

  // ---- student page ----
  const bad = await openPage('/l/nope-not-a-token');
  check('student: bad link shows not found', await until(() => /Link not found/.test(bad.text())), bad.text());

  const s = await openPage('/l/' + token);
  check('student: picker shows names', await until(() => /Who is handing in/.test(s.text()) && /Linh T\./.test(s.text())), s.text() + s.errors.join(';'));
  check('student: no script errors', realErrs(s.errors).length === 0, s.errors.join(';'));
  check('student: picker hides reading until name chosen', !/Reading 12/.test(s.text()));

  click(s.w, btn(s.w, 'Tiếng Việt'));
  check('student: Vietnamese works', await until(() => /Ai đang nộp bài/.test(s.text())));
  click(s.w, btn(s.w, 'English'));
  await until(() => /Who is handing in/.test(s.text()));

  click(s.w, btn(s.w, 'MA'));
  check('student: PIN step appears', await until(() => !!s.w.document.getElementById('pin')));
  s.w.document.getElementById('pin').value = '9999';
  s.w.document.querySelector('form').dispatchEvent(new s.w.Event('submit', { bubbles: true, cancelable: true }));
  check('student: wrong PIN message', await until(() => /not right/.test(s.text())), s.text());
  s.w.document.getElementById('pin').value = '1234';
  s.w.document.querySelector('form').dispatchEvent(new s.w.Event('submit', { bubbles: true, cancelable: true }));
  check('student: right PIN opens the class, today\'s lesson is open with its reading', await until(() => /Reading time/.test(s.text()) && /Reading 12\.pdf/.test(s.text())), s.text());
  check('student: today\'s lesson tagged Today', /Today/.test(s.text()));
  const cards = () => [...s.w.document.querySelectorAll('[data-lesson]')];
  check('student: lessons are newest first', cards().length === 6 && cards()[0].getAttribute('data-lesson') === lessonId, cards().length);
  check('student: older lesson starts collapsed', !/Old reading/.test(s.text()));
  const oldCard = () => s.w.document.querySelector(`[data-lesson="${oldL.data.id}"]`);
  click(s.w, oldCard().querySelector('button'));
  check('student: tapping an older lesson opens its reading', await until(() => /Old reading\.pdf/.test(s.text())));
  click(s.w, oldCard().querySelector('button'));
  check('student: tapping again collapses it', await until(() => !/Old reading/.test(s.text())));
  click(s.w, btn(s.w, 'Show older lessons'));
  check('student: show older lessons adds more', await until(() => cards().length === 9), cards().length);

  const dl = [...s.w.document.querySelectorAll('a')].find((a) => /materials\/.+\/file\?download=1/.test(a.getAttribute('href') || ''));
  check('student: download link present', !!dl);
  if (dl) {
    const r = await s.w.fetch(dl.getAttribute('href'));
    check('student: download works with session', r.status === 200 && /attachment/.test(r.headers.get('content-disposition')), r.status);
  }
  const today1 = () => s.w.document.querySelector(`[data-lesson="${lessonId}"]`);
  check('student: upload zone visible in today\'s lesson', /Add your video or file/.test(today1().textContent));
  check('student: single-file mode has no multi picker', !today1().querySelector('input[type=file][multiple]'));

  fire(s.w, today1().querySelector('input[type=file]'), [mkfile(s.w, 'speaking.mp4', 'video/mp4', 3000)]);
  check('student: handed-in card after upload', await until(() => !!today1().querySelector('[data-file="speaking.mp4"]'), 6000), today1().textContent + s.errors.join(';'));
  check('student: change/delete buttons', !!btn(today1(), 'Change file') && !!btn(today1(), 'Delete'));
  check('student: lesson tag shows 1 file handed in', /1 file handed in/.test(today1().textContent));

  // single mode: change replaces
  click(s.w, btn(today1(), 'Change file'));
  await until(() => /Keep my old file/.test(today1().textContent));
  fire(s.w, today1().querySelector('input[type=file]'), [mkfile(s.w, 'again.mp4', 'video/mp4', 500)]);
  check('student: changing replaces the file', await until(() => !!today1().querySelector('[data-file="again.mp4"]') && !today1().querySelector('[data-file="speaking.mp4"]'), 6000), today1().textContent);

  // delete with confirmation
  click(s.w, btn(today1(), 'Delete'));
  check('student: delete asks first', await until(() => /Take again\.mp4 back/.test(today1().textContent)));
  click(s.w, btn(today1(), 'No, keep it'));
  await until(() => !!btn(today1(), 'Delete'));
  click(s.w, btn(today1(), 'Delete'));
  await until(() => !!btn(today1(), 'Yes, delete it'));
  click(s.w, btn(today1(), 'Yes, delete it'));
  check('student: delete removes work', await until(() => /Add your video or file/.test(today1().textContent) && !today1().querySelector('[data-file]')), today1().textContent);

  // Mary switches on several files
  await tapi(`/api/teacher/classes/${classId}`, { method: 'PATCH', body: { multi: true } });
  const sm = await openPage('/l/' + token);
  await until(() => /Who is handing in/.test(sm.text()));
  click(sm.w, btn(sm.w, 'LT'));
  await until(() => /Reading 12\.pdf/.test(sm.text()));
  const mcard = () => sm.w.document.querySelector(`[data-lesson="${lessonId}"]`);
  check('student: several-files mode shows a multi picker', !!mcard().querySelector('input[type=file][multiple]'));
  fire(sm.w, mcard().querySelector('input[type=file]'), [mkfile(sm.w, 'p1.mp4', 'video/mp4'), mkfile(sm.w, 'p2.pdf', 'application/pdf')]);
  check('student: two files handed in at once', await until(() => !!mcard().querySelector('[data-file="p1.mp4"]') && !!mcard().querySelector('[data-file="p2.pdf"]'), 8000), mcard().textContent + sm.errors.join(';'));
  check('student: can still add another file', /Add another file/.test(mcard().textContent));
  check('student: 2 files shown in the tag', /2 files handed in/.test(mcard().textContent));
  click(sm.w, mcard().querySelector('[data-file="p2.pdf"] button:last-of-type'));
  await until(() => /Take p2\.pdf back/.test(mcard().textContent));
  click(sm.w, btn(mcard(), 'Yes, delete it'));
  check('student: delete just one of several', await until(() => !mcard().querySelector('[data-file="p2.pdf"]') && !!mcard().querySelector('[data-file="p1.mp4"]')));

  // teacher reviews, student sees feedback; classmates see work
  const detail = await tapi(`/api/teacher/lessons/${lessonId}`);
  const sub = detail.data.submissions[0];
  await tapi(`/api/teacher/submissions/${sub.id}`, { method: 'PATCH', body: { reviewed: true, feedback: 'Lovely reading!' } });
  const s2 = await openPage('/l/' + token);
  await until(() => /Who is handing in/.test(s2.text()));
  click(s2.w, btn(s2.w, 'MA'));
  await until(() => !!s2.w.document.getElementById('pin'));
  s2.w.document.getElementById('pin').value = '1234';
  s2.w.document.querySelector('form').dispatchEvent(new s2.w.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => /Reading time/.test(s2.text()));
  check('student: classmate sees Linh T. work', await until(() => /Linh T\./.test(s2.text()) && /Our class's work/.test(s2.text())), s2.text());
  click(sm.w, btn(sm.w, 'Not you?'));
  await until(() => /Who is handing in/.test(sm.text()));
  click(sm.w, btn(sm.w, 'LT'));
  check('student: feedback shown', await until(() => /Lovely reading!/.test(sm.text())), sm.text());

  // closed lesson hides upload
  await tapi(`/api/teacher/lessons/${lessonId}`, { method: 'PATCH', body: { status: 'closed' } });
  const s3 = await openPage('/l/' + token);
  await until(() => /Who is handing in/.test(s3.text()));
  click(s3.w, btn(s3.w, 'LT'));
  check('student: closed lesson shows note, no upload', await until(() => /lesson is finished/.test(s3.text())) && !/Add your video or file/.test(s3.text()), s3.text());
  await tapi(`/api/teacher/lessons/${lessonId}`, { method: 'PATCH', body: { status: 'open' } });

  // ---- teacher pages ----
  const cur = await tapi(`/api/teacher/lessons/${lessonId}`);
  await tapi(`/api/teacher/submissions/${cur.data.submissions[0].id}`, { method: 'PATCH', body: { reviewed: false } });
  const dash = await openPage('/teacher/');
  check('teacher dashboard: shows class and review queue', await until(() => dash.text().includes('PT ' + tag) && /Waiting for your review/.test(dash.text())), dash.text());
  check('teacher dashboard: shows the permanent class link', dash.text().includes('/l/' + token), dash.text());
  check('teacher dashboard: no script errors', realErrs(dash.errors).length === 0, dash.errors.join(';'));

  // new class with a weekly schedule
  const nb = await openPage('/teacher/new/');
  await until(() => !!nb.w.document.getElementById('classname'));
  setVal(nb.w, nb.w.document.getElementById('classname'), 'Built ' + tag);
  click(nb.w, nb.w.document.querySelector('[data-dow="2"]'));
  click(nb.w, nb.w.document.querySelector('[data-dow="6"]'));
  await until(() => !!nb.w.document.querySelector('[data-time="6"]'));
  setVal(nb.w, nb.w.document.querySelector('[data-time="2"]'), '19:00');
  setVal(nb.w, nb.w.document.querySelector('[data-time="6"]'), '18:30');
  for (const n of ['Bo K.', 'Cam L.']) {
    setVal(nb.w, nb.w.document.getElementById('addname'), n);
    click(nb.w, nb.w.document.getElementById('addbtn'));
    await until(() => nb.text().includes(n));
  }
  nb.w.document.getElementById('multi').checked = true;
  nb.w.document.getElementById('multi').dispatchEvent(new nb.w.Event('change', { bubbles: true }));
  check('builder: create enabled with a name', !nb.w.document.getElementById('create').disabled);
  click(nb.w, nb.w.document.getElementById('create'));
  check('builder: shows the class link', await until(() => !!nb.w.document.getElementById('newlink'), 6000), nb.text() + nb.errors.join(';'));
  const newTok = (nb.w.document.getElementById('newlink')?.textContent || '').split('/l/')[1];
  const info = await tapi('/api/l/' + newTok);
  check('builder: class works for students with 2 names', info.status === 200 && info.data.students.length === 2 && info.data.multi === true && info.data.schedule.length === 2, info.data);
  const ov = await tapi('/api/teacher/overview');
  const built = ov.data.classes.find((c) => c.name === 'Built ' + tag);
  check('builder: Tue 19:00 and Sat 18:30 saved, lessons created', !!built && built.schedule.map((e) => e.dow + '@' + e.time).join() === '2@19:00,6@18:30' && built.nextLesson, built);
  const bc = await tapi('/api/teacher/classes/' + built.id);
  check('builder: lessons exist for the next two weeks', bc.data.lessons.length >= 4, bc.data.lessons.length);

  // class page: review tab
  const cp = await openPage(`/teacher/class/?id=${classId}&lesson=${lessonId}&tab=review`);
  check('class page: review shows Linh homework', await until(() => /Linh T\./.test(cp.text()) && /p1\.mp4/.test(cp.text())), cp.text() + cp.errors.join(';'));
  check('class page: not-handed-in list', /Not handed in yet/.test(cp.text()));
  click(cp.w, cp.w.document.querySelector('[data-act=watch]'));
  check('class page: video player appears', await until(() => !!cp.w.document.querySelector('#viewer video')));
  const fb = cp.w.document.querySelector('textarea');
  fb.value = 'Great voice!';
  click(cp.w, cp.w.document.querySelector('[data-act=save]'));
  await sleep(400);
  const after = await tapi('/api/teacher/lessons/' + lessonId);
  check('class page: feedback saved', after.data.submissions[0].feedback === 'Great voice!', after.data.submissions[0]);

  // prepare tab
  const pp = await openPage(`/teacher/class/?id=${classId}&lesson=${lessonId}`);
  await until(() => !!pp.w.document.getElementById('lessonpanel'));
  check('class page: prepare shows reading and the class link', /Reading 12\.pdf/.test(pp.text()) && pp.text().includes('/l/' + token), pp.text());
  // schedule editor
  click(pp.w, pp.w.document.querySelector('#settings [data-dow="3"]'));
  await until(() => !!pp.w.document.querySelector('#settings [data-time="3"]'));
  click(pp.w, pp.w.document.getElementById('saveschedule'));
  await sleep(600);
  const sch = await tapi('/api/teacher/classes/' + classId);
  check('class page: schedule can be saved', sch.data.class.schedule.length === 1 && sch.data.class.schedule[0].dow === 3, sch.data.class.schedule);
  // extra lesson
  const pp2 = await openPage(`/teacher/class/?id=${classId}&lesson=${lessonId}`);
  await until(() => !!pp2.w.document.getElementById('extradate'));
  setVal(pp2.w, pp2.w.document.getElementById('extradate'), addD(today, 40));
  click(pp2.w, pp2.w.document.getElementById('addlesson'));
  await sleep(600);
  check('class page: extra lesson added', (await tapi('/api/teacher/classes/' + classId)).data.lessons.some((l) => l.date === addD(today, 40)));
  const pp3 = await openPage(`/teacher/class/?id=${classId}&lesson=${lessonId}`);
  await until(() => !!pp3.w.document.getElementById('clearhw'));
  click(pp3.w, pp3.w.document.getElementById('clearhw'));
  await sleep(500);
  check('class page: clear homework works', (await tapi('/api/teacher/lessons/' + lessonId)).data.submissions.length === 0);
  click(pp3.w, pp3.w.document.querySelector('[data-material] .btn.danger'));
  await sleep(500);
  check('class page: remove reading works', (await tapi('/api/teacher/lessons/' + lessonId)).data.materials.length === 0);
  click(pp3.w, pp3.w.document.getElementById('dellesson'));
  await sleep(500);
  check('class page: delete lesson works', (await tapi('/api/teacher/lessons/' + lessonId)).status === 404);
  // delete class with typed name
  const dc = await openPage(`/teacher/class/?id=${built.id}`);
  await until(() => !!dc.w.document.getElementById('delclass'));
  dc.w.prompt = () => 'wrong';
  click(dc.w, dc.w.document.getElementById('delclass'));
  await sleep(400);
  check('class page: wrong name does not delete', (await tapi('/api/teacher/classes/' + built.id)).status === 200);
  dc.w.prompt = () => 'Built ' + tag;
  click(dc.w, dc.w.document.getElementById('delclass'));
  await sleep(600);
  check('class page: typed name deletes class', (await tapi('/api/teacher/classes/' + built.id)).status === 404);

  console.log(failures ? `\n${failures} FAILED` : '\nALL PAGE CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}
