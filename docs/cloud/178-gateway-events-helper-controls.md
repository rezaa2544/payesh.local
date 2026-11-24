# Row 178 — instant notifications through the Gateway, pause for the helper server, helper-card controls

Row 177 added event-driven sync on the school LAN (`GET /api/v1/events`). This row closes the gaps
the owner reported.

## 1. Instant change notifications through the Gateway

Devices that sync over the internet talk to the Gateway (`server/gateway.js`, PostgreSQL). The
Gateway is not a proxy to a school server, so it gets its own stream with the **same contract**:

```
GET /api/gw/v1/events?since=<seq>&topics=a,b     (Gateway token; tenant only from the token)
event: hello  {seq, at, missed}
event: change {seq, topics, at}                   only after a committed push, 150 ms coalesced
:                                                 every 45 s (keeps proxies from closing it)
```

```
push (any instance) ─► applyOps tx ─► pg_notify('payesh_gw_feed', {t, s:max(seq), c:[collections]})
                                          │  delivered only after COMMIT (rollback ⇒ nothing)
                                          ▼
every Gateway instance: one LISTEN connection (only while ≥1 stream is open)   server/gw-events.js
   └─► SSE to that tenant's devices ─► device: GET /api/gw/v1/pull?since_seq=…
```

* `seq` is the tenant change-feed seq, so the client's cursor and the notification match.
* Database cost:
  * no open stream ⇒ zero queries and no LISTEN connection;
  * open streams ⇒ one LISTEN connection per instance, plus one indexed `max(seq)` per connected
    tenant every 60 s as a safety net (every 15 s while LISTEN is down);
  * notifications carry collection names only, never record data.
* Limits: `GW_EVENTS_MAX` streams per instance (default 2000) and 300 per tenant. Over the limit the
  Gateway answers 503, and the app keeps its slow safety check.
* Drain (SIGTERM): open streams are closed at once, so they never hold the shutdown.
* The response has `X-Accel-Buffering: no` and `Cache-Control: no-transform`, so nginx and Passenger
  (serv00) do not buffer it.
* Client: `ChangeFeed(path: ChangeFeed.gatewayPath, deviceId: …)` is used in Gateway mode in
  `attendance_wiring.dart`. LAN mode is unchanged. `X-Device-Id` keeps the per-device quota bucket.

Tests: `tests/gw-events-178.js`.
* 7 checks need no database (`npm test`).
* 3 checks run on real PostgreSQL with two Gateway processes (CI api-contract). A push on
  instance B reached a stream on instance A in about 170 ms locally.

## 2. «Pause processing» also stops the helper server's background work

| Background work (school server) | Paused |
|---|---|
| 30 min public-URL check (`start()` tick) | skipped (row 177) |
| `runJob(…, {background:true})` | returns `{ok:false, error:'processing_paused'}`, does not run, no queue write |
| 5 s load-route tick | still reads the policy (60 s cache, so «resume» arrives); routing and the external probe are skipped |
| user/manager request (`/api/admin/helpers/usage`, `check-public`) | runs locally at once (`why: processing_paused`); never waits for helpers that are paused too |

CPU cap: a background job run locally rests `processing.restMs(work)` afterwards. User requests are
never throttled. Tests: PR-06 and PR-07 in `tests/events-177.js`.

## 3. API documentation

* `components/schemas/ProcessingStatus` = `{paused, cpu_pct, source, at}`.
* The schema is referenced from `GET /api/admin/helpers` and `GET /api/live/state`.
* `GET /api/gw/v1/events` is documented. The drift gate shows 136 = 136.

## 4. Start/stop and processing amount inside «پردازش کمکی (همین سیستم)»

The card now has its own control box (`helper-controls`). It appears both on the dashboard and on
«زیرساخت».

* **شروع / توقف** (`helper-toggle`):
  * «توقف» pauses this system and is persisted (`owner.helper.paused`).
  * «شروع» clears everything that blocks this system: the local pause, the global «توقف پردازش»,
    «فقط دیتابیس» mode (switched back to helpers mode) and this helper's off switch.
* **مقدار پردازش این سیستم** (`helper-cpu`, 10–100 %, persisted in `owner.helper.cpu`):
  * effective cap = min(this system, the global «کنترل پردازش» cap);
  * concurrent jobs = `slotsForCpu(effective)`;
  * after each job the node rests `restForCpu(work, effective)` (same formula as the server, max 5 s)
    and does not even read the queue while resting.
* Global «توقف پردازش» ⇒ the node claims no new jobs; running jobs finish.
