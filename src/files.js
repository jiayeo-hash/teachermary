// File storage in R2: chunked uploads (so big phone videos work through a Worker),
// and streaming with Range support (so videos play in the browser without a download).

import { HttpError, uuid } from './util.js';

export const PART_SIZE = 8 * 1024 * 1024; // 8 MiB (R2 minimum is 5 MiB except the last part)
export const MAX_BYTES = 1024 * 1024 * 1024; // 1 GiB per file

// Only these types are accepted. Anything that a browser could run as a web page
// (html, svg, js ...) is refused, because files are served from our own domain.
const TYPES = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
};
const INLINE = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'application/pdf', 'image/jpeg', 'image/png', 'audio/mpeg', 'audio/mp4']);

export function checkUpload(filename, size) {
  const name = String(filename || '').replace(/[\\/\u0000-\u001f]/g, '_').trim().slice(0, 120);
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (!name || !TYPES[ext]) throw new HttpError(415, 'That file type is not allowed. Use a video, PDF, Word file, photo or audio.');
  if (!Number.isFinite(size) || size <= 0) throw new HttpError(400, 'Empty file');
  if (size > MAX_BYTES) throw new HttpError(413, 'File is too big (limit 1 GB)');
  return { name, ext, contentType: TYPES[ext] };
}

export function newKey(prefix, name) {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80);
  return `${prefix}/${uuid()}-${safe}`;
}

export async function startUpload(env, prefix, filename, size) {
  const f = checkUpload(filename, size);
  const key = newKey(prefix, f.name);
  const mp = await env.FILES.createMultipartUpload(key, { httpMetadata: { contentType: f.contentType } });
  return { uploadId: mp.uploadId, key, partSize: PART_SIZE, name: f.name, contentType: f.contentType };
}

export async function uploadPart(env, request, prefix, url) {
  const key = url.searchParams.get('key') || '';
  const uploadId = url.searchParams.get('uploadId') || '';
  const n = Number(url.searchParams.get('n'));
  if (!key.startsWith(prefix + '/') || !uploadId || !Number.isInteger(n) || n < 1 || n > 10000) {
    throw new HttpError(400, 'Bad upload part');
  }
  const len = Number(request.headers.get('content-length'));
  if (!len || len > PART_SIZE + 1024) throw new HttpError(413, 'Part too large');
  const mp = env.FILES.resumeMultipartUpload(key, uploadId);
  const part = await mp.uploadPart(n, request.body);
  return { partNumber: part.partNumber, etag: part.etag };
}

export async function completeUpload(env, prefix, body) {
  const { key, uploadId, parts, filename, size } = body;
  if (typeof key !== 'string' || !key.startsWith(prefix + '/') || !uploadId || !Array.isArray(parts) || parts.length === 0) {
    throw new HttpError(400, 'Bad upload');
  }
  const f = checkUpload(filename, Number(size));
  const mp = env.FILES.resumeMultipartUpload(key, uploadId);
  const obj = await mp.complete(parts.map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag) })));
  if (obj.size > MAX_BYTES) {
    await env.FILES.delete(key);
    throw new HttpError(413, 'File is too big (limit 1 GB)');
  }
  return { key, name: f.name, contentType: f.contentType, size: obj.size };
}

export async function abortUpload(env, prefix, body) {
  const { key, uploadId } = body;
  if (typeof key !== 'string' || !key.startsWith(prefix + '/') || !uploadId) throw new HttpError(400, 'Bad upload');
  try {
    await env.FILES.resumeMultipartUpload(key, uploadId).abort();
  } catch {
    /* already gone */
  }
}

export async function deleteKeys(env, keys) {
  const list = keys.filter(Boolean);
  if (list.length) await env.FILES.delete(list);
}

// Stream an object. Supports "Range: bytes=a-b" so video can seek.
export async function streamFile(env, request, key, { name, contentType, download }) {
  const head = await env.FILES.head(key);
  if (!head) throw new HttpError(404, 'File not found');
  const total = head.size;
  let status = 200;
  let range;
  const h = request.headers.get('range');
  const headers = new Headers({
    'content-type': contentType || 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "sandbox; default-src 'none'",
    'x-robots-tag': 'noindex, nofollow',
  });
  const asAttachment = download || !INLINE.has(contentType);
  const safeName = String(name || 'file').replace(/["\\\r\n]/g, '_');
  headers.set(
    'content-disposition',
    `${asAttachment ? 'attachment' : 'inline'}; filename="${safeName.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name || 'file')}`
  );
  if (h) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
    if (!m || (m[1] === '' && m[2] === '')) {
      return new Response(null, { status: 416, headers: { 'content-range': `bytes */${total}` } });
    }
    let start;
    let end;
    if (m[1] === '') {
      const suffix = Number(m[2]);
      start = Math.max(0, total - suffix);
      end = total - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
    }
    if (start > end || start >= total) {
      return new Response(null, { status: 416, headers: { 'content-range': `bytes */${total}` } });
    }
    range = { offset: start, length: end - start + 1 };
    status = 206;
    headers.set('content-range', `bytes ${start}-${end}/${total}`);
    headers.set('content-length', String(range.length));
  } else {
    headers.set('content-length', String(total));
  }
  const obj = await env.FILES.get(key, range ? { range } : undefined);
  if (!obj) throw new HttpError(404, 'File not found');
  return new Response(request.method === 'HEAD' ? null : obj.body, { status, headers });
}
