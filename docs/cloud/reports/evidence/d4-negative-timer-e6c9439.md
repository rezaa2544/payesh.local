# D4 negative control — timer after database close

- Product source under test: `e6c9439d9d5f18068206a336c6cc46fe814ab58c`.
- Mutation: isolated temporary worktree at that commit; `server/db.js`, `server/update.js`, and `server/index.js` restored from pre-fix `origin/main` snapshot `15d2ab758ea0bc3df4bc1301f979f0d738c7d400`; final `tests/update.js` retained.
- Command: `npm run test:update`; expected regression: nonzero exit, including `database is not open` from the timer test.
- Exact unedited stdout/stderr: `d4-negative-timer-e6c9439.raw.b64` (base64; decode with `base64 -d d4-negative-timer-e6c9439.raw.b64`).
- SHA-256 of decoded raw output: `6c4a6e633654eabe0016bd2732b6cf8b64642cbfaa8e776942a1fbf60e94ff0a`.
