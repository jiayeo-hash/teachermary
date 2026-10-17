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
  return { dom, w, errors, jar, text: () => (w.document.querySelector('x-dc') || w.document.body).textContent.replace(/\s+/g, ' ') };
}
export const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
export const btn = (w, label) => [...w.document.querySelectorAll('button,a,label')].find((b) => b.textContent.trim().startsWith(label));
export async function until(fn, ms = 4000) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { if (fn()) return true; } catch {} await sleep(40); }
  return false;
}
export { tapi, tupload, check, sleep };

if (process.argv[1].endsWith('pages.test.mjs')) {
  const day = (o) => new Date(Date.now() + o * 86400000).toISOString().slice(0, 10);
  const tag = Date.now().toString(36);
  const cls = await tapi('/api/teacher/classes', { method: 'POST', body: { name: 'PT ' + tag, students: ['Linh T.', 'Minh A.', 'An P.'] } });
  const L = await tapi(`/api/teacher/classes/${cls.data.id}/lessons`, { method: 'POST', body: { date: day(1) } });
  const token = L.data.link.split('/')[2];
  await tupload(`/api/teacher/lessons/${L.data.id}/materials/upload`, 'Reading 12.pdf', new TextEncoder().encode('%PDF-1.4 fake'));
  const minh = L.data.roster.find((s) => s.name === 'Minh A.');
  await tapi(`/api/teacher/students/${minh.id}/pin`, { method: 'PUT', body: { pin: '1234' } });

  // ---- student page ----
  const bad = await openPage('/l/nope-not-a-token');
  await until(() => /Link not found/.test(bad.text()));
  check('student: bad link shows not found', /Link not found/.test(bad.text()), bad.text());

  const s = await openPage('/l/' + token);
  check('student: picker shows names', await until(() => /Who is handing in/.test(s.text()) && /Linh T\./.test(s.text())), s.text() + s.errors.join(';'));
  const realErrs = (e) => e.filter((x) => !/fonts\.googleapis/.test(x));
  check('student: no script errors', realErrs(s.errors).length === 0, s.errors.join(';'));
  check('student: picker hides reading until name chosen', !/Reading 12/.test(s.text()));

  // Vietnamese toggle
  click(s.w, btn(s.w, 'Tiếng Việt'));
  check('student: Vietnamese works', await until(() => /Ai đang nộp bài/.test(s.text())));
  click(s.w, btn(s.w, 'English'));
  await until(() => /Who is handing in/.test(s.text()));

  // PIN student: wrong then right
  click(s.w, btn(s.w, 'MA'));
  check('student: PIN step appears', await until(() => !!s.w.document.getElementById('pin')));
  s.w.document.getElementById('pin').value = '9999';
  s.w.document.querySelector('form').dispatchEvent(new s.w.Event('submit', { bubbles: true, cancelable: true }));
  check('student: wrong PIN message', await until(() => /not right/.test(s.text())), s.text());
  s.w.document.getElementById('pin').value = '1234';
  s.w.document.querySelector('form').dispatchEvent(new s.w.Event('submit', { bubbles: true, cancelable: true }));
  check('student: right PIN opens lesson', await until(() => /Reading time/.test(s.text()) && /Reading 12\.pdf/.test(s.text())), s.text());
  const dl = [...s.w.document.querySelectorAll('a')].find((a) => /materials\/.+\/file\?download=1/.test(a.getAttribute('href') || ''));
  check('student: download link present', !!dl);
  if (dl) {
    const r = await s.w.fetch(dl.getAttribute('href'));
    check('student: download works with session', r.status === 200 && /attachment/.test(r.headers.get('content-disposition')), r.status);
  }
  check('student: upload zone visible', /Add your video or file/.test(s.text()));

  // upload a file through the real input
  const input = s.w.document.querySelector('input[type=file]');
  const file = new s.w.File([new Uint8Array(3000).fill(7)], 'speaking.mp4', { type: 'video/mp4' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new s.w.Event('change', { bubbles: true }));
  check('student: handed-in card after upload', await until(() => /Handed in/.test(s.text()) && /speaking\.mp4/.test(s.text()), 6000), s.text() + s.errors.join(';'));
  check('student: change/delete buttons', !!btn(s.w, 'Change file') && !!btn(s.w, 'Delete'));

  // delete with confirmation
  click(s.w, btn(s.w, 'Delete'));
  check('student: delete asks first', await until(() => /Take speaking\.mp4 back/.test(s.text())));
  click(s.w, btn(s.w, 'No, keep it'));
  await until(() => !!btn(s.w, 'Change file'));
  click(s.w, btn(s.w, 'Delete'));
  await until(() => !!btn(s.w, 'Yes, delete it'));
  click(s.w, btn(s.w, 'Yes, delete it'));
  check('student: delete removes work', await until(() => /Add your video or file/.test(s.text()) && !/speaking\.mp4/.test(s.text())), s.text());

  // upload again, then teacher reviews, student sees feedback; classmates see work
  const input2 = s.w.document.querySelector('input[type=file]');
  Object.defineProperty(input2, 'files', { value: [new s.w.File([new Uint8Array(500)], 'again.mp4', { type: 'video/mp4' })], configurable: true });
  input2.dispatchEvent(new s.w.Event('change', { bubbles: true }));
  await until(() => /Handed in/.test(s.text()), 6000);
  const subs = await tapi(`/api/teacher/lessons/${L.data.id}`);
  const sub = (subs.data.submissions || [])[0];
  if (sub) await tapi(`/api/teacher/submissions/${sub.id}`, { method: 'PATCH', body: { reviewed: true, feedback: 'Lovely reading!' } });
  const s2 = await openPage('/l/' + token);
  await until(() => /Who is handing in/.test(s2.text()));
  click(s2.w, btn(s2.w, 'LT'));
  await until(() => /Reading time/.test(s2.text()));
  check('student: classmate sees Minh A. work', /Minh A\./.test(s2.text()) && /Our class's work/.test(s2.text()), s2.text());
  // log out of s, back as same - feedback
  click(s.w, btn(s.w, 'Not you?'));
  await until(() => /Who is handing in/.test(s.text()));
  check('student: Not you returns to picker', /Who is handing in/.test(s.text()));
  click(s.w, btn(s.w, 'MA'));
  await until(() => !!s.w.document.getElementById('pin'));
  s.w.document.getElementById('pin').value = '1234';
  s.w.document.querySelector('form').dispatchEvent(new s.w.Event('submit', { bubbles: true, cancelable: true }));
  check('student: feedback shown', await until(() => /Lovely reading!/.test(s.text())), s.text());

  // closed lesson hides upload
  await tapi(`/api/teacher/lessons/${L.data.id}`, { method: 'PATCH', body: { status: 'closed' } });
  const s3 = await openPage('/l/' + token);
  await until(() => /Who is handing in/.test(s3.text()));
  click(s3.w, btn(s3.w, 'LT'));
  check('student: closed lesson shows note, no upload', await until(() => /lesson is finished/.test(s3.text())) && !/Add your video or file/.test(s3.text()), s3.text());

  console.log(failures ? `\n${failures} FAILED` : '\nALL PAGE CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}
