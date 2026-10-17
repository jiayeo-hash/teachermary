// Nightly clean-up (cron). Two jobs:
//  1. Retention: if RETENTION_DAYS is set (e.g. 90), delete homework from lessons older than that.
//     Reading material and the lessons themselves are kept. Off unless RETENTION_DAYS is set.
//  2. Orphans: delete stored files that no database row points to (for example an upload that
//     was never finished) once they are more than 2 days old.

import { deleteKeys } from './files.js';

export async function runCleanup(env, now = new Date()) {
  const report = { retentionRemoved: 0, orphansRemoved: 0 };

  const days = Number(env.RETENTION_DAYS || 0);
  if (days > 0) {
    const cutoff = new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
    const old = await env.DB.prepare(
      `SELECT s.id, s.r2_key FROM submissions s JOIN lessons l ON l.id = s.lesson_id WHERE l.lesson_date < ?`
    )
      .bind(cutoff)
      .all();
    for (let i = 0; i < old.results.length; i += 50) {
      const chunk = old.results.slice(i, i + 50);
      await env.DB.batch(chunk.map((r) => env.DB.prepare('DELETE FROM submissions WHERE id = ?').bind(r.id)));
      await deleteKeys(env, chunk.map((r) => r.r2_key));
    }
    report.retentionRemoved = old.results.length;
  }

  const known = new Set([
    ...(await env.DB.prepare('SELECT r2_key FROM materials').all()).results.map((r) => r.r2_key),
    ...(await env.DB.prepare('SELECT r2_key FROM submissions').all()).results.map((r) => r.r2_key),
  ]);
  const grace = now.getTime() - 2 * 86400000;
  let cursor;
  do {
    const page = await env.FILES.list({ cursor, limit: 500 });
    const orphans = page.objects.filter((o) => !known.has(o.key) && o.uploaded.getTime() < grace).map((o) => o.key);
    await deleteKeys(env, orphans);
    report.orphansRemoved += orphans.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return report;
}
