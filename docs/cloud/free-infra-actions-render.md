# Free infrastructure: GitHub Actions tasks + Render backend (2026-11-28)

Zero-cost replacement for the Oracle VPS idea (Oracle signup needs an
international credit card and is sanction-blocked from Iran).

## What runs where

| Need | Service | Cost | Behaviour |
|---|---|---|---|
| Scheduled jobs (uptime, data validation, reports) | GitHub Actions `payesh-free-tasks` | Free | Runs every 6h + on demand; ephemeral, not always-on |
| Light backend (status API) | Render free web service `payesh-status` | Free | Sleeps after 15 min idle, ~1 min cold start, 512 MB RAM, no persistent disk |
| Site + web app hosting | Arvan (existing, live) | Existing | Unchanged |

## GitHub Actions as a "task server"

- Workflow: `.github/workflows/payesh-tasks.yml`, script `tools/payesh-monitor.mjs`.
- Every 6 hours it checks https://payeshschool.ir/ , https://app.payeshschool.ir/
  and the rendezvous file `/payesh/pub/school-servers.json`, validates the JSON
  (`kind=payesh-school-servers`, `servers` array), stores a JSON report as a
  workflow artifact (30 days), and — when secrets exist — sends a Persian
  summary to the owner's Telegram via @PayeshSchoolMonitorBot.
- Required repo secrets (Settings → Secrets → Actions): `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_CHAT_ID`. Without them the workflow still runs and logs.
- Honest limits: Actions is batch compute, not a server — no inbound traffic,
  no persistent state, jobs capped at 6h, free minutes apply to private repos.
  It fits scheduled/data tasks (monitoring, validation, report generation);
  anything needing a live socket stays on Arvan/Render.

## Render free backend

- Blueprint `render.yaml` deploys `services/status-service` (dependency-free
  Node, no school data): `GET /health`, `GET /api/status` (60s-cached probe of
  the three public endpoints). First hit after idle takes ~1 minute.
- Setup: dashboard.render.com → sign in with GitHub (no card) → New →
  Blueprint → pick this repo → Apply. Deploys come from pushes to the branch
  Render tracks; production app data is never sent to Render.

## Impact on the app

None for end users today: the Flutter app keeps using Arvan + the fixed
rendezvous address. These two free services are auxiliary (monitoring +
status), so if either is down, the school app is unaffected. They replace the
LightVela paid-after-trial monitor with a free, owner-controlled equivalent.
