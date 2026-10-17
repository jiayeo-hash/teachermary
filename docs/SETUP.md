# Real build: setup notes

## Done
- D1 database `teachermary` (id 51c4060c-8597-45e6-9fe2-38f21a183986). Schema: `migrations/0001_init.sql`, `0002_pin_lockout.sql`.
- R2 bucket `teachermary-files` (private).
- Cloudflare Access application on `teachermary.online/teacher/*` and `/api/teacher/*`.
- Worker code in `src/` (API) with `wrangler.jsonc` (bindings DB and FILES, static files in `public/`).

## Settings
Already in `wrangler.jsonc` (not secrets): `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`.
Add in the dashboard (Workers & Pages > teachermary > Settings > Variables and Secrets):

| Name | Value |
|---|---|
| `TEACHER_EMAILS` | optional. Mary's and Ricky's emails, comma separated. A second check on top of the Access policy. Kept out of the code because the repo is public. |
| `RETENTION_DAYS` | optional. e.g. `90` deletes homework from lessons older than 90 days (reading and lessons are kept). Off when unset. |

If `ACCESS_*` are missing the teacher API refuses every request (it fails closed).
Never set `DEV_TEACHER_EMAIL` outside local development (it skips the login check).

## Keeping storage clean
- Delete a lesson: removes its reading and homework files.
- Clear homework for one lesson: `DELETE /api/teacher/lessons/:id/submissions` (keeps lesson and reading).
- Delete a class: `DELETE /api/teacher/classes/:id` with `{"confirm": "<class name>"}`.
- See what uses space: `GET /api/teacher/storage`.
- Nightly job (03:00 Sydney): applies `RETENTION_DAYS` and deletes stored files nothing points to (older than 2 days).
- Optional: in R2 > teachermary-files > Settings, add a lifecycle rule to abort incomplete multipart uploads after 1 day.

## Local development
```
npm install
npx wrangler d1 execute teachermary --local --file migrations/0001_init.sql
npx wrangler d1 execute teachermary --local --file migrations/0002_pin_lockout.sql
echo 'DEV_TEACHER_EMAIL=test@example.com' > .dev.vars
npm run dev        # in one terminal
npm test           # in another: end-to-end API checks
```

## Routes
- `/api/teacher/*`  teacher API (Access + JWT check)
- `/api/l/:token/*` student API (lesson link, then name + optional PIN)
- `/l/:token`       student page
