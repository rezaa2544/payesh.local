# Row 177 — event-driven sync and processing control

## Architecture

**Publish/subscribe with change notifications** (event-driven), delivered over
**Server-Sent Events (SSE)**. Clients then pull **only the delta** (cursor + ETag).

```
write (any source: user, phone mailbox, admin)
   │  Store.insert/update/remove ─► onWrite(collection)            server/db.js
   ▼
events hub: coalesce 150 ms ─► {seq, topics:[collections], at}     server/events.js
   ├─► SSE  GET /api/v1/events  ─► every connected device          (no data, only "what changed")
   │        device ─► GET /api/v1/pull?since=…  (If-None-Match ⇒ 304 when nothing new)
   └─► live loop: publish to the shared bucket at once              server/live.js
```

* Idle stream: zero bytes, apart from a `:` comment every 45 s that keeps proxies from closing it.
* Reconnect: `?since=<seq>`. `hello.missed=true` means something changed in between, or the
  server restarted. The client then pulls once.
* Phones (S3 mailbox): the school server checks `realtime/rev.json` on an **adaptive** schedule.
  It checks every 1 s for 2 min after any activity. When idle it doubles the gap up to 60 s while
  devices are connected, or up to 5 min when nobody is connected.
  * Reads per idle day: 86 400 before ⇒ 1 440 (devices connected) or 288 (nobody connected).
  * Local writes never wait: the write event triggers the publish.
* `GET /api/live/state` exposes `delay_ms`, `clients`, `events` and `processing`.

### Clients

| Client | Behaviour |
|---|---|
| Web (`client/app.js`) | Streaming `fetch` to `/api/v1/events`, because `EventSource` cannot send `Authorization`. `pullAll` runs only on `change`. While connected, a safety check runs every 5 min. If the stream is unavailable, the old adaptive `/api/live/rev` polling resumes, with reconnect backoff from 5 s up to 5 min. A hidden tab closes the stream and stops timers. The 90 s sweep is skipped while the stream is up and the queue is empty. |
| Native app (`payesh_sync` `ChangeFeed` + `AutoSync`) | Same SSE feed in LAN mode. While the feed is live the idle poll becomes a 10 min safety check, and `notifyRemoteChange` pulls. `AppLifecycleListener` pauses everything while hidden. |
| Owner panel | Talks to the bucket directly (no server session), so refresh is **activity-driven** through `PacedTimer`. Hidden: off (background jobs slow down instead). Owner active in the last 2 min: normal pace. Idle: slower. Coming back: one immediate refresh. Live-monitor probe: 5 s active, 60 s idle. Capacity scan: 30 min (was 2 min), or on tap. |

## Processing control (pause / CPU %)

Set in the owner panel (Infrastructure ▸ «کنترل پردازش»). It is stored in the sealed infra policy
`control/infra-policy.json` as the optional field `proc: {paused, cpu}`. The default is not
written, so older servers and panels keep the same envelope. Every system follows it on its next
policy read (≤ 60 s).

| System | `paused` | `cpu` (10–100 %) |
|---|---|---|
| Helper (owner app) | Takes no jobs (`acceptWork`) | Concurrent jobs = ⌊cores × cpu⌋, from 1 to cores (unset ⇒ old cores/2, from 1 to 4) |
| School data service (Node) | Auto backup, mirror and the periodic external check are skipped | The cap is the "busy" threshold (above it, heavy work goes to helpers). Local heavy loops rest `work × (100 − cpu) / cpu`, at most 5 s |
| Owner app background | Heavy `PacedTimer`s skipped (guard, auto backup, capacity scan) | — |

Server environment variables override the policy: `PAYESH_PROC_PAUSED=1`, `PAYESH_CPU_PCT=10..100`.
User requests and data sync (`live` / `outbox`) are never paused.

## Tests

* `tests/events-177.js` (17 checks, part of `npm test`).
* `apps/payesh/packages/payesh_sync/test/change_feed_test.dart`.
* `apps/payesh/owner/test/power_177_test.dart`.
