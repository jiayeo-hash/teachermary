// Unit tests that need no server: teacher login (JWT) checks and the orphan clean-up.
import { requireTeacher } from '../src/auth.js';
import { runCleanup } from '../src/cleanup.js';

let failures = 0;
const check = (label, ok, extra) => {
  if (!ok) failures++;
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (!ok && extra !== undefined ? '  -> ' + String(extra) : ''));
};

// ---- JWT ----
const TEAM = 'test-team.cloudflareaccess.com';
const AUD = 'aud-123';
const b64 = (buf) => Buffer.from(buf).toString('base64url');
const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const otherKp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
globalThis.fetch = async (url) => {
  if (String(url) === `https://${TEAM}/cdn-cgi/access/certs`) return new Response(JSON.stringify({ keys: [jwk] }));
  return new Response('nope', { status: 404 });
};

async function token({ key = kp.privateKey, kid = 'k1', claims = {} } = {}) {
  const header = b64(JSON.stringify({ alg: 'RS256', kid }));
  const payload = b64(JSON.stringify({ aud: [AUD], iss: `https://${TEAM}`, exp: Math.floor(Date.now() / 1000) + 600, email: 'mary@example.com', ...claims }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64(sig)}`;
}
const req = (t) => new Request('https://x.test/api/teacher/me', { headers: t ? { 'cf-access-jwt-assertion': t } : {} });
const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, TEACHER_EMAILS: 'mary@example.com, ricky@example.com' };
const status = async (p) => { try { await p; return 200; } catch (e) { return e.status || 500; } };

check('valid token accepted', (await requireTeacher(req(await token()), env)) === 'mary@example.com');
check('missing token is 401', (await status(requireTeacher(req(null), env))) === 401);
check('token signed by another key is 401', (await status(requireTeacher(req(await token({ key: otherKp.privateKey })), env))) === 401);
check('expired token is 401', (await status(requireTeacher(req(await token({ claims: { exp: 1 } })), env))) === 401);
check('wrong application (aud) is 403', (await status(requireTeacher(req(await token({ claims: { aud: ['other'] } })), env))) === 403);
check('wrong issuer is 403', (await status(requireTeacher(req(await token({ claims: { iss: 'https://evil.example' } })), env))) === 403);
check('email not on the allow list is 403', (await status(requireTeacher(req(await token({ claims: { email: 'kid@example.com' } })), env))) === 403);
check('unknown key id is 401', (await status(requireTeacher(req(await token({ kid: 'zzz' })), env))) === 401);
check('garbage token is 401', (await status(requireTeacher(req('a.b.c'), env))) === 401);
check('with no TEACHER_EMAILS, Access policy alone decides', (await requireTeacher(req(await token({ claims: { email: 'anyone@example.com' } })), { ...env, TEACHER_EMAILS: '' })) === 'anyone@example.com');
check('not configured fails closed (503)', (await status(requireTeacher(req(await token()), {}))) === 503);

// ---- orphan clean-up ----
const now = new Date('2026-11-01T00:00:00Z');
const deleted = [];
const fakeEnv = {
  RETENTION_DAYS: '0',
  DB: { prepare: (sql) => ({ all: async () => ({ results: sql.includes('materials') ? [{ r2_key: 'materials/a/keep.pdf' }] : [{ r2_key: 'submissions/a/b/keep.mp4' }] }) }) },
  FILES: {
    list: async () => ({
      truncated: false,
      objects: [
        { key: 'materials/a/keep.pdf', uploaded: new Date('2026-01-01') },
        { key: 'submissions/a/b/keep.mp4', uploaded: new Date('2026-01-01') },
        { key: 'submissions/a/b/orphan-old.mp4', uploaded: new Date('2026-10-01') },
        { key: 'submissions/a/b/orphan-new.mp4', uploaded: new Date('2026-10-31T12:00:00Z') },
      ],
    }),
    delete: async (keys) => deleted.push(...keys),
  },
};
const rep = await runCleanup(fakeEnv, now);
check('orphan older than 2 days removed', deleted.includes('submissions/a/b/orphan-old.mp4'));
check('recent orphan (maybe mid-upload) kept', !deleted.includes('submissions/a/b/orphan-new.mp4'));
check('files that rows point to are kept', !deleted.includes('materials/a/keep.pdf') && !deleted.includes('submissions/a/b/keep.mp4') && rep.orphansRemoved === 1, JSON.stringify(rep));

console.log(failures === 0 ? '\nALL UNIT CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
