# 36 — System Logging (structured, enforced)

**Branch:** `feat/system-logging` · Shared logger + enforced per-request logging for admin/dev debugging.

## Logger — `@invest254/shared/logger`
Dependency-free, structured, secret-safe. Used by the API + engine (browser code keeps `console`).

- `createLogger({ level?, bindings?, sink?, pretty?, now? })` → `Logger` with `debug/info/warn/error`
  and `child(bindings)`.
- **One JSON line per event:** `{ t, level, msg, ...bindings, ...fields }` (compact human line when
  `LOG_PRETTY=1`). Aggregator-friendly on Fly.
- **Env-gated:** `LOG_LEVEL=debug|info|warn|error` (default `info`). Below-threshold calls are no-ops.
- **Child loggers** carry bound context so every line in a flow is correlated:
  `const plog = log.child({ module: "payments", requestId })`.
- **Secret/PII safe (critical for a money system):** keys like `token`, `authorization`, `api_key`,
  `password`, `pin`, `passkey`, `service_role_key`, `connection_string`, … are replaced with
  `[REDACTED]`; `phone`/`msisdn`/`partyA/B` values are masked (`254***678`). Deep, bounded by depth
  (6), array size (50) and string length (2000). Matching is separator/case-insensitive
  (`api_key` = `apiKey` = `api-key`).
- **Never throws, never blocks** — a logging fault (even circular fields) can't affect a request.
- `logger.error("msg", err)` accepts an `Error` and serializes `name/message/stack` under `err`.

## Enforcement — the request chokepoint (`apps/api/src/http.ts`)
Every HTTP request flows through `Router.handle`, which now:
- mints (or honours an inbound) **`x-request-id`** and echoes it as a response header (support/cross-
  service correlation);
- exposes `ctx.requestId` and a pre-bound **`ctx.log`** (`{ requestId, method, path }`) to every
  handler/middleware;
- emits **exactly one** structured line per request on completion with `method, path, status,
  durationMs, ip, userId, role, siteId` (and `code` on failures):
  - `2xx/3xx` → `info`, `4xx` → `warn`, `5xx` → `error` (with stack), `**/health*` → `debug` (no noise).

So no route can be added that isn't logged — the logging lives in the dispatcher, not per-route.

## Wiring
- `server.ts` builds the base logger (`createLogger({ bindings: { app: "api" } })`, env-driven) and
  passes it via `ApiDeps.logger` → `Router`. Boot milestones, the Mega Pay client init, and the
  deposit/Mega Pay reconcile sweeps log through it (money-path background jobs are structured).
- Tests use a silent logger (`level:"error", sink:()=>{}`) so the suite stays quiet; the request-log
  path is still exercised.

## §6 — Background-sweep liveness (BUGLOG #162)

Logging on its own cannot answer *"is this background job still running?"*, because every sweep in
`server.ts` logs only when it has something to report. Silence from a sweep is therefore ambiguous:
it means both "nothing to settle" and "the timer is dead". Three of eleven sweeps did log an "armed"
line, through the module-scoped `log` whose sink is `process.stdout` — never the `system_logs` sink
— so not even boot left a durable trace. **A money-path sweep's death must not be invisible**, so
liveness is tracked separately from logging:

- **`apps/engine/src/sweeps.ts`** — an in-process registry. Each sweep `arm`s with its cadence and
  records `ok`/`fail` per tick. Late at `period × 2 + 30 s` (one missed tick plus jitter). It pages
  Telegram from memory, per process, about its own sweeps, evaluated on every recorded run rather
  than on a watchdog timer (a watchdog is one more timer that can die). `persist`/`page` are
  fire-and-forget and the registry never throws — these calls sit inside the `.then` of sweeps that
  move money.
- **`public.sweep_heartbeats`** (migration 0212) — the durable record. One UPSERTed row per
  `(app, machine, name)`, throttled to one write a minute per sweep with status changes written
  through at once. Deliberately not `system_logs`: a heartbeat stream there would be ~16k rows/day
  and would bury the log UI it shares.
- **`GET /admin/sweeps`** (owner-only, same `backoffice.logs` capability) and the **job board**
  above the System logs table. The board asserts health positively and with a timestamp ("All 10
  jobs running, checked 12s ago"), because a positive claim can be visibly wrong while an absence
  cannot.
- **The read recomputes the verdict** from the timestamps via `resolveSweepStatus` and never trusts
  the stored `status` column: a machine whose process died leaves it frozen at `'ok'`, so a board
  that read it would render a dead sweep green. One rule, shared by the pager and the query, so the
  two cannot drift apart.
- **Nothing alerts off the table.** Fly's `auto_stop_machines` leaves stopped machines' rows
  legitimately stale; paging off them would manufacture false alarms. A live process pages for
  itself, a dead one is the `/api/v1/health` check's job, and departed rows are pruned after 7 days.
- **Adding a sweep.** Call `track.arm(name, { everyMs, firstRunMs })` beside the timer and
  `track.ok(name)` / `track.fail(name, err)` in its `.then`/`.catch`, and put the "armed" line on a
  persisted child of `deps.logger` (never the bare `log`).
  `apps/api/src/server.sweeps.guard.test.ts` fails the build otherwise.

## Config (Fly secrets / env)
`LOG_LEVEL` (default `info`; set `debug` to trace a live issue), `LOG_PRETTY=1` for local dev.
`SWEEP_HEARTBEAT_RETENTION_DAYS` (default 7) prunes departed machines' heartbeat rows.

## Adoption guideline (for new/edited backend code)
- In a request handler/service call chain, prefer `ctx.log` (already carries `requestId`).
- Elsewhere, `const log = createLogger().child({ module: "<name>" })`.
- Log **events with context objects**, not string concatenation: `log.info("deposit initiated",
  { userId, amountCents, provider })` — never interpolate secrets/PINs (the logger also redacts as a
  safety net). Use `warn` for handled/expected failures and `error` (with the `Error`) for faults.

## Tests
- `packages/shared/src/logger.test.ts` — level gating, JSON shape, deep redaction + phone masking,
  error serialization, child-binding merge, circular-safety, helpers.
- `apps/api/src/app.logging.test.ts` — one structured line per request, correct level per status,
  `requestId`/`x-request-id` present, inbound request-id honoured.
- `apps/engine/src/sweeps.test.ts` — the staleness boundaries, `pending` vs `stale` on a young
  process, a disabled sweep never being reported late, alert cooldown/re-arm, write throttling, and
  the never-throw contract under a throwing `persist`, `page` and clock.
- `apps/engine/src/sweeps.pg.test.ts` (`E2E_PG_DSN`) — the upsert key, the recomputed verdict on a
  row frozen at `'ok'`, worst-news-first ordering, and the prune.
- `apps/api/src/server.sweeps.guard.test.ts` — static: no untracked module-scope `setInterval`, both
  outcomes recorded per sweep, no outcome for an unarmed name, no "armed" line on the stdout logger.
