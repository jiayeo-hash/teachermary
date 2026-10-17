# Real build: setup notes

## Done
- D1 database `teachermary` (id 51c4060c-8597-45e6-9fe2-38f21a183986), schema in `migrations/0001_init.sql`.

## To do in the Cloudflare dashboard
1. **R2**: Storage & databases > R2 > enable (needs a payment method on file; stays free under 10 GB).
   Then create a bucket named `teachermary-files` (keep it private).
2. **Teacher login** (Zero Trust > Access > Applications > Add > Self-hosted):
   - Domain: `teachermary.online`, paths `/teacher/*` and `/api/teacher/*`
   - Policy: Allow, Emails = Mary's email and Ricky's
   - Login method: One-time PIN
   Students' pages (`/l/*`) stay public.
