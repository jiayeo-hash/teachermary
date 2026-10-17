# Real build: setup notes

## Done
- D1 database `teachermary` (id 51c4060c-8597-45e6-9fe2-38f21a183986). Schema: `migrations/0001_init.sql`, `0002_pin_lockout.sql`.
- R2 bucket `teachermary-files` (private).
- Cloudflare Access application on `teachermary.online/teacher/*` and `/api/teacher/*`.
- Worker code in `src/` (API) with `wrangler.jsonc` (bindings DB and FILES, static files in `public/`).

## Settings the Worker needs (Workers & Pages > teachermary > Settings > Variables and Secrets)
| Name | Value |
|---|---|
| `TEACHER_EMAILS` | Mary's and Ricky's emails, comma separated (same as the Access policy) |
| `ACCESS_TEAM_DOMAIN` | your Zero Trust team domain, e.g. `yourteam.cloudflareaccess.com` |
| `ACCESS_AUD` | the Application Audience (AUD) tag of the Access application |

If any are missing the teacher API refuses every request (it fails closed).
Never set `DEV_TEACHER_EMAIL` outside local development (it skips the login check).

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
