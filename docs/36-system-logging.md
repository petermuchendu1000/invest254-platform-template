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

## Config (Fly secrets / env)
`LOG_LEVEL` (default `info`; set `debug` to trace a live issue), `LOG_PRETTY=1` for local dev.

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
