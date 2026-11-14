# TechStar public API — staging-only foundation

This is a small Cloudflare Worker and D1 foundation for the existing quote form.
**It is not deployed or connected to the live website.** It is not a complete CRM, CMS,
admin panel, or production-ready lead-management system.

## Endpoints

| Endpoint | Purpose | Security |
|---|---|---|
| `GET /health` | Reports service availability and configuration readiness | Public, no secrets |
| `GET /api/content` | Read-only empty override list; the website retains its built-in catalogue | Strict Origin policy |
| `POST /api/leads` | Validate and store new quotation leads in D1 | Strict Origin, Turnstile, input validation, idempotency |
| `OPTIONS /api/*` | Browser CORS preflight | Only approved Origins |

A successful lead response has `{"received":true,"reference":"TS-..."}`.
The website must **not** interpret a client-side summary as a successful submission.

## Local tests

Requires Node.js 22+:

```bash
cd backend
node --check src/index.mjs
node --test test/index.test.mjs
```

Tests cover CORS, request validation, honeypot rejection, Turnstile hostname
verification, storage failure and idempotent retries. GitHub Actions runs them
before deploying the public website.

## Before enabling API ingestion

1. Decide the legal controller, privacy notice, retention/deletion schedule, and
   staff access roles; review applicable personal-data requirements.
2. Create a Cloudflare D1 database named `techstar-leads`, record its real
   database ID, and replace `REPLACE_WITH_YOUR_D1_DATABASE_ID` in `wrangler.toml`.
3. Install Wrangler and apply the included migration **to the intended database**.
4. Set the `TURNSTILE_SECRET` using Wrangler secrets, never in `wrangler.toml`
   or Git. Set the public `TURNSTILE_HOSTNAME` and exact `ALLOWED_ORIGINS`
   for the website and any approved staging origins.
5. Review rate limits, operational monitoring, admin authentication, backups,
   data export/deletion, and access audit logging before accepting real leads.
6. Deploy the Worker. Confirm `GET /health` reports `ready:true` and test
   failed and successful Turnstile verification in staging.
7. Only after the checks pass, set the **public** values in `index.html`:
   `window.TECHSTAR_CONFIG.apiBaseUrl` to the deployed Worker URL and
   `window.TECHSTAR_CONFIG.turnstileSiteKey` to the public site key.
8. Verify a real test lead reaches D1 once, that repeat submissions use the same
   reference, and that the website reports success only after the API confirms it.

Do not configure only one of the Turnstile keys; the Worker intentionally
fails closed without a private `TURNSTILE_SECRET` and the website needs the
matching public site key to produce tokens. Never share either the D1 admin
credentials or the secret key publicly.

## Status and limitations

- The public website remains GitHub Pages static hosting.
- The API has no authenticated lead-management UI, notifications, scheduled
  deletion, or advanced multi-dimensional rate limiting yet.
- Do not store live customer records until these are implemented and reviewed.
- `database_id` in `wrangler.toml` is intentionally a placeholder.
