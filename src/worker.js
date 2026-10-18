// Teacher Mary: one Worker serving the static site plus the API.
//   /api/teacher/*  -> teacher API (Cloudflare Access + JWT check)
//   /api/l/:token/* -> student API (permanent class link + name + optional PIN)
//   /l/:token       -> the student page
//   everything else -> static files in /public

import { HttpError, json } from './util.js';
import { requireTeacher } from './auth.js';
import { handleTeacher } from './teacher.js';
import { handleStudent } from './student.js';
import { runCleanup } from './cleanup.js';
import { ensureAllLessons } from './classes.js';

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Block cross-site requests that change data (cookies are sent automatically by browsers).
function checkOrigin(request, url) {
  if (!WRITE.has(request.method)) return;
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) throw new HttpError(403, 'Bad origin');
  if (!origin && request.headers.get('sec-fetch-site') === 'cross-site') throw new HttpError(403, 'Bad origin');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path.startsWith('/api/')) {
        checkOrigin(request, url);
        const parts = path.split('/').filter(Boolean).slice(1); // drop "api"
        if (parts[0] === 'teacher') {
          const email = await requireTeacher(request, env);
          return await handleTeacher(request, env, url, email, parts.slice(1));
        }
        if (parts[0] === 'l' && parts[1]) return await handleStudent(request, env, url, parts[1], parts.slice(2));
        throw new HttpError(404, 'Not found');
      }

      // Student page: /l/<token> serves the same page for every class.
      if (path.startsWith('/l/')) {
        const res = await env.ASSETS.fetch(new Request(new URL('/student/', url), request));
        const h = new Headers(res.headers);
        h.set('x-robots-tag', 'noindex, nofollow');
        h.set('referrer-policy', 'no-referrer');
        h.set('cache-control', 'no-store');
        return new Response(res.body, { status: res.status, headers: h });
      }

      return env.ASSETS.fetch(request);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: 'Something went wrong' }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      ensureAllLessons(env)
        .then((n) => console.log('lessons created', n))
        .then(() => runCleanup(env))
        .then((r) => console.log('cleanup', JSON.stringify(r)))
    );
  },
};
