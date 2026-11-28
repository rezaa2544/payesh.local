# Free infrastructure: GitHub Actions tasks + Cloudflare Worker backend (2026-11-28)

Zero-cost replacement for the Oracle VPS idea (Oracle signup needs an
international credit card and is sanction-blocked from Iran).

## What runs where

| Need | Service | Cost | Behaviour |
|---|---|---|---|
| Scheduled jobs (uptime, data validation, reports) | GitHub Actions `payesh-free-tasks` | Free | Every 6h + on demand; ephemeral, not always-on |
| Light backend (status API) | Cloudflare Worker `payesh-status` | Free | Always on (no sleep), no card, 100k req/day free |
| Site + web app hosting | Arvan (existing, live) | Existing | Unchanged |

## Live endpoints (deployed 2026-11-28, verified)

- Worker: https://payesh-status.0skttfw1vayxk0lghrl.workers.dev
  - `GET /health` → `{"ok":true,...}`
  - `GET /api/status` → live probe of site / web-app / school-servers
    (first verification: all three 200, allOk=true)
- Source: `services/status-service/worker.js` (+ `wrangler.toml` for CLI
  deploys, `server.js`/`Dockerfile` kept as a portable Node variant).
  Holds NO school data. Deployed via the Cloudflare dashboard editor on the
  owner's existing Cloudflare account (Google sign-in, no card).

## GitHub Actions as a "task server"

- Workflow `.github/workflows/payesh-tasks.yml`, script `tools/payesh-monitor.mjs`.
- Every 6 hours: checks payeshschool.ir, app.payeshschool.ir, the rendezvous
  JSON (validates `kind` + `servers` array) and the status Worker's /health;
  stores a JSON artifact (30 days) and sends a Persian Telegram summary via
  @PayeshSchoolMonitorBot when repo secrets `TELEGRAM_BOT_TOKEN` /
  `TELEGRAM_CHAT_ID` are present (they are set).
- Proven live 2026-11-28: manual run green, Telegram delivered.
- Honest limits: batch compute only — no inbound traffic, no persistent
  state, 6h max per job.

## Render — attempted, owner decided to skip (2026-11-28)

Render account was created (GitHub OAuth) and email verified, and the repo
contains `render.yaml` + the Docker variant. But at deploy time Render shows
an "Add Card — verify your identity" gate (temporary $1 authorization) on
this account, in both the Blueprint and Web Service flows. The owner has no
international card and chose to skip Render; the Cloudflare Worker above
covers the same need better (no sleep). No card data was ever entered. If a
card becomes available: dashboard.render.com → New → Web Service →
rezaa2544/payesh.local (root directory `services/status-service`) → Free.

## Impact on the app

None for end users: the Flutter app keeps using Arvan + the fixed rendezvous
address. These free services are auxiliary (monitoring + status); if either
is down, the school app is unaffected. The Actions workflow replaces the
LightVela monitor (free month, then paid) with a free permanent equivalent.
