# Bug Log

Running log of bugs caught (new or pre-existing) while working through issues, with status. Each
entry: what, evidence, root cause, impact, and resolution.

---

## #162 — Eleven background sweeps, none of which could tell you it was still running — FIXED (migration 0212 + a liveness registry)

- **What.** Every background sweep in `apps/api/src/server.ts` reports only when it has something
  to say: `if (r.settled || r.errors)`, `if (n > 0)`, `if (r.warnings.length > 0)`. Three of the
  eleven also logged an "armed" line at boot — through the module-scoped `log`, whose sink is
  `process.stdout`, **not** the `system_logs` sink (`dbLog`, `server.ts:119`). So the only durable,
  queryable record of the whole sweep layer was silence.
- **Why that is a bug and not a style point.** Silence is also exactly what a dead timer looks
  like. The same empty screen means all of:
  - every sweep is running and there is simply nothing to settle (the healthy case);
  - `DEPOSIT_RECONCILE_INTERVAL_MS` / `TICKET_ESCALATE_INTERVAL_MS` / `POOL_HEALTH_INTERVAL_MS` set
    to `0` in Fly secrets;
  - `deps.payments` / `deps.tickets` / `deps.billing` / `deps.poolHealth` absent, so the arm block
    never ran;
  - a sweep that armed and then stopped firing.
  The owner-visible System logs page made the inference explicit and wrong, telling the operator
  *"Warnings and errors will appear here as they happen"* — i.e. teaching them to read a blank page
  as reassurance.
- **What it was costing.** These are not cosmetic jobs. `reconcileDeposits` /
  `reconcileMegaPayDeposits` / `reconcilePayHeroDeposits` / `reconcilePaynicornDeposits` /
  `reconcilePayHeroLedger` are what settle a deposit whose provider callback never arrived — a dead
  reconciler means players' money is taken and never credited, with no alert. `pool.health` is what
  notices a brand's players losing 100% of their stakes (#12, #160).
- **How we got here.** #160 moved the pool monitor OFF a GitHub cron precisely because that cron
  failed silently — measured 6 firings out of 48 over 24 h. Moving it to a timer whose death is
  equally silent swapped one invisible failure for another. The same was true of the
  ticket-escalation move before it. That is the actual defect: we fixed the mechanism and not the
  observability.
- **Fix.** `apps/engine/src/sweeps.ts` — an in-process liveness registry. Each sweep `arm`s with its
  cadence and records `ok`/`fail` per tick; a sweep is **late** at `period × 2 + 30 s` (one missed
  tick plus jitter: 60 s for the 15-second fast re-verify lane, 10.5 min for a 5-minute reconciler,
  60.5 min for the 30-minute pool monitor). Three parts:
  1. **It pages.** From memory, per process, about its own sweeps, evaluated on every recorded run
     rather than on a watchdog timer — a watchdog is one more timer that can stop, and would be the
     single point of failure for the whole scheme. Any one surviving sweep notices that the others
     have stopped. Verified: a 15-second lane alone detects a dead half-hourly monitor in 61 min.
  2. **It persists.** `public.sweep_heartbeats` (0212), one row per `(app, machine, name)` — an
     UPSERT, so the table is permanently ~11–22 rows however often the sweeps fire. Throttled to
     one write a minute per sweep, with any status change written through immediately. Deliberately
     NOT `system_logs`: a heartbeat stream there would be ~16k rows/day and would bury the log UI.
  3. **It is readable.** Owner-only `GET /admin/sweeps` and a job board above the System logs table,
     which asserts health *positively and with a timestamp* ("All 10 jobs running, checked 12s ago")
     because a positive claim can be visibly wrong and an absence cannot.
- **The subtle part, and the one most likely to have been got wrong.** The read path **recomputes**
  the verdict from the timestamps and never trusts the stored `status` column. A machine whose
  process died leaves that column frozen at `'ok'` — so a board that read it would render a dead
  sweep green, which is the exact failure this feature exists to end. One rule
  (`resolveSweepStatus`) is shared by the registry that pages and the query that renders, so the
  board and the alert cannot disagree; expressing it in SQL would have put the same tolerance in two
  places, free to drift. Pinned by a pg test that ages a row to five hours, asserts the board says
  `stale`, and asserts the row still says `ok` (the read is a view, not a mutation).
- **Why nothing alerts off the table.** `auto_stop_machines = "stop"` with
  `min_machines_running = 1` (fly.api.toml) means Fly stops surplus machines, leaving a legitimately
  stale row behind. Paging off those rows would manufacture 3am false alarms. A live process pages
  for itself; a process that is gone is Fly's `/api/v1/health` check's job. Departed machines' rows
  are pruned after 7 days.
- **Never-throw contract.** `persist` and `page` are fire-and-forget and both swallow their own
  rejections, and every registry entry point is wrapped. These calls sit inside the `.then` of
  sweeps that move money: a fault in observability must not become a fault in the thing observed.
  Tested with a `persist` and a `page` that both throw, and with a clock that throws.
- **One real bug found while wiring it.** `track.ok("pool.health")` placed before
  `await poolHealth.page(...)` recorded a tick as BOTH a success and (via the `.catch`) a failure
  when the Telegram delivery failed. Moved to the end of the handler, so a tick that failed to
  deliver a starvation page is recorded as the failure it is.
- **Guard.** `apps/api/src/server.sweeps.guard.test.ts` reads `server.ts` and fails if a
  module-scope `setInterval` has no tracked sweep, if an armed sweep records only one of the two
  outcomes (`ok` without `fail` looks healthy while failing every tick; `fail` without `ok` pages
  the operator for a working system — the fastest way to teach somebody to ignore the alert), if an
  outcome is recorded for a name never armed (the registry drops those by design, so a typo would
  otherwise be invisible), or if an "armed" line slides back onto the stdout-only logger. The
  omission is how this bug class recurs, so the twelfth sweep cannot be added the old way.
- **Verification.** 20 unit tests (14 of 15 mutants killed; the survivor is behaviourally
  equivalent). 2 pg tests against a real PostgreSQL 16.15 with 0212 applied: the upsert collapses
  to one row per key, a second machine is a separate row, the frozen-`ok` case renders `stale`,
  ordering is worst-news-first, `last_error` is bounded at 500 chars at the DB boundary, and the
  prune drops only departed machines. 7 guard mutants, all caught (one of which exposed a guard
  regex that matched the *other* callback's `.catch` — fixed). Full suite 2411 tests, 0 failures.
- **Out of scope, noted.** The engine process has its own timers (game loop, config polls), but
  their failure is immediately visible in what they feed; `sweeps.ts` lives in the shared engine
  package so the engine can adopt it. `scripts/winrate_monitor.py` and `scripts/pool_reconcile.py`
  are still on the Python-ops cron pattern that pool-health left in #160.

---

## #161 — The schema-drift gate cannot see triggers, which is how a live one sat in production for weeks — FIXED (migration 0211 + a trigger catalog)
- **Started as:** `schema-drift` red since 2026-10-14 on two differences and nothing else:
```
  only-production  function       fn_pool_auto_settings_seed()
  only-production  function-exec  fn_pool_auto_settings_seed()  [prod=false/false]
```
- **What it actually is.** Not an orphaned leftover, which is what a function nothing calls looks
  like from the repository. It is a **`SECURITY DEFINER` trigger function**, and it is **live**:
```
  CREATE TRIGGER trg_platform_pool_defaults AFTER INSERT ON public.platforms
    FOR EACH ROW EXECUTE FUNCTION fn_pool_auto_settings_seed()
```
  It inserts a `pool_auto_settings` row for each new platform. Production: 3 platforms, 3 rows.
  Grants `postgres=X/postgres | service_role=X/postgres` — no anon surface, consistent with the
  gate's own `[prod=false/false]`.
- **THE REAL BUG IS THE GATE, not the function.** `CATALOG` in `scripts/schema_drift.mts` compares
  functions, function EXECUTE grants, policies, indexes, views, columns and table write-grants.
  **It does not compare triggers.** So the trigger — the thing that actually changed how `platforms`
  behaves on every INSERT — was invisible, and the only reason anything went red is that the
  function it calls happened to be production-only too. **Attach a trigger out-of-band to a function
  the migrations already create and this gate would have said nothing at all**, while a table
  silently gained a side effect on every write. That is a worse version of exactly what #57 built
  this gate to catch.
- **Fix, two parts.**
  1. **Migration 0211 adopts it**, rather than dropping it. Reasons, in order: it is live; the repo
     already does precisely this for precisely this table shape (0136's
     `trg_platform_seed_subscription`, also `AFTER INSERT ON public.platforms` — whoever wrote this
     followed that pattern by hand and never made it a migration); and dropping live machinery to
     satisfy a gate is the wrong direction when adopting costs nothing. If any consumer did depend
     on the row existing from day one, adopting keeps it working and dropping would not.
  2. **A `trigger` catalog in the gate**, keyed `table.trigger_name` on `md5(pg_get_triggerdef())`,
     excluding `tgisinternal` (every foreign key carries RI triggers, and comparing those would make
     the gate red on any schema with a foreign key) and extension-owned objects, like the rest of
     the catalog.
- **It is behaviourally a no-op, which is why adopting was safe to do unilaterally.** `0164`'s
  `fn_pool_auto_settings_get` coalesces an **absent** row to `mode='dynamic'`, `lookback_days=14`,
  and reports `is_default` true while `updated_by` is null — so a trigger-inserted bare row reads
  **identically** to no row at all. And `fn_pool_auto_record_run` inserts that same row on every
  nightly run regardless. The trigger only moves the row's creation earlier, from the first
  distribution to the platform's own INSERT. The money-moving consumer
  (`scripts/pool_distribute_daily.mts`) reads through that RPC, so it cannot tell the difference.
- **Verified against production, not inferred.** With a management token that carries
  `database_read`, built a local Postgres 16 from the shim plus all 212 migrations and compared:
  | | production | migrations + 0211 |
  |---|---|---|
  | `md5(pg_get_functiondef)` | `e7380ac8ae17633053644b5408300e77` | **same** |
  | `pg_get_triggerdef` | `CREATE TRIGGER trg_platform_pool_defaults …` | **same** |
  | `function-exec` (anon/authenticated) | `false/false` | **same** |
  | platforms : pool_auto_settings | 3 : 3 | 1 : 1 — the invariant holds |
  So 0211 makes the gate **green** rather than trading one difference for another.
- **Then the whole gate was re-run by hand, all eight catalogs, production against a
  migrations-built reference — 0 real differences:**
```
  CATALOG                PROD   MIGS   REAL
  function                292    291      0
  function-exec           292    291      0
  policy                   28     28      0
  index                   232    231      0
  view                     14     14      0
  column                 1140   1140      0
  table-write-grant        22     22      0
  trigger                  32     32      0
```
  Six remaining rows are artefacts of this sandbox, not drift: `pgvector` cannot be installed here,
  so 0057's `kb_chunks.embedding` / `fn_kb_search` / the hnsw index are stubbed to `text` in a local
  COPY of the migrations (never in the repo). CI's job runs `pgvector/pgvector:pg17` and sees the
  real types.
- **A caution for anyone repeating this.** The first attempt reported **29** differences, and every
  one was my own fault: the reference build applies
  `alter default privileges in schema public grant all on tables/functions/sequences to anon,
  authenticated, service_role` BEFORE the migrations (`schema_drift.mts:107`), reproducing Supabase's
  real posture so that the migrations' `revoke`s have something to revoke. Skip that step and 22
  `table-write-grant` rows and one `function-exec` row go missing — which looks exactly like
  production having been tampered with. A reference database is only a reference if it is built the
  way the gate builds it.
- **And the new catalog was itself checked against production before shipping:** all **32**
  non-internal triggers compared, production against the migrations-built reference, **zero
  differences**. `trg_platform_pool_defaults` was the only trigger-shaped drift there was, so
  turning this catalog on does not light up a wall of pre-existing noise.
- **Applying 0211 to production is a no-op, by construction.** `create or replace` with a
  byte-identical body; revoke/grant already in that state; the backfill is `on conflict do nothing`
  against 3 rows that already exist. The `drop trigger if exists` / `create trigger` pair is the only
  moment anything is missing, and `scripts/migrate.mts` runs each file inside `begin`/`commit`, so it
  is atomic — there is no window in which a platform INSERT could miss its settings row.
- **Regression guard:** two tests in `scripts/schema_drift.test.mts` — one asserting the `trigger`
  catalog exists and that `diffSnapshots` reports a production-only trigger and a changed trigger
  body, one asserting the query excludes internal and extension-owned triggers and keys on
  `table.name` (two tables may legitimately carry a trigger of the same name). The first exists
  because **a missing catalog is a blind spot that reads exactly like a pass** — the same hazard as
  #152's scanner that examined nothing and #156's guard that found no capped jobs.
- **Worth saying about the credential:** the first management token supplied for this could not do
  it — missing `database_read`, and it saw 0 projects. Neither could the anon, publishable,
  service-role or `sb_secret_` keys: PostgREST exposes only the `public` schema's own objects, so
  `pg_catalog` is unreachable and `pg_get_functiondef` is not available to the data API at all. A
  function body is not something the application's own credentials can read, by design.

---

## #160 — The withdrawal-pool starvation monitor ran six times a day instead of forty-eight — FIXED (in-process)
- **What:** `pool-health.yml` asked GitHub for `*/30`. Measured over the 24 hours to 2026-10-22 it
  fired **6 times out of 48**, at gaps of **3h14m, 5h15m, 5h04m, 4h16m and 3h14m**:
```
  00:07  05:13  10:28  15:32  19:48  23:02
```
  The daily crons in the same repository fired **1-for-1** over the same window, so this is not the
  Actions billing interruption (#156) and not a repository problem — GitHub de-prioritises
  high-frequency `schedule` events, and it will not improve by being asked again.
- **Why that is worse than it sounds.** This monitor is the defense-in-depth net from #12/#12b, and
  it exists *specifically* to cover the other monitor's blind spot: `winrate_monitor` only alerts on
  windows with ≥50 samples, and starvation **suppresses volume** — players hit 100% losses and
  leave — so a starved brand often never reaches 50 trades and the drift alert stays silent. The net
  written to catch what the other one cannot see was itself running at one-eighth rate, on real
  money, with an alert that is supposed to fire *early*.
- **Fix:** the sweep now runs in the API process beside the ticket-escalation and deposit sweeps
  (`apps/api/src/server.ts`, `POOL_HEALTH_INTERVAL_MS`, 30 min, first run 45s after boot). Same
  shape, same reasoning and the same place as the ticket-escalation move that preceded it. The
  workflow stays, schedule commented out, as the manual lever for when the API is down or
  mid-rollback.
- **And there is now ONE implementation instead of two.** `scripts/pool_health_monitor.py` was
  deleted, not kept alongside. It was a second copy of these thresholds and had **already drifted**:
  it restated `PLAYER_SHARE = 0.15` as a literal beside the real `DEFAULT_POOL_KNOBS.playerShare` in
  `pool.ts`, with nothing to notice if the knob were ever retuned. The new module imports the knob,
  and both the in-process sweep and the CLI (`scripts/pool_health_check.mts`) call it.
- **Verification — differential, not asserted.** Built a throwaway Postgres 16 locally, applied the
  Supabase shim plus **all 211 migrations** (109 tables, 326 functions — matching production's
  PostgREST surface), seeded eight scenarios, and ran the Python original and the TypeScript port
  against the same database:
  - `--json` output **byte-identical** on all eight, and identical exit codes (1 on hard alert).
  - Human output **byte-identical** between the old script and the new CLI.
  - The scenarios covered healthy, `POOL_STARVED`, `ALL_LOSS`, `BELOW_VIABLE`, a quiet brand, a
    brand hitting two alerts at once, `min_stake = 0`, and the trap below.
- **THE TRAP, which is the single most dangerous way to get this port wrong.** Every cents column
  here is `bigint` and `max_multiplier` is `numeric`, and node-postgres returns both as **strings**.
  This module compares them with `<`. Left as strings, `"9000" < "25000"` is **lexicographically
  false and numerically true**, so a brand with 9,000 cents available against a 25,000-cent minimum
  stake — starved, every trade a guaranteed loss — would have been reported healthy and nobody paged.
  The row values are coerced at the boundary (the repo's existing `toCents` convention), a fixture
  pins exactly that case against the real schema, and a unit test pins it with string inputs.
- **One deliberate divergence from the original, recorded so nobody "fixes" it.** The Python wrote
  its ceiling as `-(-x // PLAYER_SHARE)`, and CPython's float floor-division is fmod-corrected: it
  sees the TRUE quotient of the doubles rather than the rounded one. `0.15` as a double is a shade
  under 0.15, so `15/0.15` is `100.0` rounded but `100.0000000000000037` exactly, and the original
  returned **101** where `Math.ceil` returns **100**. Python's own `math.ceil(x/0.15)` also returns
  100 — the original disagreed with itself. `Math.ceil` is kept, because the intent is the decimal
  0.15 and not its binary neighbour. The gap is **one cent**, only when the division comes out
  exact, and only on `BELOW_VIABLE`, which is a warning that never pages. A scan of the feasible
  parameter space (`site_cfg_feasible` requires `max_multiplier > 1`) shows the disagreement needs
  `min_stake ≤ 15` **cents**; production runs 25,000. Both values are pinned in the unit test.
- **Duplicate pages are accepted, deliberately.** `auto_start_machines` (fly.api.toml) can bring a
  second API machine up under load and both will sweep, so a starvation event can page twice.
  Suppressing that would need a distributed lock held across the interval; for an alert that means
  "players are losing everything right now", twice is better than never.
- **Tests:** `poolhealth.test.ts` — 9 unit tests (the ceiling and its divergence, the knob is
  imported not copied, the string-comparison trap, each alert's preconditions, precedence of
  `POOL_STARVED` over `BELOW_VIABLE`, `available` never negative, warnings not raising the alert
  flag, the page wording). `poolhealth.pg.test.ts` — the real query against the real schema
  (`E2E_PG_DSN`, rolled back): five brands, one per verdict, plus ageing every decision past the
  rolling window and asserting the alerts clear, which is what stops a re-funded brand being paged
  for pre-remediation losses. Verified green against the local 211-migration database and verified
  to SKIP without a DSN, which is how CI will see it.
- **Caught while writing this, worth its own line:** the first draft of `poolhealth.ts` would not
  compile, because the doc comment contained the cron spec `*` `/30` and `*/` **terminates a block
  comment**. Same family as #152's Tailwind-in-a-comment: a comment is not inert.

---

## #159 — An EXPIRED MIRROR_PAT is worse than no MIRROR_PAT: the mirror failed on its FIRST step for 23 days — PARTIALLY FIXED (needs the owner to replace the token)
- **What:** `mirror-sync` in the template has failed every run since 2026-09-29 — 23 days, ~180 runs on
  a 3-hourly cron, each one appending to the same blocker issue (template #32). The template sits at
  `invest254@0405bb9` while production is 100+ commits past it.
- **Where it fails, and this is the whole point:** `actions/checkout`, the FIRST step, with
  `fatal: could not read Username for 'https://github.com': terminal prompts disabled`. Not the push.
  The job never reaches the drift check, the typecheck, or the push it exists to perform.
- **Root cause:** the token expression is `${{ secrets.MIRROR_PAT || github.token }}`. `||` falls back
  when the secret is **empty**, not when it is **rejected**. So a set-but-dead PAT is handed to
  checkout, which authenticates with it, is refused, and falls through to prompting for a username on
  a runner that has no terminal. An ABSENT PAT would have mirrored everything except
  `.github/workflows/`; an EXPIRED one mirrors nothing. The failure mode gets worse as the credential
  gets worse, which is backwards.
- **Why nobody saw it for 23 days:** the blocker issue says "Common cause: MIRROR_PAT missing/expired"
  — a guess printed on every failure, correct this time, and indistinguishable from the same guess
  printed when the cause is something else. ~180 identical comments on one issue is not a signal.
- **Fixed here (the part that is code):** a preflight step, modelled on `deploy.yml`'s `fly-auth`,
  asks `GET /repos/{this repo}` with the PAT before anything uses it. 200 → use it. Anything else →
  annotate with the HTTP code and what to do, and fall back to `GITHUB_TOKEN`, with
  `.github/workflows/` held at the template's current content so the refused paths cannot lose the
  whole push. A workflow-only drift then commits nothing and says so rather than dying on
  `nothing to commit`.
- **NOT fixed here (the part that is a credential):** the PAT itself. A fine-grained PAT on
  `petermuchendu1000/invest254-platform-template` with **Contents: read and write** AND **Workflows:
  read and write**, stored as the `MIRROR_PAT` secret in the TEMPLATE repo's Actions secrets. Nobody
  but the owner can mint it, and this change cannot reach the template until it exists — the mirror
  is how it would get there. First sync after the fix carries this file.
- **Consequence while it was broken, worth stating:** every one of #155's timeouts, #156's mirror
  guards and #157's `max-parallel: 1` is absent from the template. Its jobs still inherit GitHub's
  360-minute default, which is the exact condition #155 was written about.

## #158 — A candle test compared two windows fetched up to 25 seconds apart, so CI went red whenever a run straddled the hour — FIXED (test)
- **Caught by:** the CI `build` job of PR #178 failing on `WS candles: naming a symbol returns THAT
  instrument's bars, not the default's rescaled`, on a branch whose diff touched only workflows,
  docs and a workflow guard test. Nothing in the change could reach the engine, which is what made
  it worth reading rather than re-running.
- **What the failure said** (`multiengine.candles.test.ts:278`, `assert.deepEqual`): the two bar
  windows were identical except that the actual one was shifted **one bar — exactly 3600s —**
  later at both ends. Decoded, the expected window ended **2026-10-22T09:00:00Z** and the actual
  ended **10:00:00Z**.
- **Root cause.** The test makes **two sequential requests**:
```
  const gold = await c.ask("candles", { tf: "H1", count: 24 }, "candles");
  const euro = await c.ask("candles", { tf: "H1", count: 24, symbol: "EURUSD" }, "candles");
```
  Each reply is the most recent 24 H1 buckets **as of the moment that request was served**, and this
  file's own header says warming a second symbol on an already-ticking brand costs up to 24s — the
  client's ceiling is `WARM_MS = 25_000`. So the gap between the two asks is seconds to tens of
  seconds, and an H1 boundary falling inside it slides the second window forward by one bar. The
  assertion then compared a 10:00-ending window against a 09:00-ending one and failed. It is a
  **clock-boundary race with a deterministic trigger**, not a random flake: roughly 25s of every
  3600 is a losing window, which at ~380 CI runs a month is a handful of red builds — invisible
  individually, and each one an invitation to re-run rather than read.
- **A second instance of the same assumption, three lines down.** `shape()` indexed the two series
  **positionally** (`b[i]`), so a shifted window also compared bar *i* of one symbol against a
  different hour of the other. That one did not fail loudly; it silently compared the wrong bars.
- **Fix.** Compare the buckets the two replies **share**, and align the shape comparison **by time**
  instead of by index. The assertion's purpose is to prove the two symbols bucket alike and are not
  one series on two axes; it was never about them being sampled at the same instant. The new form is
  also stricter in a way the old one was not: each series must be a **contiguous** 3600s grid, and
  the two must overlap by at least `count - 1` bars, so one bar of boundary slack is allowed and a
  genuine grid disagreement still fails.
- **Proven, not assumed** (`scratchpad` harness, three synthetic cases):
  | case | old assertion | new assertion |
  |---|---|---|
  | one H1 boundary crossed between the asks (the CI failure, gold→09:00 / euro→10:00) | **FAIL** | **PASS** |
  | the grids genuinely differ (M30 against H1) | — | **FAIL**, as it must |
  | the same series rescaled (both rising, never opposite directions) | — | **FAIL**, as it must |
  So the fix accepts the boundary and still rejects both faults the assertion exists to catch.
  `multiengine.candles.test.ts` 18/18; full suite 2366/2376.
- **Worth generalising:** this file has five other cross-request comparisons (lines 172, 176, 206,
  319, 320) and all of them are keyed by **trade DATE** rather than by hour, so their losing window
  is a day boundary rather than an hour — the same bug with a ~24x smaller target. They are left
  alone deliberately; the pattern to watch for is any assertion that two separately-served replies
  describe the same slice of a moving window.

---

## #157 — The deploy hangs were never a slow builder: the two matrix legs race each other on one Fly builder — FIXED (`max-parallel: 1`)
- **What #155 and #156 saw:** one `deploy` leg occupying a runner until something killed it (six
  hours under GitHub's default, 25 minutes under #155's cap), while the other leg shipped in about a
  minute. #155 capped it; #156 widened the cap to 45 because one healthy deploy had taken 22
  minutes. Both were right about the symptom. Neither had the mechanism, and **#156 wrote the wrong
  one down** — it blamed "a cold Fly remote builder", which is corrected here.
- **The mechanism, from the logs of all four incidents.** Both matrix legs build the **same root
  Dockerfile** (`fly.api.toml` and `fly.engine.toml` share it — HOSTING.md), so Fly hands them to
  **one remote builder**, and buildkit deduplicates their identical layers against each other:
```
  #12 Deduplicating step ID [ 8/12] RUN npm ci --include=dev, another build is calculating it done
  #23 Deduplicating step ID [ 9/12] COPY packages/shared ./packages/shared, another build is calculating it done
```
  In the **successful** 22-minute run (`38137608432`) all nine dedup lines resolve inside **12
  seconds** and `exporting to image` starts at **+26s** — so dedup is fast and normal, and those 22
  minutes were spent in the **export** phase. In the hangs the same leg never leaves it. #155's
  six-hour stall is recorded as sitting at `#17 exporting to image`; the 2026-10-22 hang
  (`39754693431`, 25.3 min, killed by #155's cap) ends on
  `#17 [ 1/12] FROM docker.io/library/node:20-alpine@sha256:…` after deduplicating nine steps
  against a sibling build that had already finished.
- **Why "race" and not "bad image":** it has happened **four times in sixty runs, and never to both
  legs**. The sibling succeeded in ~1 minute every single time, building the same Dockerfile from
  the same commit. A defect in the build would not pick one leg.
- **Impact, which is the part that matters.** The matrix is `fail-fast: false` — correctly, so one
  app failing cannot abort the other mid-rollout — so every occurrence shipped one app, left the
  other behind, and **reported the run as containing a success**. That is how the API sat five days
  behind `main` (#155) and how, on 2026-10-22, `invest254-engine-pm` was found running
  `git-936a0ed` — a commit that was never on `main` — while the API ran `git-85ac550`, `main`'s tip. #156 fixed the *reporting* half of this (the annotation step was
  `if: failure()`, and all of these concluded `cancelled`, so it was skipped exactly when it was
  needed). This entry fixes the cause.
- **Fix: `max-parallel: 1` on the deploy matrix.** The legs build one after the other, so the second
  meets a warm cache instead of a half-built sibling. `timeout-minutes: 45` stays as the backstop —
  it is for a build that is never going to finish, not for this.
- **The cost, stated plainly:** a **1-2 minute window** where one app is newer than the other, where
  before there was none. Against it: a failure mode that has twice left an app behind `main`
  indefinitely and silently. A bounded skew beats an unbounded split release. The ordering is
  unchanged (`invest254-api`, then `invest254-engine-pm`), and `migrate` has already run before
  either, so both apps are on the new schema throughout the window regardless.
- **`fail-fast: false` is kept and now matters more, not less:** with serial legs it is the only
  thing that makes the second app still get attempted when the first one fails.
- **Regression guard:** a sixth test in `scripts/workflows.guard.test.mts` asserts the matrix keeps
  both `max-parallel: 1` and `fail-fast: false`, and that it still has at least two apps so a
  rewrite cannot quietly satisfy the first two. **Mutation-checked four ways** — removing
  `max-parallel`, setting it to 2, flipping `fail-fast` to true, and cutting the matrix to one app
  each turn it red; adding an inline comment to the value leaves it green.
  - For the third time in this file, the first version of a guard was defeated by this repository's
    habit of annotating values inline: `/^\s*fail-fast:\s*false\s*$/m` cannot match
    `fail-fast: false          # one app failing must not abort the other`. Every value regex here
    now ends `(?:#.*)?$`. (#152's z-index scanner, #156's `timeout-minutes` reader, this.)
- **Not changed:** the shared Dockerfile. Giving each app its own would also end the contention, but
  it duplicates the build definition for the two services that must stay in lockstep, and one
  `max-parallel` line buys the same thing for two minutes of wall time.

---

## #156 — The Actions "consumption" these two repositories bill is zero; what they do waste is a mirror's worth of runners and one permanently red gate — FIXED (branch `claude/busy-pascal-x44fkv`)
- **Reported as:** *"we need to fix the issue with the CI actions high consumption rate"*, after an
  Actions payment had to be made.
- **The first thing to say, because it changes what the rest of this is for: NEITHER REPOSITORY HAS
  EVER BILLED A MINUTE.** Both are public, so GitHub-hosted standard runners are free. Checked
  directly against `GET /actions/runs/{id}/timing` rather than inferred: `billable.UBUNTU.total_ms`
  is **0** for every job of every run sampled in both repositories — CI runs, deploy runs, and the
  374-minute hung deploy of #155 included (`{"UBUNTU":{"total_ms":0,"jobs":6,...}}`). #155 reached
  the same conclusion independently; this is a second, separate confirmation of it.
  **So whatever exhausted the account's Actions budget was spent somewhere other than here**, and
  nothing in these two repositories can reduce it. The owner's billing breakdown is the only place
  that answer lives (another, private repository; an organisation; or a different line item —
  Packages, LFS, Codespaces, Copilot — all of which arrive on the same invoice as "Actions").
  This session is scoped to these two repositories and the billing endpoints are blocked to it, so
  that check could not be made from here.
- **What IS being wasted, measured (GitHub REST, 30 days to 2026-10-22, `ceil` per job, which is how
  GitHub would charge a private repository):** `invest254` **14,501 runner-min**,
  `invest254-platform-template` **750**. CI 7,353 (19.3/run x 381) · Deploy 6,679 (56.6 x 118) ·
  the eight crons 469. Of the Deploy figure, **three hung jobs are 997 of the 1,086 minutes the
  deploy matrix has ever used — 92%** (#155's six-hour stall is one of them).
- **#155 and the commits around it already fixed the two biggest items** (a `timeout-minutes` on all
  17 jobs; `ci.yml` concurrency that spares `main`; ticket escalation moved into the API process, so
  `*/15` stopped being 96 cold runners a day). **This entry is what was left after that**, found by
  measuring the same thing from a different angle.

### Fixed here
1. **The mirror template was running production's ops crons — six workflows with no repository
   guard.** The two repositories share one byte-identical tree (docs/30), so every fire allocated a
   runner in a repository that **can never hold `DATABASE_URL`**; each then installed the whole
   workspace and exited 0 on its script's first line. The proof that a guard is the right shape is
   already in the tree: `mirror-drift.yml`'s job-level `if` measured **0 minutes across 223 runs**,
   while a step that no-ops bills a full minute, because GitHub rounds **each job** up.
   `pool-health` (`*/30`), `pool-distribute`, `subscription-lifecycle`, `reproducibility`,
   `schema-drift`, `ticket-escalation` and `ci.yml`'s `reproducibility` job now carry
   `if: github.repository != '<template>'`. **~390 runner-minutes in the measured window, ~1,600 a
   month at the crons' nominal cadence.**
   - Written as **"not the mirror"**, never "is production", and that is the whole design: the
     template is a mirror and never a running brand, but a brand repo forked *from* it is a running
     system and must keep every ops cron the moment it sets the secret. `== production` would have
     silently disabled ticket escalation and pool distribution for every future brand.
2. **`reproducibility.yml` had been red every single night in the template — 26 runs of 26.**
   Pre-existing, and found only by counting the bill. Unlike every other DB cron its step has no
   `[ -z "$DATABASE_URL" ] && exit 0` guard, so it did not skip; it failed on
   `DATABASE_URL is required` (exit 2). The loud failure is **correct** for a provable-fairness audit
   in a repository that is supposed to hold the secret — silence must never read as a pass — so it is
   kept, and the guard above removes the one place it was guaranteed to fire. A gate that is always
   red is how a real one stops being believed, which is #144's lesson restated.
3. **`deploy`'s ceiling raised from 25 to 45 minutes.** #155 was right to cap it; the cap landed
   inside the healthy distribution. Over the last 60 Deploy runs every matrix leg finished in 1-2
   minutes **except run `38137608432`, where `deploy invest254-api` took 22 minutes and SUCCEEDED**
   (a cold Fly remote builder), and the three hangs at 275, 361 and 361. Nothing lands between 22
   and 275. A 25-minute cap therefore sat three minutes above a known-good run: a builder 15% colder
   would have failed a real deploy of the money backend, and since `concurrency: cancel-in-progress:
   false` holds the `fly-deploy` group, recovering needs a human to notice and re-run. 45 is twice
   the slowest healthy run and still an order of magnitude below the hang it exists to catch.
4. **The step that tells an operator production is half-deployed was skipped exactly when it was
   needed.** `Explain a failed deploy` was `if: failure()`, and all three hangs concluded
   **`cancelled`** — so the annotation never printed, and `Verify the live release is this commit`
   never ran either. With `fail-fast: false` the sibling app shipped and the hung one did not: a
   split release with nothing anywhere saying so, which is the silent half-deploy #48 was supposed
   to have ended, arriving through a different door. Now `if: failure() || cancelled()`, and the
   message leads with "THIS app may not have shipped while the other one did".
5. **`mirror-drift.yml` now serialises itself.** A correctness fix, not a cost one: its rolling-issue
   bookkeeping is a non-atomic `gh issue list` -> `gh issue create`, and the nightly check collides
   with the push `mirror-sync` makes every 3h, so two runs would each find no open issue and each
   open one. `mirror-sync` already serialises itself for exactly this reason.
- **Regression guard: `scripts/workflows.guard.test.mts`** (in `npm test`, so CI's own `build` job
  runs it). It reads the workflow text and asserts: every job declares `timeout-minutes`; none
  exceeds 60, because a 300-minute "cap" is the same hang with extra steps; every job reading
  `secrets.DATABASE_URL` is inert in the mirror, either by its own `if` or transitively through
  `needs`; every scheduled job has a job-level `if`; and `ci.yml` cancels superseded runs but never
  one on `main`. **#155's timeouts had nothing asserting them** — this is what stops the next
  refactor quietly dropping one.
  - **Mutation-checked six ways**, each turning it red: removing one CI cap; raising `deploy`'s to
    300; deleting `pool-health`'s mirror guard; deleting `fly-auth`'s production guard (which is
    what makes `migrate` and `deploy` transitively inert); making CI cancel `main`; removing the
    concurrency block. A harmless comment edit leaves it green, so it is not merely brittle.
  - It parses the YAML itself rather than importing a parser: the only one on disk is a transitive
    hoist no `package.json` declares, and a guard that vanishes with a lockfile bump is not a guard.
    It therefore also asserts **how much it found** (>=10 files, >=17 jobs, >=6 `DATABASE_URL` jobs,
    >=7 scheduled workflows) and spot-checks the two hardest shapes, a matrix job and a folded
    multi-line `if` — a checker that silently examines nothing looks exactly like a passing test
    (#152). The first version proved that on itself: it matched `/^\d+$/` against
    `"30            # measured avg 11.0"` and reported all sixteen capped jobs as uncapped.

### Deliberately not changed, with the measurement that decided it
- **`npm test` (553s on a runner, 282s locally) is ~52% of CI's job-minutes and is left alone.**
  2,360 tests, of which **1,973 finish inside 100ms while 25 are 51% of all test CPU**: the
  Monte-Carlo fairness proofs (`no stopping rule a trader can choose beats the house`, 56s; the
  three `EXPLOIT:` edge tests, 50s) and the WS market-data integration tests. They are exhaustive
  because the exploits they rule out were real (#15, #18, docs/25 §16). Cheapening them is the one
  saving this repository must not take.
- **Raising `--test-concurrency` above Node's default (`cores - 1` = 3 on a 4-vCPU runner).**
  Measured on an identical 4-core/16GB box: 285s at 3, and **still unfinished at 513s at 4** — the
  runner process plus four workers oversubscribe four cores. Not memory (15.5GB free). It would also
  put the soak and real-timer tests under CPU contention, and a flaky suite costs far more in
  re-runs than it saves.
- **Node's native type stripping instead of `tsx`**, which would remove the ~34% of suite CPU spent
  re-transpiling each file's import graph in each of 321 child processes. Blocked by the source:
  parameter properties in at least ten classes (`constructor(private readonly q: ...)`), 13
  extensionless relative imports, one `@/` alias — none of which native stripping supports.
- **Caching the headless browser** in `web roles e2e`: 29s of a 318s job, most of it the
  `--with-deps` apt step a cache cannot skip. ~60 minutes a month for another moving part inside a
  security gate.

### Raised, not fixed here
1. **The mirror has been dead for 23 days, and that is what stops half of the above from landing.**
   `invest254-platform-template@main` is `04ade0f` of **2026-09-29**; production is 23 days ahead.
   Every `mirror-sync` run since has failed, all at the same place: `actions/checkout@v4` with
   `fatal: could not read Username for 'https://github.com': terminal prompts disabled`. Because
   `token: ${{ secrets.MIRROR_PAT || github.token }}` falls back only when the secret is *unset*,
   that message means **`MIRROR_PAT` is set but expired** — the non-empty bad value wins the `||`.
   So the template is still running the OLD workflows — and `04ade0f` predates **#155 entirely**:
   checked against its live `main`, **no job in any of its ten workflows has a `timeout-minutes`**,
   and `ticket-escalation.yml` is still on `*/15` there rather than dispatch-only. Every fix in
   #155 and in this entry is therefore absent from it, including the one that stops a six-hour hang,
   and will stay absent until the secret is rotated. **Owner action, and it cannot be done from code:** mint a fine-grained PAT on
   the template with `contents:write` + `workflows:write` and update the `MIRROR_PAT` secret
   (docs/30 §A). The workflow already opens a `🔴 Mirror sync blocked` issue saying this.
2. **Production carries a function the migrations do not create.** `schema-drift` has been red since
   2026-10-14 (green through 10-13) with one unchanging report:
   `only-production function fn_pool_auto_settings_seed()` / `function-exec [prod=false/false]`.
   Nothing in the tree creates, calls or even names it; `pool_auto_settings` itself comes from 0164.
   An out-of-band object — exactly the class #57 built this gate to catch, and the gate worked. Not
   reconciled here because the right fix (docs/30 §C: a migration) depends on what its body does,
   and its name says it seeds **money configuration**; dropping something a dashboard or an ops
   script still calls is a production break. Read the body first, then write the migration.
3. **The crons were firing at about 2% of their schedule.** `*/15` should fire 672 times a week; it
   fired **10**. `*/30` should fire 336; it fired **9**. Daily crons fired 2 of 7. GitHub
   de-prioritises and drops `schedule` events, and Actions was additionally interrupted over payment
   in this window. Ticket escalation moving in-process (#155 era) is the right answer and already
   landed; `pool-health` (`*/30`) is the remaining one whose value depends on actually running, and
   it is a monitor — `pg_cron` or the API process would make it reliable as well as free. Not done
   here: this sandbox cannot reach Postgres (only port 443 egresses), so a `pg_cron` migration could
   not be verified against the real database, and an unverified change to production scheduling is
   not one to make blind.
4. **`actions/checkout@v4` and `actions/setup-node@v4` are being force-run on Node 24** — every run
   logs `Node.js 20 is deprecated`. Not a bug yet; it becomes one in all ten workflows at once when
   GitHub drops the shim. A version bump deserves its own verification pass.
5. **The live engine's release label names a commit that is not on `main`.** `invest254-api` runs
   `git-f29b59c`; `invest254-engine-pm` runs `git-936a0ed`, a branch commit reached by a manual
   `workflow_dispatch`. Harmless this time — `936a0ed..f29b59c` is one line of `.gitattributes` and
   `git diff --name-only -- apps/engine packages Dockerfile` between them is empty, so the running
   code is identical. But labelling images `git-<sha>` (#48) exists so `flyctl releases --image` can
   be matched against `main`'s history, and a label off `main` cannot be. The habit to avoid is
   dispatching Deploy from a branch.

---

## #155 — A hung deploy job with no timeout ran for six hours and left the API five days behind main — FIXED (CI)
- **What it looked like from the product:** the platform console's "Reset someone's security answers"
  answered **"Could not reset / not found"** for every target. The route was missing from the deployed
  API (`http.ts:386`'s unmatched-route 404), because the API had been running `bb76bf3` since 15 Oct
  while `main` carried the 0210 work. `/api/v1/health` named the stale commit.
- **Root cause:** the `deploy invest254-api` job of the 16 Oct run stalled at `#17 exporting to image`
  on Fly's remote builder and was still sitting there **six hours and twelve minutes** later
  (`run_duration_ms: 22418000`), when GitHub's own 6-hour ceiling cancelled it. No job in any of the
  ten workflows had a `timeout-minutes`, so GitHub's ceiling was the only limit in play.
- **Why one stuck job mattered so much:** `deploy.yml` holds `concurrency: { group: fly-deploy,
  cancel-in-progress: false }` — correct, since cancelling a deploy mid-flight is worse than waiting.
  But a job that never ends holds that group for as long as it lives, so the hang did not just lose
  its own deploy; it blocked the queue. The engine deployed (separate matrix leg, succeeded in 63s)
  and the migration applied, so the DB and the engine moved while the API did not: a split release
  nobody was told about. The deploy's own verification step, which checks the live release carries
  this commit, was skipped along with the job that would have failed it.
- **Fix:** a `timeout-minutes` on every job in all ten workflows, sized to observed runtimes (CI's
  four jobs finish inside 8m16s wall; the deploy's own `--wait-timeout` is 5m). A build that stalls
  now fails in minutes with a red job, releasing the concurrency group, instead of occupying a runner
  for a working day and reporting nothing.
- **Also:** `ci.yml` gained `concurrency` with `cancel-in-progress` for every ref EXCEPT `main` — a
  superseded PR run is work nobody will read, while on main each commit's result is the record of
  whether that commit was green.
- **NOT the cause of the billing block that surfaced alongside this** (see the note below): this
  repository is PUBLIC, so GitHub-hosted standard runners are free. The usage API confirms it —
  `billable.UBUNTU.total_ms: 0` for every job of both the CI and deploy runs, the six-hour one
  included. Whatever exhausted the account's Actions budget was spent somewhere other than here.

## #154 — The PayHero ledger sweep wrote ~10 Postgres ERRORs a minute, forever — FIXED (engine)
- **Reported as:** a wall of red `P0001 TX_NOT_FOUND` rows in the Supabase Postgres log.
- **Measured, from a 96-minute export (1,000 rows, 2026-10-21 13:01–14:37 UTC):** 954 `TX_NOT_FOUND`
  errors — **every single error line in the database log**. Exactly 10 per minute, in all 96 minutes
  covered, in bursts ~0.39s apart separated by ~53s gaps. That cadence is a 60-second timer, not a
  user: `PAYHERO_LEDGER_RECONCILE_INTERVAL_MS` defaults to 60s (`server.ts:1303`). The other 46 rows
  were checkpoints and health probes. ~14,400 error rows a day.
- **Root cause, and it was deliberate:** `reconcilePayHeroLedger` discovers whether a ledger row
  belongs to us by calling `fn_complete_deposit` and catching the `TX_NOT_FOUND` it raises
  (`paymentservice.ts:632`). PayHero's ledger is ONE SHARED ACCOUNT, so most rows carry references
  written by something else; each one raised a plpgsql exception, which Postgres records as an ERROR.
  The sweep re-reads page 1 every minute and the page barely changes, so the SAME ~10 misses were
  re-raised every minute indefinitely. The money path was never wrong — the exception is caught and
  the payment falls through to claimable-by-code, which is what it should do.
- **Why it is worth fixing rather than filtering:** `TX_NOT_FOUND` is also raised by
  `fn_complete_withdrawal`, `fn_reject_withdrawal` and `fn_admin_mark_withdrawal_paid`, where it means
  an operator acted on a transaction that is not there — a real failure. One noisy caller at 10/min
  made that signal unfindable, in the same log and under the same code. A log nobody can read is a log
  nobody reads.
- **Fix:** `PaymentRepository.ownedDepositRefs(refs)` — one indexed lookup per sweep (idx_tx_checkout,
  0005) answering which references belong to a deposit of ours, using the SAME predicate
  fn_complete_deposit uses (`checkout_request_id` + `kind='deposit'`). The loop then calls the RPC only
  for references we own. N exceptions become one query, and the round trip per foreign row goes away.
- **The money RPC was NOT touched.** `fn_complete_deposit` is shared by Daraja, Mega Pay, PayHero and
  Paynicorn, and for those callers the raise is correct. No migration; engine-only change.
- **Semantics unchanged, deliberately:** a reference we own still goes through the same idempotent RPC;
  one we do not still becomes claimable-by-code, so a payment is still EITHER credited to its tx OR
  claimable, never both. The `TX_NOT_FOUND` catch stays as the race fallback (a tx vanishing between
  the batch lookup and the call), so even that path behaves exactly as before.
- **Verification:** a new test asserts a foreign reference never reaches the deposit RPC while our own
  still does — **proven to fail** against the old code (`a foreign reference must not be sent to the
  deposit RPC at all`). 8/8 PayHero tests, full suite 2370 tests, 0 failures, `tsc -b` clean.

## #153 — "Sign-in failed. Please try again." was the console's answer to five different failures — FIXED (web)
- **Reported as:** a screenshot of the operator sign-in — phone and password filled, a six-digit
  authenticator code typed in, and **"Sign-in failed. Please try again."** under it. Nothing in the
  screenshot said what went wrong, which is the bug reported here.
- **What:** `AdminSignIn` translated three codes — `MFA_REQUIRED`, `MFA_INVALID`,
  `INVALID_CREDENTIALS` — and sent everything else to one sentence. "Everything else" is the half
  that matters at an operator door: `RATE_LIMITED` (429 from the per-IP throttle),
  `ACCOUNT_SUSPENDED` / `ACCOUNT_BANNED`, any 5xx out of the API, a `fetch` that never reached it
  (DNS, CORS, a sleeping machine — no `ApiError` at all, so the code read as `''`), and the one that
  is not a sign-in failure: the `GET /auth/me` that `adminLogin` runs *after* a successful login
  (`useAuthActions.ts:40`) being refused by the token gate, which `requireAuth` flattens to
  `AUTH_INVALID` (`http.ts:514`) whether the cause was the force-logout epoch, a non-active profile
  or the idle gate.
- **Why that last one matters most:** the token is already in `localStorage` by then. The operator is
  told their sign-in failed while holding a valid session, and the thing they retry — the code — was
  never the problem. The same sentence appears when the code was *right* and the server 500'd.
- **Impact:** no failed console sign-in could be diagnosed from what the operator saw, and no
  screenshot of one could be diagnosed by anyone else either. Nothing was unauthorised; the console
  was simply undebuggable from the outside.
- **Fix:** `lib/auth/signInError.ts` — one pure mapper, unit-tested, returning a sentence that says
  what happened and what to do, plus `code · HTTP status` for the failures whose real answer is in
  the API log. A player must never be shown an error code, so this is deliberately *not* shared with
  `lib/auth/errors.ts`; an operator debugging their own console is exactly who needs one.
- **Second gap, closed with it:** the form offered no recovery-code field, though
  `/auth/admin/login` has always accepted `recovery_code` and `#135` closed with "if that
  authenticator is gone, a recovery code is needed". There was nowhere to type one — and a recovery
  code typed into the 6-digit box went up as `totp` and could only ever come back `MFA_INVALID`.
  `adminLogin` now takes the same `{ totp | recoveryCode }` second argument `login` takes, and the
  code field toggles between the two. TOTP input is digits-only (a pasted code carrying a space was
  refused as a wrong code).
- **NOT fixed by this, and worth saying plainly:** this does not make the reported sign-in succeed.
  It makes the next attempt name its own cause. The candidates for that screenshot, in order:
  migration `0196`'s `user_mfa.last_totp_step` missing on the deployed database (the replay guard
  `update` is what runs on a CORRECT code — `identity.ts:576` — so a correct code is exactly what
  would 500); the `/auth/me` refusal above, with clock skew between the API host (`iat`) and
  Postgres (`stampForceLogout` uses the database's `now()`) as the mechanism; the 429; or the API
  not being reached at all.
- **Verification:** 9 new unit tests pin each branch (including "a correct code that meets a server
  error does not read as a bad code"). 2368 tests pass, `tsc -b` and the web typecheck clean.

## #152 — Admin payout decisions deadlocked behind an unreachable security prompt — FIXED
- **Reported as:** *"I can't accept or reject."* The Reject dialog sat on **"Rejecting…"** forever,
  with the "Confirm it's you" step-up prompt visible but greyed out BEHIND it.
- **What:** `StepUpGate` rendered at **`z-[62]`**; `RejectDialog` renders at **`z-[70]`**. Rejecting
  a commission payout is an action launched *from* a dialog, so the 403 `STEP_UP_REQUIRED` it
  provoked raised a challenge that painted **underneath the dialog that triggered it**. The reject
  dialog's own container is `fixed inset-0`, so it swallowed every click aimed at the prompt.
- **Why it hangs rather than errors:** the gate is deliberately non-dismissible — no backdrop click,
  no Esc — because a refused call is parked behind it and `apiFetch` replays that call only once the
  challenge settles (`client.ts:97`). Unreachable + non-dismissible = the promise never settles, so
  the mutation never leaves `isPending`.
- **Why BOTH buttons died, not just reject:** `ReferralPayouts` gated every row's controls on the
  SHARED `action.isPending`. One permanently-pending mutation therefore disabled approve *and*
  reject on **every row in the panel** until the operator reloaded. The reported symptom is the
  amplification, not the cause.
- **It is worse than one panel.** `requestStepUp` keeps ONE global `pending` slot and has no
  timeout (`stepUp.ts:75`): while a challenge is outstanding, a later gated call either joins that
  same promise or resolves `false` immediately. So the stuck reject did not just freeze the payout
  queue — until the tab was reloaded, every other gated admin action in the app either hung on the
  same unreachable prompt or failed with its raw 403.
- **Impact:** no commission payout could be approved or rejected from the moment anyone clicked
  Reject once. Not data loss — the payout stayed `requested` and nothing was dispatched — but the
  queue was unworkable, and the obvious operator response (reload, click Reject again) reproduced it
  every time.
- **Resolution, two parts:**
  1. The three security gates move to the top of the stack — `SecurityQuestionsGate` `z-[100]`,
     `MfaEnrolmentGate` `z-[101]`, `StepUpGate` `z-[102]`, above the app's previous ceiling of
     `z-[91]`. They are the only overlays with a blocked request behind them, so they outrank
     everything by definition.
  2. `busyId = action.isPending ? action.variables?.id : undefined` — the in-flight lock now names
     WHICH row is being decided instead of WHETHER one is. Applied to `ReferralPayouts` and
     `Advances`. (`AffiliatePayoutsPanel` already calls `usePayoutAction()` per row, so it was
     never affected.)
- **Regression guard:** `gates.z.test.ts` reads the source and fails if ANY `fixed` overlay is given
  a z-index at or above the gates. Bumping three numbers fixes today; the test is what stops the
  next `z-[110]` modal from putting it back. **Proven to fail when `StepUpGate` is reverted to
  `z-[62]`** — both assertions go red.
- **Tailwind scans comments.** `content: ['./src/**/*.{ts,tsx}']` feeds every source file to an
  extractor that is a regex over raw text, so writing an arbitrary value in Tailwind's bracket form
  inside a COMMENT emits a real rule. The first version of this fix shipped a dead `z-index:62` from
  the explanatory comment in `StepUpGate.tsx`, and a dead `z-index:110` onto invest254.com from a
  sentence in `gates.z.test.ts` — dead CSS from a test file, in the production bundle. Harmless to
  render, but it defeats reading the shipped CSS to tell which build is live, which is exactly how
  this bug was confirmed in production. Arbitrary z-indexes are now written as prose in comments.
- **Two bugs inside the guard itself, worth recording:** the first version matched `z-50` and
  nothing else, because the trailing `\b` in `/\bz-(?:\[(\d+)\]|(\d+))\b/` cannot match after
  `z-[70]` — `]` and the following space are both non-word, so there is no boundary. It reported
  "no z-index at all" for the gates rather than a failed comparison. The second was the className
  scanner desynchronising on apostrophes inside comments, which made it find zero overlays. Both
  are the same hazard: **a checker that silently examines nothing looks exactly like a passing
  test.** Hence the explicit `zs.length > 0` assertion per gate file.

---

## #151 — The PDF text extractor silently rewrote the document it was checking — FIXED
- **What:** `pdfText()` in `marketers.statement.pdf.test.ts` decodes the document's text so the
  assertions can read it. Switching the statement from the standard-14 fonts to embedded DejaVu and
  Jost subsets changed the encoding from single-byte WinAnsi to Identity-H — 16-bit glyph IDs — so
  the helper was rewritten to map each CID through the font's `/ToUnicode` CMap. Two bugs in that
  rewrite, each of which produced *plausible* text rather than obvious garbage.
- **Bug A — the contiguous-range pattern matched inside the array form.** A CMap `bfrange` entry is
  either `<lo> <hi> <dstStart>` or `<lo> <hi> [<u0> <u1> ...]`. Scanning for both with two
  independent regexes looks equivalent to scanning once; it is not, because `<a> <b> <c>` also
  matches any three consecutive destinations *inside* an array, overwriting real mappings with
  values derived from their neighbours.
- **Bug B — ligature destinations were skipped entirely.** The CMap writes the "ff" ligature as
  `<0066 0066>`, with a space inside the brackets. The destination pattern `<([0-9a-fA-F]*)>` does
  not match that, so the entry was skipped — which did not lose one glyph, it shifted **every**
  mapping after it by one.
- **Evidence:** the extracted text read `Disclaimer: An* personal information ... proKided` and
  `To Kerif* this statement, open inKest254.comkKerif*` — `y`→`*`, `v`→`K`, `/`→`k`, `fi`→`Q`.
- **Impact:** test-only, and caught before it could mislead. But the failure mode is the dangerous
  one: a helper that returns *almost* the right text makes some assertions fail for the wrong reason
  and lets others pass for the wrong reason. The two tests that failed pointed at the document, not
  at the helper.
- **Resolution:** one sequential pass over each `bfrange` block handling both entry forms in order,
  and `\s` admitted into every destination character class, with whitespace stripped before the hex
  is paired off. Full suite green.
- **Lesson:** when a decoder's output is readable, "readable" is not "correct". Both bugs would have
  been invisible had the sample text not contained a `y`.

---

## #150 — The statement was printed in the wrong direction — FIXED (migration 0209)
- **What:** `fn_marketer_statement_range` returned the detail **oldest-first**. The reference
  statement supplied as the artifact to reproduce runs **newest-first**: its first page opens on
  `2026-10-14 21:24:50` and walks backwards, and every page after continues down.
- **Root cause:** not a coding error — a reasoning error, made in `0208` while fixing #149. Having
  corrected the ordering *column* (`created_at`, which the statement prints, not `id`, which it does
  not), 0208 chose ascending so a reader could follow the Balance column downward as a running
  total. That argument is sound in the abstract and was made **in place of looking at the artifact**,
  which was available.
- **Impact:** on a long statement — the reference is 255 pages — the most recent transactions land
  on the last page. A report produced for accountability buries the thing it is consulted for.
- **Resolution:** `0209` reverses the final `order by` to `created_at desc, id desc`. The column fix
  from 0208 stands and is the load-bearing part; only the direction changed. The cap still selects
  the NEWEST `p_cap` rows — the migration and the in-memory mirror each do the select and the
  reverse as two explicit steps, because collapsing them is how one silently returns the oldest.
- **Also corrected alongside:** the summary label `LIPA NA M-PESA (PAY BILL)` → `(PAYBILL)`, one
  word, as the reference prints it; and the disclaimer, verification panel and footer now repeat on
  every page rather than the last, which is what the reference does.
- See `docs/67` §4.

---

## #149 — The statement sorted by one column and printed another — FIXED (migration 0208)
- **What:** `fn_marketer_statement_range` (0206) ordered the detail rows by **`id`**. The statement
  PRINTS **`created_at`**. 0206's own header asserted the two were interchangeable — *"both columns
  are monotonic in practice"* — which is the kind of claim that holds until it does not.
- **Why they diverge:** `id` is drawn from the identity sequence at INSERT time; `created_at`
  defaults to `now()`, which in PostgreSQL is **transaction START** time. A transaction that begins
  at 10:00 and inserts at 10:05 takes a HIGHER id than one that began at 10:02 and inserted at
  10:03, while carrying the EARLIER timestamp. This system runs exactly that shape of concurrency —
  the transfer and airtime RPCs take row locks and are proven against eight simultaneous
  connections — so a transaction waiting on a lock is the ordinary case, not a contrived one.
- **Evidence:** a statement rendered for review printed Completion Times
  `2026-09-17, 09-21, 09-28, 09-23, 09-25, 09-30, 10-06, 10-09, 09-24 …`. **Found by looking at the
  output, not by reading the code.**
- **Impact:** rows out of time order, and — worse — a Balance column that steps up and down for no
  visible reason. `balance_after_cents` is correct per row and only reads as a running balance when
  the rows are in time order, so an out-of-order statement makes correct data look like corruption.
  Exactly the opposite of what a statement produced for accountability is for.
- **Fix:** 0208 orders by `(created_at, id)` at both ends — inside the cap (`desc`) and outside it
  (`asc`). `id` stays as the TIE-BREAKER rather than being dropped: the two halves of a transfer
  (0203) are written in one transaction and share a timestamp to the microsecond, so without it
  their order is whatever the plan produces, and a statement showing the credit before the debit it
  came from is its own small lie. The cap still keeps the newest rows; what changes is the
  definition of "newest", from *last inserted* to *last to happen*.
- **Verification:** four assertions in `e2e_marketer_statement.py`, inserting rows whose id order is
  deliberately not their timestamp order — **proven to fail** when the ordering is reverted to `id`
  (3 of the 4 fail, including the capped read keeping the wrong rows). 27/27 on real Postgres.
  `ix_marketer_ledger_mkt_created` from 0206 already serves the new sort.

## #148 — A refused transaction still announced itself as "Successful" — FIXED (mpesa_2)
- **What (pre-existing):** `ReceiptScreen` printed `"${TxFlow.title} Successful"` with a green tick
  unconditionally. `TxFlow.success` had always been SET — `AppState.performTransaction` returns
  false when the wallet cannot cover the amount — and was **never read**. So a transaction the app
  itself had declined showed the success icon, the success wording, a receipt card and a Download
  Receipt button.
- **Found while** wiring the first flow on that screen that can be refused by the SERVER (airtime,
  0207): a declined purchase would have told the marketer their money was spent.
- **Impact before 0207:** limited to the local sample flows, where nothing is at stake. **After
  0207 it would have been a real debit the marketer was told had happened when it had not.**
- **Fix:** the screen branches on `TxFlow.success` — error icon, "… Not Completed", and the reason
  in place of the amount (`TxFlow.failure`, new). The receipt card and the download button are not
  drawn at all when there is nothing to receipt, and the button reads "Close" rather than "Done".
- **Verification:** `assembleDebug` green; the failure path is reachable from both the local
  insufficient-funds case and every server refusal the airtime route can return.

## #147 — The test harness's withdrawal disagreed with the database about Fuliza — FIXED
- **What (pre-existing):** `testutil.ts`'s in-memory `withdraw` refused outright at
  `m.balance < amountCents`, never consulted `m.fuliza`, and never wrote `fuliza_used_cents` into
  the ledger meta. The database's `fn_marketer_withdraw` (0033) does all three: spending power is
  `balance + available_fuliza`, the overdraft covers the shortfall, and the amount drawn is
  recorded on the row.
- **Evidence:** a new airtime test asserted the contrast the 0207 header rests on — *Fuliza cannot
  buy airtime, although it funds a withdrawal* — and the withdrawal half returned 409 against the
  harness while succeeding against real Postgres (`e2e_marketer_airtime.py`, same scenario).
- **Impact:** every route test touching a withdrawal was pinning behaviour production does not
  have, and the `fuliza_used_cents` branch of `ledgerToTxDto` — and now `detailsFor`, which prints
  "Customer Withdrawal (Fuliza X)" on a statement — had **never been exercised by anything**. It
  also made BUGLOG #141 (wallet drifts from its ledger once Fuliza pays part of a withdrawal)
  unreproducible in the fast suite, which is where it would have been noticed.
- **Fix:** the mirror now does the same arithmetic as the RPC — `spendable = balance + fuliza`, the
  shortfall drawn from the overdraft, `fuliza_used_cents` stamped on the row.
- **Verification:** full API suite **2331 tests, 0 failures** after the change — no existing test
  depended on the wrong behaviour, which is the good news and the bad news. The contrast is now
  asserted in both suites: `app.marketers.airtime.test.ts` and `e2e_marketer_airtime.py`.

## #146 — A docs/58 phone-leak guard failed 17.9% of runs for a reason unrelated to phone numbers — FIXED
- **What (pre-existing, mine to find):** `packages/db/_testkit/e2e_marketer_transfer.py` asserts that
  neither half of a transfer stores a phone number in `meta` (docs/58). Across six consecutive runs
  of an otherwise unchanged script it failed once:
  ```
  [FAIL] ledger: no phone number is stored in meta (docs/58)
  47/48 passed
  ```
- **Root cause:** the check was a SUBSTRING test over the whole blob —
  `meta ? 'phone' or meta::text like '%07%'` — and `meta` contains `counterparty_marketer_id`, a
  random UUID. **Measured over 200,000 `uuid4`s: 9.389% of UUID texts contain the digits "07"**, so
  with two rows examined the assertion false-failed **17.9%** of runs.
- **Why it matters more than a flake:** this is one of the guards whose entire value is being
  believed. A security check that cries wolf one run in six trains the reader to re-run it until it
  is quiet — the same failure mode as #144, and the state in which a genuine leak passes unnoticed.
- **Fix:** asked per KEY/VALUE with `jsonb_each_text` instead: a phone-ish key
  (`phone|msisdn|mobile|number`) or a value matching `(\+?254|\m0)[17][0-9]{8}`. Anchored on a WORD
  boundary rather than a string start, so a number quoted mid-sentence is still caught while a
  UUID's interior digits are not.
- **Verification:** six probe rows run against real Postgres — `{"phone":"0798661061"}`,
  `{"note":"paid 0798661061 today"}`, `{"note":"paid +254798661061 today"}`,
  `{"note":"sent to 254712345678"}` and `{"recipient_number":"x"}` all flag; the UUID meta and
  `{"pair_ledger_id":"1074"}` do not. **Nine consecutive clean runs** of the full script afterwards
  (48/48 each). Residual false-positive rate ~1 in 5,000 (a 12-hex UUID segment would have to open
  `0`, then `1` or `7`, then eight more digits).

## #145 — The payer and the payee saw two different confirmation codes for one transfer — FIXED (migration 0205)
- **What:** a marketer-to-marketer transfer produced one M-PESA code in the sender's transaction
  feed and a different one in the recipient's, for the same transfer. No real M-PESA transaction
  behaves this way, and the contradiction surfaces the first time two marketers compare phones —
  which, in a till app whose users are in the same WhatsApp group, is immediately.
- **Root cause:** `ledgerToTxDto` derives the code with `mpesaCode(createdAtMs, r.id)` — the row's
  own ledger id. A transfer (0203) is **two** rows, so it produced two codes. The timestamps already
  matched (both rows take `created_at` from the same transaction's `now()`); only the id differed.
- **Found while** building the confirmation screen, which has to print one of the two.
- **Impact:** cosmetic in the sense that no money is affected, and corrosive in the sense that the
  confirmation code is the one string either party would quote to query a transfer.
- **Fix:** 0205 stamps the credited row with `meta.pair_ledger_id` = the debited row's id, and
  `ledgerToTxDto` prefers it. Both sides now render the sender's code, which is also the code the
  API returns to the app for the receipt. Rows written before 0205 have no `pair_ledger_id` and keep
  falling back to their own id, so nothing already rendered changes.
- **Verification:** `app.marketers.transfer.test.ts` — "both sides of one transfer carry ONE
  confirmation code" (**proven to fail** when the pairing is reverted), plus "a credit that is not a
  transfer still takes its code from its own row" pinning the fallback. On real Postgres:
  `e2e_marketer_transfer.py` asserts the credited row points at the debited row, the debited row
  carries no self-referential pair, and both halves share one timestamp. See docs/64 §2.

## #144 — CI's migration-ledger gate races the deploy, so every migration merge shows red — FIXED (moved into deploy.yml)
- **What:** merging 0203 turned CI red on `main` twice in a row, for a reason that had nothing to do
  with the change. Both runs failed the same job:
  ```
  UNRECORDED  0203_marketer_peer_transfer.sql  (file present, not in ledger)
  204 migration files, 203 ledger rows, 1 problem(s).
  ```
- **Root cause — a timing race, not a defect in the migration.** One push starts BOTH workflows:
  `CI` (whose `migrations-ledger` job compares the repo's migration files with the ledger rows in
  PRODUCTION) and `Deploy (Fly)` (whose `migrate` job applies the new migration and records it). CI
  has nothing to wait for and wins; Deploy has to run typecheck + the full test suite first.
  Measured on this merge: the ledger gate started **11:07:40**, `migrate` recorded the row at
  **11:16:19** — nine minutes later. The gate was asking production a question whose answer was
  still eight minutes away.
- **Evidence it is only the race:** re-running the failed job after `migrate` completed turned it
  green with no code change (`migrations-ledger` ✓, and the whole run ✓).
- **Impact:** every merge that adds a migration shows a red `main` for roughly the length of the
  deploy's verify step, and the red clears only if somebody re-runs the job. That trains people to
  ignore a gate whose whole job is to be believed — and it hides a REAL unrecorded migration behind
  an alarm everybody expects.
- **FIXED — option (b), owner's choice.** `migrations-ledger` moved out of `ci.yml` into
  `deploy.yml` with `needs: migrate`, so it runs immediately after the step that records and asserts
  what `migrate` just claimed to have done. The question "is production's ledger complete?" is only
  answerable once the deploy that completes it has run.
- **Nothing is weakened by the move.** It still reports all three conditions, and the one it is
  really for — a migration file EDITED after it was applied (CHANGED, checksum mismatch) — is the
  one that no amount of re-running would ever clear. Coverage is preserved because `deploy.yml`
  triggers on `packages/**`, which contains `packages/db/migrations`, so every push that adds or
  edits a migration runs it. Same `DATABASE_URL`, same graceful skip without it.
- **It deliberately does NOT gate the deploys.** `deploy` needs `migrate`, not this, so the two run
  in parallel. A drift report must not stop code that matches the schema from shipping: it is a
  report about state, and blocking the rollout on it would turn a stale checksum into an outage.
- `ci.yml` keeps a comment where the job was, saying where it went and why it must not come back —
  CI has no step that records a migration, so re-adding it there would restore the race.

---

## #143 — Two SECURITY DEFINER functions are callable with the public anon key — FIXED (migration 0204 + CI gate)
- **What:** found while confirming migration 0203's own grants. `packages/db/_testkit/e2e_function_grants.py`
  — the repo's own guard for exactly this — **fails on current main**:
  ```
  [FAIL] no SECURITY DEFINER public function is EXECUTE-able by anon
         2 exposed: fn_marketer_in_practice(uuid,uuid), trg_billing_platform_addon_charge()
  [FAIL] ... by authenticated   (same two)
  ```
- **Root cause:** migration 0153 closed this hole wholesale, but a NEW function is created with
  `EXECUTE` granted to `PUBLIC` by default, and neither migration that added these revoked it:
  `fn_marketer_in_practice` (0176) and `trg_billing_platform_addon_charge` (0172), both after 0153.
  **The guard is never run in CI** (`grep e2e_function_grants .github/workflows` → nothing), which is
  why it went unnoticed; it needs a local Postgres, like the rest of `_testkit`.
- **Impact, measured not assumed:**
  - `fn_marketer_in_practice(p_user, p_site_id)` is `stable` and read-only, but SECURITY DEFINER so
    it reads `wallets` past RLS. With the public anon key it answers "is this user id a marketer
    account in practice mode?" for any uuid — an identity-disclosure oracle, bounded by having to
    guess a uuid. It moves no money.
  - `trg_billing_platform_addon_charge()` is a trigger function; called directly it has no `TG_OP`
    and errors out. Exposure is the defect, not a usable path.
  So: real, but neither is a money mutation. The money RPCs 0199 recreated were checked at the same
  time and are SECURITY INVOKER, so RLS still stands behind them.
- **Fix (not applied — separate issue, owner's call):** a migration that revokes `EXECUTE` on both
  from `public`/`anon`/`authenticated`, exactly as 0203 does for `fn_marketer_transfer`, plus wiring
  `e2e_function_grants.py` into a CI job with a local Postgres service so the next one is caught.
  That second half is the part worth doing: without it this recurs on the next SECURITY DEFINER
  function anybody adds.
- **0203 is clean:** `fn_marketer_transfer` revokes EXECUTE from public/anon/authenticated and keeps
  it for `service_role`; verified with `has_function_privilege` on a real database.
- **FIXED, migration 0204** — revokes EXECUTE on both from `public`/`anon`/`authenticated`,
  `service_role` keeps it. Idempotent (a REVOKE of an absent privilege is a no-op), re-applied 3x.
  Revoking a TRIGGER function's PUBLIC EXECUTE cannot break the trigger: it fires as the table
  owner, not the caller — the trigger is still bound after the revoke, and
  `e2e_addon_entitlements.py` passes 26/26.
- **AND the half that matters: the guard now runs in CI.** `e2e_function_grants.py` existed and was
  never called by any workflow, which is the only reason 0172 and 0176 survived. A `function-grants`
  job now runs it on every push and PR against a THROWAWAY Postgres built from the shim + every
  migration (`pgvector/pgvector:pg16`, because 0057 needs that extension), so it needs no secret and
  gates forks too. The script now reads the standard `PG*` env vars so it is runnable over TCP — a
  check nobody can run is how this survived.
- **Verified both ways:** the guard FAILS (11 pass / 2 fail, naming both functions) with 0204 removed
  and PASSES (13/13) with it. `e2e_billing.py` independently corroborates: 110 pass / 2 fail before,
  111 pass / 1 fail after — one of its two failures was this exposure.
- **Separate pre-existing failure, untouched:** `e2e_billing.py`'s "free add-ons are typed 'free',
  paid ones 'one_off' by default" fails identically with and without 0204. Not investigated here.

---

## #142 — The PIN lock screen could NEVER succeed; every marketer was stranded on it — FIXED
- **What:** found while wiring the PIN step of #140. The marketer app shows a PIN lock screen on
  every launch and every return from the background (`AppState.authenticated` is cleared when the
  app is backgrounded). That screen could not authenticate anybody.
- **Evidence (route-level probe against the real API code):**
  ```
  login with the REAL number      -> OK
  phone the app then persists     -> "0798****099"
  login with the PERSISTED number -> HTTP 401 {"code":"INVALID_CREDENTIALS"}
  ```
  and on a live Postgres: `fn_phone_sig9('0798****061')` is `'0798061'`, **length 7**, while every
  marketer lookup requires `length(fn_phone_sig9($1)) = 9`.
- **Root cause:** docs/58 (Issue 2) masked the phone on `/marketers/me` and BOTH login responses, on
  the stated reasoning that the marketer app "never uses the number functionally". **It does.** The
  app persists the profile it is given (`MarketerSession.persistProfile` -> `savedPhone`;
  `AppState.applyMarketer` -> `AppState.phone`), and `PinLoginScreen` defaults its `phone` argument
  to `AppState.phone` and posts it to `/marketers/auth/login`. After the mask shipped, that is a
  masked string on every attempt, so the PIN login was refused every time.
- **Impact:** severe and live. A marketer could sign in with phone + password, but the moment the
  app was backgrounded or relaunched they hit a PIN screen that always said the PIN was wrong. The
  only way through was logout then retyping the password. It also blocked #140, since a money
  transfer should be authorised by a PIN that works.
- **Fix (mpesa_2):** the app keeps the number the marketer typed at sign-in — their OWN, which
  docs/58 was never about — in `MarketerSession.savedLoginPhone`, persisted beside the token and
  written on both successful sign-in paths. `PinLoginScreen` and the new `SendPinScreen`
  authenticate with that; `AppState.phone` stays masked and is used only for display.
  **docs/58 is untouched: the server still never sends this app a full number.**
- **Upgrade path:** an install from before this fix holds a token and only the masked phone, and the
  real number cannot be recovered from it. `MarketerSession.canPinLogin` is false for those, and
  `AppNav` routes them to credential sign-in rather than to a PIN screen that cannot succeed — which
  repairs the session in one pass.
- **Note on docs/58:** its own safety argument — that a masked value provably fails
  `normalizeMsisdn`, so it can never be mistaken for a dialable number — is exactly why it also
  failed every login. The property held; the conclusion drawn from it did not.

## #141 — A marketer wallet stops matching its own ledger once Fuliza pays part of a withdrawal — OPEN (pre-existing)
- **What:** observed while proving the conservation invariant for #140's transfer RPC against real
  Postgres. For every wallet, `balance_cents` equals the sum of its own `marketer_ledger` rows —
  except any wallet that has made a Fuliza-funded withdrawal.
- **Evidence:** `packages/db/_testkit/e2e_marketer_transfer.py`. A marketer with balance KES 10 and
  a KES 300 Fuliza grant withdraws KES 50: `balance_cents` goes to 0, `available_fuliza_cents` to
  26,000 cents, and the ledger records the FULL `-5000`. Ledger sum `-4000`, wallet `0`.
- **Root cause:** `fn_marketer_withdraw` (0033) writes one ledger row for the whole amount but
  splits the debit across two columns, so the ledger stops being a complete record of the wallet the
  moment the overdraft is used. `meta.fuliza_used_cents` records the split, so the information is
  not lost — but no reader reconstructs the balance from it.
- **Impact:** any report or reconciliation that derives a marketer balance by summing the ledger is
  wrong for those wallets. Nothing in the product does that today, which is why it has gone
  unnoticed.
- **Why it matters for #140:** it is the reason a transfer must not be able to spend Fuliza. The
  same split on a transfer would open the hole on a path where the money is still inside the system,
  so the two wallets would no longer sum to a constant. The transfer RPC is cash-only (0203), and
  the e2e asserts the drift is confined to Fuliza withdrawals and never appears on a wallet that
  transferred.
- **Not fixed:** making the ledger whole means either a second row for the Fuliza portion or a
  `fuliza_after_cents` column, plus a backfill. That is its own change with its own migration, and
  it touches the withdrawal path that pays marketers.

---

## #140 — A marketer who ran out of funny money had to wait for an admin — FIXED (both screens)
- **What:** owner report. The marketer till app runs on simulated money (docs/27). When a marketer
  ran out, the only ways to get more were an admin or platform admin crediting them
  (`POST /admin/marketers/:id/credit`) or the self top-up to a fixed cap
  (`POST /marketers/me/demo-topup`, #102). Both put a ceiling or a person in the way of something no
  real cash passes through. The ask: let a marketer ring a colleague and be sent some.
- **Root cause:** not a defect — a missing path. Every route that could move money into a marketer
  wallet was admin-gated or self-only; there was no marketer-to-marketer one, and the till app had
  no screen that could address another marketer at all.
- **Fix (this entry):** the **Send Money screen** in `mpesa_2` and the one server read it needs.
  - `POST /api/v1/marketers/recipients/lookup` `{ phone } -> { name, self }` — auth + marketer gate
    + a **per-marketer** 20/min budget. Resolves ONLY within the caller's own brand (the site id
    comes from the authenticated profile, never the request), returns the registered name and
    nothing else, and collapses "no such number", "another brand's marketer", "suspended" and "not a
    marketer" into ONE `RECIPIENT_NOT_FOUND` so the response cannot be used to map numbers to
    brands. POST rather than GET because a number in a query string reaches edge access logs,
    history and `Referer` headers that a body does not.
  - `self` is returned because the app **cannot** work it out: `/me` masks the marketer's own number
    (docs/58), so there is nothing on the handset to compare a typed number against. Without the
    flag a send-to-self could not be detected at all.
  - The app: `SendMoneyScreen.kt` (two tabs — mobile number and Pochi), `Msisdn.kt` (Kenyan number
    normalisation + the simulated agent-withdrawal tariff), `Favourites.kt` (device-local only).
    `Routes.forAction` intercepts the `send_money` and `pochi` tiles, so all four places that render
    them pick the new screen up at once.
- **docs/58 is NOT reversed.** The app still never receives anyone's full number from the server,
  the recipient's included — it receives a NAME, for a number the user already had and typed in.
  A directory of marketers (names and numbers, or names alone) was offered to the owner and
  declined for exactly that reason; see docs/63 §5.
- **Rate-limit shape:** `by: "user"`, not `by: "ip"`. Every marketer is behind Kenyan carrier-grade
  NAT, so an IP budget is shared by thousands of unrelated handsets — it throttles honest users and
  barely inconveniences one account walking `07xx`. A per-marketer budget binds the attacker, who
  must BE an authenticated active marketer of the brand being swept.
- **SCREEN 2 (the transfer itself) — DONE, migration 0203.** `fn_marketer_transfer` does the debit,
  the credit and both ledger rows in ONE transaction under row locks, with the two wallets locked in
  a FIXED order (by marketer id) so two marketers sending to each other cannot deadlock. Idempotent
  on a REQUIRED `ref` (stored as `<ref>:out` / `<ref>:in`, since `marketer_ledger.ref` is UNIQUE).
  Refuses self-send, overdraw, dust and a negative amount, and — with ONE opaque
  `RECIPIENT_NOT_FOUND` — an absent, other-brand or suspended recipient. Enforces a rolling-24h
  per-sender cap. `POST /marketers/me/transfer` takes the sender from the TOKEN, never the body.
- **Fuliza cannot fund a transfer**, although it funds a withdrawal. The overdraft is operator-
  granted and repaid by nobody, so spending it into another live wallet would mint funny money
  nobody granted (see #141 and docs/63 §7). The Send Money screen counts cash only for the same
  reason and says so.
- **Proven against real PostgreSQL 16 with all 203 migrations applied** — 12 parallel sends from a
  wallet holding 5 sends' worth succeed exactly 5 times and never overdraw; 8 simultaneous requests
  on one ref move money exactly once; 20 opposing transfers between the same pair never deadlock and
  conserve the pair's total.
- **Tests (screen 2):**
  - `packages/db/_testkit/e2e_marketer_transfer.py` — 40 assertions against real Postgres; the
    concurrency, atomicity and deadlock properties are not checkable any other way.
  - `app.marketers.transfer.test.ts` — 13 route tests, including a forged
    `from`/`fromMarketerId`/`marketerId` in the body leaving the named victim's wallet untouched,
    and both wallets' statements naming each other with no number leaked into either feed.
- **Tests:**
  - `app.marketers.recipientlookup.test.ts` — 9 route tests: the name resolves from the DB; every
    typed format (07../7../254../+254../spaced/dashed) folds to the same person; the body carries
    `{name, self}` and the recipient's digits appear nowhere in it; send-to-self is flagged; a
    sibling brand's marketer and a number nobody holds give **byte-identical** refusals; a suspended
    marketer is not a destination; malformed input is a 400 that does not echo what was typed;
    anonymous 401 / player 403 / admin 403 / suspended-caller 403; and 40 lookups in a minute start
    being refused.
  - `MsisdnTest.kt` — 8 JVM tests. The normalisation cases are lifted from the SERVER's own
    `normalizeMsisdn` test table, so the two implementations are pinned to the same table rather
    than to each other's good intentions. Plus the tariff bands at their edges and a monotonicity
    check (a tariff that dipped would let a sender pay less by sending more).
- **Tariff provenance:** the KSh 11 band for KSh 50–100 — the band the owner's screenshot shows —
  is confirmed on Safaricom's own M-PESA rates page. **The bands above KSh 100 are reported by
  independent Kenyan tariff trackers and are NOT confirmed against Safaricom's own published table.**
  Recorded as reported, not verified, in `Msisdn.kt` and docs/63.
- **Docs:** docs/63-marketer-to-marketer-transfer.md.

---

## #138 — The "someone just won" card covered up to 42.7% of the chart — FIXED (both trade shells)
- **What:** reported by marketers demonstrating the app: *the activity notification blocks the
  waves*. `ActivityNotice` was a 288x73 card, absolutely positioned at `top-3` **inside** the wave
  shell's chart box and centred on phones, for three seconds at a time.
- **Evidence (Chromium 131, local dev build, feed served from a fixture — the method is now
  `apps/web/e2e/activitynotice.e2e.mjs`):**

  | Viewport | Card box | Chart box | Share of the chart covered |
  |---|---|---|---|
  | 320x568 | 272x73 @ (24,143) | 158px tall | **42.7%** |
  | 360x640 | 288x73 @ (36,142) | 206px tall | **30.6%** |
  | 390x844 | 288x73 @ (51,156) | 395px tall | 14.6% |
  | 768x1024 | 288x73 | 623px tall | 4.6% |
  | 1440x900 | 288x73 | 507px tall | 3.3% |

- **Why a marketer saw it at all** — the component's own header says it is shown "never to a
  MARKETER", and both shells do gate on `useMarketerSkin()`. That comment is **stale**:
  `skinPolicy.ts` carries `NEUTRALISE_SHARED_UI = false`, so `marketerSkinOn()` collapses to
  `playerBasic` alone. Since marketer unification (docs/29) a marketer gets the player interface
  exactly, card included, and `useMarketerSkin().isMarketer` now means "this screen is on the Basic
  skin". The comment is corrected in the same commit.
- **Root cause:** the card was mounted inside the positioned chart box, so by construction it was
  over the one surface a player reads to choose Higher or Lower — and it was sized for a desktop
  (288px wide) while being centred on a 320px phone.
- **Impact:** worst on the two phone classes the product sells into hardest. Not a money or data
  bug; a usability one, on the screen that earns.
- **Fix:** the notification is a **one-line ribbon** (~28-30px) carrying the same four facts, with
  one placement per shell and no third:
  - **wave/classic** — `placement="band"`: `absolute inset-0` inside a new `relative` wrapper that
    holds `TickerStrip`, so for its three seconds the ribbon *is* the decorative ticker row and the
    marquee returns underneath. `TickerStrip` is a client-side random walk (its own header says so),
    the only purely decorative surface on the screen, so nothing of value is covered — and because
    it is an overlay rather than a row, **the chart gives up no height and never resizes**.
  - **candlestick** — `placement="ribbon"`: hangs flush off the quote band at the top-left of the
    pane. That shell has no marquee to lend and no dead space in its chart, but `CandlestickTape`
    sets `rightPriceScale.scaleMargins.top = 0.12`, so the top 12% of the plot holds no candle body
    or wick at any zoom, and the bars run newest-at-the-right, so the left of that band is the
    oldest ones. Bottom-left is unavailable: `attributionLogo: true` puts the TradingView mark there.
- **Also fixed (#138b):** on the candlestick PHONE tree the card is mounted against `<main>`,
  outside both trees, so it hung over the Chat, Top and Tours panes as well — and **Chat carries
  these very rows as text**, so it was covering its own content with a duplicate of it. It is now
  hidden there with `max-md:hidden`, **not unmounted**: unmounting drops the queue and the `seen`
  set, and every event already shown would come round again on the next poll.
- **Deliberately NOT fixed:** viewports under 640px tall show no ribbon, because the ticker row it
  rides is hidden there (#129) and handing those 30px back would push the screen past `h-dvh` inside
  an `overflow-hidden` shell — at 320x568 the chart measures 158px against #129's 160px floor. Those
  are also the viewports where the card was doing the most damage. See docs/62 §5 for the reversal.
- **Unchanged:** the feed, the gate, the selection and the timings — same endpoint, query key, limit
  and 20s poll as `ChatPane` (React Query still dedupes them into one request), same `selectCards`,
  same `SHOW_MS`/`EXIT_MS`/`GAP_MS`, same announcement cap. Still no client-side generator.
- **Tests:**
  - `apps/web/e2e/activitynotice.e2e.mjs` — 53 browser assertions over 8 viewport/shell/skin
    combinations: zero chart overlap on the wave at every width, >=99% coverage of the ticker row it
    borrows, no pointer events swallowed, chart height unchanged by the ribbon across its cycle,
    nothing rendered under 640px tall or on the Basic skin, flush under the candlestick quote band,
    inside the 12% candle-free band, >=40px clear of the price axis, hidden-but-mounted on the
    phone's other tabs, and the live region's `aria-hidden` cap. Needs no DB, API or engine.
  - `apps/web/src/components/game/activityNotice.guard.test.ts` — 5 source assertions that run in
    `npm test`, where there is no browser: one mount per shell, the right placement each, nothing
    inside the chart box, the ticker wrapper still `relative` and still carrying #129's rule, and no
    other surface mounting it. Verified to FAIL when the mount is moved back into the chart box.
- **Docs:** docs/62-activity-notice-placement.md (decision, measurements, rejected options,
  the accepted trade-off).

## #139 — The wave's chart jumps 23px whenever the price strip wraps — OPEN (pre-existing, not from #138)
- **What:** found while asserting that #138's ribbon changes no layout. The classic shell's chart
  box gains and loses 23px at runtime with nothing on screen being resized by the user.
- **Evidence (Chromium 131, 390x844, 50s sample at 4Hz):** chart height alternates **397px <-> 374px**,
  in perfect lockstep with `PriceHeader`'s own height, **36px <-> 59px**. Grouped by strip height the
  mapping is exact and one-to-one (`strip=36 -> chart 397`, `strip=59 -> chart 374`). Reproduced
  **identically on the commit before #138** with the card still in the chart box, so it is
  pre-existing and unrelated.
- **Root cause:** `PriceHeader`'s single row is `flex flex-wrap items-center justify-between`, and
  its content width moves at runtime — the staleness label appears and flips between "syncing" and
  "last known", and the price value and the % pill gain and lose digits. When the total crosses the
  row width the right-hand group (H / L / Online) wraps to a second line, the strip grows 23px and
  the chart, which is `flex-1` under it, loses exactly that.
- **Impact:** `CurveCanvas` watches its canvas with a `ResizeObserver` and recomputes its geometry
  on every change, so the wave visibly rescales — the chart "jumps" while a player is watching it,
  with no action of theirs behind it. Worst on narrow phones, where the row is closest to wrapping.
- **Not fixed here.** What should give way when the strip is tight is a UI decision on a live-data
  surface (truncate the pair? drop H/L earlier? fix the row height and let the content truncate?),
  and it is a different issue from #138. Raised with the owner rather than folded into this diff.
- **Candidate fix:** take the row off `flex-wrap`, give the two groups `min-w-0` and let the
  secondary stats truncate or drop by breakpoint, so the strip has ONE height at every width.

---

## #137 — Brands were born UNTHEMED, so seven live sites rendered as the stock design system — FIXED (api onboarding + the 7 brands applied)
- **What:** reported as "why are brand themes not taking effect?". Seven of eighteen live brands wore
  the generic dark/cyan look no matter what colour had been chosen for them.
- **Evidence (live production):** a brand's appearance comes from `sites.theme_tokens` (~20 tokens:
  bg, surface, surface2, border, fg, muted, brand/brandHover/brandText, accent/accentFg, up, down,
  warn, info, three font faces, heading weight, radius). The three `color_*` columns produce exactly
  THREE CSS variables (`brandCssVars`). Measured: `invest254.com` (tokens present) renders 14+
  `--brand-*` variables; `dakafx.com` (tokens null) rendered exactly three — primary, bg, accent —
  and everything else fell back to globals.css. Unthemed: `66investors, 94wins, betyangu, dakafx,
  fxhacks, paidpesa, peakpesa`.
- **Root cause:** two write paths that were never reconciled. `onboard` (`api/src/server.ts`)
  collected ONE colour (`colors: { primary }`) and wrote `color_primary` only — it never wrote
  `theme_tokens`. The thing that actually skins a brand is the console's "Apply theme"
  (`useApplySiteTheme` → `fn_platform_set_site_theme`), a separate, manual, platform-tier action.
  So every brand created through onboarding was born unthemed and stayed that way until a human
  noticed. Nothing in the onboarding form said so; it asks for a colour, which implies it is enough.
- **Not the engine.** The question asked was whether a theme change needs an engine restart like
  BUGLOG #136 did. It does not, and the two are unrelated: the theme path is
  `sites` row → `GET /site/brand` → the web root layout → CSS variables, server-rendered per
  request. The only delay is the 60s brand cache (`BRAND_TTL_MS`). Confirmed by applying the seven
  themes and watching them appear on production with no deploy and no restart.
- **Fix:**
  - `autoThemeFor()` + `themeIdOfTokens()` in `@invest254/shared/siteThemes`, with the theme library,
    the font registry and the mark/favicon generator moved from `apps/web` to `packages/shared` so
    the API and the console choose from the SAME 56 themes (two copies would drift, and a brand's
    look would then depend on which screen created it). The web files remain as re-export shims, so
    no component changed.
  - `onboard` now assigns a complete theme when a brand has none: mode + the three colour columns +
    the full token palette + a generated favicon. It honours a colour the operator actually chose
    (nearest theme wins, so "I picked blue" yields the whole blue theme), never crosses light and
    dark, prefers a theme no other brand wears, and only ever FILLS A GAP — a re-onboard of a brand
    that already has tokens leaves them untouched.
  - The seven existing brands were applied with the same rule (owner approved), each keeping its
    stored dark mode: Tezos, Ethereum, Bybit, Solana, Cardano, Chainlink, Binance respectively.
- **Verification:** 9 unit tests on the rule (determinism, mode never crossed, chosen colour
  honoured, the stock placeholder NOT treated as a choice, taken-theme avoidance, graceful
  degradation when every theme is worn, invalid colour fall-through). After applying: 18/18 active
  brands themed, 18/18 with a favicon, 0 unthemed. Live: dakafx `--brand-primary:#9945FF` with the
  full palette, paidpesa `#375BD2`, peakpesa `#F0B90B`. 2254 unit tests, `tsc -b` clean, web build
  clean after the module moves.
- **A rule refined mid-flight:** the first pass picked purely by slug hash and handed three brands
  LIGHT themes, though all seven are stored as dark. Flipping a brand to a white site is a far bigger
  change than giving it a palette, so the mode is now treated as the operator's decision and never
  overridden. Caught by reading the dry run before writing anything.

## #136 — "The graphs has been loading for the last 5mins": a REFUSED chart that looked like a loading one — FIXED (web + engine restart + one brand's config)
- **What:** dakafx.com sat on "Fetching market data… The first prices are on their way" indefinitely,
  on a screen whose badge said LIVE. cpfmarket.com runs the SAME shell and drew fine. Reported by the
  owner, who correctly pushed back that identical code cannot explain it.
- **Evidence (live production, browser + raw WS):** both pages send the identical frame
  `{"type":"candles","tf":"M1","count":180}`. cpfmarket gets 180 bars; dakafx got
  `{"type":"error","code":"NO_CANDLES","message":"this brand draws a line chart, not candles"}` in
  ~300ms, while ticks streamed the whole time. Asking the live engine directly, per brand:
  cpfmarket and muchwins (both candlestick) → bars; dakafx → REFUSED. So the engine does serve
  candles — it refused this one brand.
- **Root cause (two, stacked):**
  1. **A STALE ENGINE.** `sites.chart_style` is read once per brand, when `SiteRegistry.ensure`
     builds that brand's runtime (seeded at boot in `server.ts:162`; `curveProfileFor` only hits the
     DB on a cache MISS), and the registry has no eviction path — so a brand's runtime, and its
     "has candles" decision, are fixed for the life of the process. dakafx was switched to
     `candlestick` at 13:15:21Z; the Fly machine's own event log shows the engine last started at
     2026-10-12 22:59:56Z, over 14 hours earlier. It was still serving dakafx as a line brand.
  2. **A SCREEN THAT COULD NOT SAY "REFUSED".** `CandlestickTape` ended its history fetch in
     `.catch(() => null)` — the rejection was discarded — and `dataPhaseOf(status, hasData)` had no
     failure state, so an open socket with nothing drawn was `waiting` forever. A definite "never"
     rendered as "the first prices are on their way". (`CandleChart`, the broker terminal, already
     handled this correctly with `setLoadError`; only this shell swallowed it.)
- **Also found:** paidpesa.com was broken the same way for a DIFFERENT reason — `chart_style=line`
  with `trade_ui=candlestick`, a candlestick screen on a brand with no candle history. A restart
  would not have fixed it. Predicted from the mechanism, then confirmed by probing it.
- **Fix:**
  - web: `DataPhase` gains `failed`; `dataPhaseOf` takes a third `failed` argument (defaulted, so
    every existing caller is untouched); `CandlestickTape` records the refusal instead of discarding
    it and renders a retry that genuinely re-asks. A failure never blanks a chart that already has
    bars, and never outranks a reconnect (which re-asks by itself). `tradeDisabledReason('failed')`
    is null on purpose: a chart with no history is no reason to refuse a trade.
  - ops (owner approved): `paidpesa.chart_style` → `candlestick` to match its screen, then ONE engine
    restart (0 open positions platform-wide at the time, verified immediately before) so both brands'
    runtimes rebuilt from the current rows.
- **Verification:** reproduced locally by making the mock engine answer `NO_CANDLES` exactly as
  production did — the old build spun, the new one says "No market data to show / This chart could
  not load its history. Try again.", keeps BUY enabled, and the retry re-asks (1 → 2 requests).
  Regression: with candles present there is no placeholder, no retry and a printed price. On
  production after the restart: dakafx PRICE 2844.56 with bars, paidpesa 2694.04, cpfmarket
  unchanged. 2245 unit tests, `tsc -b` clean.
- **Caught in review of my own copy:** the first draft of the failed-state text read "The live price
  is still running", but the price axis arrives WITH the history reply, so a brand with no history
  shows `—` where the price goes. The screenshot had a dash two inches above that sentence. Reworded,
  and a test now forbids the claim.
- **Still open (reported, not actioned):** the engine will go stale again the next time a brand's
  `chart_style` changes, because nothing invalidates a built runtime. Making it live means rebuilding
  a brand's runtime in a running trading engine — which re-anchors the price axis that open positions
  are measured against — so it is a deliberate piece of work, not a quick follow-on.

## #135 — An older PLAYER account on the same phone shadowed a real ADMIN: "can't login anywhere, just 404" — FIXED (api/engine)
- **What:** an admin could not reach the back office from any domain — every operator surface showed
  a 404. Reported by the owner against phone `0100406758`.
- **Evidence (live prod, read-only):** that phone holds TWO accounts, one person: `joy` (role
  `player`, site tamutraders, active, created 2026-08-19) and `joy_admin` (role **admin**, site
  invest254, active, created 2026-09-11). Both have credential rows, both active, neither locked.
  `joy_admin` has never held a privileged session (`privileged_sessions` = 0 rows for either id).
- **Root cause:** `AuthService.login` resolves the identity-based (`anyBrand`) candidate set
  **oldest-first** (`identity.ts:426`, `order by p.created_at asc`) and took the FIRST candidate
  whose password verified, then `break`. When both accounts share a password — one person, one
  number — the older PLAYER always won. The operator was issued a perfectly valid player token, and
  `/console` (`console/page.tsx:49-57`), `AdminShell` and `PlatformShell` each then rendered their
  deliberate wrong-tier 404. No error and no bad-password message, which is exactly why it presented
  as "just 404". The existing comment called `created_at` a deterministic tie-break; it is one, but
  determinism is not correctness — at the operator door the account that can use the console is the
  right answer, not the one that happens to be older.
- **Impact:** TWO admins, both active: `joy_admin` (above) and `Jay` (admin, site madolar, created
  2026-08-17), shadowed by the older active player `Jay_254` (invest254, 2026-06-27) on
  `0791908395`. `zrinok` (platform_superadmin) is unaffected — it is the oldest row on its phone.
  Marketers are unaffected either way (`marketer` is not in `PRIVILEGED_ROLES`). No unauthorised
  access: the shadow only ever produced a LOWER-privileged session than intended.
- **Fix:** a `preferPrivileged` option on `login()`, set by `/auth/admin/login` and nothing else. The
  scan no longer stops at the first match: it keeps the first match as the fallback (so the default
  path and the all-player case behave exactly as before) and takes an operator match when one
  exists. The marketer apps' `anyBrand` login does NOT set it, deliberately — a marketer's wallet
  lives on one brand, and resolving them to an admin account they also own would land them on the
  wrong one.
- **Not an escalation, and tested in both directions:** a candidate is only considered after ITS OWN
  hash verified the submitted password, so the password that opens the admin session is the admin's
  own. With DIFFERENT passwords the player's password resolves the player and the admin's resolves
  the admin (that test passed before the fix too). The same credential already opened the admin
  account through the per-brand login on its own brand's host, so no new door opens; one that was
  shut on the operator domain opens.
- **Verification:** reproduced first as a failing test — `expected: 'admin', actual: 'player'` — then
  green. Four tests: the shadow case, oldest-first preserved when no operator is on the phone, a
  wrong password still refused when the phone holds an admin, and the different-passwords case both
  ways. 2240 unit tests pass, `tsc -b` clean.
- **Note for the affected operator:** `joy_admin` has MFA enabled, so the sign-in will now ask for
  the 6-digit authenticator code (`AdminSignIn` handles `MFA_REQUIRED`). If that authenticator is
  gone, a recovery code is needed — or the owner clears MFA for the account.

## #134 — The operator back office answered on EVERY client brand domain — FIXED (web, middleware + layout gate)
- **What:** `/console`, `/admin/**` and `/platform/**` were served by hostname-independent routing, so
  every brand domain on the platform presented the operator sign-in form. The console is supposed to
  live on the operator domain (`triocodes.com`); nothing stopped a player's domain from serving it too.
  Surfaced while answering "what is the admin entry point" and closed on the owner's decision that the
  console be reachable only on the admin domain.
- **Evidence (live production, before the fix):** `https://cpfmarket.com/console` → **200**,
  `/admin` → **200**, `/platform` → **200**, each rendering `AdminSignIn` (phone + password). The same
  three paths on `triocodes.com` → 200, as intended. So the back office had as many front doors as the
  platform had brands.
- **Root cause:** host was used for exactly one routing decision — `middleware.ts` redirected `/` →
  `/console` on the admin host — and for nothing else. Access control on the operator surfaces was
  entirely ROLE-based (`console/page.tsx:18-22`, `AdminShell`, `PlatformShell`), and a role check runs
  *after* the page is served, so it can refuse an account but cannot refuse a domain.
- **Impact:** no unauthorised access — every surface still refused anything below `admin` with a 404,
  and that held. What leaked was the back office's *existence and its login form* onto client-facing
  domains: a credential form to brute-force or phish a lookalike of, on a domain whose operator never
  asked to host one, plus a plain statement to any visitor that the brand is one skin of a larger
  platform. White-label brands are sold on not advertising that.
- **Fix:** `operatorSurfaceAllowed(host)` (`lib/brand/adminHost.ts`) — one predicate, allowing the admin
  host, loopback/`.test`/`.localhost` (the e2e harness drives the console at `127.0.0.1:3100`, and CI's
  own readiness probe is `curl -sf …/console`), and `*.pages.dev` (so a deploy can be checked before DNS
  points at it). Enforced twice: `middleware.ts` rewrites the operator paths to `/_not-found` with a 404
  before Next matches the route, and each operator layout calls `requireOperatorHost()` as the backstop.
  The middleware is what makes it real — with the layout gate alone the 404 still preloaded
  `static/chunks/app/console/page-*.js` and carried `Console · CPF Market` in its flight payload, i.e.
  named the page it was hiding. Also removed the now-dead `/console` link from the affiliate page's
  staff notice.
- **Verification:** local production build, status matrix over 6 hosts × 8 paths — player hosts 404 on
  all operator paths and 200 on `/`, `/wallet`, `/account`; `triocodes.com` and `www.` unchanged at 200
  (`/` still 307 → `/console`); loopback, `.test` and `.pages.dev` 200. Real browser: the operator
  sign-in form renders on `triocodes.com/console|/admin|/platform` (password + identity field present),
  and `cpfmarket.com` shows "404 Page not found" with no form. Body diff confirms the 404 no longer
  carries any route-naming chunk or title. 2236 unit tests pass (9 in `adminHost.test.ts`), typecheck
  clean, e2e 199/0 + 20/20 + 20/20 + 26/26.
- **Residual (reported, not actioned):** the 404 a player host returns for an operator path renders
  without the player chrome, because `AppShell` suppresses chrome by pathname. The page and status are
  identical to any other 404; the missing nav is a weak oracle that the path is handled specially.
  Closing it means threading a host-derived flag through `AppShell`, the most load-bearing component in
  the player app — not worth that risk unprompted.

## #133 — Marketer's phone sat in PLAIN VIEW on the sign-in / sign-up screen — FIXED (web, docs/61)
- **What:** Issue 2 masked the marketer phone in the three `/marketers/*` API responses, but the number
  a marketer actually exposes is the one they TYPE into the website sign-in / sign-up form — rendered
  plaintext in a `type="tel"` field with no hide toggle. Marketers demo the platform on live streams
  from sign-up onwards, so their real MSISDN was on camera every time. Reported by the owner.
- **Evidence:** `AuthModal.tsx:409-421` (one field serves signin/signup/reset) `type="tel"`, no toggle —
  while the *password* directly beneath it already had a `showPw` eye toggle. Same in
  `AdminSignIn.tsx:115`. A full own-number render also survived at `billing/parts.tsx:138`
  (`Enter your M-Pesa PIN on {phone}`) fed by a prefill of `me.phone` into a plaintext input (`:101`).
- **Root cause:** Issue 2 was scoped to API *response* bodies. Masking a response does nothing about a
  number the user types, or one the client prefills from `/auth/me` (which legitimately returns the full
  number for deposit/withdraw prefill). The leak was entirely client-side and was never in scope.
- **Impact:** every marketer's real phone number, broadcast to their whole audience, on every demo.
- **Resolution:** the field now shows the house **partial** mask `0798****061` at rest with an eye that
  reveals the hidden digits — per the owner's requirement, *"not completely hide the number"*. (A first
  pass used `type="password"`, which the owner rejected as a dots-blob; corrected.) Implemented as
  `phoneDisplay()` in `apps/web/src/lib/auth/phoneMask.ts`: real digits while the field has FOCUS —
  an `<input>` renders its own `value`, so masking mid-edit would feed the mask back through `onChange`
  and silently post `0798061` instead of the real number — mask at rest and on autofill, full number
  when revealed, and every `onChange` guarded by `isMaskedValue()`. `type="tel"`/`inputMode` unchanged,
  so keypad and autofill behave as before and the submitted value is identical. Unit-tested in
  `phoneMask.test.ts`. The billing own-number echo goes through `maskPhoneForDisplay`, and its
  prefilled field uses the same partial mask. Residual, stated plainly: the digits are visible while
  the field is actively focused — unavoidable for an editable field, and what the owner asked for.
  **Deliberately NOT masked:** the deposit / withdrawal *destination* inputs — you must
  be able to read a number back before money moves, and those screens already show the stored number
  masked (only a freshly typed replacement is visible). `/auth/me` still returns the full number, since
  masking it would break deposit/withdraw prefill (a masked string fails `normalizeMsisdn`).

## #132 — "Force all marketers to sign out" never touched their website session — FIXED (migration 0200)
- **What:** 0198's force sign-out stamped `public.marketers.sessions_valid_after` (all 24 rows) — the
  TILL APP identity only. A marketer signed in on the WEBSITE holds an ordinary `profiles` token with
  role='marketer', and that session was never ended. The owner reported "no marketer was logged out",
  and they were right.
- **Evidence (read-only prod):** `profiles where role='marketer'` = **28 rows, only 11 stamped** (those
  11 from unrelated earlier admin actions). Worse, the stamp was irrelevant: the verifier's force-logout
  gate `AuthService.assertSessionValid` opens with `if (!isPrivilegedRole(role)) return;` and
  `PRIVILEGED_ROLES = {admin, platform_admin, platform_superadmin}` — **'marketer' is not privileged**,
  so `profiles.sessions_valid_after` was never even READ for a marketer token.
- **Root cause:** two separate gaps compounding — the wrong identity was stamped, AND the gate that
  would have enforced it skips non-privileged roles by design (a deliberate performance choice so
  player traffic does no DB read per request). 0198 only ever closed the till-app half via
  `requireMarketer`, which gates `/marketers/*` routes and nothing else.
- **Impact:** every marketer's website session (7-day JWT) stayed alive indefinitely. The headline
  control of Issue 1 did not work for the accounts it was written for.
- **Resolution:** new `SESSION_GATED_ROLES = PRIVILEGED_ROLES ∪ {marketer}` drives `assertSessionValid`,
  so a marketer's website token is now checked against the epoch (kept as a SEPARATE set, because
  `PRIVILEGED_ROLES` also drives the password-reset knowledge factor and the MFA requirement, where a
  marketer must stay non-privileged; players still skip the read). The 0196 five-minute IDLE timeout is
  deliberately left operator-only — logging a marketer out mid-demo would be worse than the bug.
  Migration 0200 stamps `profiles.sessions_valid_after` for every role='marketer' and re-stamps
  `public.marketers`, so both identities end at one moment. Regression test:
  `authservice.security.test.ts` — "assertSessionValid revokes a MARKETER website token issued before
  the epoch (0200)" + a set-membership test pinning marketer in/out of the two role sets.

## #131 — Marketer money/PIN RPCs had no DB brand fence (single point of failure) — FIXED (migration 0199, docs/60)
- **What:** the six marketer mutating RPCs (`fn_marketer_credit` / `_withdraw` / `_set_pin` /
  `_set_status` / `_set_fuliza` / `_set_airtime`) took only the marketer id and had no actor/brand
  awareness at the database. The user/brand/advance RPCs got the F-46 DB fence in 0156; the marketer
  RPCs were the one mutating surface left relying on the API `marketerInScope` guard alone.
- **Evidence:** `pg_get_functiondef` of all six on prod shows no `fn_assert_actor_site_scope` call and no
  actor params; their only guard is `marketerInScope` in `apps/api/src/app.marketers.ts`. Not a live
  exploit — that guard is correct today — but a one-route regression (a new/forgotten `marketerInScope`)
  would be an immediate cross-tenant marketer takeover (re-PIN) / drain / disable, with no backstop.
- **Root cause (why it was deferred first):** not clean-additive — `fn_marketer_credit` is called
  internally by `fn_marketer_game_withdraw` (0109) with no actor, so a *required* actor param would
  break the live demo→wallet game settlement; `fn_marketer_withdraw`'s defaulted params make an appended
  required arg illegal.
- **Impact:** defense-in-depth gap (no live hole). Account-takeover / money class if the API guard ever
  regressed on one route.
- **Resolution:** migration 0199 adds OPTIONAL trailing `p_actor`/`p_actor_role` to all six, fenced by
  the existing `fn_assert_actor_site_scope` (0156) only when a site-tier role is passed; old signatures
  dropped + recreated, bodies byte-identical apart from the one guard line. The admin routes forward the
  token actor (fence engages on every admin mutation); the internal + self-service paths pass none (fence
  no-op, game-withdrawal flow untouched). Deploy-order safe both directions. Validated: 61-assertion
  `e2e_marketer_rpc_tenant_fence.py` on a full 0001..0199 Postgres 16 apply (fence + system path + no body
  drift) and `app.marketers.tenantfence.test.ts` (wiring + semantics).

## #65 — 0198 revert block could not drop the appended view column — FIXED (branch `claude/issue1-marketer-signout-2fa`)
- **What:** the first draft of `0198_marketer_security_and_logout.sql`'s manual revert block restored the
  14-column `marketer_profiles` view with `create or replace view`, which in Postgres can only APPEND
  columns, never drop one.
- **Evidence:** applying 0198 then the revert on a throwaway Postgres 16 raised
  `ERROR: cannot drop columns from view` and left the view at 15 columns, the epoch column undroppable.
- **Root cause:** `create or replace view` forbids removing a column; the forward migration appends
  `sessions_valid_after` (allowed), so only the revert hits the restriction, and the column cannot be
  dropped while the 15-column view still selects it.
- **Impact:** documentation-only (a commented manual rollback), never executed by the runner — but a
  rollback that errors mid-incident is worse than none.
- **Resolution:** revert now `drop view`s first, recreates the 14-column view, then drops the table and
  column (order matters). Re-validated on a fresh cluster: forward + revert both clean, view back to 14
  columns with `security_invoker=true`.

## #120–#130 — Apple pass: every UI measured on real phone widths — FIXED (branches `ui/apple-pass`, `ui/apple-pass-2`)
Reported: the Entry Scanner's Market dropdown opened off the bottom of a phone screen. A scripted audit then
walked every player, admin and owner screen and overlay at 320/360/390/430 (touch) and 1440. It checked five
things: clipped overlays, sideways scroll, hit targets under 44 pt (Apple HIG; under 32 fails), inputs under
16 px (iOS Safari zooms on focus), and controls covered by other layers.
- **#120 (reported):**
  - **Bug:** the scanner's Market list was a dropdown inside a bottom panel, so it clipped.
  - **Fix:** new `Sheet` (bottom sheet on phones, card on desktop, grabber, safe area, scrolling body) and
    `Segmented` (HIG segmented control, 48 px, arrow keys). The scanner is a Sheet with a
    Even/Odd · Match/Differ · Over/Under segment. Nothing can open off-screen.
- **#121:**
  - **Bug:** the Markets sheet rendered *under* the bottom nav. It was `fixed z-50` inside a z-20 stacking
    context.
  - **Fix:** portalled to `<body>`.
  - Positions is now a real bottom sheet too.
- **#122:** the side drawer could not scroll on short phones, so its last items were unreachable. It now
  scrolls and respects the safe area. Verify Identity and Change Password are in it.
- **#123:**
  - **Bug:** 41 controls failed the target check: digit keys, stake steppers, pills, table links, checkboxes,
    and the withdrawals switch.
  - **Fix:** under a coarse pointer every control is at least 44 pt, checkboxes are 24 px (WCAG 2.2), and
    pill switches get an invisible 44 pt hit area.
  - Digits are 5 × 2 keys on phones. Stake/Payout is a segment.
- **#124:** inputs at 12–14 px made iOS zoom the page on focus. Fields are 16 px on phones; the amount heroes
  stay large.
- **#125:**
  - Brand name and balance wrapped onto two lines at 320 px. They no longer wrap, and the mark stands alone
    under 360 px.
  - The chat placeholder was cut off; it is now "Message".
  - Market names drop the redundant "Index", so "Volatility 10 (1s)" fits.
- **#126:** native checkboxes were white on the dark theme. `color-scheme` and `accent-color` now follow the
  theme and the brand.
- **#127 (classic brands, e.g. invest254.com):** the SELL button was grey and looked disabled. The brand's
  stored theme had `down: #8fa396`. Gain and loss now stay green and red on every brand: an up/down token
  outside that colour family is ignored, and the default applies (`semanticColourOk`, brand.test.ts). All
  56 preset themes pass.
- **#128 (classic):**
  - **Bug:** the duration was a hidden tap-to-cycle circle ("10 s"), undiscoverable.
  - **Fix:** it is now a segmented control showing 10s · 30s · 1m · 2m at once.
  - Stake pills and ± steppers are 44 pt on phones. The chart's interval keys are 44 wide on touch, and the
    zoom buttons are hidden there (pinch zooms).
- **#129 (classic, short phones):** at 320×568 the chart was about 100 px tall. The decorative ticker hides
  on screens under 640 px tall, and the chart keeps at least 160 px.
- **#130:**
  - The account card said "Identity" twice.
  - The auth switch link ("Log in") was 41 px wide; it is now at least 44 px.
  - Selected segments use the brand accent, like every active pill. The old raised surface read as
    recessed on dark themes.
- **Result:** 172 screen×width checks (digits brand) and 70 (classic brand). COVERED 0, CLIP 0, HSCROLL 0,
  ZOOM 0, TARGET<32 0. The only remaining note is the TradingView attribution logo (third-party, 35×44).
- **Tests:** digits 57/57, account 65/65, roles 198/198, npm test 1208/1208 (new brand.test case), typecheck clean.

## #115–#119 — Regressions caught by reviewing today's own diff — FIXED (branch `fix/hunt-regressions`)
A line-by-line review of everything changed since 136a092 (web, API, both migrations). There were no hook-order
or circular-import problems, and grants and scope checks were right. It found:
- **#118 (high on weak currencies):** 10,000 of a weak currency (UGX ≈ KES 350) is below
  `fn_topup_demo_account`'s KES 1,000 floor. The switch to Demo returned 400, although the wallet was already in
  demo mode at 0, and every refill failed. The target is now clamped to the function's bounds, and funding is
  best-effort after the switch.
- **#115:**
  - **Bug:** a multiplier closed while the socket was away (another page, a drop) stayed "open" in the new store.
    It blocked new opens and the account switch until a reload.
  - **Fix:** while a position is shown, the screen checks `/positions?status=open` (on mount and every 15 s)
    and clears a position that is gone.
- **#116:**
  - **Bug:** the auth queue had no timer and dropped non-digit trades silently. A classic rise/fall open queued
    behind a slow or failed sign-in stayed "Opening…" for good.
  - **Fix:**
    - The auth answer must come within 8 s. Every dropped open is reported (digits via the screen; classic
      rolls back and toasts).
    - An `ENGINE_ERROR` while waiting for auth is taken as the answer, because the engine binds the socket
      before its wallet read.
    - The heartbeat pings every 6 s, so brands with a slow tick rate never trip the 12 s dead-socket check.
- **#117:** when a contract was given up on (refusal race or backstop) but DID open, its ack and result were
  ignored. It is now kept as "last dropped", so a late ack still attributes the result.
- **#119:**
  - Changing a brand's currency keeps no stale stake limits (KES 50 must not become $50).
  - The commission-rate field seeds once, so an admin can clear it.
  - A demo refill that cannot cover a stake above 10,000 says "Demo max …" instead of "Demo refilled".
- **Tests:**
  - digits.e2e.mjs, new: sign-in held 10 s → dropped with "Not connected", nothing in play, the next trade
    goes through. 57/57.
  - app.demo1.test.ts: demo target bounds.
  - npm test 1207/1207. account 65/65. demo1.pg 2/2.

## #108–#114 — Operator console bug hunt + minimal copy — FIXED (branch `fix/console-hunt`; API: one read-only route)
- **#108 (money):**
  - **Bug:** pressing Cancel on the reference prompt still marked a commission payout PAID, and Cancel on the
    note prompt still APPROVED an advance, because `window.prompt()` returns null and that was treated as an
    empty note.
  - **Fix:** Cancel now does nothing.
  - **Also:** many console actions failed silently: payout approve/paid/reject with a wrong owner password,
    advance decisions, expenses, the platform master switches and banner, the global economy saves, and
    manual pool distribution. All of them now show the server's reason (`useFailToast`).
- **#109:**
  - **Bug:** users ticked under one filter stayed selected after switching filter, so a bulk Ban or
    Clear-balance also hit people no longer on screen.
  - **Fix:** the selection clears when the filter changes. The bulk toast is now "3/3 done", with no raw
    exception text.
- **#110:**
  - **Bug:** brand Economy / Identity / Legal forms were overwritten whenever the brand refetched (for
    example after saving the Stake card on the same tab), losing unsaved edits.
  - **Fix:** `useSyncedForm` follows server changes only while nothing has been edited. The native
    min-withdrawal field works the same way.
- **#111:**
  - **Bug:** a marketer's commission rate always showed 20%, and "Update rate" wrote 20%.
  - **Fix:** a new `GET /admin/affiliates/:id/rate` (brand-scoped; the F-44 matrix covers it) feeds the real
    value. The button is disabled until the value changes.
- **#112:** player overrides took win rate and house edge as 0–1 fractions, unlike every other editor. They are now
  entered in % with the brand limits in %.
- **#113 and other fixes:**
  - Confirmation is now required before removing a brand admin and before turning a brand's withdrawals OFF.
  - The ban toast read "Account band".
  - The user page showed the raw role code.
  - Reconciliation tiles were labelled `success` / `pending`.
  - "TypeError: Failed to fetch" was shown as an error.
  - Tables nested inside `TableWrap` broke the 640 px scroll on phones.
  - Credit and Clear no longer both run while one is in flight.
- **#114:**
  - **Bug:** overview windows used UTC or the browser's midnight, and "last 30 days" covered 31 days. A
    half-picked or reversed custom range showed all-time totals under a custom label.
  - **Fix:** days are EAT (UTC+3), the window is exactly 30 days, and an incomplete range shows "—".
- **Copy:**
  - Prose subtitles removed from 22 console pages. Config now reads "N active brands".
  - Removed the withdrawal-switch helper text, the global-economy per-field hints (one of them was wrong: "Fraction
    of positions that win" on a % input) and the overrides paragraph (now "Blank = brand · win ≤ 40% · edge ≥ 5% ·
    ×≤ 5").
  - Kept: the irreversible-money warnings and confirm dialogs.
- **Tests:**
  - roles.e2e.mjs 198/198 (updated for %).
  - app.commissionrate.test.ts.
  - The scope matrix caught the new route answering 501 before its scope check. Fixed: scope is checked first.
  - npm test 1206/1206. account 65/65, digits 55/55.

## #99–#107 — Player UI bug hunt, round 2 + minimal copy — FIXED (branch `fix/player-ui-hunt`, web only)
- **#99:**
  - **Bug:** signing out (or a 401 reset, or signing in as someone else) left the previous player's cached
    queries on screen, because no key names the user. The next person saw that player's notification
    banners (including blocking ones), chat and unread badge, identity status, referral earnings and
    session list.
  - **Fix:** `SessionCacheGuard` (global) clears the query cache and the session, multiplier, dialog and chat
    stores whenever the signed-in account changes. The banners render only with a token.
- **#100:**
  - **Bug:** on the classic trade screen the floating chat button sat on top of SELL on phones.
  - **Fix:** chat is now a CHAT item in the phone bottom bar, and the floating button is desktop-only.
- **#101:**
  - **Bug:** an autofilled or pasted "+254 712 345 678" was cut to "2547123456" and refused.
  - **Fix:** it now becomes "0712345678". Login no longer applies the NEW-password rules (older passwords
    reach the server), and Change password uses the server's rules.
- **#102:** the welcome-bonus card said "Deposit $1.93" on a USD brand (raw KES cents). It now uses the enforced
  minimum stake.
- **#103:** the classic stake field re-seeded itself whenever it was emptied, so deleting "100" and typing "200"
  gave "50200". It now seeds once.
- **#104:** a chat voice note wiped the typed draft and a staged photo, and closing the chat while recording left
  the microphone on. The composer now clears only what was sent and releases the mic on close.
- **#105:** KES amounts in the digits UI were rounded UP (KES 99.50 showed as "100", and a 100 stake was then
  refused). They now show cents when there are any.
- **#106:**
  - **Bug:** the win overlay put "+" on the gross payout, overstating a win by the stake. The near-miss
    "Just missed the mark" line has gone.
  - **Fix:** the big figure is now the net result, with the payout and stake on the line below.
- **#107 (and minor fixes):**
  - The Modal no longer steals focus from an autofocused field.
  - Escape now closes the bell, the drawer, Change password, and a zoomed chat photo (and only the photo).
  - The account switcher fits at 320 px.
  - The price header re-renders only on a new tick; "24H H/L" becomes "H/L", since it is the buffer's
    extremes.
  - The referral card uses the brand currency and has separate "Copied" states.
  - Hard-coded "Invest254" / "P" / "BTC/KES" are gone from the referral landing, offline and 404 pages.
- **Copy cut (numbers first):**
  - Auth subtitles and trust line.
  - Classic BetPanel: "Trades settle automatically", "Auto-sell / Trade duration", the idle "Live P&L 0",
    "Price rises / falls", "Deposit to buy or sell".
  - The welcome-bonus sales sentence (now "Min stake $5 · Bonus · withdrawable once won").
  - Chat greeting paragraph (now WhatsApp / email chips).
  - Switcher toasts (now "Demo · 10,000 KES").
  - KYC sub and toast text.
  - Trade toasts ("Min $5", "Trade in progress").
  - Offline / 404 / error bodies.
  - Footer taglines. The risk sentence, 18+ badge, helpline 1190, licence and Terms / Responsible Gaming
    links stay.
- **Tests:**
  - account.e2e.mjs, new: sign-out leaves no trace; "+254" autofill. 65/65.
  - digits.e2e.mjs 55/55.

## #90–#98 — Deriv client bug hunt, round 1 — FIXED (branch `fix/deriv-hunt`, web only; engine untouched)
Found by a line-by-line audit of the digits screen, socket provider and wallet sheet, then checked against the code.
- **#90 (money):**
  - **Bug:** the deposit sheet said "Deposit received" when the balance rose. AUTO wins, a demo account or a
    take-profit could do that with no deposit at all, and the sheet closed as if paid.
  - **Fix:** success is now only THIS deposit's transaction status. A shortfall below the minimum deposit is
    pre-filled at the minimum, so the pre-filled amount is never refused.
- **#91:**
  - **Bug:** the engine sends every `digit_settled` to all of a player's sockets. With two tabs or devices, one
    tab's result cleared the other's contract, showed a mixed result card, and fed AUTO the wrong P&L.
  - **Fix:** the provider passes on `digit_opened` (sent only to the opening socket). The screen keeps the
    position ids it opened and ignores anyone else's settlements. A late answer after the 20 s backstop is
    still counted, without a card.
- **#92 (socket):**
  - **Bugs:**
    - A dead socket that still read "open" was never detected.
    - The awaiting-ack counter leaked across reconnects, so a stray error could clear a live contract.
    - The provider's value was a new object on every render, and brand-wide `online` counts re-rendered the
      whole trade screen and chart.
  - **Fix:**
    - 12 s of silence (ticks arrive every 1–2 s) forces a reconnect.
    - The counter resets on close, and only open-related errors count as refusals.
    - The context is split into stable API / state / instrument key, and heavy consumers use the stable API.
    - `useInvalidateDigitHistory` is stable, and FitText re-fits only when its figure changes, not with a
      reflow on every render.
- **#93:**
  - **Bug:** signing out or in as someone else kept the socket bound to the previous user, who went on
    receiving balance and settlements. Their wallet, history and session list also stayed on screen.
  - **Fix:** a different user reconnects the socket and drops the user-scoped caches and the session stores.
- **#94:** the result and insufficient-balance cards re-focused themselves on every tick (an inline `onClose`
  in the deps), pulling keyboard and screen-reader users back. They now focus once per open.
- **#95:**
  - **Bug:** Session P/L summed demo and real (for example +5,000 demo and −200 real showed +4,800).
  - **Fix:** the totals are per account. The footer is numbers only: "7 · 4W 3L  +240 KES".
- **#96:**
  - **Bug:** the scanner compared Over 5 (40% expected) with Under 5 (50%) on raw share, so it nearly always said
    "Under". It also showed the base rate as a lean.
  - **Fix:** each side is measured against its own expectation, and the edge (+x.x points) is ranked and shown.
- **#97:**
  - **Bug:** on phones a swipe detached the chart from live, with no way back.
  - **Fix:** a phone live button. The instrument's old IN / result markers are cleared on switch, and each
    buy button checks its own side's stake.
- **#98:**
  - **Bug:** an open multiplier lived in the panel's local state. Switching to a digits tab hid it (no Close,
    and a second open was possible). The price of another instrument showed as "Current", and switching account
    ignored it.
  - **Fix:** the position lives in `multSession` and is synced by the always-mounted screen. "Current" shows
    only for its own instrument, and an open multiplier blocks an account switch.
- **Copy:**
  - Removed: repeated sentences on the result card, the insufficient-balance card, the deposit sheet (both
    paragraphs) and the positions empty states.
  - Withdraw sheet: "Paid instantly" corrected to "M-Pesa · Secured", since payouts are held for approval.
  - Foreign brands get the decimal keypad.
  - "Min KES250" now has its space.
  - The AUTO summary reads "· 7 trades".
- **Tests:**
  - digits.e2e.mjs, new: two tabs; scanner edge; footer format. 55/55.
  - account.e2e.mjs, new: the multiplier survives a tab switch; the Real footer excludes demo. 63/63.

## #89 — Saving the economy more than 6 times an hour showed "Something went wrong" (a bare 500) — FIXED (branch `feat/stake-ladder`, API only)
- **What:** the DB guard `fn_guard_config_change_rate` (6 economy changes per brand per hour) raises
  `CONFIG_CHANGE_RATE_LIMIT`. That code was not mapped, so the console showed a generic 500 and the admin could
  not tell why the save failed.
- **Fix:** it maps to 429 with "6 economy changes in the last hour for this brand. Try again later." The stake
  card also skips re-writing an unchanged pair, so it does not use up the budget.

## #88 — "Log in to trade" while signed in: a trade tapped right after the socket (re)connected was refused — FIXED (branch `feat/stake-ladder`, web only; engine untouched)
- **What:** the engine verifies `auth` asynchronously (JWT, then a wallet read). A digit, multiplier or
  rise/fall open that reached it before that finished was refused `AUTH_REQUIRED`. The player saw "Log in to
  trade" while signed in. It hit anyone tapping during a reconnect (mobile networks), and it showed up as a
  rare e2e flake.
- **Fix:** the socket provider holds trades until the auth answer (the `balance` frame) and then sends them in
  order.
  - Anything older than 8 s is dropped as not sent, and the screen is told.
  - On a close, or on `AUTH_INVALID` / `AUTH_SITE_MISMATCH`, queued digit opens are reported as not sent, so
    nothing waits for ever.
  - An unexpected `AUTH_REQUIRED` while signed in re-sends `auth` quietly.
- **Test:** digits.e2e.mjs closes the socket, holds the next `auth` for 1.5 s and taps Buy during the gap. The trade
  settles and there is no "Log in to trade".

## #87 — Stake pills were fixed lists, not multiples of 5 from the admin's minimum; min/max only in KES — FIXED (branch `feat/stake-ladder`, migration 0170; engine untouched)
- **What (owner):** "Stake pills should be in multiples of 5… if min is $5, the next pill is double, then quad,
  then pent… dynamic based on the min stake… admin has UI to control min and max".
- **Before:**
  - Pills were hard-coded (USD 5 · 10 · 25 · 50 · 100 · 250; KES 50 · … · 5000). Some sat below the minimum and
    were greyed out.
  - Admins could set min/max stake only in KES cents.
  - The classic panel had its own fixed chips, and Multipliers had none.
- **Fix:**
  - `site_stake_native` (0170, service_role only) holds min/max in the brand currency. Each is a multiple of
    5, and the DB checks it too.
  - `PUT /platform/sites/:id/stake-limits` validates the pair and writes the engine's KES-cents limits through the
    normal economy path (versioned, audited): KES exactly, foreign currencies with a 10% FX margin so a rate move
    never refuses a pill.
  - `GET /game/config` returns `minStakeNative` / `maxStakeNative`.
  - Player: `stakeLadder()` gives min ×1, 2, 4, 5, 10, 20, capped at max ($5 → 5 · 10 · 20 · 25 · 50 · 100). It is
    never below what the server enforces. `useStakeLimits()` feeds the Deriv screen, Multipliers (new pills) and
    the classic panel (first three pills).
  - The stake starts at the minimum pill. The stepper moves in 5s ($) or 50s (KES) and never goes below the
    minimum.
  - Console → Economy has a Stake card: Min / Max in the brand currency, a live preview of the pills, and a
    refusal before saving for any value that is not a multiple of 5.
  - Server refetches no longer overwrite what the admin is typing.
- **Tests:**
  - stakeLadder.test.ts (7) and stakelimits.test.ts (3).
  - app.stakelimits.test.ts: gate, validation, USD margin, KES exact, no re-write, no rate → 503.
  - account.e2e.mjs: console refusal, preview, save → public config, and the player's pills and starting stake.

## #86 — Payout mode: the second side used the first side's stake, so it paid a different amount than typed — FIXED (branch `fix/deriv-auto-ai`, web only)
- **What:** in Payout mode the stake was derived from the PRIMARY side's odds only. For example, a Matches/Differs
  payout typed as 100 staked the Matches stake on Differs and paid about 11, not 100.
- **Fix:** `stakeFor(side)` derives each side's stake from its own win probability. Manual trades, AUTO and each
  button's figure use it.

## #85 — A refused trade froze the Deriv screen "in play" for good (manual and AUTO) — FIXED (branch `fix/deriv-auto-ai`, web only; engine untouched)
- **What:** when the engine refused a digit open (insufficient balance, stake limits, one contract per market,
  paused play), the screen kept its local "pending" contract. After that, every tap said "Trade in progress" and
  AUTO silently stopped placing, until a reload. The same happened when the socket was offline at the moment
  of the tap, because the contract was marked pending before the send.
- **Root cause:** the engine answers a refused open with an `error` frame. The socket provider only toasted it,
  and the screen had no way to learn that its open was refused.
- **Fix:**
  - The provider counts unacknowledged digit opens. An `error` while one is outstanding is that open's refusal,
    and it goes to `onDigitRejected` listeners. `openDigit` returns false when nothing was sent, and the screen
    only marks a contract pending after a successful send.
  - The screen clears the pending contract on a refusal, and AUTO stops instead of retrying the same refusal.
  - A 20 s backstop clears any contract that never settles and re-syncs history.
  - Engine codes now read in plain words ("Insufficient balance · Top up or lower the stake") instead of
    "Trade rejected · INSUFFICIENT_FUNDS".
- **Perf (same change):** the 250 ms loop re-rendered the whole screen four times a second even without a new tick.
  It was also torn down and rebuilt on every balance or stake change. It now re-renders only on a new tick, and
  one interval lives for the screen's lifetime (it reads a ref).
- **Tests:** digits.e2e.mjs routes the socket and refuses the next open. It checks the plain-words reason, that
  nothing is left in play, and that the next trade goes through.

## #84 — AUTO could not be started again after a run finished; the AI scanner only "loaded" and never traded, and could get stuck — FIXED (branch `fix/deriv-auto-ai`, web only)
- **What (owner):** "After clicking the auto button, once it completes the rounds, clicking again does not do
  anything" and "The AI functionality on loading best conditions and clicking the button does not work".
- **Root causes:**
  - Target and stop loss were compared to the SESSION P&L, which never reset. After a run hit its target, every
    new run was already "at target" and stopped on its first tick.
  - "Load Deep Scanner Bot" only switched the market and highlighted a button for 5 s. Nothing traded.
  - Closing the scanner mid-scan left `scanning` true forever, so both buttons stayed disabled until a reload.
  - AUTO stopped silently. It also looped for ever without trading when the martingale stake exceeded the balance
    but was below the minimum.
- **Fix:**
  - `lib/game/autoBot.ts` (pure, 6 unit tests) gives each run its own P&L baseline, trade count and loss streak.
    It stops on target / stop loss / funds / below-minimum stake with a reason. The stop shows a
    numbers-only summary (for example "Target hit · +240 KES · 3").
  - The scanner is now Scan → Run. Run loads the best entry and starts AUTO on its side at once, with the current
    stake, target, stop loss and multiplier. The scan always ends.
  - Copy cut to numbers: progress %, the index being scanned, and the share.
- **Tests:** digits.e2e.mjs checks two consecutive AUTO runs that both trade and stop, and the summary. It checks
  that Scan shows progress and a best entry, that Run closes the sheet and the bot trades and stops by itself,
  and that the scanner is usable after closing it mid-scan. 53/53.

## #83 — A new demo account showed 0 until the player found "Refresh demo balance"; a USD brand's demo was KES 10,000 (≈ $77) — FIXED (branch `fix/deriv-demo-money`, migration 0169; engine untouched)
- **What:** a player who signed up and switched to Demo saw a 0 balance and could not trade until they opened the
  account menu and pressed "Refresh demo balance". On the USD brand (muchwins) the refill was KES 10,000, shown as
  about $77, not $10,000.
- **Root cause:** `wallets.demo_balance` defaults to 0 and was only funded by the manual refresh
  (`fn_topup_demo_account`, a fixed KES 1,000,000-cent target).
- **Fix:**
  - The switch to Demo (`demo.pg.ts setMode`) funds the demo account when it cannot cover the brand's minimum
    stake (new or spent). The switch response carries the funded wallet, so the pill shows 10,000 at once.
  - The target is 10,000 of the brand currency, converted to KES cents at the live rate and rounded up so it
    never reads 9,999.99 (`demoTargetCents`). `fn_topup_demo_account` takes that target, bounded to
    KES 1,000–100M, and callable by service_role only.
  - Marketers keep their own demo flow.
- **Tests:**
  - demo1.pg.test.ts (real schema): the first switch opens funded; USD opens at $10,000; a spent demo refills on
    the next switch; a balance that can still trade is left alone; the marketer is untouched.
  - e2e_account_demo_mode.py §G: target, no-op, 2-arg compatibility, bounds, ledger, grants. 34/34.
  - account.e2e.mjs: "a new demo account opens at 10,000 (no refresh)".

## #82 — Demo money showed as withdrawable, and a withdrawal in Demo took REAL money — FIXED (branch `fix/deriv-demo-money`, migration 0169; engine untouched)
- **What (owner):** "users can withdraw demo money".
- **Evidence:**
  - In Demo, the wallet sheet's "Available to withdraw" and the 25/50/75/Max chips used `wallet.real`, which is
    the ACTIVE account's balance, so the demo balance was offered.
  - `fn_create_withdrawal` had no mode check and debits `real_balance`. A player with real money who withdrew
    "their demo balance" silently lost real money. A player without real money got a confusing
    "Insufficient balance" for a figure the sheet said was available.
- **Fix (defence in depth):**
  - The API refuses `DEMO_ACCOUNT` (409) before any money path runs. Marketers are demo-locked and keep their
    demo transfer.
  - `fn_create_withdrawal` refuses `DEMO_ACCOUNT` under the wallet row lock, so a switch cannot race it.
  - Web: `walletFigures()` is the one source for the wallet figures. Withdrawable is the Real cash only, and 0 in
    Demo. In Demo the sheet shows the Real balance and a single "Switch to Real" button, with no amount entry.
    The sheet header reads the Real account (Real balance / Withdrawable).
- **Tests:**
  - figures.test.ts (5).
  - app.demo1.test.ts: DEMO_ACCOUNT in demo; marketer and Real reach the service.
  - e2e_account_demo_mode.py §E: demo-only, real+demo refused with nothing debited, Real proceeds, and demo is
    never counted.
  - account.e2e.mjs: the sheet, the API refusal, and no money moved.

## #81 — Digits screen: Markets picker, Trade types sheet and scanner list to the mock; Multipliers built but never reachable — FIXED (branch `ui/deriv-markets-tradetypes`, web only; engine untouched)
- **What (owner's Deriv mocks):**
  - The instrument menu was a plain list: no categories, search or favourites.
  - There was no "Trade types" view.
  - The Entry Scanner list did not match the mock.
  - `MultipliersPanel` and the engine's `open_multiplier` existed, but no screen rendered them.
- **Fix:**
  - **Markets picker:** on desktop, a popover with a category rail (Favorites, Synthetic indices → Volatility (1s) / Volatility), search, grouped rows with a volatility badge, and favourite stars saved per device. On phones, the same content as a bottom sheet with category chips.
  - **Only tradable markets are listed.** Forex, stock indices, crypto and commodities from the mock are left out: the engine cannot price or settle them, and TradingView offers chart widgets, not a feed trades can settle on.
  - **Trade types sheet:** chips All / Multipliers / Options, then Multipliers and Digits (Matches/Differs, Even/Odd, Over/Under). It opens from the ⊞ button on phones and from "All trade types" in the desktop console.
  - **Tab rows:** the phone row scrolls to keep the active type in view. The desktop console shows the types as a grid.
  - **Entry Scanner:** the list is restyled to the mock. Its scope is unchanged: digits only.
  - **Multipliers:** the console now shows the existing panel. Its first stake is the brand's minimum stake; it was KES 200, which was refused against KES 250.
- **Why Multipliers is Demo-only (found during the work):**
  - Every active brand runs in pool mode, and mpesapap now uses the digits screen.
  - In pool mode the engine decides a real-money multiplier's result when it opens. It then draws a scripted P/L path to that result ("green feint" before a decided loss). Stop loss, deal cancellation and closing early are switched off.
  - On a real account the P/L a player watched would therefore not follow the chart. The Close button would also fail with CLOSE_DISABLED.
  - The Demo path prices it from the quote. So the sheet shows Multipliers on real accounts as "Demo account" and does not let it be picked.
- **Verification:**
  - Digits e2e 42/42 (new checks: picker, search, favourites, switching index, the sheet, the chip filter, Demo-only lock, picking a type).
  - Account e2e 49/49 (new: a demo multiplier opens and closes, and only the demo balance moves).
  - Roles e2e 198/198, `npm test` 1182 pass, and the hooks lint is clean.
  - Phones have no horizontal scroll.

## #80 — Figures cut off with "…" in KPI cards and on phones; demo notices trimmed; player two-factor switched off — FIXED (branch `ui/trim-demo-2fa-figures`, no migration)
- **Reported (owner, with screenshot):** on the console Overview, "Deposits · today" and "House revenue · today" showed "KES 14…" and "KES 13…". The demo banner and the switcher's disclaimer were too much text. Player two-factor should be off until SMS codes (Africa's Talking) are ready.
- **Root cause (figures):** `StatCard` values used `truncate`. On wide screens the console shows seven tiles in one row, about 150px each, so any KES figure longer than about seven characters was cut off. Checking every page with large amounts turned up three more cases:
  - At 1024–1279px the digits desktop header pushed the balance, Deposit and the account menu off-screen.
  - At 390px or narrower the phone header pushed the bell or Deposit off-screen when the balance was large.
  - The phone payout on the buy cards ran into the "Even/Odd" label.
- **Fix:**
  - **Figures always shown in full:** a new `FitText` component scales a figure down to fit its card instead of cutting it off. It wraps only as a last resort. It is used by every `StatCard`, the trend cards, Live now, the trade result tiles, the buy-card payouts and the marketer's available balance.
  - **Overview layout:** on wide screens the row now has 9 columns, and each money tile spans two, so the figure shows at full size. On phones the money tiles take the full row.
  - **Digits header:** from 1024 to 1279px the nav shows icons only (labels return at 1280px). The balance steps down a size only when it is long. On phones under 360px the speaker moves into the menu, where there is also a Sound row. When a player is signed in on a phone under 420px, the clipped wordmark is hidden.
  - **Demo:** the demo banner on the trade screen and the switcher's disclaimer are removed. The "D" badge and the DEMO label on the pill remain.
  - **Two-factor:** it is off for players and marketers. Two-Factor Auth is hidden from the account menu and the account page, and the API refuses enrolment with `PLAYER_MFA_DISABLED` unless `PLAYER_MFA_ENABLED=1`. Staff two-factor is unchanged. No player or marketer had enrolled in production (checked), and the sign-in code step remains in case one ever does.
- **Verification:**
  - A new sweep inflates every money figure from the API to KES 14.5M and checks 13 pages at 320–1920px: no figure is cut off or off-screen. The only cut-off text left is the instrument name at 320px, which is a label, not a figure.
  - Account e2e 46/46 (it now checks: no banner, no disclaimer, 2FA not offered, the API refuses enrolment, sign-in has no code step). Digits e2e 34/34. Roles e2e 198/198. `npm test` passes with 1182 tests, including a new API test for the switched-off player 2FA. The hooks lint is clean.

## #79 — Opening the sign-in window crashed the whole app (found in e2e before merge) — FIXED (branch `feat/demo-sound-chat-account`)
- **Found by:** the new `apps/web/e2e/account.e2e.mjs`. After signing out, tapping "Log in" replaced the page with "The app failed to load". The browser console showed React error #310 ("rendered more hooks than during the previous render").
- **Root cause:** the new two-factor step in `AuthModal` declared its three `useState` hooks after the component's `if (!open) return null`. The first render with the window open ran more hooks than the closed render before it. Every brand's sign-in would have broken. Nothing reached production.
- **Fix:** the hooks now sit above the early return, and the code step resets when the window closes or the mode changes.
- **Guard:** a one-off `react-hooks/rules-of-hooks` scan of all of `apps/web/src` is now clean. The repo has no ESLint set up; adding that rule to CI is recommended.
- **Also fixed during the same e2e pass:**
  - The account switcher stayed open after a switch. It now closes, as in Deriv's switcher.
  - On phones the demo banner pushed the buy buttons under the bottom nav. It is now one line on phones.
  - The chat header said "A live agent is here to help" even when nobody is online. It now says "Our support team replies here".

## #78 — No identity verification for players (ACCT-1) — FIXED (migration 0168)
- **What:** the mock's "Verify Identity" item had nothing behind it. Brands had no way to collect or review an ID.
- **Fix:**
  - Players choose a document type (National ID, passport or driving licence) and enter the name, number and date of birth (18+ only). They upload the front, the back when needed, and a selfie; the phone camera opens directly.
  - The brand reviews on the new **Identity checks** page and approves, or rejects with a note the player sees. The player's page in the back office shows the latest status.
  - The database refuses: a second pending submission, re-submitting once verified, another player's file, re-used files, a PDF selfie, over 6 MB, more than 12 unused uploads a day, and reviews outside the reviewer's brands or platform.
  - Every decision is audited (`kyc.review`). Unused uploads are removed after two days.
  - Files are served only through signed links that expire after one hour.
- **Scope note:** verification does **not** block deposits or withdrawals. It is shown to the player and to staff only.
- **Verification:**
  - `e2e_identity_verification.py`: 34/34 (BEFORE 0167 / AFTER 0168).
  - `app.kyc.test.ts` passes, and the scope matrix now covers `/admin/kyc/:id`.
  - The real-stack e2e covers submit, then review with the three images, then approve, then "verified" in the player's menu.

## #77 — Players could not use two-factor sign-in (ACCT-1) — FIXED (web; API unchanged)
- **What:** the API already supported TOTP for every role, but the player sign-in window could not send a code. The account menu also had no way to turn it on. A player who enabled 2FA through the API would have been locked out.
- **Fix:**
  - A new **Two-Factor Auth** dialog shows a QR code, the key and 8 one-time recovery codes. Two-factor turns on only after the player ticks "I saved my recovery codes" and enters a valid code. The same dialog turns it off.
  - When needed, sign-in asks for the 6-digit code or a recovery code.
- **Verification:** the real-stack e2e sets up 2FA with a real TOTP and signs out. It then checks that a wrong code is refused and that the right code signs the player in.

## #76 — "Live Chat" had no human behind it; no WhatsApp contact (CHAT-1) — FIXED (migration 0167)
- **What:** Live Chat opened the AI assistant widget, or nothing when that widget was off. Players could not reach a person, and brands could not list a WhatsApp number.
- **Fix:**
  - **Player side:** a Customer Care chat on every brand, from the top bar, the phone bottom nav and the account menu. It supports text, photos (compressed on the phone), short videos and voice notes, and shows an unread badge. Agents appear as "Support".
  - **Back office:** **Player chats → Live chat** lists open, resolved or all threads with search. Agents reply with the same attachments and can resolve or reopen. The nav shows an unread count.
  - **WhatsApp:** each brand can set a WhatsApp number in the console (Brand → Identity). It is shown as "WhatsApp Care" in the account menu and in the chat greeting.
  - **Database rules:** one open thread per player, and messages always carry the thread's brand. Limits are 5 MB for photos, 15 MB for videos and 3 MB for voice notes. The API refuses cross-brand access.
  - **Retention:** attachments are removed after 90 days (`CHAT_MEDIA_RETENTION_DAYS`), by a job that runs every 6 hours.
- **Verification:**
  - `e2e_live_chat.py`: 30/30.
  - `app.livechat.test.ts` passes, and the scope matrix covers `/admin/chat/threads/:id`.
  - The real-stack e2e covers player text and photo, then the agent reply, then the unread badge, then resolve.

## #75 — Demo mode existed in the database but the engine traded it as real money (DEMO-1) — FIXED (engine change authorised by the owner; no migration)
- **What:** migration 0123 added `wallets.account_mode` and a separate demo balance. The engine, however, only put **marketers** on the demo path. A player switched to demo would still have traded real money against the pool. There was also no switch in the UI.
- **Fix:**
  - **Engine** (authorised, "with a demo label"): an account in demo mode is now handled exactly like a marketer demo account. It uses a separate balance, never touches the pool, and positions are flagged `demo`. The mode is read fresh on every trade; marketer status is cached for 60 seconds; if the check fails, the trade takes the real path.
  - **API:** `POST /wallet/mode` switches accounts, and is refused while a contract is open. `POST /wallet/demo/topup` refills the demo balance to KES 10,000.
  - **Web:** the balance pill now has a Real/Demo switcher (as in the mock) and a Refresh demo balance button. In demo mode a "Demo account" banner says results can differ from real-money play, and demo trades are tagged DEMO in positions and history.
- **Verification:**
  - `app.demo1.test.ts` and `demo1.pg.test.ts` pass.
  - The real-stack e2e confirms a demo trade moves only the demo balance, while the real balance stays the same.

## #74 — Digits screen: digit row overlapped AUTO/MANUAL on phones; Live Chat button did nothing; no positions, session or history view (DIGITS-UI) — FIXED (branch `ui/digits-mock`, web only; engine untouched)
- **Found while rebuilding the digits screen to the owner's mocks (desktop and phone):**
  - **Overlap:** on phones the digit-statistics row sat on top of the AUTO/MANUAL toggle. The centre column was `min-h-0` inside a fixed-height flex column, so it shrank below its content (visible on the pre-change screenshot at 390×844).
  - **Dead button:** the bottom nav's "Live Chat" opened the support store even when the support widget is switched off, which is the default, so tapping it did nothing.
  - **Missing views:** there was no Open / Closed view of positions, no session P/L, and no single transaction history. Players had to leave the trade screen for the history page.
- **Fix (web only):**
  - **Layout:** on phones the columns no longer shrink below their content.
  - **Bottom nav:** Live Chat shows only when support chat is on. Otherwise "Guide" opens How to Trade.
  - **Screen layout (to the mocks):** desktop has a positions rail (Open / Closed / History plus session totals), the chart and digit row in the centre, and the trading console on the right. Phones have market tabs on top and a bottom nav with a Positions sheet.
  - **Top bar:** Trader's Hub, Deposit, Withdraw, History (the ledger-backed transaction list), AI, How to Trade, the balance pill, notifications and the account menu. The menu includes Change password, using the existing API.
  - **Chart:** tools for line/area, drawing a horizontal line, PNG export, zoom, show-all and back-to-live, plus an outlined live price tag and a start dot.
  - **Result card:** P/L, stake, payout, result digit, duration and the contract.
  - **Auto:** STOP takes the first slot while Auto runs, and the header shows "Auto · <side>".
  - **Unchanged:** payout figures still come from the engine's 0.95 factor. Nothing in the engine or API changed.
- **Verification:**
  - New `apps/web/e2e/digits.e2e.mjs` passes 34/34 against the real local stack (API, engine and web), covering a real trade from open to settle.
  - The role e2e still passes 198/198.
  - Screenshots checked at 320, 390, 768, 1440 and 1920 px.

## #73 — Mega Pay "rejected the API key" for the live key; test mislabelled bad keys as valid; saving config would break deposits — FIXED (branch `fix/megapay-live-endpoint`, no migration)
- **Reported:** Test connection said "✕ Mega Pay rejected the API key" for the key that is collecting live payments.
- **Evidence:** read-only status queries against Mega Pay with a sentinel id, which never move money.
  - `/backend/v2` (our default host) answers every real key with "Invalid Api Key. Use Test Api Key: MGPY1EvRts3I". With the test key it answers "Invalid email. Use Test Email: megapaysandboxtest@gmail.com". It is a sandbox.
  - `/backend/v1` is the only host in Mega Pay's documentation. With the owner's key and account email it answers "Transaction request does not exist!", meaning the key and email were accepted. A wrong key gets "Api Key does not exist!" and a wrong email gets "Email does not exist!".
  - The email the owner typed (`cosiam22@…`) does not exist on Mega Pay. The account email is `cosialm22@…`.
  - Live deposits keep working (386 succeeded in 3 days) because they use the deployment's `MEGAPAY_API_BASE`, not the code default.
- **Root cause:**
  - The code, the gateway form and the probe all defaulted to `/backend/v2` for both environments. The form's Environment also defaulted to Sandbox.
  - The probe only looked for "invalid … key". On production it reported a wrong key or wrong email as valid.
- **Latent risk (worse than the report):** console-saved Mega Pay config layers over env. Saving the live key with the form's default host would have moved live deposits onto the sandbox, and every deposit would have failed. The same applied to per-platform and per-brand Payment accounts, which resolve without env.
- **Fix:**
  - The host now follows the environment: production uses `/backend/v1`, sandbox uses `/backend/v2`.
  - A production config carrying the old v2 default is corrected to v1. A genuinely different host is kept.
  - The deployment's `MEGAPAY_API_BASE` is still used verbatim, so live deposits are unchanged.
  - The probe reads Mega Pay's actual messages: wrong key, wrong email, "live key in Sandbox — set Environment to Production", or valid. It never echoes the key.
  - The form's host field is blank by default ("Automatic (follows Environment)").
- **Verification:**
  - `megapay.endpoint.test.ts` has 8 tests built on the recorded live responses.
  - The existing gateway and Mega Pay tests pass, and `npm test` passes 1177/1177.

## #72 — The same job lived on two or three pages; some links led to a 404; "Needs setup" miscounted brands (UI-F) — FIXED (branch `ui/f-focused-pages`, no migration)
- **What:** an audit of the console and back office found the same function on several pages, often with different rules.
  - Pool mode and today's budget could be set from the brand page and the Withdrawal pool page.
  - A gateway could be switched on from the Gateways list, the gateway page and the brand's Payments tab.
  - There were two audit trails: `/platform/audit` for the owner and `/platform/activity` for platform admins.
  - Marketer expenses could be logged from the user page and from Marketer payouts, and the two used different category lists (`tiktok_promo` against `promo`).
  - Brand admins could be appointed from the user page for the owner only, a path no one could reach.
  - Player overrides had an editable branch in the back office that could never render.
  - The back-office Overview repeated the Users, Balances and RTP panels from other pages.
- **Broken links found along the way:**
  - Old back-office URLs (`/admin/game`, `/admin/audit`, `/admin/logs`, `/admin/mpesa`, `/admin/fly`) sent brand admins to console pages, which returned a 404.
  - The users table nested a phone `<a>` inside the name `<Link>`, which is invalid HTML.
  - Platform-level audit rows (no brand) never showed to platform admins.
- **Wrong figure:** the console's "Needs setup" KPI counted a brand as not ready unless it had its own legacy M-Pesa fields. Since PAY-1, every brand gets paid through its own accounts, its platform's accounts or the System accounts, so live brands were flagged.
- **Fix: one home per job, with links everywhere else.**
  - Brand page tabs are now Identity, Branding, Economy, Add-ons, People and Legal. Pool, payments and audit are links to their own pages.
  - People covers brand admins (appoint and remove) and a read-only player list with overrides. Its "Manage in back office" button opens the brand session straight on that player.
  - There is one audit log, `/platform/audit`, scoped on the server. `listPlatformAudit` now includes platform-level rows that target the caller's platform. `/platform/activity` forwards to it.
  - The Gateways list only shows state. Switching a gateway on happens on the gateway page, where a per-brand switch appears only for brands that own that gateway add-on; brands without it link to their Add-ons tab.
  - The back-office Overview shows trends plus a "Needs attention" list of deep links. Game health moved to Reports → Health.
  - Users has quick-filter pills with counts, reads `?status=` and `?role=` from the URL, and drops the repeated columns.
  - The user page links to Marketer payouts (which reads `?marketer=`) for marketer money, and to the console for brand admins. Its overrides are read-only.
  - Old URLs go through `MovedToConsole`: operators land on the console page, brand admins on `/admin`.
  - Readiness now counts only a live domain.
- **Owner request #32, done in the same change:** the Brand back office picker now has you choose a platform, then a brand. It shows brand counts per platform, keeps the platform in `?platform=`, remembers it on the device, hides archived brands unless asked, says which other platform matches a search, and uses a select on phones.
- **Verification:**
  - Role e2e: 198/198 (+17 new UI-F and picker checks).
  - `npm test`: 1169/1169.
  - `platformaudit.pg.test.ts` has a new platform-level scope case and passes.
  - Screenshots taken on the real local stack.
- **Follow-up (caught during deploy verification):** the first merge did not deploy the API. The new pg test called `listPlatformAudit({ limit })` without `platformId: null`. `tsc -b` type-checks test files, so the deploy's verify step failed, while the per-app `--noEmit` check had passed. Fixed in the test. The pre-merge check is now the same `npx tsc -b packages/shared apps/engine apps/api` that CI runs.

## #71 — Add-ons: paid charts never reached players; catalog, requests and billing gaps (ADDON-1) — FIXED (branch `feat/addon1-marketplace`, migration 0166)
- **What (owner request, 2026-09-23: "a complete overhaul of the /addons page … a total joke"):**
  - **Players never saw paid charts (critical, found in the audit).** `/site/brand` coerced every `chart_style` except `candlestick` to `line`. A brand sold *Area graph* (KES 50,000 in production), *OHLC bars* (60,000) or *Baseline* got the free line chart.
  - The catalog had no descriptions, the pricing model could not be edited, add-ons could not be hidden, and there were no adoption numbers.
  - Approving or declining a request overwrote the brand's reason, and a request could not be withdrawn. A decline returned `"rejectd"`.
  - A price change before approval changed what the brand paid. Removing an add-on before it was invoiced still billed it.
  - Brands could not switch between systems they owned. Platform admins had no add-ons page.
- **Fix:** see docs/48.
  - Every chart system is served and rendered: TradingView opens on the brand's series type.
  - Migration 0166 adds the catalog editor RPC with rules, quoted-price billing, void-on-remove, cancel and activate, the brand matrix, and product-named notices.
  - New routes; a rebuilt `/platform/addons` (owner: Requests / Catalog / Brands; platform admin: marketplace + history); a marketplace component used on every tier.
- **Tests:**
  - `e2e_addon_marketplace.py`: BEFORE 4; AFTER 46. All 39 DB suites pass.
  - Unit tests: 1169/1169.
  - Role e2e: 181/181, including 21 new checks.
  - Real stack: the player page on an Area brand renders the area chart.

---

## #70 — Billing was a stub: no invoices, no way to pay, add-on prices never billed, dunning on dates alone (BILL-1) — FIXED (branch `feat/bill1-billing`, migration 0165)
- **What (owner request, 2026-09-23: "a really serious /billing page … what we have is a total basic and a joke"):**
  - There were no invoices. A "payment" was the owner pressing *Mark paid*, which extended the period with no record of what was paid for.
  - Platforms had no way to pay. Add-on prices were shown ("It is billed at KES X") but never charged.
  - The cron moved platforms to past_due / grace / suspended purely on dates, even when nothing had been invoiced.
  - The owner saw each platform's active/archived state, not its subscription standing. There were no revenue figures and no settings.
- **Fix:** see docs/47.
  - Migration 0165 adds consolidated per-platform invoices (plan + each brand's monthly add-ons + pending one-off/setup charges), numbered `PREFIX-YYYY-00001` and billed in advance.
  - Dunning now follows the oldest unpaid invoice (past_due → final notice → suspended), with a reminder at each stage. A paid-up platform returns to active and its brands come back online.
  - Payments: manual (bank / cash / M-Pesa / other, including part payments) and M-Pesa **Pay now**, an STK push from the System account. Every result is verified with STKPushQuery, success *and* failure, so a forged callback can neither pay nor cancel. A 2-minute sweep settles payments whose callback was lost.
  - Settlement is idempotent. Overpayments (rounding up to whole KES, or a double settle) and credits larger than an invoice carry forward as credits instead of being lost.
  - Add-ons get a pricing model (free / one-off / monthly + setup fee). One-off and setup fees are charged on grant, never twice. The System's own platform is exempt, and existing (grandfathered) entitlements are not charged.
  - Owner console: Overview (MRR/ARR, outstanding, overdue, aging, needs-attention, renewals, payments), Invoices, Subscriptions (manage: plan, charge/credit, status, exempt, history), Plans, Settings (seller, prefix, terms, tax, Pay now, overdue timeline).
  - Platform admin page: a due banner that states the consequence and date, plan, next-invoice estimate, usage, invoices with Pay, plan comparison.
  - Printable invoice page.
- **Found while testing on the real stack:** Pay now pre-filled the phone as `00700000003` when the profile stored `07…` (it only handled `254…`), so the Send button stayed disabled. It is now normalised from any stored form (`localPhone`, unit-tested).
- **Behaviour change (production):** the daily lifecycle job now issues invoices. NDUATI (Business, KES 40,000) gets its first invoice on its renewal date (2026-10-19), due 7 days later. MUCHENDU (the System's platform) is exempt.
- **Tests:**
  - `e2e_billing.py`: BEFORE reproduces 3; AFTER 112 checks.
  - `e2e_subscriptions_tickets.py` updated to the invoice-driven lifecycle (33/33).
  - Engine: 5 unit tests. API: 3 route tests and a real-schema pg test. The F-44 cross-tenant matrix now covers the billing routes against a seeded invoice. Web: 4 label tests. Unit total 1167/1167.
  - All 38 DB e2e suites pass.
  - Role e2e: 23 new checks; 163/163 pass.
  - Real stack: Pay now → the stub Daraja client → the reconcile sweep settled the invoice, and the platform went from grace_period to active.

---

## #69 — No per-brand pool view; dynamic distribution had no setting and was off unless a GitHub variable was set; history hid who got what (POOL-1) — FIXED (branch `feat/pool1-overview-auto`, migration 0164)
- **What (owner request, 2026-09-23):**
  - Nothing showed each brand's pool for today: budget, paid, reserved and available.
  - Automatic (dynamic) distribution only ran if the `POOL_DAILY_TOTAL_CENTS` repo variable was set, and then as one envelope across every platform.
  - Dynamic runs were stored as `per_site`, the same as hand edits, and the history never showed each brand's share.
  - Pool controls were duplicated on Controls & economy.
- **Fix:** see docs/46.
  - Migration 0164 adds the overview RPC, per-platform `pool_auto_settings` (dynamic when nothing is saved), and a `source` on each distribution.
  - `PoolOpsService`, the rewritten daily job, four API routes, and a rebuilt `/platform/pool`.
  - Controls & economy now links to the pool page.
- **Tests:**
  - `e2e_pool_overview.py` (BEFORE reproduces; AFTER 22 checks).
  - Engine 3, a real-schema pg test, and unit tests: 1155 pass.
  - Role e2e: 8 new checks, all failed before the fix; 139/139 pass after.

---

## #68 — No C2B configuration: Pay Bill details not editable, C2B URLs never registered with Safaricom (PAY-2) — FIXED (branch `feat/pay2-c2b-config`, migration 0163)
- **What (owner question, 2026-09-23):**
  - `/platform/mpesa` had only STK and B2C settings.
  - The Pay Bill players are told to pay into (`paybill_config`) was seed-only: no API or UI could change it.
  - Nothing could set or register the C2B Confirmation and Validation URLs. Without that registration Safaricom never reports Pay Bill payments, so the manual Pay Bill rail can verify nothing. It works only if someone registers the URLs by hand outside the product.
  - The page also said "Save 3 changes" before anything had been touched: our own auto-filled endpoints counted as edits.
  - The warning said credential changes needed a restart, but they reload within a minute.
- **Fix:** see docs/45.
  - Migration 0163 adds owner-only read and update (validated and audited), Safaricom's URL rules, and a record of each registration.
  - Daraja C2B RegisterURL v2 is wired up.
  - The API has three routes.
  - The M-Pesa page is split into Deposits / Payouts / Pay Bill (C2B) / Credentials. The C2B tab shows status and health, what players see, the URLs, and a Register button.
  - Auto-filled endpoints now count as suggestions, not changes.
- **Tests:**
  - `e2e_c2b_config.py` (BEFORE reproduces; AFTER 18 checks).
  - Engine: 3 tests. API: 1 test.
  - Role e2e: 5 new checks. All 5 failed before the fix; 131/131 pass after.
  - `e2e_c2b_paybill`, `e2e_function_grants` and `e2e_postgrest_surface` still pass.

---

## #67 — Page-level P1s from the UI audit: clipped withdrawal actions, an announcement that couldn't be edited, fake trends, editable-looking read-only overrides, sideways scroll on phones (UI-C) — FIXED (branch `ui/c-page-p1-fixes`, migration 0162)
- **What:**
  - **Withdrawals.** At 1440px the Reject and Mark paid buttons sat past the right edge of the table (Reject measured at x=1505). On a phone, Approve was at x=1146 on a 390px screen.
  - **Announcements.** The "Announcement" template said "Edit the title and body before sending", but there was no text field, and `fn_broadcast_notification` could only send a template verbatim. A brand admin would have sent "We have an update to share with you…" to every player. The clear button's copy said "platform-wide" on a brand page.
  - **Overview.** Trend chips showed "▲100%" whenever the first half of the 30 days was zero, and rising withdrawals were coloured green.
  - **User page.** Player overrides rendered as eight editable inputs, and only a footnote said they were read-only. Nobody in the brand back office can write them.
  - **Phones.** /admin/marketer-finance was 456px wide on a 390px screen. The segmented tab control overflowed.
  - **Brand page.** Add-ons rendered under every tab, and the open tab was not in the URL.
- **Fix:**
  - **Withdrawals.** Actions are pinned to the right edge, and the phone view uses a card list. Four duplicate KPI tiles became one summary line. The kill switch is now a compact row.
  - **Announcements.** Migration 0162 adds `p_title`/`p_body` to `fn_broadcast_notification`. They are trimmed and bounded, blank means the template's own text, and the audit trail records that the text was edited. It is one function, not an overload, and deploy-order safe. The API validates the text, and the page gets Title and Message fields with a live preview.
  - **Overview.** A metric with nothing in the earlier half now shows "New", and each metric is coloured by what counts as good news for it.
  - **User page.** Overrides are shown read-only as values, with "Managed in the console".
  - **Tabs.** One underline `PageTabs` component, with the tab in the URL, replaces the segmented control and the old brand-page tabs. Add-ons now has its own tab.
- **Tests:**
  - `e2e_broadcast_custom_text.py` (BEFORE reproduces; AFTER 11 checks). `e2e_notification_scope`, `e2e_actor_scope_impersonation` and `e2e_function_grants` pass.
  - API test for the edited text and its validation. `charts.test.ts` (trendDelta).
  - Role e2e: 12 new checks. 9 failed before the fix; 126/126 pass after.

---

## #66 — "now ago", browser-dependent dates and numbers, "KES 1,607.5" in the operator consoles (UI-B) — FIXED (branch `ui/b-shared-formatting`)
- **What:**
  - `formatRelativeTime` returns "now" for anything under 5 s, and 13 call sites appended " ago", so tables read "now ago" (seen in System logs).
  - Dates were printed with `toLocaleString()` / `toLocaleDateString()` without a locale, so the same timestamp showed as "23 Sept 2026, 21:03" on one page and "9/23/2026, 9:03:05 PM" on another, depending on the browser.
  - Counts used the browser locale too.
  - Four console pages formatted money with a local helper that dropped the second decimal ("KES 1,607.5").
  - KPI values and money cells wrapped ("KES" on one line, the number on the next).
  - Disabled buttons kept their colour at 50% opacity, so a disabled green "Save" looked live, and `pointer-events-none` stopped any tooltip explaining why.
- **Fix:**
  - `formatAgo` ("just now", "5m ago"; the date after a week).
  - `formatDate` and `formatNumber` pinned to en-KE.
  - `formatKes` everywhere.
  - Money, badges and KPI values no longer wrap; table headers no longer wrap, and `Th`/`Td` gained a `numeric` prop that right-aligns numbers.
  - A neutral disabled style that keeps tooltips working.
  - One toolbar search control, 36px, the same height as the filters.
- **Tests:** `format.test.ts` (no "now ago"; the date shown after a week; en-KE dates and numbers). Role e2e and a screenshot review on seeded data.

---

## #65 — Console shell: collapse control drawn over page content; no Log out on phones; flat, unlabelled navigation (UI-A) — FIXED (branch `ui/a-console-shell`)
- **What (found by the docs/44 UI audit on seeded data):**
  - System owner console: the sidebar header row had no `min-w-0`, so the long subtitle "SYSTEM CONSOLE · ALL PLATFORMS" pushed the collapse chevron out of the 240px sidebar (measured at x=250–282). It sat on top of the first letter of every page title.
  - Every tier on a phone: the account block and Log out were `hidden md:flex`, so an operator could not sign out of a money console from a phone. The horizontal nav strip showed about 3 of 10–16 items, was not sticky, and could hide the current page.
  - Navigation was a flat list (16 items for the owner), with duplicate icons and near-duplicate labels.
- **Fix:** one shared `ConsoleShell` (see docs/44): a truncating workspace header, labelled groups with dividers, one current item, distinct icons, a footer with collapse (⌘/Ctrl+B) and the account with Log out, and a phone top bar plus drawer. Navigation is defined once in `components/console/nav.tsx`.
- **Tests:** role e2e with 16 new checks. Before the fix, 15 of them failed (collapse chevron at x=250 > sidebar 240; no labelled groups; no phone menu or Log out). After the fix all pass, and so do all 98 existing checks. `nav.test.ts` covers the navigation rules.

---

## #64 — Phone-only password reset + "Change number" on withdrawals = wallet theft for players (F-49) — FIXED (branch `fix/f49-payout-to-registered-phone`, migration 0161)
- **What:**
  - The player password reset is phone-only (no OTP) while `ALLOW_UNVERIFIED_PASSWORD_RESET` is on. **Confirmed live on 2026-09-23:** a reset for an unregistered number returns `{"reset":true}` instead of `RESET_DISABLED`.
  - Privileged accounts have been protected by security questions since #4. Players and marketers were not.
  - The withdraw form had **"Change number"**, and `fn_create_withdrawal` accepted any payout phone.
  - So anyone who knew a player's phone number could reset the password, sign in, and request a withdrawal to their own M-Pesa. Only a manual approval stood in the way, and approvers are not told the number differs.
- **Impact (production, read-only):** no evidence of abuse.
  - 74 real withdrawals ever. 2 were to a different number, 0 of those were paid, and none is pending now.
  - Every profile phone has at least 9 digits.
- **Fix (money-side, independent of how an attacker gets in):**
  - `fn_create_withdrawal` (0161) pays out **only to the account's registered number**, compared on the significant 9 digits so every format matches. Anything else is refused with `PAYOUT_PHONE_MISMATCH` (400) and nothing is held.
  - The in-memory double mirrors this.
  - The web form shows the registered number with "Withdrawals are paid to your registered number only" and no Change button.
  - Also tightened: the wallet debit in that function is now filtered by `site_id` as well as `user_id`.
- **Owner decision (2026-09-23): phone-only player reset stays ON until an SMS provider is integrated.**
  - The flag was briefly unset in production (probe returned `RESET_DISABLED`), then restored at the owner's request (probe returns `{"reset":true}` again). Admin-issued reset codes were considered and declined as extra support load.
  - Accepted residual risk: someone who knows a player's number can still sign in and gamble the balance away, but can no longer withdraw it (0161).
  - **Follow-up:** replace the phone-only reset with an SMS one-time code once a provider is chosen. Then unset `ALLOW_UNVERIFIED_PASSWORD_RESET` on `invest254-api`.
- **Tests:**
  - `e2e_payout_phone.py`: BEFORE reproduces any-number acceptance; AFTER, 7 checks cover refusal, nothing held, 3 formats accepted, short number refused and grants.
  - Engine test `F-49` (other number refused, formatted own number accepted).
  - `e2e_account_demo_mode.py` fixture made realistic: numeric phone, withdrawing to the registered number.

---

## #63 — PAY-1: platform admins can run their platform / brands on their OWN payment accounts, honoured by live payments (owner decision 2026-09-23) — DONE (branch `feat/pay1-payment-scopes`, migration 0160, docs/43)
- **Before:**
  - Every deposit, verification and payout used ONE System-wide account set: the `mpesa_config` singleton and the global Mega Pay / PayHero rows.
  - The per-brand M-Pesa fields on the brand page were editable by platform admins but **never read by payments**. The page itself said live routing used the platform-wide config, and was misleading.
  - Per-site `payment_provider_config` rows could exist, but nothing wrote or read them.
- **Design:** docs/43.
  - **Payment owner.** A brand's payment owner is its own scope if active, else its platform's scope if active, else the System.
  - **Drafts until go-live.** Non-global configs stay drafts until an explicit go-live. Go-live is audited and the System owner is notified.
  - **Money-safety invariants, enforced and tested:**
    - (1) No mixing across owners: scoped clients never use env, a stub or a parent scope's account, and an unset rail is refused rather than re-routed.
    - (2) Payouts follow the owner and are refused before approval when the owner cannot pay, so no withdrawal is stranded in processing.
    - (3) Verification and reconcile use the scope recorded on the transaction, so deposits in flight survive a switch.
    - (4) Platform admins cannot set sandbox mode, base URLs, callback URLs or CIDRs. Enforced in the database and the API; otherwise they could point verification at a fake provider.
    - (5) Go-live needs a ready deposit rail, plus a payout account or an explicit "deposits only".
    - (6) The System's manual Pay Bill is hidden and refused for brands on their own accounts.
- **Also:**
  - Platform admins may switch entitled gateways on or off for their own brands.
  - Affiliate B2C payouts follow the owner too.
  - Owner and client caches are invalidated by NOTIFY, with a TTL backstop.
- **Production at deploy:** behaviour-neutral. No scope is active, so every brand stays on the System accounts, and the legacy global RPCs ignore platform rows.
- **Tests:**
  - DB e2e 63/63.
  - Engine money-invariant suite 11/11.
  - Real-schema money path (pg).
  - API 5/5.
  - F-44 cross-tenant matrix and capability contract extended.
  - Browser role e2e 89/89.

---

## #62 — M-Pesa Till number, B2C shortcode and B2C CommandID could never take effect (PAY-0, found while designing PAY-1) — FIXED (branch `fix/pay0-mpesa-till-b2c-fields`)
- **What:** two independent drops.
  - (A) `resolveDarajaConfig` rebuilt the live Daraja config from `mpesa_config` **without** `transactionType`, `tillNumber`, `b2cShortcode` or `b2cCommandId`. A Till (Buy Goods) configuration would have gone out as a Paybill STK to the paybill shortcode, and B2C always paid from the STK shortcode with `BusinessPayment`.
  - (B) `PATCH /admin/mpesa-config` accepted only the older plain fields and silently discarded the four the M-Pesa page sends, so they could not even be saved. Migration 0150 and `HttpDarajaClient` supported all four; the tests built `HttpDarajaClient` directly, so neither gap was visible.
- **Impact (production, read-only):** none so far. `transaction_type = 'paybill'` and `b2c_shortcode`/`till_number` are empty, which matches the defaults. It would have broken the first Till brand or separate B2C shortcode.
- **Fix:**
  - Carried through: DB value first, then env (`MPESA_TRANSACTION_TYPE`, `MPESA_TILL_NUMBER`, `MPESA_B2C_SHORTCODE`, `MPESA_B2C_COMMAND_ID`), then the client defaults.
  - The PATCH accepts and validates them: rail `paybill|till`, CommandID enum, numbers 4–10 digits or empty.
  - The in-memory repository mirrors this.
- **Tests:**
  - `daraja.configfields.test.ts` drives the real factory and reads the Safaricom bodies: Till + PartyB, B2C PartyA + CommandID, env fallback and DB precedence, defaults unchanged. The first two fail on the old code.
  - `app.admin.mpesafields.pay0.test.ts`: saved and read back; 5 invalid values give 400.

---

## #61 — Paged lists silently skipped rows that shared a millisecond with the page boundary (PAGE-1) — FIXED (branch `fix/page1-keyset-precision`)
- **What:** every keyset-paginated list (audit log, system logs, admin transactions/withdrawals/deposits, user list, user activity, affiliate payouts, referrals, commissions, a player's ledger/positions/digits/transactions) built its cursor from the last row's time in **milliseconds** and asked the database for `(created_at, id) < (cursor_ms, id)`. Postgres timestamps carry **microseconds**, so every remaining row in the cursor row's millisecond compared as *newer* and was never shown on any page. Rows written in one transaction share `now()` exactly — e.g. a bulk action's audit rows, a settlement's ledger lines.
- **Evidence:** production `admin_actions` has 1,223 rows in 406 same-millisecond groups (the owner's Audit log could hide them at page boundaries). A real-schema test paging 7 same-transaction ledger rows 2 at a time returned **2 of 7** on the old code.
- **Fix:** each keyset now compares against the cursor row's EXACT timestamp, looked up by its id (`coalesce((select k.created_at from <table> k where k.id = $cursorId [and k.user_id = $owner]), $cursor_ms)`) — an index-friendly InitPlan; the ORDER BY and indexes are unchanged (EXPLAIN on production `system_logs`: PK lookup + the existing `(t, id)` index scan). User-scoped lists resolve the cursor only within the caller's own rows. The activity union resolves across its three sources with guarded casts.
- **Tests:** `keyset.page1.pg.test.ts` (real schema, one transaction = identical timestamps): ledger, positions, player transactions, user activity (21-row union, 3/page), audit, system logs and admin transactions each return every row exactly once; fails on the old code.

---

## #60 — Platform admins could not see or manage a player properly: no detail, bonus adjustments impossible, overrides API with no UI (and no validation), no audit across their brands (docs/42 UI-10) — FIXED (branch `fix/ui10-platform-admin-gaps`)
- **What:**
  - A platform admin's player panel showed only the list row.
  - "Adjust balance" never sent a wallet, so every credit or debit hit **real cash**. The API supported `kind: real|bonus`; bonus could not be adjusted, and a goodwill bonus became withdrawable money.
  - `PATCH /platform/sites/:id/users/:uid/overrides` existed with no read route and no UI. It forwarded the raw body, so a typo reached the database and came back as a 500.
  - No page showed the audit trail across a platform's brands; each brand's Audit tab had to be opened one at a time.
- **Fix (API):**
  - `GET /platform/sites/:id/users/:uid/overrides` (platform-scoped).
  - The PATCH now uses the back office's `parseOverridePatch` (400 `VALIDATION`). The database's fairness fence (0135) still refuses any override better for the player than the brand.
  - `GET /platform/audit-log[?platform=][&site=]`: a platform admin is pinned to its own platform; `?site=` must be in scope (403 otherwise). Rows carry the brand name and actor username.
- **Fix (web):**
  - The Players panel shows a summary: real/bonus balance, deposits and withdrawals, net, turnover and bets, GGR, last active, joined/referred.
  - `BalanceAdjust` has an explicit Wallet (real cash vs bonus) and a review step that states "credit KES X to @user's bonus (non-withdrawable) balance — before → after", blocking any overdraw.
  - `PlayerOverridesForm` shows the brand's limits up front and blocks invalid or player-favouring values before saving.
  - New **Brand audit** page (`/platform/activity`), in the nav for platform admins only (the owner keeps the global Audit log), with a brand filter and Load more.
- **Found alongside, fixed separately:** PAGE-1. Keyset pagination compares a millisecond cursor with microsecond timestamps, so rows sharing the cursor's millisecond are skipped. Production `admin_actions` has 1,223 rows in 406 same-millisecond groups. The new audit query already uses the millisecond-consistent form.
- **Tests:**
  - `app.platform.players.ui10.test.ts`: override read and scope, 6 invalid patches return 400, valid saved, audit pinning and site scope, refused requests never query.
  - `platformaudit.pg.test.ts` (real schema): own brands only, brand and actor names, site filter, paging across a shared timestamp.
  - Browser role e2e 78/78 (+10 UI-10 checks: detail, bonus wallet sent, before→after confirm, override fence, audit page, nav).

---

## #59 — The System console hid who runs each platform, and several owner tools silently acted on the wrong platform (docs/42 UI-9) — FIXED (branch `fix/ui9-owner-console-gaps`)
- **What (six gaps):**
  - **Platform admins by raw uuid.** The owner saw only a COUNT of platform admins and appointed/revoked by pasting a user id. Refusals from the governance RPCs (`NO_SELF_ACTION`, `PLATFORM_NOT_FOUND`, `USER_NOT_FOUND`, `SUPERADMIN_PROTECTED`, `DEFAULT_MARKETER_LOCKED`, `INVALID_ROLE`, `NOT_A_PLATFORM_ADMIN`) were unmapped, so they surfaced as HTTP 500.
  - **Tickets.** The owner's "New ticket" sent no platform, so the API refused it with 400 `INVALID_PLATFORM`, while the dialog said "Assigned to your platform admin". "Escalate to System" was offered to the System admin itself; it would only reassign the ticket to the owner.
  - **Withdrawal pool.** For the owner, `/platform/pool` distributed across every brand of every platform while its copy said "your brands".
  - **Registrar.** The registrar page always edited the default platform. A registrar the owner saved for the default platform was never used: provisioning for the default platform was hard-wired to the env Namecheap account.
  - **Onboarding and domain import.** The onboarding capability banner and the registrar domain import took no platform. Bulk-imported brands were created without the owner's chosen platform.
  - **Add-ons.** The add-on grant/revoke API existed but had no UI. A brand page only ever offered "Request", even to the System admin.
- **Fix (API):**
  - `GET /platform/platform-admins[?platform=]` (who, platform, home brand) and `GET /platform/users/search?q=` (cross-brand username/phone search, 2–64 characters, at most 25 rows, `LIKE` wildcards escaped, default-marketer flag). Both are System-owner only.
  - Governance and pool codes are now mapped to 4xx.
  - `actingPlatform()`: a platform admin is always pinned to its own platform; the owner may name one with `?platform=<uuid>` (a bad value returns 400). It is used by onboarding capabilities, the registrar domain import, `/platform/sites`, and the pool routes (distribute, dynamic, demand, history).
  - Provisioner resolution is extracted to `provisionerfor.ts`. Each platform uses its own stored registrar. The default platform uses its stored registrar, falling back to env; any other platform with none gets no registrar and never borrows the owner's.
  - Production has no stored registrar config, so this is behaviour-neutral live.
- **Fix (web):**
  - `PlatformAdminsPanel` lists current admins (revoke with an explicit "make them" role). Appoint works from search results; ineligible people are shown disabled with the reason, and every action is confirmed.
  - `TicketsView` is role-aware: the owner picks the platform and gets matching routing copy, never sees "Escalate to System", and sees a Platform column. A platform admin is told its ticket goes straight to the System admin.
  - `OwnerPlatformPicker` appears only for the owner, on the registrar, onboarding and pool pages. One choice at the top drives the capabilities banner, the domain import (listing and `platformId` on every onboard) and the manual form.
  - `BrandAddons` gives the owner Assign/Remove with an inline effect statement (active for every player now, the price, and that gateway payments stop).
- **Tests:**
  - `app.platform.admins.ui9.test.ts` (list, filter, search, gating, 4xx mapping).
  - `platformadmins.pg.test.ts` (real schema: literal `_`/`%`, default-marketer flag, platform resolution).
  - `app.platform.registrar.ui9.test.ts` and `app.platform.pool.ui9.test.ts` (the owner's `?platform=` honoured and a platform admin pinned).
  - `provisionerfor.test.ts` (4).
  - `e2e_subscriptions_tickets.py`: an owner ticket without a platform is refused; with one it goes to that platform's admin at level 0.
  - Browser role e2e 68/68 (+22 UI-9 checks).

---

## #58 — Operators could join the affiliate/referral programme and earn on players they manage (docs/42 UI-12) — FIXED (branch `fix/ui12-operators-never-affiliates`, migration 0159; owner decision 2026-09-23: hide for all operators)
- **What:** every operator tier could (API) enrol via `POST /affiliate/enroll`, read and share a referral code (`/me/referral`), request commission payouts, and — because the marketer routes used `requireRole("marketer")`, a MINIMUM rank — use every marketer earning route: a site admin could file a **cash-advance request** (`POST /affiliate/advances` → 200). In the DB, `fn_affiliate_enroll` enrolled admins / platform admins / the system admin, `fn_register_user` attributed sign-ups to an operator's code, the instant 5% perk paid any referrer whose role was `<> 'marketer'` (so every operator tier), and GGR accrual credited an affiliate row whatever its owner's role (e.g. a marketer later made admin). The web showed operators the "Apply" card on `/affiliate` (and treated `admin` as a marketer) and the "Invite & earn 5%" card on `/account`.
- **Also fixed (found in DRIFT-1):** enrolment replaced the player's existing referral code with a new affiliate code, silently breaking every link the player had already shared. Enrolment now keeps it. `fn_gen_referral_code` also avoids other users' affiliate codes.
- **Impact (production, read-only):** none realised — no operator affiliates, no operator-referred players, 0 affiliate commissions.
- **Fix (API):** `requireEarningRole()` (players + marketers only; fail-closed) on enrol, all `/me/referral*` routes and every marketer earning route (marketer routes are now EXACTLY marketer) → 403 `OPERATOR_NOT_ELIGIBLE`. Admin queues/approvals unchanged.
- **Fix (DB, 0159):** production-equal bodies (0158 / 0117) with only the UI-12 changes: operator enrolment refused, attribution only to player/marketer referrers, 5% perk only to a `player`, accrual only to player/marketer affiliates.
- **Fix (web):** capabilities `earn.referrals` (player, marketer) and `earn.marketer_dashboard` (marketer); `/affiliate` shows a plain staff notice with a link back to the workspace; `/account` hides the invite card; no referral/affiliate request is made for an operator session (decided on the token role, so an opened brand counts as staff).
- **Tests:** `app.affiliate.operators.ui12.test.ts` (4 operator token shapes × 12 earning routes; players/marketers keep theirs; admin side intact); capability contract probes for both new capabilities (5 tiers); `capabilities.test.ts` (operators never hold `earn.*`); `e2e_operators_never_affiliates.py` 34/34 (every gap reproduced on 0158, closed on 0159, player/marketer flows intact, role-change auto-enrol intact, idempotent, grants); browser role e2e 46/46 (+18 UI-12 checks; 15 fail on the old pages). `e2e_referral_commission_providers.py` BEFORE-build hardened to exactly 0001..0116 (0159 redefines the payer).

---

## #57 — Production's schema had silently drifted from the migrations: an out-of-band script added player referral codes and rolled back affiliate brand hardening (DRIFT-1) — FIXED (branch `fix/drift1-prod-reconcile`, migration 0158, nightly + post-deploy drift gate)
- **What:** while preparing UI-12, the live definition of `fn_affiliate_enroll` did not match any migration. A full catalog comparison (production vs a database built from every migration) found 42 differences. A script applied outside the migrations had (a) ADDED a real feature — `profiles.referral_code` (unique), `fn_gen_referral_code()`, a newer `fn_register_user` / `fn_affiliate_enroll` / `fn_marketer_create` / `fn_marketer_credit` and rebuilt `v_real_profiles` / `v_demo_profiles` — but was written against OLD bodies, so it also (b) ROLLED BACK brand hardening: `fn_affiliate_request_payout` no longer stamped the payout's brand (F-44's per-brand approval checks could not resolve it), accrual credited GGR across brands, `uq_commission_bucket` lost `site_id` (so accrual's per-brand `ON CONFLICT` target no longer matched any index — accrual would have errored), and all 10 `sel_own` row policies lost `site_id = current_site()`. It also (c) left 12 pre-multi-brand overloads (e.g. `fn_create_deposit(uuid,bigint,text)`) plus `fn_marketer_topup_demo(uuid)` behind, and `fn_gen_referral_code()` executable by `anon`/`authenticated`.
- **Why nothing caught it:** the migrations ledger (0091) proves WHICH files ran and that they were not edited — not what the schema IS. Every ledger check stayed green.
- **Impact (production evidence, read-only):** latent. 0 affiliate payouts, 0 commissions, no referred players, so no money moved under the clobbered definitions. The brand-less `sel_own` policies and stale overloads are only reachable with a Supabase `authenticated` JWT; Supabase Auth self-signup was open (unused by the app, 0 users) — disabled as part of this fix.
- **Fix (0158):** converge deliberately, object by object — ADOPT the production feature verbatim (definitions fetched from production and kept as fixtures), with the generator and profile views now `service_role`-only; RESTORE the repo's brand-hardened accrual / payout-request, the per-brand commission index (temp-name swap) and the 10 brand-fenced `sel_own` policies; DROP the production-only stale overloads and the two unused 2-argument marketer overloads. Idempotent.
- **Prevention:** `scripts/schema_drift.mts` builds a reference DB (shim + every migration) and diffs production on function bodies, anon/authenticated EXECUTE grants, policies, indexes, views (+ options), columns and table write-grants; `KNOWN_DIFFERENCES` holds the two justified platform helpers. `.github/workflows/schema-drift.yml` runs it nightly, after every successful Deploy (Fly), and on demand (Postgres 17 + pgvector service).
- **Tests:** `packages/db/_testkit/e2e_drift_reconcile.py` 19/19 — a faithful production replica (0001..0157 + production's exact drift) and a fresh build converge to an IDENTICAL catalog; referral codes attribute, enrolment unifies the code, payout requests carry their brand, accrual's conflict target matches, stale overloads are gone, generator/views are not callable by anon/authenticated, re-apply is clean. `scripts/schema_drift.test.mts` 3/3. All 31 DB e2e suites and `npm test` (1099 pass) green. Pre-deploy the live gate reported exactly the 42 differences 0158 resolves.
- **Verified live (2026-09-23):** deploy `fad5c59` applied 0158 (ledger row present; 10/10 `sel_own` fenced, per-brand `uq_commission_bucket`, stale overloads gone, generator not executable by anon); the drift gate against production reported **0 differences**. Supabase Auth self-signup disabled (`disable_signup=true`; a probe signup returns 422 `signup_disabled`; `auth.users` = 0).
- **Follow-up (UI-12):** production's `fn_affiliate_enroll` overwrites the player's profile code with a new affiliate code, invalidating links the player already shared. Adopted as-is here (behaviour-neutral reconcile); fixed in UI-12.

---

## #56 — The owner's unscoped back office wrote brand #1 while labelled "every brand" (docs/42 UI-2) — FIXED (branch `fix/ui2-owner-brand-picker`; owner decision 2026-09-23: brand picker)
- **What:** the system owner's own session opened `/admin` with no brand: lists mixed every brand, while settings writes — the pool-mode switch labelled "Default for every brand", game config, daily withdrawal budget, withdrawal kill switch, config review — fell back to `DEFAULT_SITE_ID` and changed brand #1 only. No brand was named anywhere.
- **Fix (API):** owner-tier brand-config routes (`/admin/game-config`, `/admin/withdrawal-pool`, `/admin/withdrawals-enabled`, `/admin/config-review`) require an explicit, well-formed `?site=` from the system owner (400 `SITE_REQUIRED`); site admins stay pinned to their token's brand. The silent fallback is gone at the source, for every client.
- **Fix (web):** the owner's own session at `/admin` shows a **brand picker** (search + "Open brand as admin"); brand work happens inside an opened brand (UI-3 `act` session). Owner-only per-brand settings moved to the console brand page (**Pool & payouts** tab: pool mode, daily budget, kill switch — each call names the brand). Owner governance moved into the console: Audit log, System logs, M-Pesa (global), Engine (Fly.io); old `/admin/*` URLs forward there (owner) or reveal nothing (others). Console link now reads "Open a brand →". Shared `OpenBrandButton`.
- **Tests:** `app.admin.ownersite.ui2.test.ts` (7 owner routes × bare/malformed/named; site admin pinned), J5 updated to name the brand + assert `SITE_REQUIRED`; browser role e2e 28/28 (owner picker, no brand-less back-office request, console governance nav, forwarding, platform admin 404s). npm test green; web build OK.

---

## #55 — The removed `superadmin` tier lingered in code and copy (docs/42 UI-11) — FIXED (branch `fix/ui11-superadmin-remnants`)
- **What:** role literal `'superadmin'` still sent to the API as an announcement audience role and present in the `MeDto` role union, the payments "privileged" list, the engine in-memory default-marketer gate and harness role lists; ~20 comments described a "superadmin" impersonation session or "platform_superadmin-only" gating that no longer exists (misleading for the next change).
- **Fix:** literals removed (announcement "Admins only" = brand admins + system owner); comments rewritten to the current model (brand `admin` sessions with an `act` claim; capability gating per docs/42). The DB's inert `fn_*` allow-lists are left as documented in docs/41 (no behaviour).
- **Guard:** `legacyroles.guard.test.ts` fails CI if a `'superadmin'` role literal reappears in executable source of any app/package (mutation-checked). npm test 1097/1097 (+2 DB-gated); web build OK.

---

## #54 — Operators were never shown WHICH brand or platform they were acting on (docs/42 UI-8) — FIXED (branch `fix/ui8-scope-chips`)
- **What:** the back office header read "TrioCodes Admin" for every brand, and a platform admin's console never named its platform — a mode error waiting to happen for operators who switch brands (NN/g: modes need clear, redundant indicators). In a second impersonation tab the badge read "Accessing " (empty slug).
- **Fix:** `/auth/me` returns `scope` — the brand/platform the SESSION's token is scoped to, with names (one targeted lookup, never a brand list; impersonated sessions report the opened brand). The back office header now reads "<Brand> Admin" with the session kind (Brand admin / Opened from the console · as admin / Owner · all brands) and the footer badge names the brand; the console shows "Platform · <name>" (or "System console · all platforms").
- **Tests:** `app.auth.scope.ui8.test.ts` (brand session names its brand, platform admin its platform, owner neither); browser role e2e +2 checks (25/25). npm test green; web build OK.

---

## #53 — A platform admin's Overview showed zeros and a fake "Live" badge (docs/42 UI-5) — FIXED (branch `fix/ui5-platform-dashboard-scoped`)
- **What:** the console Overview (default period "today") called `GET /platform/performance`, which was owner-only → every KPI tile and per-brand column rendered 0 for a platform admin. The live card/feed opened the engine's `?platform=1` socket, which refused every role but the owner; the client marked itself "connected" on socket open and ignored the refusal, so a pulsing **Live** badge showed 0 online forever.
- **Fix:** `/platform/performance` is open to platform admins, **scoped to their platform** (`adminScopePlatform`; owner → every brand; claimless platform admin → 403), via a `platform_id` filter in the performance query. The engine's console feed grants the owner every brand and a platform admin only its own platform's brands (online counts + deposits filtered per socket; scope re-resolved at most once a minute so newly onboarded brands appear; no platform claim → refused). The web marks the feed connected only when **granted**, and on refusal sets `denied`, stops reconnecting and hides the live widgets (docs/42 P6). `console.performance` / `console.live` opened to the platform tier in the shared capability list (contract test agrees).
- **Tests:** `app.platform.performance.ui5.test.ts` (owner all / platform A only its brands / platform B only its brand / claimless 403 / site admin 403); engine `multiengine.test.ts` UI-5 (owner snapshot all brands, platform admin only its brand, other platform's deposit never delivered, unauthorised roles refused); capability contract 6/6. npm test 1095/1095 (+2 DB-gated); web build OK.

---

## #52 — The UI decided visibility from the ACTOR's role and a per-tab flag; screens and API drifted apart (docs/42 UI-3, UI-7, UI-6 partial, UI-13) — FIXED (branch `fix/ui3-capabilities-effective-role`)
- **What:** (1) while impersonating, pages checked `/auth/me` (the operator's own tier) instead of the brand session's token role (`admin`): an impersonating owner saw owner governance/role options the API refused; an impersonating platform admin lost Edit details / Role / Delete / Default marketer that the API allows. (2) The impersonation flag lived in per-tab `sessionStorage` while the token is shared: opening `/admin` in a second tab made `SessionBootstrap` "heal" the token back to the operator's own (`POST /auth/refresh`), silently ending the brand session for every tab — and meanwhile showed the owner the full governance nav on an `admin` brand token. (3) Dead controls: "Save overrides" for site admins (owner-only API), `/admin/audit` and `/admin/logs` loading into 403s, platform-admin console calling owner-only `/platform/platforms`, owner-only brand settings (chart style, trade UI, site owner / default marketer) shown to platform admins. (4) The impersonate button promised a "platform admin"/"superadmin" session.
- **Fix:**
  - **One permission list** `packages/shared/src/capabilities.ts` (`can(role, cap)`), imported by the web via a browser-safe subpath; every nav entry, page gate and role-dependent control now uses it on the **token** role (`useEffectiveRole`/`useCan`, `RequireCapability`). The hand-written `SuperadminOnly` and all `user.role === …` gates in the back office are gone.
  - **Impersonation is in the token:** `POST /platform/sites/:id/impersonate` mints an RFC 8693-style `act` claim `{sub, role, brand}` (authorisation still reads only `role`/`site`). The web reads impersonation from the token in any tab, never re-mints an impersonation token, shows the brand banner from the token, and "Exit" works in any tab (stash, else `/auth/refresh` back to the operator's own session). Tokens minted before `act` still work via the tab stash.
  - Console: a brand session visiting `/platform` gets "You're in <brand> as admin — Exit brand" instead of a 404; owner-only brand settings are hidden from platform admins (shown read-only); onboarding fetches platforms only for the owner; button reads "Open brand as admin".
- **Tests:** `capabilities.contract.test.ts` — every capability × all 5 tiers against the real router (mutation-checked: two wrong entries are reported). `app.platform.impersonate.test.ts` +2 (act claim present / absent). Unit: `capabilities.test.ts`, `token.test.ts`. **Browser e2e** `apps/web/e2e/roles.e2e.mjs` — production web build in headless Chromium, 6 sessions incl. second-tab and legacy impersonation, 23/23; the same suite against the previous build fails 10 checks (reproduces UI-3/UI-6/UI-7). Now a CI job (`web roles e2e`). npm test 1093/1093 (+2 DB-gated); web build OK.

---

## #51 — A link rejected a withdrawal on page load (docs/42 UI-4) — FIXED (branch `fix/ui4-links-never-act`)
- **What:** `/admin/withdrawals?highlight=<tx>&do=reject` executed the rejection as soon as the page loaded (the push notification's Reject action builds that URL). Any link an admin opened — or a browser prefetch — could reject a withdrawal; the only barrier was knowing the tx id. It violated safe-method semantics (RFC 9110 §9.2.1: following a link must not request a state change).
- **Fix:** `lib/admin/deeplink.ts` parses the link into *selection + intent* only (validated tx id, known intents, `do` stripped from the address bar). The page highlights and scrolls to the row and shows a confirmation banner with the request's player, amount and phone (or its already-decided status); **the click** executes. Approve was already click-only (needs the owner password). Service-worker comment updated.
- **Tests:** `deeplink.test.ts` 2/2; npm test 1080/1080 (+2 DB-gated); web build OK.

---

## #50 — Affiliate payout approval sent real M-Pesa money without the owner password (docs/42 UI-1) — FIXED (branch `fix/ui1-affiliate-payout-password`)
- **What:** `POST /admin/affiliate/payouts/:id/approve` and bulk approve dispatch a real M-Pesa B2C (`affiliateservice.ts:82`) but, unlike withdrawals and commission payouts, never asked for the system owner approval password. A site-admin session alone (or a stolen one) could pay out affiliates; the UI offered a plain two-step confirm.
- **Evidence:** api `app.affiliate.ts:140,163` had no `requireApprovalPassword`; prod `affiliate_payouts` has 0 rows — latent, never exercised.
- **Fix:** both routes call `requireApprovalPassword` (bulk: once per batch, approve only; reject stays ungated because it only releases the reservation). The payouts panel uses the same `PasswordConfirmButton` as withdrawals; the field now reads "System owner password" (was "Superadmin password").
- **Tests:** `app.affiliate.payoutgate.ui1.test.ts` 3/3 (2 fail before the fix: missing/empty/wrong password → 403 `PASSWORD_REQUIRED` and the payout stays `requested`; bulk approve gated, bulk/single reject not). npm test 1078/1078 (+2 DB-gated); web build OK.

---

## #49 — Support conversations were not owner-bound; withdrawal alerts were scoped by a stale brand snapshot; unsubscribe was not owner-bound; `v_mfa_status` was stale (Issue 1 / F-48) — FIXED (branch `fix/issue1-f48-support-push-mfa`, migration 0157)
- **What (support, S1):** knowing a conversation id was enough to write to it. A stranger could post into anyone's conversation, get earlier turns replayed back through the assistant ("what did I ask before?"), and **re-point the escalation contact** so staff follow up with the attacker. A logged-in player could do the same to another player of the same brand (only the brand was checked).
- **What (support, S2 — shared device):** the widget kept the conversation id and full transcript in `localStorage` across logout/account switch, so the next person on the browser saw — and continued — the previous person's conversation.
- **What (push, P1):** withdrawal alerts (player phone, amount, Approve/Reject) went to subscriptions by the brand **stored at opt-in**: a subscription stored with a null brand (a claimless token, #43) received **every brand on every platform**; an admin moved to another brand kept the old brand's alerts; suspended/banned admins kept receiving them; a withdrawal with no known brand alerted every admin device.
- **What (push, P2):** `POST /admin/push/unsubscribe` deleted any endpoint for any admin — one admin could silence another's alerts.
- **What (MFA view, M1):** `v_mfa_status` listed `('admin','superadmin')` — the removed tier — and hid both platform tiers, whose 2FA is mandatory; it was granted to anon/authenticated (blocked only by `user_mfa` privileges).
- **Evidence (prod, read-only, 2026-09-23):** 4 support conversations (none owned, last 2026-08-15); 2 push subscriptions, both the owner's — **no exploitation**, the flaws were latent. Anon REST read of `v_mfa_status` → `permission denied for table user_mfa`. MFA: 1 of 3 site admins, the platform admin and the owner enrolled (the other two site admins are forced to enrol at their next sign-in).
- **Fix — support:** `POST /support/conversations` issues a 256-bit capability token once (`conversationToken`); only its SHA-256 is stored (`support_conversations.access_hash`, 4-arg `fn_support_start`, migration 0157). Every write needs the logged-in owner or the token (constant-time compare); without proof the answer is the same 404 as an unknown id; a different logged-in account is refused even with the token; brand mismatch still 403; legacy (hash-less) conversations accept only their owner. Operator DTOs never carry the hash. **Web:** the widget stores and sends the token, wipes a signed-in conversation (transcript, token, visitor id) the moment the person using the browser changes, and transparently replaces a conversation the server no longer accepts.
- **Fix — push:** one rule, `mayReceiveWithdrawalAlert(liveProfile, site, sitePlatform)`: active accounts only; owner → all; platform admin → its platform's brands; site admin → its brand; nobody else; unknown brand → owner only. The Postgres query mirrors it exactly (the DB e2e runs the SQL extracted verbatim from `push.ts`). Unsubscribe removes only the caller's own row (`removeForUser`); endpoint-wide removal is internal (410 pruning) only.
- **Fix — MFA view:** rebuilt for `admin`/`platform_admin`/`platform_superadmin` with site/platform/status columns, `security_invoker`, service_role only (proven unreadable by anon/authenticated even under Supabase default privileges).
- **Tests:** engine `push.test.ts` 12/12 (truth table, live-profile matrix, owner-bound removal); `app.push.e2e` 8/8 and `app.support.e2e` 15/15 — the new F-48 cases fail when the old logic is restored (mutation-checked); `support.pg.test.ts` + `onboardscope.pg.test.ts` against the real schema; `e2e_support_push_mfa.py` 26/26; web `format.test.ts` (identity reset + token decode). Full: npm test 1074/1074 (+2 DB-gated), DB e2e 30/30, web build OK, secret scan clean.
- **Compatibility:** migration first (3-arg `fn_support_start` kept for the old API; the 4-arg has no defaults so calls cannot collide). A browser still running the old widget gets a generic error on its next message until it reloads.

---

## #48 — Merges migrated production but never shipped the code: the Fly deploy jobs failed silently (deploy pipeline) — HARDENED (branch `ci/deploy-preflight-and-verify`); root cause: overdue Fly invoice (paid)
- **What:** every backend merge since 2026-09-23 06:25Z (F-43 → F-47, six runs) ran `verify` and `migrate` — migrations 0153–0156 are in production — but produced **no Fly release**: `invest254-api` stayed on v156 and `invest254-engine-pm` on v119 (2026-09-22 20:50Z). The API/engine code fixes for F-43, F-44, F-46 and F-47 were therefore not live.
- **Evidence:** until then each backend merge produced a release ~3 min later (19f0870 → v154, 415d3fd → v155, 49069df → v156). Nothing the image build uses changed after v156 (Dockerfile, fly configs, lockfile, tsconfigs identical), and the latest flyctl (0.4.106) predates the last two good deploys — so the failure is in the deploy job itself. The most likely cause is `FLY_API_TOKEN` being revoked/expired overnight (the secret held a Fly org token, and Fly credentials were reissued for this session). Actions logs are not reachable from the agent sandbox, so this is inferred, not read.
- **Why it was silent / harmful:** the deploy jobs ran AFTER `migrate`, so a bad token left production migrated but un-deployed, with no signal outside the Actions tab; flyctl was unpinned (`@master` → latest); nothing verified that the release that went live was the merged commit.
- **Fix (`.github/workflows/deploy.yml`):** new `fly-auth` preflight job (token must reach BOTH apps) runs BEFORE `migrate`, with an explicit error annotation and remediation; flyctl pinned (`FLYCTL_VERSION`); deploys are a `fail-fast: false` matrix; images labelled `git-<sha>`; after each deploy the workflow verifies the latest release carries this commit's label and the API health endpoint returns 200; production-repo-only guard (mirror skips). `HOSTING.md §2.6.1` documents the token (a dedicated long-lived org deploy token) and the rotate-then-re-run procedure. actionlint clean.
- **Root cause (owner-confirmed 2026-09-23):** an overdue Fly.io invoice blocked deploys; the org tokens are non-expiring and valid. Paid 2026-09-23 ~12:00Z. The deploy step now emits an explicit billing/builder hint on failure.
- **Owner action (still recommended at rotation time):** create a deploy token (`fly tokens create org -o personal -n github-deploy -x 8760h`) and update the `FLY_API_TOKEN` Actions secret, then re-run Deploy (Fly). Include this secret in every future Fly credential rotation.

---

## #47 — Platform admins saw every tenant's domains and could re-onboard (overwrite) another platform's brand (Issue 1 / F-47) — FIXED (branch `fix/issue1-f47-onboard-domain-scope`)
- **What:** slugs and domains are GLOBAL (one `sites` table, one system Cloudflare account) while a platform admin's authority is ONE platform, and the onboarding surface ignored that. (1) `GET /platform/domains/health` returned the Cloudflare Pages status of EVERY platform's brand domains — each other tenant's client list. (2) `GET /platform/onboard/domain-status?domain=` probed any domain on the system Cloudflare account. (3) `POST /platform/onboard` with an EXISTING slug upserted it — whatever platform owned it — overwriting that tenant's brand identity, domain and economy (house edge, stakes). (4) The domain check was case-sensitive (`UNIQUE(primary_domain)`), while host resolution is not, so `Brand.com` and `brand.com` could be claimed by two brands. A claimless platform-admin token also reached (1) because that route never resolved the caller's scope.
- **Evidence (prod, read-only, 2026-09-23):** no exploitation found — the only two platform-admin site edits were on its own platform; 13 brands, no case-variant/`www.`-variant duplicate domains, no brand without a platform.
- **Fix:** new `apps/api/src/onboardscope.ts` is the single place global identifiers meet platform scope: `refuseForeignReonboard` (`SLUG_TAKEN` 409 when the slug belongs to another platform), `refuseDomainClash` (`DOMAIN_TAKEN` 409, case-insensitive, `www.` normalised), `assertDomainInPlatform` (`DOMAIN_NOT_FOUND` 404 — no existence oracle for other tenants' domains), `platformDomainSet` (health filtered to own brands' apex + `www.`). Routes pass `adminScopePlatform(ctx)` (null = system owner, unrestricted; claimless platform admin → 403 `PLATFORM_CLAIM_MISSING`).
- **Tests:** `onboardscope.test.ts` 4/4 (DB-free); `onboardscope.pg.test.ts` against the fully migrated schema (rolled-back transaction; runs when `E2E_PG_DSN` is set); `app.platform.onboard.scope.f47.test.ts` 3/3 — all 3 fail on the pre-fix routes. npm test 1063/1063 (+1 DB-gated skip); `e2e_onboarding.py` green; secret scan clean.
- **Compatibility:** API-only, no migration. The owner's behaviour is unchanged; the console's Clients table only ever rendered the caller's own brands, so nothing visible is lost.

---

## #46 — The database scoped a site-tier actor by its PROFILE, the API by its TOKEN: impersonation hit the wrong brand, and site-admin RPCs had no brand fence (Issue 1 / F-46) — FIXED (branch `fix/issue1-f46-actor-scope`, migration 0156)
- **What (a) — impersonation mis-scope:** impersonating brand X mints `role='admin', site=X` for the operator's OWN user id. `fn_actor_target_sites()` (used by 22 functions) re-derived an `admin` actor's brand from its profile, so broadcasts, audience counts, category clears and tickets issued while impersonating X landed on the impersonator's HOME brand (for a platform admin, possibly a brand of another platform), and add-on requests for X were refused.
- **What (b) — no DB fence for site admins:** the user/money/brand RPCs (`adjust_balance`, `set_user_role`, `delete_user`, pool/withdrawal switches, `decide_advance`, `set_site_owner`, … 17 in all) only fenced the `platform_admin` branch. For `p_actor_role='admin'` the API was the single guard, which is exactly how the claimless-token escalation (#43) credited other brands' users in production. A demoted admin still holding an `admin` token was likewise unfenced.
- **Evidence (prod, read-only, 2026-09-23):** 6 owner impersonation actions (`actor_role='admin'`, profile `platform_superadmin`); 36 actions by an `admin`-role actor whose profile is now `player` — all BEFORE that demotion (last action Aug 13, demoted Aug 17), so no stale-token abuse occurred, but nothing in the DB would have stopped it. Production function bodies md5-identical to the repo before generation.
- **Fix — migration 0156:** PERMISSION is split from TARGETING, both checked against the actor's real profile. `fn_actor_scope_sites(actor, role)`: owner and platform admin unchanged; token role `admin`/`superadmin` → a genuine site admin's own brand, an impersonating platform admin's platform, an impersonating owner's all brands, anyone else (demoted/stale) NONE. `fn_actor_target_sites` (untargeted bulk) returns the own brand only for a GENUINE site admin, never an impersonator's home. `fn_actor_bulk_sites(actor, role, audience)` = named brands ∩ permission. `fn_assert_actor_site_scope` raises `SITE_SCOPE_FORBIDDEN` and is injected as the first statement of the 17 RPCs (bodies otherwise byte-identical; the e2e asserts the diff is exactly that one line). Add-ons use permission; audience/broadcast/category-clear use the bulk set (new 4-arg `fn_notification_clear_category(…, p_site)`); tickets accept an explicit brand only within permission, else the genuine admin's own brand, else `NOT_AUTHORIZED`. Grants: `service_role` only.
- **API/engine:** every site-tier bulk action now NAMES the token's brand (`scopedAudience`: `sites=[brand]` + the template's default audience); tickets use `adminScopeSite(ctx)`; add-ons refuse a site other than the token's (`SITE_SCOPE_FORBIDDEN`); the engine's `resolveCategory` passes the brand to the 4-arg function.
- **Deploy-order safety:** under the API currently in production (which never names a brand) an impersonated bulk action reaches NOBODY instead of the wrong brand; genuine site admins, platform admins and the owner behave exactly as before. The legacy `superadmin` role (whose untargeted bulk now resolves to nobody) has not been minted since the Sep 22 deploy.
- **Tests:** `e2e_actor_scope_impersonation.py` 37/37 (reproduces both defects on the pre-0156 schema, then proves fence, targeting, bulk, category clear, tickets, add-ons and the one-line RPC diff); `app.impersonation.scope.f46.test.ts` 6/6 (5 fail before the API change); fixtures corrected where an "admin" actor was not a genuine admin (`e2e_default_marketer_lock`, `e2e_platform_isolation` + a cross-brand DB-fence check). Full DB e2e 29/29; npm test 1056/1056; secret scan clean.

---

## #45 — Audit rows filed under the DEFAULT brand whatever they touched (cross-platform leak via the per-brand audit view) (Issue 1 / F-45) — FIXED (branch `fix/issue1-f45-audit-attribution`, migration 0155)
- **What:** `admin_actions.site_id` was `NOT NULL DEFAULT <default brand>`, and 26 of 50 audit-writing functions plus the API's `recordAction()` never set it. Every such row was filed under the default brand.
- **Evidence (prod, read-only, 2026-09-23):** all 570 `user`-targeted rows on the default brand, 251 of them about users of other brands; 550 `site`-targeted rows (impersonations, pool top-ups, …) about other brands also on the default brand; platform-level actions (platform create/update, global provider/M-Pesa config, templates, add-on pricing) masquerading as the default brand's.
- **Impact:** `GET /platform/sites/:id/audit` (platform admin, `site_id = $brand`) showed the default brand's operators actions taken on OTHER platforms' users (cross-platform leak) and hid each brand's own actions from its platform admin.
- **Fix — migration 0155:** `site_id` nullable, no default (NULL = platform-level, excluded from every per-brand view; the system owner still sees all). `fn_admin_action_site(type, target, detail)` derives the brand of the TOUCHED entity (profiles/marketers, sites, `withdrawal_pool` `site:day`, transactions, advances, notifications; else `detail.site_id`/`detail.after.site_id`). A `BEFORE INSERT` trigger makes that derived brand authoritative (it also overrides a wrong explicit value); with nothing derivable, a GENUINE site admin's untargeted action goes to its own brand and anything else stays NULL — an impersonator's untargeted action is never mis-filed under its home brand. Backfill uses the same rule, keeps deliberately-set non-default sites, and keeps the legacy singleton `game_config` rows (the pre-multitenant era's only brand) on the default brand.
- **Prod dry-run before shipping (read-only):** 550 site + 251 user + 4 expense + 1 affiliate rows move to the brand they concern; 58 platform-level rows become NULL; transaction/pool/advance/per-brand game-config rows untouched.
- **Tests:** `e2e_audit_attribution.py` 22/22 — reproduces the leak pre-0155 (the default brand's audit view shows brand B's actions), then proves backfill, trigger, wrong-explicit override, impersonation → NULL, and the exact per-brand view using the same query as `listAudit`. Full DB e2e 28/28 (576); npm test 1050/1050.
- **Compatibility:** migration-only; safe with the currently deployed API (its `recordAction` inserts are attributed by the trigger; `listAudit` handles NULL).

---

## #44 — Operator routes addressed a target by id without checking its brand (Issue 1 / F-44) — FIXED (branch `fix/issue1-f44-admin-target-scope`, migration 0154)
- **What:** id-addressed operator routes resolved scope from the caller's token but never checked the TARGET's brand: `GET /admin/users/:id`, `/:id/activity`, `/:id/overrides`; `GET|POST /admin/users/:id/notifications` and `POST /admin/notifications/:id/resolve` (sequential ids; also reachable by a raw `platform_admin` of ANY platform); **all** of `GET|PATCH /admin/marketers/:id`, `/credit`, `/withdraw`, `/fuliza`, `/airtime`, `/statement`, **`/pin`** (reset any tenant's marketer PIN → account takeover), `/status`, `/bulk`; `GET|POST /admin/affiliate/expenses` (and the RPC never checked the marketer's brand while the withdrawable total nets across brands → cross-tenant financial sabotage); `/admin/affiliate/accrue` (any brand, or all). `GET /admin/audit` and `GET /admin/mpesa-config` served cross-brand/global data to every site admin (the UI hid them; the API did not). The remaining moderation routes (withdrawals, affiliate/commission payouts, advances) used a guard that is tolerant of an unresolved target and passed it through to the money RPC.
- **Production forensics (2026-09-23, read-only):** 12 real-money `balance.adjust` actions by a brand-A site-admin account on users of two other brands (Sep 12–14; KES 3,200 total). The wallet route does check the target's brand, so this required a claimless token — i.e. the #43 refresh escalation was used in production (owner to review whether the operator was authorised). Separately, 4 marketer expenses the system owner logged for other brands' marketers were stamped on the owner's home brand (mis-attribution, not an attack) — corrected by 0154.
- **Fix:** new `apps/api/src/scope.ts` — ONE fail-closed tier rule (`assertSiteTarget` / `assertUserTarget`): system → any brand; platform admin → only brands of its platform; site admin → only its brand; an unresolvable target → 404, never passed through. Applied to every route above and to all 11 remaining moderation call sites (the tolerant guard is no longer used by any route; the in-memory payout mirror now resolves a payout's brand like Postgres does). Audit trail + global M-Pesa config → System-owner-only. Expenses are recorded on the MARKETER's brand; a site admin's accrual is confined to its brand. Migration **0154**: `fn_admin_add_marketer_expense` refuses a brand-bounded actor crossing brands (`MARKETER_SITE_MISMATCH`), normalises the global owner's expense onto the marketer's brand (deploy-order safe with the previous API), and re-stamps the 4 mis-attributed rows (amounts/withdrawable unchanged).
- **Regression guard (future-proof):** `app.scope.matrix.e2e.test.ts` reads EVERY id-addressed `/admin|/platform|/tickets|/addons|/support` route from the real router (`Router.listRoutes`, 72 routes) and attacks each as brand B's site admin AND as another platform's admin against real brand-A entities with VALID bodies (only 403/404 pass; 400 counts as a failure so validation can't mask a missing check), then proves brand A untouched (marketer balance/status/PIN, user status/wallet, notifications, advance). **144/144 refused on the fix; on the pre-fix source it reports 19 breaches** (incl. PIN reset 200, marketer credit/withdraw 200, foreign platform admin injecting notifications 201). A new route is attacked automatically. DB: `e2e_marketer_expense_scope.py` 13/13 (reproduces the prod defect pre-0154).
- **Contract change (intentional):** an UNKNOWN id in a bulk withdrawal approve now fails its row (was a silent no-op success); the UI never submits unknown ids and already reports failed rows.
- **Verification:** npm test 1050/1050; DB e2e 27/27 files (554 checks); `tsc -b` clean; secret-scan clean.

---

## #43 — Token scope loss: re-minted tokens dropped `site`/`platform`, and a claimless site `admin` was read as UNRESTRICTED (every brand, every platform) — FIXED (branch `fix/issue1-f43-token-scope-claims`)
- **What:** four token-mint paths omitted the holder's scope: `POST /auth/refresh` (`issueToken(userId, role)`), `POST /affiliate/enroll`, and both marketer-app logins (`/marketers/auth/login`, `/login-web`). Independently, `adminScopeSite()` returned `claims.site ?? null` for a site `admin`, and `null` means *unrestricted* — the #38 class, which had only been closed for `platform_admin`.
- **Exploit chain (reproduced end-to-end):** a brand-A account is promoted to `admin` → the web sees token-role ≠ live role and calls `/auth/refresh` automatically (`SessionBootstrap.tsx:35`, `useAuthActions.ts:64`) → the refreshed token has no `site` → every `/admin/*` list and every `assertTargetSiteInScope` write treats it as cross-brand → the new site admin reads and mutates users, balances, withdrawals and marketers of **every brand on every platform**. Any site admin could also call `/auth/refresh` directly. A claimless `platform_admin` was fail-closed by #38 (locked out instead of escalated); a partial fix for that case (`03c269c`) sat unmerged. Tokens live 7 days.
- **Fix (two independent halves):** (1) **root cause** — new single choke point `AuthService.issueSessionToken(userId)` re-reads the LIVE profile (`profiles.site_id`, `platform_id`) and stamps role + site + platform exactly as login does; refresh and enrolment use it; marketer-app tokens are stamped with the marketer's brand. (2) **defense-in-depth** — `adminScopeSite()` now **fails closed**: a site `admin` without a `site` claim gets `403 SITE_CLAIM_MISSING`; new `adminListSite()` replaces every raw `ctx.claims.site` read in admin lists/writes so the rule cannot be bypassed. The system owner's behaviour is unchanged.
- **Tests:** new `app.auth.scope.f43.e2e.test.ts` (7): decodes the REAL refreshed JWT and replays its claims — brand-A admin sees only brand A; claimless admin refused on 20 back-office surfaces + a write; platform_admin keeps its platform claim; enrolment and both marketer-app logins keep the brand; owner + scoped admin unaffected. **On the pre-fix source 5/7 fail for the exact reasons** (missing `site`; claimless admin → 200 everywhere). 136 legacy test tokens that encoded "claimless `admin` = all brands" were migrated: 134 to `admin`+`site` (the brand their fixtures live in) and 2 explicit "unrestricted operator" constants to `platform_superadmin`; 2 tests that acted cross-brand now assert the refusal and use the owning brand's admin. Full suite **1044/1044**, `tsc -b` + web build clean.
- **Residual (owner action):** tokens already minted claimless in the last 7 days: `admin` ones are now refused (sign in again); player/marketer ones fall back to the default brand until expiry. Rotating `SUPABASE_JWT_SECRET` (BUGLOG #41 action 2) ends all of them immediately.

---

## #42 — PostgREST TABLE/VIEW surface open to the public anon key: 36 tables without RLS + 14 owner-run views — FIXED in code (branch `security/postgrest-table-surface`, migration 0153); prod state to be confirmed
- **What:** #39/0151 closed the PostgREST **function** surface; the **table/view** surface was never audited. Supabase's default privileges grant `ALL` on every new public table/view/sequence to `anon` + `authenticated`, so RLS is the only gate. In the repo schema **36 of 70 public tables were never RLS-enabled** (incl. `sites`, `platforms`, `marketers`, `marketer_credentials` [PIN hashes], `marketer_wallets`, `commission_payouts`, `withdrawal_pool`, `site_game_config`, `platform_global_config`, `admin_actions`, `system_logs`, `tickets`) and **all 14 public views ran as owner** (no `security_invoker`), bypassing the RLS of the tables beneath them (`v_real_profiles` → every player's phone on every platform).
- **Evidence (reproducible, not inferred):** new `packages/db/_testkit/e2e_postgrest_surface.py` builds the DB under Supabase's real default-privilege posture, seeds two platforms, and attacks as `anon` and as a claimless `authenticated` (Supabase self-signup) JWT. On the pre-fix schema (`E2E_UPTO=0152`) it **fails 37 checks**: anon reads `admin_actions`, `marketer_credentials`, `marketer_wallets`, `platforms`, `sites`, `system_logs`, `tickets`, `withdrawal_pool`, `platform_global_config`, … and succeeds at crediting marketer wallets, flipping the platform withdrawal kill-switch, inflating the pool, forging and **erasing** the audit trail, `TRUNCATE system_logs` (TRUNCATE ignores RLS), re-parenting brands, minting platforms and resetting marketer PINs. Independent static replay of all 153 migrations flags exactly the same 36 tables / 14 views (0 false positives/negatives).
- **Doc correction:** docs/40 §0 stated "`sites`/`platforms`/`marketers` — RLS enabled, 0 policies" from a live read. **No migration enables RLS on those tables**, so either prod drifted out-of-band or that line was wrong (docs/40 also reported "70 RLS tables" — 70 is the *total* table count in the repo schema, of which 34 have RLS). The live state is unverified from this sandbox (egress-blocked); 0153 is idempotent, so it converges whichever is true.
- **Fix — migration `0153_postgrest_table_surface_lockdown.sql`:** (0) **fail-closed guard**: aborts before any change unless the migrating role owns or BYPASSRLS every public table (so it can never lock the app out); (1) RLS on every public table (no policy = deny-all); (2) `security_invoker = true` on every view; (3) anon/authenticated lose INSERT/UPDATE/DELETE wherever no write policy exists for them (only `push_subscriptions` own-row keeps it), lose TRUNCATE/REFERENCES/TRIGGER everywhere, and lose all sequence access; (4) `sites`: no table-wide SELECT for public roles — `authenticated` keeps only `(id, platform_id)`, row-scoped by a **claims-only** policy mirroring `is_site_admin` (no recursion), so the platform branch of RLS keeps working without exposing brand config; (5) default privileges so future tables/sequences are not auto-writable. The `v_real_*`/`v_demo_*` views now **fail closed** for public roles (their marketer classifier is a DEFINER fn that 0151 made non-executable) — deliberately not re-granted, as that would create a cross-tenant "is this user a marketer?" oracle.
- **App impact: none.** API/engine never run as anon/authenticated (no `SET ROLE`, no JWT GUCs, no PostgREST, no supabase-js); they connect as the table owner. Verified: owner row counts identical in all 84 relations; owner writes + SECURITY DEFINER RPCs unaffected.
- **Regression guards:** (a) `e2e_postgrest_surface.py` 50/50 (fix) vs 37 failures (pre-fix); (b) new DB-free `packages/db/migrations.guard.test.ts` in `npm test`/CI fails any future migration that creates a public table without RLS, creates/replaces a view without `security_invoker` (a bare `CREATE OR REPLACE VIEW` silently **resets** the option — verified), or grants write privileges to anon/authenticated. Full DB e2e **26/26 files, 541 checks** green.

---

## #41 — PRODUCTION `DATABASE_URL` (+ API token-signing secret) committed to the PUBLIC repo — FIXED in code (branch `security/remove-committed-e2e-env`); ⚠️ credential ROTATION required (owner action)
- **What:** `.e2e.env` was committed on 2026-08-04 (`f1532eb`) and mirrored to the template. It holds the production Supabase `DATABASE_URL` **with password** and a `SUPABASE_JWT_SECRET` value (the variable the API uses to sign every auth token and withdrawal-action link).
- **Evidence (2026-09-23):** `invest254` is public by design (`mirror-sync.yml`: "Reads PUBLIC upstream with no secret"); an unauthenticated `GET https://raw.githubusercontent.com/petermuchendu1000/invest254/main/.e2e.env` returned **HTTP 200**. The committed `DATABASE_URL` is byte-identical to the live production connection string. The committed JWT secret does **not** verify the Supabase project anon/service_role keys (offline HMAC check), so it is not the PostgREST key; whether it equals the API's production signing secret cannot be checked from the repo — treat it as compromised. Full-history secret sweep of both repos: every other hit is a test/dev placeholder.
- **Impact:** the most severe possible scope leak. A direct Postgres connection as the pooler `postgres` user bypasses **every** layer of the isolation model (RLS, API role/scope guards, in-definer platform checks) — read/write every platform's PII, balances, roles, withdrawals. If the JWT secret is the prod value, anyone can also mint a `platform_superadmin` token. Exposure window: ~7 weeks.
- **Code fix:** file removed from HEAD; `.gitignore` now ignores `*.env` / `.env.*` (only `*.example` tracked); new CI gate `scripts/secret_scan.mts` (+ 6 unit tests) fails the build on any tracked env file, a remote Postgres URL with a real password, or real-shaped GitHub/Supabase/Telegram/Cloudflare/Fly/Stripe/private-key/Supabase-JWT secrets — it never prints a value. Verified: gate FAILS on the pre-fix tree (`.e2e.env` flagged), PASSES after (760 files, 0 findings). Nothing in the code read `.e2e.env`.
- **Owner action (cannot be done from code):** (1) reset the Supabase DB password and update `DATABASE_URL` on both Fly apps + GitHub Actions secrets; (2) rotate `SUPABASE_JWT_SECRET` on both Fly apps (invalidates all sessions — intended); (3) review Supabase Postgres logs since 2026-08-04 for unknown clients; (4) decide whether the upstream should stay public. History still contains the old value — harmless once rotated; a history rewrite (force-push) is optional and was not done.

---

## #40 — Legacy `superadmin` tier removed; owner-tier config moved to the system console (Issue 1 / F1 + F2) — FIXED (branch `issue1-remove-superadmin`)
- **What:** the codebase carried a 6th, out-of-hierarchy role `superadmin` (per-brand "owner" tier) that duplicated the site tier in RLS while also holding owner-tier powers, and was minted at runtime as the system owner's site-fenced impersonation token. This muddied the authoritative 5-tier model (`platform_superadmin > platform_admin > admin > marketer > player`).
- **Evidence:** live DB had **0** `superadmin` holders (`select role,count(*) from profiles`), yet the role was wired into `profiles_role_check`, `is_site_admin`, `ROLE_RANK`, `PRIVILEGED_ROLES`, ~273 non-test refs, and the `/platform/sites/:id/impersonate` minting. `is_site_admin` also carried unreachable `finance_admin`/`support` branches (not in the role CHECK, never minted) — F2.
- **Resolution (Option B):** migration `0152_remove_superadmin_role.sql` fail-closed-guards on 0 holders, drops `superadmin` from `profiles_role_check`, and simplifies `is_site_admin` (removing the `superadmin` + dead `finance_admin`/`support` branches). Code: removed `superadmin` from `ROLE_RANK`/`requireSiteAdmin`/`PRIVILEGED_ROLES`/MFA roles/role-set validation and the in-memory admin mirror; **impersonation now always mints a day-to-day `admin`** (system owner and platform admin alike); owner-tier `/admin/*` levers (game/economy config, seed rotation, M-Pesa config, per-brand withdrawal pool, Fly ops, per-user overrides) are re-gated to `requireRole("platform_superadmin")` (System console), and the web owner-tier UI is System-owner-only. The ~29 other `fn_*` keep their harmless `superadmin` allow-list/protected-target literals as inert defense-in-depth (the CHECK now forbids the role); a follow-up (F1c) may sweep them.
- **Impact:** none for live users (0 `superadmin` accounts; owner-tier `/admin` routes were only reachable by the system owner in practice). Site admins do NOT gain owner-tier powers.
- **Tests:** migration applied on ephemeral PG; **DB e2e 25/25 files green**, **TS 1035/1035 green** (backend 960 + web 75), `tsc -b` + web `tsc` clean. New/updated assertions: `superadmin` is not privileged, not assignable via `/role`, owner-tier is System-only, impersonation mints `admin`, fences hold via the `admin` site claim.
- **Deferred (documented):** F1b — allow a `platform_admin` to manage its OWN brands' owner-tier economy (requires widening the economy RPCs with platform scope); F1c — sweep inert `superadmin` literals from the 29 `fn_*` bodies; F1d — brand selector on the System-console owner-tier pages.

---

## #38 — Cross-tenant leak: a platform_admin with NO platform claim was read as "unrestricted"; an unresolved target was deferred — FIXED (branch `fix/issue1-platform-scope-fail-closed`)
- **What:** A `platform_admin` reached brands in ANOTHER platform. Live audit: actor `51ecc888` (**@thegenius**, `platform_admin`, `platform_id = a8502771…` = **NDUATI**) ran `platform.impersonate` against sites in **MUCHENDU** (owned by **@zrinok**) on 2026-09-21 — **Tamu Traders** (`47e2ab1f…`) and **Invest254** (`00000000-…-001`). "One missing platform claim opens all thirteen brands" (12 MUCHENDU + 1 NDUATI).
- **Evidence:** read-only forensics on prod (`admin_actions`, `profiles`, `sites`, `platforms`) reconstructed the actor/target/platform mapping. New e2e `apps/api/src/app.platform.scope.failopen.e2e.test.ts` reproduces the mechanism against the app: a `platform_admin` token carrying **no** `platform` claim → `GET /platform/sites` returned **200 listing every platform's brands** (expected 403) and `POST /platform/sites/:id/impersonate` on a cross-platform brand returned **200 + a minted admin token**.
- **Root cause:** `apps/api/src/http.ts` `adminScopePlatform()` returned `ctx.claims.platform ?? null`; a **missing** claim → `null` → treated identically to the system owner (unrestricted). `scopeSiteParam` then early-returns and `listSites(null)` returns every platform. Independently, `assertTargetPlatformInScope()` **deferred** (returned) on an unresolved target platform ("defer to the RPC's own guard"). The claim is only minted at login when `profiles.platform_id` is set (`authservice.issueToken` 4th arg), so any `platform_admin` without a `platform_id` — or any path that drops the claim — silently escalates to system-wide.
- **Also caught (latent):** `PgPlatformRepository.platformOfSite()` returned the **string `"null"`** for a site whose `platform_id` IS NULL (`String(null)`), and would **throw on an empty `siteId`** (invalid-uuid cast) — both defeat a fail-closed target check.
- **Impact:** a single-platform admin (or any claimless token) could enumerate, edit, and impersonate-admin **every brand across all platforms** — cross-tenant full access. Blast-radius check on prod: **0** `platform_admin`s with null `platform_id`, **0** sites with null `platform_id` → the fail-closed fix locks out nobody legitimate.
- **Fix:** `adminScopePlatform()` now **throws `PLATFORM_CLAIM_MISSING` (403)** for a `platform_admin` with no platform claim (never `null`=unrestricted). `assertTargetPlatformInScope()` now **refuses an unresolved target** (403 `PLATFORM_SCOPE_FORBIDDEN`) for any bounded caller; only the system owner (null scope) is unrestricted. `platformOfSite()` hardened (empty→null; NULL `platform_id`→null).
- **Verification:** new failopen e2e (3 scenarios: claimless refused; unresolved target refused; legit `platform_admin` + system owner unaffected). `http.platform.test.ts` updated to the fail-closed contract + a claimless-admin unit test. **Full suite 1035/1035 green; `tsc -b` clean.**

## #39 — PostgREST exposes SECURITY DEFINER admin/financial `fn_*` to anon/authenticated; `fn_*` trust the caller-supplied `p_actor_role` — FIXED & DEPLOYED (migration 0151, applied to prod 2026-09-22)
- **Resolution status update (Issue 1 / F3):** migration `0151_revoke_public_function_execute.sql` is APPLIED in production (`schema_migrations`, applied_by `issue1-buglog39`, 2026-09-22). Live grant audit confirms **anon/authenticated can EXECUTE 0 of 152 SECURITY DEFINER functions** (spot-checked `fn_admin_adjust_balance`, `fn_admin_set_user_role`, `fn_platform_appoint_platform_admin`, `fn_admin_delete_user` → all denied). The earlier "pending prod approval" note was stale.
- **What:** Nearly every `fn_*` in schema `public` is `EXECUTE`-able by `anon`/`authenticated`/`PUBLIC`, and the exposed admin/financial functions authorize on the **`p_actor_role` argument** rather than the caller's real role.
- **Evidence (read-only prod):** 90+ public functions granted `EXECUTE` to anon/authenticated incl. `fn_admin_adjust_balance`, `fn_admin_adjust_balance_kind`, `fn_admin_clear_balance`, `fn_admin_delete_user`, `fn_admin_set_user_role`, `fn_admin_rotate_seed`, `fn_approve_withdrawal`, `fn_complete_withdrawal`, `fn_create_withdrawal`, `fn_reject_withdrawal`. Surface is **LIVE**: `POST /rest/v1/rpc/fn_first_name` with only the **public anon key** returned `200 "Test"`. `fn_admin_adjust_balance` (0135) is `security definer` and gates only on the **string** `p_actor_role` (line 24); passing `p_actor_role='superadmin'` also **skips** the platform-scope branch (which only runs for `'platform_admin'`). `fn_platform_*` and `fn_addon_*` are already correctly revoked (the fix pattern exists).
- **Root cause:** the default Supabase EXECUTE-to-anon/authenticated posture was never revoked for the `fn_*` family; functions authorize on a passed-in role instead of `profiles.role`.
- **Impact:** any holder of the public anon key (embedded in the frontend) can call admin/financial RPCs **directly via PostgREST, bypassing the API guard entirely** — adjust any balance, set any role, approve/complete withdrawals, delete users, across all brands. Highest-severity path. No anonymous actor ids in `admin_actions` to date.
- **Fix (PREPARED, not yet applied):** `packages/db/migrations/0151_revoke_public_function_execute.sql` — revoke `EXECUTE` from `anon, authenticated, PUBLIC` on every **`SECURITY DEFINER`** function in `public`; `GRANT EXECUTE … TO service_role`; `ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated, PUBLIC` (no future function auto-exposes). **Verified safe:** the web app uses no PostgREST/anon RPC (no `@supabase/supabase-js`, no `.rpc(`; all traffic via `fetch` to the API), and the API/engine connect as the `postgres` owner — neither is affected. Idempotent + reversible.
- **⚠️ Refined from the original report (caught by test):** the report prescribed *"REVOKE EXECUTE ON ALL FUNCTIONS"*. A blanket revoke **broke the anon/authenticated RLS read path** — RLS policies call `SECURITY INVOKER` helpers (`current_site`, `is_site_admin`, `current_platform`, `jwt_role`) evaluated with the querying role's privileges, so stripping their `EXECUTE` yields `permission denied for function current_site` (reproduced via `e2e_platform_isolation.py`). Corrected to revoke **`SECURITY DEFINER` only**: DEFINER functions run as OWNER (the actual escalation surface); INVOKER functions run as the caller and cannot escalate, so they stay callable and RLS keeps working. Empirically: 228 anon-exposed pre-fix → **0 SECURITY DEFINER** anon-exposed post-fix, with RLS intact.
- **Regression guard (prepared):** `packages/db/_testkit/e2e_function_grants.py` — fails the build if ANY `SECURITY DEFINER` public function is `EXECUTE`-able by anon/authenticated/PUBLIC, asserts the specific admin/financial RPCs are closed, AND asserts the RLS helpers stay executable (so the fix can't regress into breaking RLS).
- **Deferred (larger, tracked):** rewrite each `fn_*` taking `p_actor_role` to read the actor's real role from `profiles` and ignore the parameter, so a future grant mistake is not a compromise.
- **Status:** PENDING — production DB change; **do not apply without explicit approval**.

## #37 — DB e2e harness silently tested a 30-migration-STALE schema (+ 2 stale test fixtures) — FIXED (branch `issue1-platform-tier`)
- **Surfaced while building Issue 1** (platform tier). Ran the whole `packages/db/_testkit/e2e_*.py`
  suite to establish a regression baseline; 6 of 18 scripts crashed on setup.
- **Root cause A (systemic):** every `reset_and_migrate()` applied migrations with
  `glob("00*.sql")`. That pattern matches `0001`–`0099` but **NOT `0100`–`0130`** (they start with
  `01`). So for a long time the DB e2e suite has been building its test DB from a schema **missing
  the last 31 migrations** — every `v_real_*`/`v_demo_*` view (0101), `min_withdrawal_native` (0120),
  payment-provider config (0130), etc. Any test touching a ≥0100 object crashed; tests that didn't
  simply passed against a stale schema (false confidence). Fixed the glob to
  `"[0-9][0-9][0-9][0-9]_*.sql"` in all 9 affected scripts (2 others had already fixed it locally with
  a comment about this exact pitfall).
- **Root cause B (fixture drift):** with the full schema now applied, two more pre-existing staleness
  bugs surfaced:
  - `fn_open_position(...)` calls hard-coded `config_version = 1`, but migration 0089 added the
    composite FK `positions(site_id, config_version) → site_game_config_versions(site_id, version)`
    and the default site's config is now at **version 3** (only the current snapshot is retained).
    A brand-new deployment opening at v1 would hit the same FK. Test fix: seed the default site's
    historic v1 snapshot in setup (test-created sites already get a v1 snapshot via the config
    insert trigger). *Note for prod: a fresh single-tenant bootstrap should ensure a v1 snapshot
    exists — tracked separately; not triggered on the live DB because its snapshots pre-date 0085.*
  - `fn_admin_set_user_overrides` was called with `house_edge:0.05` / `win_rate:0.9`, both of which
    migration 0074's `OVERRIDE_FAVORS_PLAYER` guard correctly rejects (better-than-house). Test fix:
    use punitive/valid override values (`win_rate:0.1`), which is what the guard permits.
  - The RLS tests (`e2e_rls_sites`, `e2e_rls_admin_sites`) `set role authenticated` but the shim
    never `grant`s that role SELECT, so they errored on the grant before RLS was ever evaluated
    (they had not run to completion in a long time). Test fix: `grant select on all tables in schema
    public to anon, authenticated` in setup, mirroring Supabase's default-privilege posture so RLS
    is the operative gate (matches the design intent of migrations 0051/0056).
- **Impact:** the DB e2e safety net was effectively inert for 0100+ behaviour. No production impact
  (harness-only), but it masked regressions.
- **Resolution:** all fixes above; the full suite is now **18/18 green** (incl. the new
  `e2e_platform_isolation.py`, 32 scenarios). See docs/38.

## #36 — Daraja B2C payouts failed SILENTLY when initiator/credential unset → withdrawals stranded in `processing` — FIXED (branch `fix/daraja-b2c-fail-loud`)
- **Surfaced by log analysis (post-#34/#35):** the only recurring non-4xx warning was
  `[payments] Daraja credentials not configured … using StubDarajaClient`. That specific line is benign
  (a boot-time ENV fallback; the API immediately loads the real STK creds from `mpesa_config` — "mpesa_config
  loaded from database"). But investigating it exposed a real latent gap.
- **Root cause:** `missingDarajaCredentials` only validates the **STK-4** (consumerKey/secret/shortcode/passkey).
  Live `mpesa_config` has those set, so the API builds a real `HttpDarajaClient` — but `b2c_initiator`
  and `b2c_security_credential` were **EMPTY**. `HttpDarajaClient.b2cPayment` POSTed those empty fields
  straight to Safaricom, which rejects the payout with no usable ConversationID/result callback. Because
  `fn_approve_withdrawal` flips the row to `processing` **before** the API dispatches, a rejected B2C left
  the withdrawal **stuck in `processing` with `conversation_id = NULL`** — the exact stranded-withdrawal
  state the operator had to clear by hand, with nothing in the logs explaining why.
- **Fix (code — surfaces the misconfig; the credentials themselves are operator config):**
  - New `missingB2cCredentials(cfg)` (b2cInitiator, b2cSecurityCredential, b2cResultUrl, b2cTimeoutUrl) —
    B2C readiness is now checked **independently** of STK.
  - `HttpDarajaClient.b2cPayment` now **fails loudly** with `MPESA_B2C_NOT_CONFIGURED:<missing>` *before*
    any network call, instead of POSTing empty creds and getting a silent Safaricom rejection.
  - `makeDarajaClientFromConfig` logs a clear **warning at every build/reload** when STK is ready but B2C
    is not — so the gap shows up proactively in the System logs UI (thanks to #34), not only when a
    withdrawal is attempted.
  - API `DOMAIN_STATUS`: `MPESA_B2C_NOT_CONFIGURED → 503`, so an admin approve returns a clear message.
- **Operator action still required:** set **B2C Initiator Name** + **B2C Security Credential** (Safaricom
  Daraja) in Admin → M-Pesa. STK deposits are unaffected and already live.
- **Tests:** `daraja.b2c.test.ts` (3 — missing-creds detection independent of STK; b2cPayment fails loud
  with no network; STK-only config still yields a usable deposit client with B2C guarded). Suites green:
  engine 314 / API 333; typecheck clean. No migration, no web change.

---

## #35 — Engine starved the session pooler: one LISTEN connection per brand for a GLOBAL channel — FIXED (branch `fix/engine-config-listen-multiplex`)
- **Surfaced by #34:** with system logs now capturing the engine, `[config] listen-connect [site …]:
  timeout exceeded when trying to connect` was firing ~49×/30min across brands.
- **Root cause:** the engine opened a **dedicated session-pooler LISTEN connection per brand** for the
  per-site config store (`configFor` → `SiteGameConfigStore({ connect })`), each held forever
  (`idleTimeoutMillis: 0`). But `listenPool` `max = 4` and there were **10 active brands** (plus the
  sites-store + deposit-feed LISTENs), so the first few brands permanently occupied the pool and every
  other brand's `connect()` timed out at 10s — forever — leaving those brands on the 15s poll fallback
  and spamming errors. `site_game_config_changed` is a **GLOBAL** channel (payload = the changed
  site_id), so N connections all listening to the same channel was pure waste.
- **Fix:** a `SharedSiteConfigListener` — **ONE** session connection LISTENing on the global channel,
  fanning each notification out to the matching brand's `refresh()` by payload (refresh-all when a
  notification carries no payload). Per-brand stores are now **poll-only** (the 15s fallback stays as a
  safety net), so a dropped shared connection degrades to polling, not silence; the shared listener
  reconnects with backoff. Engine session-LISTEN usage drops from ~12 → 3 (shared-config + sites +
  deposit) regardless of brand count. Also raised `PG_LISTEN_POOL_MAX` default 4 → 6 for reconnect
  headroom. No migration, no per-request/hot-path change.
- **Tests:** `siteconfiglisten.test.ts` (5 unit — one connection for many brands, payload dispatch,
  refresh-all on no payload, unknown-brand no-op, a throwing handler doesn't break others, reconnect
  after error re-arms LISTEN, `stop()` halts reconnects). Suites green: engine 311 / API 333; typecheck
  clean. Verified post-deploy that the timeout errors stop.

---

## #34 — System logs were only half-wired: the WS engine + all direct console.* were never captured — FIXED (branch `fix/system-logs-wire-all`, migration 0129)
- **Report (follow-up to #33):** "map and wire the ENTIRE logs" — #33 only persisted API request/error
  lines; the rest of the system was still invisible.
- **Map (exhaustive, no assumptions):** grepped every `createLogger` and every `console.*` in the
  backend. Findings: (a) the **WS engine has NO structured logger** — its boot, **crash recovery**,
  **daily-seed rotation**, **pool top-ups**, **payments/Daraja/MegaPay**, and WS error reporting are all
  `console.*` → stdout only; (b) the **API had 22 `console.*`** (boot/pool via `makePgPools`) bypassing
  the sink; (c) all these are low-frequency events — no per-tick/per-message hot path — so safe to persist.
- **Fix (both processes, one shared module):** new `systemlog.ts` `makeSystemLogPersister(pool,{app})`
  provides (1) a `loggerSink` for the structured logger and (2) `captureConsole()` that monkey-patches
  `console.{log,info,warn,error,debug}` so EVERY direct console call is persisted too — fully guarded
  (fire-and-forget, re-entrancy-safe, never throws/blocks/recurses). The **API** uses it as its logger
  sink AND captures console (`app='api'`); the **engine** installs `captureConsole()` (`app='engine'`)
  right after its pool is created. Added migration 0129 (`app` column + index, backfilled `'api'`) so
  the UI can filter by process; the read path, `GET /admin/logs`, and the UI gained an `app` filter +
  per-row service badge. Default persist level raised to **`info`** (captures the full request stream +
  every event; `debug`/health excluded); retention prune unchanged.
- **Coverage now:** API requests + errors + money-path (reconcile) + boot console; engine boot + crash
  recovery + seed rotation + pool realtime + platform live-feed + payments (Daraja/MegaPay) + WS errors.
- **Tests:** `systemlog.test.ts` (4 unit: sink promotes columns + drops below-threshold; console capture
  maps level, tags app, serializes Errors, marks `via:console`, restores originals; null-pool no-op;
  idempotent install) + `e2e_system_logs.py` extended to 13 (adds `app` filter). Suites green: engine
  307 / API 333; backend + web typecheck clean; `next build` clean; migrations idempotent.

---

## #33 — System logging was implemented but had no UI (owner couldn't view logs) — FIXED (branch `fix/system-logs-ui`, migration 0128)
- **Report:** "I don't have a UI to see all system logs — it was implemented but the UI was never."
- **State found:** the shared structured logger + per-request logging (docs/36) were implemented, but
  emitted **stdout only** (Fly). There was no queryable store, no API and no UI — distinct from the
  business **Audit log** (`admin_actions`, which already has `/admin/audit`). So system/request/error
  logs could only be seen via `fly logs`.
- **Fix (end-to-end):**
  * **DB (migration 0128):** append-only `system_logs` table (promoted queryable columns + `fields`
    jsonb) with keyset + filter indexes, and `fn_prune_system_logs(keep_days)` for retention.
  * **API sink (`server.ts`):** a logger sink that keeps the stdout line AND persists lines at
    `>= LOG_PERSIST_LEVEL` (default `warn`) to `system_logs` — fire-and-forget, so logging can never
    block/fail a request. Wired as the app + reconcile-sweep logger (so money-path errors persist too),
    plus a periodic retention prune (`LOG_RETENTION_DAYS`, default 30).
  * **Read path:** `GET /admin/logs` — **platform_superadmin only** (system logs are cross-brand
    operational data) — via `AdminService.listSystemLogs` with filters (level, status, q on msg|path,
    requestId, since) + cursor pagination; in-memory harness returns an empty page.
  * **Web:** a **System logs** page (`/admin/logs`) under the owner Platform nav — level filter,
    debounced message/path search, level/status badges, request-id correlation, load-more.
- **Tests:** `e2e_system_logs.py` (11 DB scenarios: newest-first, level/status/requestId/since/text
  filters, keyset paging, retention prune) + `app.admin.test.ts` +1 (owner-only gate: admin/superadmin
  403, anon 401, platform_superadmin 200 page shape). Full suites green: engine 303 / API 333; backend
  + web typecheck clean; `next build` clean (`/admin/logs` builds); migration idempotent.
- **Scope note:** persists API logs (requests, errors, money-path, Mega Pay/Daraja reconcile) — the
  actionable set. Engine (WS) logs can be wired to the same sink as a follow-up. Default persist level
  is `warn` (errors + rejections); set `LOG_PERSIST_LEVEL=info` to capture the full request stream.

---

## #32 — Approved withdrawals stuck in "processing" forever; no way to mark a payout paid when the B2C callback fails — FIXED (branch `fix/admin-mark-withdrawal-paid`, migration 0127)
- **Report:** approved/paid withdrawals still show "processing"; the admin needs to mark a payment paid
  manually when the rail (e.g. Mega Pay) fails to reflect it, and that must show as paid on the client.
- **Root cause:** the withdrawal lifecycle debits the wallet at request (`fn_create_withdrawal`), flips to
  `processing` on approval (B2C dispatched), and only reaches `success` when the provider's async result
  callback arrives (`fn_complete_withdrawal`). When that callback never lands — a known Mega Pay / Daraja
  failure mode — the row is stranded in `processing`: the money already left the wallet, the player was
  paid out-of-band, but the client shows "processing" indefinitely and there was **no admin action** to
  finalise it (only approve/reject existed). 4 live rows were stuck (invest254 ×2, madolar ×2).
- **Fix:**
  * **DB (migration 0127):** `fn_admin_mark_withdrawal_paid(tx, admin, receipt)` transitions a
    pending/processing withdrawal → `success` with a manual receipt + an `admin_actions` audit row.
    **No wallet change** (money already debited at request). Idempotent on an already-paid row; **refuses**
    a failed/reversed row (`WITHDRAWAL_ALREADY_REVERSED`) so a returned payout is never double-paid.
  * **API:** `POST /admin/withdrawals/:id/mark-paid` — same guards as approve: `requireRole('admin')` +
    superadmin approval-password + `assertTargetSiteInScope` (brand-scoped). Threaded through
    PaymentService/PaymentRepository (pg + in-memory) → fires the same success event as the B2C path so
    the activity feed reflects it.
  * **Web:** a password-gated **"Mark paid"** action in the Withdrawals queue for `pending`/`processing`
    rows; the player's client then shows the withdrawal as paid (reads the same tx status).
- **Tests:** `e2e_admin_mark_withdrawal_paid.py` (17 DB scenarios: processing→paid with wallet unchanged,
  idempotent, pending→paid, reversed refused, unknown tx, audit row) + `app.approvalgate.e2e.test.ts` +4
  (password gate, processing→success + idempotent, brand-scope, reversed→409). Full suites green:
  engine 303 / API 332; backend + web typecheck clean; `next build` clean; migration idempotent.
- **Note:** the 4 currently-stuck rows are left for the operator to mark paid (or reject) per-row via the
  new control — only the operator knows whether each recipient was actually paid out-of-band.

---

## #31 — A soft-DELETED same-phone account shadowed a marketer's login; @jake locked out of the mpesa app — FIXED (branch `fix/marketer-login-deleted-shadow`)
- **Report:** @jake (marketer) still could not log into the mpesa app after the #30 PIN fix.
- **Investigation (live data, no guessing):** jake has 5 same-phone (`0113488568`) accounts across brands,
  oldest-first: **`@dave` player invest254 `status=deleted` (has password)**, `@jake` marketer safitraders
  active, `@boyz` tamutraders banned, `@jake` madolar player active, `@boyz` 33traders active. His marketer
  wallet is on safitraders (active). The app's non-PIN path is `login-web` (password) → `auth.login({anyBrand:true})`.
- **Root cause:** `AuthService.login` built the candidate list oldest-first, **broke on the FIRST password
  match, then rejected it if `deleted`**. Since jake reuses one password, the first match was his OLDEST
  account — the soft-deleted `@dave` — so login threw `INVALID_CREDENTIALS` and never reached his active
  safitraders marketer account. A soft-deleted account was **shadowing** a valid same-phone account in the
  cross-brand (marketer-app) path. (Not the default-marketer bug — verified independent code paths.)
- **Fix (`apps/engine/src/authservice.ts`):** SKIP `deleted` candidates during password matching, so a
  soft-deleted account can never shadow a valid same-phone account; keep the hard "deleted can't sign in"
  rule (a deleted-ONLY phone still 401s) and constant-time behaviour (a dummy verify when every candidate
  was skipped). Single-account (normal per-brand web) login is unchanged. Code-only (no migration); ships
  on the next Fly deploy.
- **Ripple checked:** callers of `auth.login` are the per-brand web login (single candidate — unchanged)
  and the marketer `login-web` (`anyBrand` — fixed). After the fix jake resolves via ANY non-deleted match
  (his safitraders marketer directly, or a player/banned account → `profileByPhone` any-brand fallback →
  safitraders wallet). Combined with #30 (PIN sig-9) and his now-present marketer PIN, BOTH app login paths
  work. If a marketer's password matches ONLY a deleted account, that is a password-reset case, not this bug.
- **Tests:** `app.marketers.webauth.test.ts` +2 — the deleted-shadow scenario now logs in (was 401), and a
  deleted-ONLY phone still 401s. Full suites green: shared 219 / engine 303 / API 328; typecheck clean.

---

## #30 — Marketer PIN login (mpesa_2 quick-login) failed on any non-07 phone format, on every brand — FIXED (branch `fix/marketer-login-phone-sig9`, migration 0126)
- **Report:** "some marketers cannot log into one or both apps" (mpesa_2 / truecaller).
- **Root cause:** `fn_marketer_login` (PIN path, `POST /marketers/auth/login`) matched `marketers.phone =
  v_phone` EXACTLY (btrim only) — the ONE marketer lookup never migrated to the canonical
  `fn_phone_sig9` (right-9-digits) rule that `profileByPhone`, `fn_marketer_game_withdraw`,
  `fn_is_marketer_account` (0086/0100) all use. The apps send the phone exactly as typed
  (mpesa_2 `PinLoginScreen` reuses `AppState.phone` captured at first sign-in), so a marketer who
  entered `+254…`/`254…`/bare `7…` could sign in with a PASSWORD (`login-web` → `profileByPhone`
  normalizes) but then FAILED the PIN quick-login on relaunch (exact match vs stored `07…`), on ANY
  brand. truecaller uses password-only, so it was unaffected — hence "one or both apps".
- **NOT the default-marketer bug:** marketer login resolves the `marketers` wallet + `marketer_credentials`
  PIN / website password — never `profiles.role` or `sites.owner_user_id`. Verified the two are
  independent code paths.
- **Fix (migration 0126, same 3-arg signature — CREATE OR REPLACE, no app/engine change, no deploy
  window):** match candidates AND the failed-attempt throttle on `fn_phone_sig9(phone)=fn_phone_sig9(input)`
  with a length-9 validity guard; PIN verify, per-account lockout, active-status and optional site scope
  unchanged. Fixes both apps for every marketer on every brand with no APK rebuild (server-side).
- **Also confirmed correct (no change needed):** the mpesa_2 "hardcode SITE=33traders on login" commit
  was rightly REVERTED (a single generic build must not name a brand); the apps send no site and the
  server resolves the brand from the credential (`login-web` via `auth.login anyBrand`; PIN via
  `fn_marketer_login` cross-brand). Those server fixes were already live (deployed 2026-09-12).
- **Tests:** `e2e_marketer_login_phone.py` — 14 scenarios (07/254/+254/bare/spaced all resolve;
  wrong-PIN + 5-miss lockout; cross-brand no leakage; site-hint scoping; malformed phone). Idempotent;
  backend typecheck clean. Read-only prod check: all 8 active marketers now match under 254-format entry.

---

## #29 — Default marketers on brands that lacked a default when deposits happened showed zero stats — FIXED (data backfill)
- **Report:** "the dashboard isn't populating accurate figures — e.g. the 66investors default marketer
  can't see his statistics."
- **Root cause:** `fn_pay_referral_commissions` roots the 25% at the brand's default marketer
  (`sites.owner_user_id`). Brands that had NO default marketer when deposits occurred (66investors,
  tamutraders never assigned; invest254 partially) accrued NO commission, so the (now-assigned) default
  marketer's dashboard read zero — a DATA gap, not a query bug (33traders/invest254/madolar/safitraders
  with defaults at deposit time were accurate).
- **Fix (data):** replayed the idempotent production accrual RPC over the 373 uncredited successful
  deposits. Result (all `accrued`, zero wallet-affecting rows — no depositor had a referrer so the 5%
  player perk never fired): joy +2,157,175¢ (invest254), mark_mumo +577,500¢ (66investors),
  Blessing.21 +50,000¢ (tamutraders). Every brand gap closed to ≤1¢ (float rounding). cpfmarket's 25%
  was already paid to its prior owner, so its new default legitimately starts at 0. Committed inside a
  transaction that asserted wallets untouched and gaps closed. Recurrence is prevented by the default
  now being set on every brand plus the 0104/0124/0125 default-marketer guards.

---

## #28 — Platform owner couldn't manage a brand's default marketer while impersonating it (Issue-1 control unreachable via impersonation) — FIXED (branch `fix/impersonation-default-marketer-scope`, migration 0125)
- **Report:** while impersonating **66investors**, `Make brand default` / `Remove as default` on a
  66investors marketer (`mark_mumo`) failed `SITE_SCOPE_FORBIDDEN` — a *same-brand* action that should
  succeed.
- **Root cause:** `fn_admin_set_site_owner` (0104/0124) was the ONLY RPC that fenced by the ACTOR's own
  `profiles.site_id`. Impersonation mints a token `role='superadmin', site=<brand>` but keeps the
  SUBJECT = the platform owner (for audit). So `p_actor` is the owner (home brand = the platform's own
  site), while the acted-on brand is the impersonated one. The RPC's actor-home check therefore raised
  `SITE_SCOPE_FORBIDDEN` on every make-/clear-default while impersonating any brand other than the
  owner's home — making the admin-panel default-marketer control (Issue 1) unreachable exactly the way
  the operator uses it. The API's own `ensureUserInScope` (token-scoped) had already allowed it; the
  redundant DB actor-home check contradicted the token.
- **Reproduced (read-only local PG, all migrations):** actor home=SITE_A, `fn_admin_set_site_owner(owner,
  'superadmin', <SITE_B marketer>, true)` → `SITE_SCOPE_FORBIDDEN`.
- **Fix (migration 0125, same 4-arg signature — CREATE OR REPLACE, no call-site/engine change, no
  deploy window):** skip the RPC's actor-home fence when the actor's PROFILE role is
  `platform_superadmin` (the platform owner is inherently cross-brand even via an impersonation
  superadmin token). The impersonation fence stays enforced at the API/token layer
  (`assertTargetSiteInScope` on the token's `site` claim). A REAL per-brand admin/superadmin remains
  home-fenced (defence in depth). The RPC still validates active-marketer-on-site for ASSIGN.
- **Tests:** `e2e_default_marketer_lock.py` extended to **35 scenarios** — owner impersonating SITE_B can
  make + clear a SITE_B default (was forbidden); a real SITE_A superadmin still cannot reach SITE_B; owner
  impersonating their home brand still works. Backend typecheck clean; API 326/326; migration idempotent.
  (The API in-memory harness mocks this RPC, so the DB e2e is the authoritative coverage.)

---

## #27 — Impersonation was invisible: the console showed "OWNER · FULL AUTHORITY" while fenced to one brand, and logout didn't clear the fence — FIXED (branch `fix/impersonation-clarity`)
- **Report:** as the platform owner (`@zrinok`), every write on a `mark_mumo` (brand **66investors**)
  page failed with `SITE_SCOPE_FORBIDDEN`, even after logout + hard refresh.
- **Root cause (NOT a security bug — a clarity/lifecycle bug):** `/platform/sites/:id/impersonate`
  deliberately mints a **brand-scoped `superadmin`** token (`site` = target brand) so the owner acts
  only within that client's brand. That enforcement is correct. But:
  1. **Invisible fence.** `AdminShell` derived its identity from the live `/auth/me` role
     (`platform_superadmin`), so it displayed "invest254 Console · Owner · full authority / ★ System
     owner" *even while impersonating another brand*. The owner couldn't tell the session was fenced,
     so a cross-brand write looked like a broken permission rather than the wrong brand.
  2. **Sticky after logout.** `logout()` cleared the session token but not the impersonation
     sessionStorage (`pp-impersonating-brand` / `pp-platform-return-token`), and `SessionBootstrap`
     deliberately suppresses the token drift-refresh while `isImpersonating()`. So the fence could
     survive a logout, and a stale brand scope leaked into the next view.
  3. **Dead-end nav.** The cross-brand "All brands" (platform) nav stayed visible while impersonating,
     but the brand-scoped token 403s against `/platform/*`.
- **Fix (`fix/impersonation-clarity`):**
  * Extracted the impersonation state machine into a **framework-free core** (`impersonate.core.ts`)
    with strict validation (fail-closed on a corrupt/tampered brand blob or malformed mint result) and
    a new `clearImpersonation()`; `impersonate.ts` is now a thin sessionStorage/session/window wrapper.
  * **Logout and forced-401 now clear the fence** (`useAuthActions.logout`, `SessionBootstrap`) — a
    brand scope can never outlive the session that created it.
  * **AdminShell reflects the fence:** while impersonating it shows "{Brand} Console · Impersonating ·
    superadmin" and a warn "◉ Impersonating {slug}" badge instead of "Owner · full authority / ★ System
    owner", and it hides the cross-brand "All brands" nav (return via the banner's "Exit to platform").
  * **Banner** made unmistakable: "Impersonating {Brand} as superadmin · {domain} · actions are fenced
    to this brand" with a warn-accented Exit.
- **Tests (tested + retested across different brands):**
  * `impersonate.core.test.ts` — 13 pure unit tests: parse/validation, begin/read/end round-trips,
    switching between brands A→B→C, independent round-trips per brand, clear/idempotency, and
    fail-closed on malformed input / null storage.
  * `app.platform.impersonate.test.ts` — 7 server tests proving the real ENFORCEMENT: the route is
    platform-only; it mints a superadmin token fenced to the TARGET brand for two distinct brands; an
    impersonation-shaped token (`site=B`) can write to B but NOT A, and swapped (`site=A`) can write to
    A but NOT B (SITE_SCOPE_FORBIDDEN), including the default-marketer routes; and an un-fenced session
    is unrestricted on both brands (the exit state).
  * Full suites green: shared 219, engine 303, API 326; web lib 71 (incl. 13 new); backend + web
    typecheck clean; web `next build` clean.
- **Note:** frontend chrome (banner/sidebar) is presentational over the unit-tested core; the
  security-relevant scoping is enforced server-side and covered by the API suite above.

---

## #26 — A brand's DEFAULT marketer could be demoted to 'player', stranding it un-removable + dashboard-less — FIXED (branch `fix/default-marketer-role-lock`, migration 0124)
- **Report (Issue 1):** "the admin must be able to remove a default marketer" and "some marketers cannot
  see their dashboard."
- **Evidence (read-only, production):** three brands had a default marketer (`sites.owner_user_id`)
  whose role had been demoted to **`player`**: `1000wins → @claudia`, `cpfmarket → @marketer001`,
  `muchwins → @sheila`. The `admin_actions` audit shows each was promoted to `marketer`, assigned as
  the brand default, then a superadmin ran `user.set_role` → `player` (claudia 2026-09-13, marketer001
  2026-09-14, sheila 2026-09-15). All three still hold active `affiliates` rows and were still being
  credited deposit commission (marketer001 had KES 100 accrued, sheila KES 194.15) — money routed to
  accounts that can no longer open the marketer dashboard.
- **Root cause:** migration 0104 locked *status* changes (ban/suspend) on a brand default
  (`fn_admin_set_user_status` → `DEFAULT_MARKETER_LOCKED`) but **never locked *role* demotion**.
  `fn_admin_set_user_role` freely moved a brand default out of `'marketer'`, producing an invalid
  state the guarded assign RPCs can't even create. That state then wedged two ways:
  1. **Un-removable:** `fn_admin_set_site_owner` validated `role='marketer'` for BOTH the assign AND
     the clear path, so clearing a now-`player` owner raised `OWNER_NOT_MARKETER`; and the admin panel
     hid the whole control because it was gated on `q.data.role === 'marketer'`.
  2. **Dashboard-less:** `/dashboard` (and the marketer HUD) require `role === 'marketer'`, so a
     demoted default is redirected home even though it is, in substance, the brand's earning marketer.
- **Fix (migration 0124 + web):**
  * **DB:** split `fn_admin_set_site_owner` validation — ASSIGN still requires an ACTIVE marketer on
    the actor's own brand; CLEAR now works for ANY current owner (role/status irrelevant) and derives
    the cleared brand from the ownership row itself, so a corrupt default is always removable. Added
    the symmetric **role-demotion lock** to `fn_admin_set_user_role`: a brand default cannot be moved
    out of `'marketer'` until removed/reassigned (`DEFAULT_MARKETER_LOCKED`); setting/keeping
    `'marketer'` and auto-enroll-on-promotion are unchanged.
  * **Web (`admin/users/[id]/view.tsx`):** render the default-marketer control whenever the account
    *is* a brand default (even if its role drifted off `marketer`) so the Remove action is reachable;
    only offer "Make brand default" for an actual marketer; warn on a stale (non-marketer) default;
    and surface a plain-language `DEFAULT_MARKETER_LOCKED` message on the role control ("remove them as
    the brand default first, then change their role").
- **Why this is the once-for-all fix:** the DB RPC is the authoritative production guard (the API and
  in-memory dev mirror sit behind it). GAP 1 makes removal always possible for every current/future
  corrupt row; GAP 2 stops the corruption from ever being re-created. The pre-existing three rows are
  repaired by a separate operator-confirmed data step and are now also removable directly in the panel.
- **Tests:** new `packages/db/_testkit/e2e_default_marketer_lock.py` — 28 adversarial scenarios on a
  real PG17 with ALL 124 migrations (auth gate, assign active-marketer-only, suspended/​player rejects,
  demotion lock for admin+superadmin, keep-marketer allowed, site-scope on clear, removal, re-enable
  after removal, repair of a forged player-owner default, idempotent no-op clear, platform cross-brand
  clear). Full suites green: shared 219, engine 303, API 319; backend + web typecheck clean; web
  `next build` clean. Migration re-applies idempotently.
- **Note:** the DB-e2e harness's `reset_and_migrate()` globs `00*.sql`, which silently stops at 0099
  (misses 0100–0124); the new test uses `[0-9]*.sql`. Pre-existing suites `e2e_platform_console.py` and
  `e2e_affiliate_sites.py` fail on stale test bodies (a removed `min_withdrawal_native` column; a
  `config_version` FK) independent of this change — logged for a follow-up test-maintenance pass.

---

- **Request (operator, Issue 1):** remove the "Demo balance (for showcasing the game)" card from the
  marketer dashboard, then reorganise the dashboard to bank standards — "if we have 50 expenses, do we
  really list all of them? pages? tables?"
- **Change 1 — demo card removed.** Deleted the self-service demo-wallet section (`useMarketerProfile`
  + `useMarketerDemoTopup` usage, `demoWallet`/`demoTopup`/`demoMsg` state and the `topUpDemo` handler)
  from `apps/web/src/components/marketer/MarketerDashboardView.tsx`. **Frontend-only** — the backend
  demo-topup endpoint, hooks (`api.marketerMe`/`api.marketerDemoTopup`), migration 0102 and
  `app.marketers.demotopup.test.ts` are untouched, so nothing else regresses and the capability can be
  re-surfaced elsewhere if ever wanted.
- **Change 2 — bank-standard IA (progressive disclosure).** The four unbounded lists were the real
  defect: **Expenses rendered EVERY row** (`expRows.map` with no cap — the literal "50 expenses" dump),
  while Earnings/Referrals hard-capped at `.slice(0, 8)` with **no way to see the rest** (referrals even
  had cursor pagination available but unused). Replaced them with ONE tabbed **Activity** ledger
  (Earnings · Expenses · Referrals · Advances), each paged at `LEDGER_PAGE_SIZE = 6` with an explicit
  "Showing X-Y of N · page/pages · Prev/Next" pager; referrals additionally drive the real
  `useAffiliateReferrals` cursor via a "Load more" control. The reconciling commission statement was
  promoted to its own summary card (the trust anchor), and the advance REQUEST form kept as an action
  card with its history moved into Activity ▸ Advances. Hero ("Available to withdraw") stays the
  dominant, role-first metric. Grounded in fintech-dashboard research: lead with one metric, disclose
  detail progressively, paginate with explicit indicators (not infinite scroll) on mobile.
- **Latent bug caught (pre-existing):** the removed demo card and (initially) the new tab control used
  the Tailwind class `bg-card`, but **`card` is not a defined colour token** (tailwind.config only
  defines bg/surface/surface-2/border/fg/muted/up/down/accent/accent-fg/brand/warn/info). Evidence: the
  compiled stylesheet contains **zero** `bg-card` rules (`grep -c bg-card .next/static/css/*.css → 0`).
  Impact: any element relying on `bg-card` for its fill silently rendered transparent. Resolution: the
  new Activity tabs use the app's established segmented-control tokens (`bg-accent text-accent-fg
  shadow-sm` for the active tab, matching `WalletModal`); `bg-card` no longer appears anywhere.
- **New pure module + tests:** `apps/web/src/lib/affiliate/paginate.ts` (`pageInfo`, `pageSlice`) is
  total by construction — hostile input (page 0/999, negative/NaN size, empty list) is clamped, never
  thrown, so a transient data shape can't crash the page. Covered by `paginate.test.ts` (10 cases incl.
  a 5,000-iteration fuzz proving the pages tile the list exactly once, in order, with no gaps/overlaps).
- **Verification (E2E, real-life scenarios):** green baseline captured first (`tsc --noEmit` + full
  `next build`), then re-run after the change — both exit 0, `/dashboard` builds. Full web lib suite:
  **52/52 pass** (incl. the 10 new pagination tests), zero regressions. Rendered the redesign against
  the app's actual compiled Tailwind + default dark tokens with mock data at scale (12 earnings, **50
  expenses**, 26 referrals, 3 advances) and screenshotted mobile (400px) + desktop (920px) across every
  tab and page — confirms the demo card is gone, the 50-expense list is paged 6-at-a-time (1/9), and
  layout reflows to a 4-col grid on desktop. No money-path or API changes; the reconciliation ladder
  (earned − expenses − paid − held ⇒ available) is preserved byte-for-byte.

## #24 — Migration 0118 (real-time pool top-up) was NEVER applied to prod, yet the live engine calls it — FIXED (migration 0118 applied + ledger reconciled)
- **Caught while** reconciling the migration ledger during the BUGLOG #23 rollout: the CI `migrations-ledger`
  gate had been RED for 6+ consecutive runs on `main` (i.e. before the #23 merge), flagging 0117–0120 as
  UNRECORDED.
- **Investigation (no assumptions — checked the LIVE DB, not just the files):**
  * 0117 (`fn_pay_referral_commissions` rail-agnostic + `v_owner` root), 0119 (`fn_pool_ensure_day`) and
    0120 (`site_game_config.min_withdrawal_native`) were APPLIED but never `--record`ed in
    `schema_migrations` → recorded them (metadata only, no behaviour change).
  * **0118 (`fn_pool_topup_today`) was genuinely ABSENT from prod.** But the deployed engine calls it on
    every deposit-triggered reallocation (`apps/engine/src/server.ts:265`), and the platform envelope is
    LIVE (`platform_global_config.global_daily_pool_cents = 20,000,000` = KES 200k), so the gate was open.
- **Impact:** each real-time pool reallocation threw `undefined_function` (caught by the engine's
  `onError`, logged, non-fatal), so **intra-day withdrawal-pool top-ups to under-served brands silently
  never happened** (docs/25 §15.1) — the daily distributor's once-a-day budget was the only allocation,
  degrading payout headroom for brands seeing live demand.
- **Verification before applying (rollback-only txn against the real pool row, site 000…001, today):**
  never-clawback (request < current ⇒ unchanged 7,012,995), raise (request > current ⇒ set to request),
  role-gate (non-superadmin ⇒ `NOT_AUTHORIZED`). Confirmed ZERO persistence from the test (amount
  restored, function absent) before the real apply.
- **Resolution:** applied migration 0118 to prod (additive, idempotent, revertible, money-safe by
  construction — only ever raises via `greatest()`), recorded it + 0117/0119/0120/0121 in
  `schema_migrations`. Ledger now reconciles exactly (121 files = 121 rows, 0 problems), so the
  `migrations-ledger` CI gate goes green.
- **Follow-up (DONE — `chore/auto-apply-migrations-on-deploy`):** the root cause was that migrations
  were applied to prod out-of-band, decoupled from recording. Added `scripts/migrate.mts` — an
  idempotent runner that APPLIES each unrecorded migration and RECORDS it in the SAME transaction
  (apply+record atomic ⇒ the ledger physically cannot drift), refuses to touch a CHANGED (edited-after-
  apply) file, and aborts on first failure. Wired into `deploy.yml` as a gate: `verify → migrate →
  deploy`, so prod schema is always current before the new code boots. (A plain `migrations_status
  --record` was rejected: it stamps files as applied WITHOUT running them, which would mask exactly this
  class of gap.) Validated e2e against the live DB (apply / idempotent / CHANGED-abort / FAILED-rollback,
  then cleaned up).

## #23 — Marketer "Net after expenses" didn't reconcile with withdrawable; expense TOTAL summed a capped page — FIXED (branch `fix/marketer-net-after-expense`, migration 0121)
- **Report (operator):** "fix the bug in the calculation of Marketers net after expense."
- **Root cause (three distinct defects, banker's ledger view):** the marketer's money is one ledger —
  `E` = accrued marketer commission, `X` = Σ logged expenses/advances, `P` = paid commission payouts,
  `H` = held (requested/approved) payouts, and the authoritative withdrawable is
  `Available = max(E − X − P − H, 0)` (`fn_commission_balance`, migration 0105). The dashboard broke that ledger in three ways:
  1. **"Net after expenses" = `earned − expenses`** (`MarketerDashboardView.tsx`) ignored `P` and `H`, so
     it overstated the position of any marketer who had been paid. Evidence (prod, read-only): *jake*
     showed **+KES 410** "net" while his real `Available` was **0** (E 850 − X 440 − P 562.50 → floored 0).
  2. **Expense TOTAL summed a limit-capped page**, not all rows. `GET /affiliate/expenses` and
     `GET /admin/affiliate/expenses` returned `totalCents = reduce(items)` where `items` is capped at
     `limit` (default 100), while `fn_commission_balance` nets the FULL SQL sum. Rollback-txn e2e: 150
     expense rows → the page-sum reported **10,000** vs the true **59,000** (a 49,000 undercount) — the
     displayed total silently diverges from what actually reduces the withdrawable.
  3. **`earned` was defined two ways.** `myReferral` computed `earnedCents` as an UNFILTERED sum of all
     the user's `deposit_commissions`, but pulled `held/paid/available` from `fn_commission_balance`
     (accrued-marketer only). For a player (instant 5% `status='paid'` rows) later promoted to marketer,
     "Earned all-time"/"Net after expenses" would include already-paid player commission and diverge
     from `Available`. Latent (0 cases in prod today) but a real correctness defect.
- **Operator direction:** think like a banker; find and fix ALL the miscalculations; no guesswork; test e2e.
- **Resolution (branch `fix/marketer-net-after-expense`):**
  * **Migration 0121:** `fn_marketer_expenses_total(uuid)` — the authoritative full sum, mirroring the
    `ex` term in `fn_commission_balance`. Additive, idempotent, read-only, `service_role`-only.
  * **API:** `MarketerExpensesDeps.total()` (pg + test fake); both expenses endpoints now return
    `totalCents` from the full sum, never the page. `ReferralSummary` gains `marketerEarnedCents`
    (= `fn_commission_balance.earned_cents`) so the marketer balance context uses one consistent `earned`.
  * **Web:** the dashboard's Expenses section is now a **reconciling statement** —
    `Earned → −Expenses (= Net after expenses) → −Paid out → −Pending → = Available to withdraw` — that
    ends on the exact figure the hero/KPI show. "Net after expenses" is kept as a labelled subtotal (now
    on the FULL expense sum) and can no longer mislead because the ladder continues to the true withdrawable.
    `ReferralCommissionsCard` shows `marketerEarnedCents` for marketers (players keep `earnedCents`).
- **Verification:** typecheck clean; 880/880 unit tests pass (incl. a new regression test proving
  `totalCents` is the full sum with `limit` < row count). Rollback-only DB e2e against the LIVE functions:
  for every marketer `max(E−X−P−H,0) == fn_commission_balance.available` AND `fn_marketer_expenses_total == SUM(expenses)`; the 150-row divergence proof above; ROLLBACK verified (function absent post-rollback, no rows written).
- **Known follow-up (not changed here — money-flow gating needs sign-off):** `fn_approve_commission_payout`
  / `fn_mark_commission_payout_paid` don't re-validate the payout against a balance reduced by an expense
  logged AFTER the request. The hold is locked at request time, so an expense added between request and
  pay is only recovered from FUTURE commission (the ledger stays floored ≥ 0, never negative). Payouts are
  human-gated (admin approval + superadmin password), so exposure is low. Recommend a re-check at
  approve-time as a separate, reviewed change.

## #22 — Deposit page + API ignored the `mpesa` gateway switch (Daraja always shown) — FIXED (branch `fix/deposit-gateway-switch-gating`)
- **Evidence:** in the first cut of the gateway switches (0116), `DepositPanel` rendered the "STK Push"
  and "Pay Bill" (Daraja) tabs **unconditionally**, and the API `/deposits` + `/deposits/paybill/claim`
  routes had no provider check. So switching the `mpesa` provider **off** (superadmin, e.g. because
  Pay Bill was faulty) still left Daraja visible and usable — the switch only governed Mega Pay.
- **Impact:** a superadmin who disabled M-Pesa still exposed the broken Daraja/Pay Bill rail to real
  players. Caught immediately after go-live (the operator had turned M-Pesa off + Mega Pay on).
- **Resolution:** the `mpesa` provider now governs BOTH Daraja rails. `DepositPanel` renders STK Push +
  Pay Bill only when `mpesa` is effective-enabled and Mega Pay only when `megapay` is (loading + empty
  states handled; single-method hides the tab bar). Server-side, `/deposits` and `/deposits/paybill/claim`
  refuse with `PROVIDER_DISABLED` when `mpesa` is off — mirroring the `/deposits/megapay` gate. New test
  in `app.megapay.test.ts` locks it. Fail-open (M-Pesa) still applies if the provider lookup errors.

---

## #21 — Deposit `ABOVE_MAX` mapped to HTTP 500 instead of 400 — FIXED (branch `feat/megapay-gateway`)
- **Evidence:** `PaymentService.initiateDeposit` throws `ABOVE_MAX` when a deposit exceeds the
  platform-global max single deposit (migration 0099), but `DOMAIN_STATUS` in `apps/api/src/app.payments.ts`
  had no entry for `ABOVE_MAX`, so the router mapped it to a generic **500 Internal Server Error**.
- **Root cause:** the max-deposit enforcement (0099) added the `ABOVE_MAX` throw but the HTTP error map
  was not updated, so a legitimate client-side validation failure surfaced as a server fault.
- **Impact:** a player entering an over-cap amount got a 500 (looks like an outage / no actionable
  message) instead of a clean 400 "amount exceeds the maximum". Pre-existing; low severity, no money effect.
- **Resolution:** added `ABOVE_MAX: 400` (plus the new Mega Pay codes `PROVIDER_NOT_FOUND`,
  `PROVIDER_DISABLED`, `MEGAPAY_NOT_CONFIGURED` 503, `MEGAPAY_INITIATE_REJECTED` 502,
  `MEGAPAY_VERIFY_PENDING` 409) to `DOMAIN_STATUS`. Covered by the deposit-floor/junk test in
  `app.megapay.test.ts`.

---

## #20 — Multipliers were pool-blind, tick-blind, transport-less and crash-unsafe — FIXED (branch `feat/issue1-multipliers-live`)
- **Evidence:** the Phase-2 multiplier engine methods existed but (a) TP/SL/stop-out/DC were never
  evaluated by any loop (the settle methods were dead code nothing called), (b) no WS/REST transport
  reached them, (c) P/L priced off the classic BTC/KES curve instead of the instrument the player was
  viewing, (d) open contracts lived only in memory (a restart stranded the debited stake), and
  (e) the pool fund did not govern them — an uncapped, player-timed cash-out book (manual close at
  any green tick) is even more loss-exposed than fair digits.
- **Resolution (same central algorithm as digits/rise-fall):**
  * Instrument feed pricing + per-tick evaluation via `tickMultipliers` (driven by the per-(site,
    instrument) streamer): TP / SL / stop-out / deal-cancellation auto-close; `mult_update` /
    `mult_closed` pushed to owners; `open_multiplier` / `close_multiplier` messages.
  * **Pool mode = timed bracket contract** decided at open with `decideReserveFixed` (candidate
    payout = stake + TP, default TP = +100% of stake): reserve → seeded 20–60s reversing path →
    auto-settle at exactly +TP (commit) or stop-out at −stake. SL/DC/manual close unavailable in
    pool mode (decision B). ONE shared budget + turnover + RTP ceiling across all three surfaces.
  * Crash recovery: pool contracts settle/re-arm from the persisted decision; statistical ones
    re-arm from `positions.contract`; boot re-arms instrument streamers so recovered contracts keep
    evaluating with zero clients connected.
  * Web `MultipliersPanel` trades real server-acked contracts (simulation removed).
- **Impact:** multiplier losses are hard-capped by the same central pool; realized RTP ≤
  1 − house_edge at every volume. Tests: full suite **813/813** (new: 6 statistical feed scenarios,
  6 pool scenarios incl. shared-budget + double-crash recovery, 2 WS e2e); typecheck clean.

---

## #19 — Digits shipped POOL-BLIND: a fair 5%-edge book with no budget cap (the exact "huge losses" failure mode) — FIXED (branch `feat/issue1-digits-live`)
- **Report (operator):** before merging digits, apply the pool-fund algorithm — "all clients have a
  central control point of configurations… I had tested with the other algorithm, but made huge losses."
- **Evidence / risk analysis:** the first digits increment settled EVERY trade on the provably-fair
  uniform digit at factor 0.95 (5% edge), ignoring `pool_mode` entirely. That book is the exact shape
  that loses money in practice:
  * **Variance vs a thin edge:** even/odd at 1.9× and 5% edge swings wildly; on thin-volume days the
    house is underwater a large fraction of days (the same hole docs/25 §14 closed for rise/fall).
  * **Martingale extraction:** the built-in AUTO bot doubles on loss — against an uncapped fair book a
    lucky streak cashes the whole float; nothing bounded daily payouts.
  * **No central control:** daily pools, dynamic per-client distribution, `pool_mode`, and the
    `house_edge` dial governed rise/fall only; digits bypassed all of it.
- **Root cause:** digits were wired to the statistical engine only; the PoolController (docs/25 — the
  managed-book brain with the hard cash cap + RTP-budget ceiling that already protects rise/fall) was
  never consulted for contracts.
- **Resolution (exact algorithm, fixed-odds adaptation):**
  * `decidePoolOutcomeFixed` (shared) + `decideReserveFixed` (controller): the SAME brain — propensity
    with base p = targetRtp/m (edge invariant E[RTP] ≤ 1 − house_edge), pool cash fuse, per-player
    no-scoop share, hard ceiling `paid + reserved ≤ ⌊targetRtp × turnover⌋`, near-miss lever,
    reserve→commit/release atomicity, persisted `position_decision` — with one fixed-odds rule: a win
    pays exactly the contract return or the trade loses (no shrunk wins).
  * `game.ts` routes digits exactly like rise/fall: pool path for non-marketers in pool-mode brands;
    provably-fair statistical path for pool-off brands and marketers/demo. One open digit contract per
    (user, instrument). Displayed digit is decision-consistent (seeded from the decision) and the
    owner's settle-index tick is overridden to match (chart == result).
  * **Shared central budget:** digits + rise/fall reserve from the SAME `withdrawal_pool` row,
    turnover, and ledger per brand — so per-client pools, the dynamic all-client distribution
    (docs/25 §15), and `pool_mode`/`house_edge` govern both surfaces with zero extra configuration.
  * Recovery: pool-decided digit contracts recover from the stored decision (commit on win),
    statistical ones from the seed. Idempotent.
- **Operational note (caught by test):** the 15% no-scoop share must exceed the largest fixed payout
  or players can never win — size a client's daily pool ≥ ~7× the largest digit payout (docs/34).
- **Impact:** digit losses are now hard-capped by the same central pool that already protects
  rise/fall; realized digit RTP ≤ 1 − house_edge at every volume. Tests: full suite **804/804**
  (new: 7 fixed-odds brain invariants, 9 engine pool-digit scenarios incl. combined rise/fall+digits
  budget + crash recovery, 1 WS pool-mode e2e); `tsc -b` + web `tsc` clean.

---

## #18 — Deriv-style DIGIT contracts were unreachable AND mispriced (would return 0.5× a "win") — FIXED (branch `feat/issue1-digits-live`)
- **Report (Issue 1):** the Phase-2 Deriv-style digits bot was built bottom-up (shared math + DB
  `fn_open_contract` + engine methods + a full web screen) but **no client could place a real digit
  contract**, and the web screen self-labelled "Preview mode · no real-money movement yet".
- **Evidence:**
  * WS transport (`multiengine.ts`) handled only `auth`/`open_position`/`sell`/`ping` — **no
    `open_digit`/instrument messages**, so `game.ts.openDigitContract()` was dead code (only tests
    reached it). No REST contract endpoints either.
  * The web `DigitsTradeScreen` generated its OWN client-side GBM prices (`useInstrument`) and settled
    locally — decoupled from any server, so outcomes were neither authoritative nor provably fair.
  * **Latent money bug:** `settleDigitContract` priced payouts with `factor = 1 − houseEdge`. But
    `houseEdge = 0.75` (the rise/fall crash-game economics) ⇒ an even/odd **win** would return
    `round(stake × 0.25 / 0.5) = 0.5× stake` — i.e. "winning" LOST half the stake. Unplayable and
    grossly unfair had it ever been wired.
  * Digit outcomes derived from `lastDigit(curve.rate(t))` of the single shared curve — a smooth,
    green-biased `tanh` curve whose last pip is **not uniform**, so even/odd ≠ 0.5 (edge drift).
  * Open digit contracts lived only in an in-memory map — a restart between open and settle would
    **strand a debited stake** with no recovery.
- **Root cause:** the feature was intentionally "demo-first / unwired" (per commit messages and
  migration 0113's header) and never had a transport, an authoritative price source, a digit-specific
  payout knob, or crash recovery.
- **Resolution (server-authoritative, provably fair, per-instrument):**
  * **Per-instrument seeded feed** (`packages/shared/instrumentfeed.ts`): extends the daily-seed model
    to each Deriv Volatility Index (Vol 10–250, 1s/2s). The settling last digit is
    `HMAC(daySeed, "dg:<instrument>:<index>") mod 10` — **exactly uniform**, so the payout factor IS
    the edge with no distributional drift; the displayed quote's last pip equals that digit
    ("chart digit == settled digit"). Pure & recomputable ⇒ provably fair + trivially recoverable.
  * **Digit payout factor** (`config.ts` `digitPayoutFactor`, default **0.95 = 5% edge**), independent
    of the rise/fall `houseEdge`. Fixes the 0.5× bug; operators can set 0.976 to mirror Deriv's
    on-screen "95.2% payout".
  * **WS transport** (`multiengine.ts`): `subscribe_instrument` → authoritative `inst_history` +
    live `inst_tick`; `open_digit` → `digit_opened` + balance; a per-(site,instrument) streamer
    settles every due contract (`settleDueDigits`) and fans `digit_settled` to owners. Unknown
    instrument ids are rejected (no spoofing).
  * **Crash recovery** (`recovery.ts`): open `kind='digit'` positions re-settle deterministically from
    the committed `{instrument, settleIndex}` in `positions.contract`, idempotently (no double credit).
  * **Web** (`GameSocketProvider` + `DigitsTradeScreen`): the same single socket now streams the
    instrument feed and places REAL contracts; local simulation removed. UI unchanged (Deriv layout).
- **Impact:** digits are live end-to-end, server-authoritative, provably fair (uniform), correctly
  priced, and crash-safe. Tests: **full suite 787/787**; `tsc -b` + web `tsc` clean. New coverage:
  shared feed (determinism, exact uniformity Monte-Carlo, quote↔digit invariant, edge), engine digit
  contracts, WS e2e (subscribe→stream→open→settle), and crash recovery. Multipliers are the next
  increment (tick-loop TP/SL/stop-out) and remain preview for now.

---

## #17 — Two divergent "marketer" systems + no way to delete; a "player" (stanley) was silently a demo account — FIXED (migration 0110, branch `feat/delete-and-marketer-consolidation`)
- **Report:** stanley is a player, but his withdrawals took the demo/instant rail (no bot alert). Also
  two UIs "manage a marketer" (Users → upgrade-to-marketer role; Marketer-finance → add-marketer demo),
  and there was no button to delete a marketer/user/admin.
- **Root cause (two concepts, one name):** `role='marketer'` (affiliate, real 25% commission via
  `affiliates`/`commission_payouts`) is INDEPENDENT of the DEMO cohort, which is defined by
  `fn_is_marketer_account` = a phone match in the `marketers` table (per docs/29). stanley (`role=player`)
  had a `marketers` row on his phone, so the money layer treated him as demo. `fn_is_marketer_account`
  ignores the marketers row's status, so even a `disabled` marketers row keeps a person demo — only
  DELETING the row un-demos them. Data confirmed the drift: 28 demo rows = 20 linked + 8 phantom; of
  the linked, 10 are `role=marketer` and 10 are `role=player` (demo-only, like stanley); plus 4
  affiliate-only. No delete function existed anywhere.
- **FK reality:** `marketers` FKs all CASCADE (safe hard delete). `profiles` FKs are mostly NO ACTION
  (transactions/ledger/positions/referrals/commissions/audit) → a real user/admin CANNOT be hard-deleted
  without destroying the financial audit trail.
- **Resolution:**
  * **Delete demo marketer (hard):** `POST /admin/marketers/:id/delete` → `DELETE FROM marketers`
    (cascades wallet/ledger/withdrawals/credentials), brand-scoped. Removes demo status.
  * **Delete user/admin (soft):** migration 0110 adds status `'deleted'` + `fn_admin_delete_user`
    (no-self, superadmin-protected, admin-only-by-superadmin, default-marketer-locked, idempotent);
    sets `sessions_valid_after=now()`. `POST /admin/users/:id/delete`. Login now blocks `'deleted'`
    accounts (anti-enumeration); lists hide them; money layer already rejects non-active.
  * **Consolidation:** the Marketer & affiliate finance hub is the single place to add/remove a demo
    marketer (delete in the Manage modal) and cross-links to the linked website account for the
    affiliate role; the Users page keeps the role field + deep-links to the hub.
  * **stanley fixed in production:** deleted his `marketers` row → `fn_is_marketer_account` True→False;
    profile stays player/active, real+demo balances intact. He now withdraws on the real rail.
- **Impact:** the demo/real ambiguity is resolvable from the UI; deleting is safe (cascade) or
  history-preserving (soft). Tests: full suite 728/728; `tsc -b` + web `tsc` clean; migration 0110 +
  the stanley delete verified against the real schema.

---

## #16 — Real-money vs "funny money" were entangled on the approval channel + approvals had no password — FIXED (branch `feat/telegram-approvals-issue1`, migration 0109)
- **Report (Issue 1):** improve Telegram payout alerts (thorough content, bank-grade look, no emojis),
  organise them (waiting/approved/rejected), reduce Approve/Reject to immediate actions, and require the
  superadmin password to approve — in BOTH the dashboard and the Telegram bot.
- **Bug caught (money routing):** migration 0108 had gated the **demo/"funny money"** marketer game→wallet
  transfer (`fn_marketer_game_withdraw`, `transactions` provider=`internal`) behind admin approval and
  routed it to the alert channel. Evidence: the only two `pending` withdrawals in production were
  `provider='internal'` demo transfers ("stanley", a phone-matched demo account). Real player M-Pesa
  withdrawals already alerted; real marketer **commission** payouts (`commission_payouts`) did **not**
  alert at all. So the channel carried the wrong money: fake money was gated/notified, one real-money
  flow was silent.
- **Bug caught (no approval proof):** all four approve surfaces (dashboard, Telegram inline button,
  email magic-link, web-push) executed on role/allowlist alone — **no password**. Approving real M-Pesa
  payouts required no second factor.
- **Resolution:**
  * **Migration 0109** restores the pre-0108 **instant** `fn_marketer_game_withdraw` (demo money credits
    the marketer wallet immediately, `success`, never on the channel), leaves the shared
    `fn_approve_withdrawal`/`fn_reject_withdrawal` intact for the real M-Pesa rail, and **backfills** the
    internal rows 0108 left `pending`. Validated on the real schema inside a rolled-back transaction.
  * **Superadmin password gate** on Approve across **every** surface (`requireApprovalPassword` +
    `verifyApprovalPassword`, scrypt against an active `platform_superadmin`). Reject stays immediate.
    Telegram uses a stateless force-reply flow that deletes the password message after use.
  * **Marketer commission** payouts now alert (Telegram + email); bot Approve = approve **+ mark-paid**.
  * **Content**: enriched, emoji-free, bank-grade Telegram + email templates (amount, client, user type,
    destination, time, reference); status topics optional.
- **Impact:** real money (player withdrawals + marketer commission) is what needs approval and now
  carries a password; demo money is instant and off the channel. No double-spend risk (demo hold/credit
  is atomic). Full suite green (724/724); `tsc -b` + web `tsc` clean. See docs/33.
- **Deploy note:** apply migration 0109 **before** deploying the API (the code assumes instant demo).

---

## #14 — Marketer expenses/advances never reached the dashboard; didn't affect withdrawable — FIXED (migration 0105)
- **Report:** expenses/advances logged in admin ("Marketer expenses") weren't reflected on the
  marketer's dashboard, and the net (withdrawable) math looked wrong.
- **Root cause (two identity systems):** a marketer exists as BOTH a website affiliate (`profiles`,
  role='marketer' — where commissions, `/dashboard` and its Expenses/Net section live) AND a
  marketer-APP identity (`marketer_profiles`/`marketers` — the simulated M-Pesa wallet). Same
  phone/brand, **different ids**. Migration 0068 defines `marketer_expenses.marketer_user_id` as a
  `profiles.id`, and the only marketer-facing reader (`GET /affiliate/expenses`, `fn_commission_balance`)
  keys on `profiles.id`. But the marketer-finance **Expenses** tab listed `marketer_profiles` and logged
  with `marketer_profiles.id`, so every logged expense was stored under an id **no dashboard reads**.
- **Evidence (production):** all logged expense rows were keyed to `marketer_profiles.id` (e.g. KES 450
  "Commission Tests" under *Mohan Abdul* `7965afa2…`, whose website account is *Mohane* `0cb63be4…`).
  Coverage: 9 marketer-app accounts map to a website marketer, 17 don't (no ambiguous matches).
- **Operator decision:** ALL logged expenses reduce withdrawable (`Available = earned − held − paid −
  expenses`, floored at 0).
- **Resolution (branch `feat/marketer-expenses-affiliate-key`, migration 0105 + API + web):**
  * **0105:** (a) `fn_commission_balance` now subtracts total logged expenses from `available_cents`
    (floored at 0); since the payout RPC reads `available_cents`, payouts are auto-capped at the net —
    timing-safe, never double-counts. (b) Re-keys existing mis-keyed expense rows from
    `marketer_profiles.id` → the matching affiliate `profiles.id` (`fn_phone_sig9` + same site +
    role='marketer', oldest); app-only accounts with no website marketer are left untouched. Idempotent.
  * **API:** the marketers list (`marketers.pg.ts`) now resolves each marketer-app row's linked affiliate
    `profiles.id` (`affiliate_user_id`) so expenses can be keyed correctly.
  * **Web:** the marketer-finance **Expenses** tab logs/reads by `affiliate_user_id`; app accounts with no
    website marketer are disabled ("no website account"). The `/dashboard` needed **no** change — it now
    populates automatically and `Available to withdraw` is net of expenses.
- **Verification:** rolled-back live e2e (re-key correctness + netted balances: *Mohane* KES 50 earned −
  KES 450 expenses → available 0; a +KES 50 expense on *moha* drops available by exactly that; app-only
  advance left untouched); 0105 applied to production and re-checked live; ledger reconciled (105/105);
  backend+web typecheck clean; full suite 673/673.

## #13 — Banned marketer stayed a brand's earning default; no admin-panel way to reassign — FIXED (migration 0104)
- **Report (operator):** *Mohane* (the only ACTIVE marketer on **madolar**) was still not the brand
  default; the "Make brand default" control couldn't be found where marketers are actually managed.
- **Evidence (read-only, production):** madolar had `sites.owner_user_id = moha`, but **moha and Mohan
  were both `banned`** and *Mohane* was the lone `active` marketer — yet a **banned** marketer remained
  the brand default and kept accruing 25% of every deposit. The only assignment UI lived in the
  **Platform Console** (`/platform`, platform_superadmin), not the **Admin panel** (`/admin/users`)
  operators use; and nothing prevented a default marketer from being banned or stopped a banned user
  from being (or staying) the default.
- **Root causes:** (1) surface mismatch — the control was platform-only; (2) `fn_platform_set_site_owner`
  validated role + site but **not status**, so a banned/suspended marketer could be set/left as default;
  (3) `fn_admin_set_user_status` had **no guard** against banning/suspending the current default.
- **Immediate data fix:** reassigned madolar's default from banned *moha* → active *Mohane*
  (`fn_platform_set_site_owner`, audited). Future deposits now credit Mohane 25%. (Historical
  commissions already paid to *moha* were left as-is.)
- **Resolution (branch `feat/admin-default-marketer-guards`, migration 0104 + API + web):**
  * **0104:** (a) `fn_platform_set_site_owner` now rejects a non-active marketer (`OWNER_NOT_ACTIVE`);
    (b) new **site-scoped** `fn_admin_set_site_owner(actor, role, marketer, make_default)` lets a brand
    `admin`/`superadmin` set/clear THEIR OWN brand's default (site derived from the marketer;
    `SITE_SCOPE_FORBIDDEN` off-brand; active-marketer enforced); (c) `fn_admin_set_user_status` blocks
    banning/suspending the current default (`DEFAULT_MARKETER_LOCKED`) — reassign first (per operator
    choice: **block**). Reactivating is always allowed.
  * **API:** `POST /admin/marketers/:id/make-default` and `/clear-default` (admin-gated, brand-scope
    enforced), routed via `PlatformRepository.setDefaultMarketer`. `AdminUserDetail` gains
    `isBrandDefaultMarketer`.
  * **Web:** `/admin/users/:id` shows a **"Make brand default" / "Remove as default"** control for
    marketers with a ★ current-default badge — where operators already manage users.
- **Verification:** rolled-back live e2e (13 scenarios: every guard + valid set/clear) against the real
  schema; 0104 applied to production and re-checked live (ban-of-default → `DEFAULT_MARKETER_LOCKED`).
  Typecheck clean (backend + web); full suite 673/673 (added an admin route-wiring/gating test).

## #12 — "Mohane's earnings not populating" — NOT A BUG (by design); default-marketer assignment made a first-class button + docs corrected
- **Report:** marketer *Mohane*'s dashboard showed no earnings; suspected a regression of #11.
- **Investigation (read-only, production):** *Mohane* (`0cb63be4…`, role `marketer`, brand **madolar**
  `776fd02b…`) has **0** `deposit_commissions`, **0** balance (`fn_commission_balance`), **0** direct
  referrals (`profiles.referred_by = Mohane` is empty), **0** clicks on her code `HYJJJQW2`. The
  dashboard (`GET /me/referral` → `sum(deposit_commissions.commission_amount)`) is therefore faithfully
  reporting zero.
- **Why zero is correct:** madolar's **default marketer** is *moha* (`sites.owner_user_id = a765af32…`).
  Verified the live model works: **78/78** successful M-Pesa deposits (KES 25,286.00) each generated a
  commission to *moha* at rate `0.25`, totalling KES 6,321.50 = **exactly 25%** — even though **all 118
  madolar players have `referred_by = NULL`**. So "default marketer earns 25% of every deposit,
  regardless of referral link" is already implemented and correct (`fn_pay_referral_commissions`,
  0103, invoked by `fn_complete_deposit`). *Mohane* is a **non-default** sub-marketer with no attributed
  deposits, so she correctly earns nothing.
- **Operator decision:** keep the differential-split model (every deposit still totals 25%, default
  marketer always at the root — **Model B**, no commission-math change), AND make assigning a brand's
  default marketer a first-class action.
- **Root cause of the confusion:** stale docs — `README.md` still described a legacy "20% of GGR / net
  losses" affiliate model, contradicting the live 25%-of-deposits model.
- **Resolution (branch `feat/set-default-marketer`, UI + docs only — no schema/money-path change):**
  * `apps/web/.../platform/ClientDetail.tsx`: added a **"Make brand default"** button (and
    **"Remove as default"**) in the per-user management panel, plus a **★ default** badge in the user
    table. Gated on `role = 'marketer'` client-side (backend `fn_platform_set_site_owner` already
    enforces marketer-on-same-brand + `platform_superadmin`, audited). This fixes a real gap: the
    pre-existing top-of-list selector only listed marketers from the first 50 loaded rows, so a marketer
    deeper in the list could not be selected; the search-then-select button reaches **any** marketer.
  * Docs: `README.md` (both 20% references corrected to the 25%-of-deposits hierarchical model), `docs/09`
    §3 (added "a brand always credits its default marketer" clarification + how to assign the default
    marketer), and this entry.
- **Verification:** rolled-back live e2e of `fn_platform_set_site_owner` — NOT_AUTHORIZED /
  SITE_NOT_FOUND / OWNER_NOT_FOUND / OWNER_NOT_MARKETER / OWNER_WRONG_SITE all fire; valid set
  (Mohane→madolar default) and clear-to-NULL both succeed; transaction rolled back (production
  untouched). Web typecheck clean; platform+referral+affiliate suites green (16/16).

## #1 — Bonus subsystem was dormant in the live money RPCs — FIXED (issue 1 / migration 0094)
- **What:** `bonus_balance` was frozen platform-wide — it could never be staked, wagered, or converted.
- **Evidence:** Live `fn_open_position` (10-arg) and `fn_settle_position` only moved `real`/`demo`
  balances; the `bonuses` table was empty across all 9 brands.
- **Root cause:** the original 0037 bonus mechanics were dropped when the RPCs were rewritten for
  site-scoping (0047) and demo isolation (0084). Deposit-bonus *granting* was also removed at 0077/0078.
- **Impact:** any credit to `bonus_balance` would have been permanently unusable and non-withdrawable.
- **Resolution:** migration 0094 restores bonus-first staking, wagering accrual, and FIFO conversion in
  the site-scoped/demo-aware RPCs (additive; verified no-op for existing zero-bonus accounts). See docs/31.

## #2 — DepositForm advertised a deposit bonus the backend never grants — FIXED (issue 1)
- **What:** the deposit screen showed a live "+KES X bonus (50%/25%/15%)… credited instantly as bonus
  balance" preview, but `fn_complete_deposit` (0078) grants no deposit bonus.
- **Resolution (per direction "remove any deposit-bonus apart from the one we just implemented"):**
  removed the DepositForm preview + `bonusPctForDeposit` import; deleted the shared deposit-tier module
  (`packages/shared/src/bonus.ts`, its `./bonus` package export, the engagement re-export, and its
  tests); and dropped the orphaned `fn_deposit_bonus_pct` in migration 0094. The **only** bonus in the
  system is now the sign-up welcome bonus. (Legacy `bonus_config.tiers/wagering_x` columns are left
  inert.)

## #3 — Admin "day" finance report is timezone-fragile (fails 00:00–03:00 EAT) — FIXED (issue 1 / global-config)
- **What:** `app.admin.isolation.e2e.test.ts` → "finance reports (daily/day/users) are brand-scoped"
  fails: `day report: brand A only` expects 40000, gets 0.
- **Evidence:** Reproduced on a clean `main` (pre-existing; independent of issue 1). The test derives
  `today` via `Africa/Nairobi` (`toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' })`) while the
  deposit rows are grouped by their stored (UTC) date. When the run happens in the window where the
  Nairobi calendar date is already ahead of UTC (00:00–03:00 EAT), the requested day and the stored day
  disagree and the report returns 0.
- **Impact:** the `/admin/reports/day` aggregation and/or the test are not timezone-consistent; the
  report can under-count near the UTC/EAT day boundary. Test is flaky by wall-clock (green during Nairobi
  daytime).
- **Refined root cause (this fix):** the *production* report (`PgAdminRepo.reportDay`, apps/engine/src/admin.ts)
  was already correct — it groups by `(created_at at time zone 'Africa/Nairobi')::date`. The defect was in
  the **in-memory test harness** helper `dayOfMs` (apps/engine/src/admin.ts:521), which used
  `toISOString().slice(0,10)` (UTC). The harness therefore bucketed cash facts under the UTC day while the
  test (and production) use the EAT day — diverging only in the 00:00–03:00 EAT window.
- **Resolution:** `dayOfMs` now returns the EAT calendar date
  (`toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' })`), matching production SQL and the callers'
  EAT `today`. **No production financial-reporting behaviour changed** (only the harness), so the prior
  concern about touching a live report does not apply. Baseline test suite is now fully green (610/610),
  and the finance-isolation e2e is deterministic regardless of wall-clock.
- **Follow-on:** two `app.admin.test.ts` report tests computed their expected day in UTC
  (`toISOString().slice(0,10)`) and were the mirror of the isolation test (they only passed during
  Nairobi daytime). Aligned both to the EAT calendar date so ALL day-report tests now agree with the
  production EAT boundary and each other.

## #4 — Phone-only password reset is account takeover for admins/superadmins — FIXED (issue 2 / migration 0097)
- **What:** `POST /api/v1/auth/password/reset` sets a new password from phone + new password alone
  (no possession proof), gated only by `ALLOW_UNVERIFIED_PASSWORD_RESET`. For a privileged account
  (admin / superadmin / platform_superadmin) anyone who knows the phone number could seize the back
  office.
- **Evidence:** `AuthService.resetPassword` had no second factor for privileged roles; the only reset
  path is that public endpoint (no admin-panel reset exists). Production roles are player/marketer/
  admin/platform_superadmin — note there is NO literal `superadmin`, so the real top account is
  `platform_superadmin` and had to be included in the privileged set.
- **Impact:** full account takeover of any admin whose phone number is known. `ALLOW_UNVERIFIED_PASSWORD_RESET`
  IS set as a Fly secret on `invest254-api` (confirmed via `fly secrets list`; value hidden but presence
  implies enabled), so this was very likely LIVE-exploitable before the fix. (An earlier partial GraphQL
  secret listing wrongly suggested the flag was absent.)
- **Resolution (migration 0097 + code):** privileged resets now REQUIRE all three security-question
  answers to verify, independent of the flag, and fail CLOSED when answers are unset. Added
  `user_security_answers` (scrypt-hashed, RLS/service-role only) + `profiles.sessions_valid_after`
  force-logout epoch (privileged tokens issued before it are rejected). `/auth/me` exposes
  `securitySetupRequired`; the web shows a mandatory non-dismissible setup gate. See docs/32.
  ROLLOUT COMPLETED 2026-08-21: migration 0097 applied; API deployed to Fly invest254-api; web deployed
  via Cloudflare Pages (commit 26b630a); force-logout stamped for all 3 privileged accounts. Verified in
  prod: reset on a real admin phone returns 403 SECURITY_QUESTIONS_NOT_SET (fail-closed, no change).
  Full suite 610 pass / 0 fail.

## #5 — Demo/marketer classifier was NOT site-scoped → players bypassed the withdrawal pool — FIXED (migration 0100)
- **What:** `fn_is_marketer_account` (0084) matched a profile to the `marketers` cohort on **phone
  (significant-9) alone, across ALL brands** — no `site_id` filter. But 0076 made `marketers` per-site
  and docs/20 §7 defines marketer identity as per-site. So a real **player on brand B** whose phone
  collided with a marketer on brand A was classified demo/marketer on brand B.
- **Symptoms (reported):** "global pool fund not applying to some clients (e.g. 33traders)" and "players
  using game config meant for marketers instead of the pool fund."
- **Mechanism (confirmed end-to-end):** engine `loadIsMarketer` → `fn_is_marketer_account` → wrongly
  true → `poolPath = poolActive && !isMarketer` = false → the player **skips the withdrawal pool and
  settles on the statistical ("marketer") path**, and the money layer (0086) routes them to the demo
  bucket. Not a mirror/template or deployment issue — the defect is in applied SQL affecting every brand;
  33traders is a normal row in the primary DB and pools correctly once classification is right.
- **Evidence (live):** 13 `role=player` accounts flagged as marketer; 5 were pure cross-site
  contamination (no marketer on their own site): 33traders/boyz, 66investors/Mercy, tamutraders/boyz,
  madolar/jake, invest254/grace254_waithera. The predicate also drives finance/RTP exclusion + money
  routing, so it mis-bucketed money too.
- **Fix (0100):** a user is demo/marketer IFF a `marketers` row exists **on the user's own site**
  (significant-9 match) **OR** the profile is `role='marketer'` (safety: never un-demo an enrolled
  marketer — 0084 warns that would turn funny-money into withdrawable cash). Rolled-back validation:
  player-flagged 13→8 (the 5 cross-site players become real pool players; all had 0 balance / 0 trades),
  marketer-flagged 10→12 (ALL enrolled marketers stay demo; moha KES 3,152 and jake KES 3,005 demo
  balances preserved). Additive, idempotent, reversible, money-neutral.
- **Follow-up (data hygiene) — DONE:** `madolar/moha` and `safitraders/jake` were `role=marketer` with
  live demo balances but had **no `marketers` row on their own brand** — an artifact of 0076 backfilling
  every pre-existing marketer to the default site (invest254). Enrolled them properly on their own brand
  via `fn_marketer_create` (active row + `marketer_wallets`), leaving the invest254 rows untouched;
  audited as `marketer.enroll.backfill` in `admin_actions`. Their classification now resolves via the
  site-scoped same-site match (not just the `role='marketer'` safety clause). NOTE: no marketer-dashboard
  PIN was set for the new brand identities — set one via the marketer admin if they need to log in there.
## #6 — Pool RTP tracked pool-size, not house_edge (Bug 1) — FIXED (pool RTP redesign, docs/25 §14)
- **What:** the pool controller paced payouts against `pool_amount × elapsed_day_fraction`, so realized
  player RTP tracked how big the daily pool was relative to turnover — not the operator's `house_edge`.
- **Evidence:** `sessionWinProbability` pace term was `(amount·dayFraction − paid)/amount`. With a pool
  large relative to turnover, `paid` sits far behind pace every trade, pinning win-prob at `pCap`. With
  the pre-redesign defaults (`pCap 0.6`, `meanMultiplier 1.8`) that yields `E[RTP] = 0.6·1.8 = 108%`.
  Simulation of the real decision fn confirmed RTP saturating well above the intended `1 − house_edge`.
- **Impact:** RTP was effectively set by pool sizing, not the configured edge; on generously-sized pools
  the house could pay ~100%+ RTP.
- **Resolution:** pace realized RTP toward `targetRtp × cumulative_turnover` (player-only, per site-day);
  the pool `available()` becomes only the hard cash fuse. Net: `realized RTP = min(targetRtp,
  pool/turnover)`. Turnover is tracked in-memory + DB-seeded (no migration).

## #7 — No structural positive-edge guarantee; low-volume days ran underwater (Bug 2) — FIXED (docs/25 §14)
- **What:** nothing guaranteed cumulative payout stayed below turnover. A fixed probability cap bounds
  only the *expected* per-trade edge, not realized aggregate RTP.
- **Evidence:** driving the real engine over 400 simulated days at 8 trades/day (strict `pCap = base`,
  no ceiling) ended **above 100% RTP on 116/400 days** (house net loss), max day 177%; even high-volume
  days spiked intraday RTP to 124–135%.
- **Impact:** on thin/low-volume brand-days, the house could and did (in simulation) lose money.
- **Resolution:** a HARD RTP-budget ceiling in `decidePoolOutcome` — `paid + reserved ≤ ⌊targetRtp ×
  turnover⌋` at all times (subtracting reserved makes it concurrency-safe across in-flight positions).
  Guarantees realized RTP ≤ target at **every** volume; simulation: 0/400 days over target, `maxIntraday
  = target` exactly. The pool `available()` remains the absolute cash fuse.

## #8 — Pool and statistical engines disagreed on win frequency (Bug 3) — FIXED (docs/25 §14)
- **What:** the pool used hardcoded knobs (`targetSessionRtp 0.6`, `meanMultiplier 1.8`) disconnected from
  each brand's `site_game_config`, so pool win frequency (base `0.6/1.8 = 0.33`) did not match the
  statistical engine's `targetWinRate` (default `0.125`). A player's win cadence changed with pool mode.
- **Resolution:** derive the pool's `meanMultiplier = targetRtp / targetWinRate` (the same `rtp/winRate`
  the `SettlementEngine` calibrates to), so pool base win-prob = `targetWinRate`. Both engines now share
  `targetWinRate` and both deliver RTP = `1 − house_edge`. `game.ts` threads `cfg.targetWinRate` into the
  controller; an infeasible config falls back to the default multiplier (defence-in-depth).

## #9 — Marketer/demo funny-money polluted real analytics (raw-table queries) — FIXED (migration 0101)
- **What:** money-bearing rows (positions/ledger/transactions/wallets) for the marketer/demo cohort
  live in the same tables as real players. Reports that used the cohort exclusion were correct, but any
  query that omitted it mixed demo funny-money into real figures — e.g. a raw `sum(positions.stake)`
  read ~KES 9.75M of demo turnover as real, producing a wildly wrong demand/RTP interpretation.
- **Evidence:** `positions` held 8,391 rows but the dashboard (which excludes `marketer_account_ids`)
  counted 2,128 real bets; the excess 6,263 were marketer demo bets (incl. a KES 4.7M single-day burst).
- **Root cause:** no enforced "real data" surface — cohort exclusion was applied per-query, so it could
  be forgotten.
- **Resolution (0101):** canonical `v_real_*` / `v_demo_*` views over the live classifier
  (`marketer_account_ids`), correct-by-construction and drift-free; `fn_demo_isolation_report()` proves
  0 leakage; `fn_platform_overview` rewired onto the views (identical output). Data hygiene: the
  6,263 marketer demo positions + 12,087 demo ledger rows + 426 demo transactions were removed and the
  demo wallets reset (real player data provably untouched); a bug-inflated madolar test account was
  deleted; and seeded pool caps were zeroed. See docs/27.

## #10 — Marketer app login rejected valid phone formats (false NOT_MARKETER) — FIXED (issue: marketer app login)
- **What:** the generic marketer app (mpesa/truecaller builds) showed "This account isn't registered
  as a marketer" (403 NOT_MARKETER) and the transaction feed/notifications never loaded, for a
  marketer whose website password and ledger were valid — whenever she typed her phone in any format
  other than the exact stored string (e.g. `+254706597235`, `254706597235`, `706597235`,
  `0706 597 235` vs stored `0706597235`).
- **Evidence:** read-only production comparison on the affected number (sig9 `706597235`, default
  brand): the old exact-match query found the row only for the stored format (1/6 formats); the
  sig9-match query finds it for all 6. Both marketer apps send the phone exactly as typed
  (no client-side normalization).
- **Root cause:** `profileByPhone` in `apps/api/src/marketers.pg.ts` matched `phone = $1` on the raw,
  un-normalized request string, while `auth.login` normalizes via `normalizeMsisdn` — so the password
  check succeeded but the marketer-wallet lookup missed. It was the one marketer lookup never migrated
  to the canonical significant-9-digits rule (`fn_phone_sig9`, migrations 0084/0086/0100, docs/29).
  The route tests passed because the in-memory double in `testutil.ts` replicated the same exact-match
  flaw and the fixtures never varied the phone format.
- **Impact:** any marketer typing their number in a non-stored format was locked out of the app with a
  misleading "not a marketer" error; downstream, the app's poll worker no-ops without a session, so
  M-Pesa-style transaction notifications silently stopped.
- **Resolution:** `profileByPhone` now matches on
  `fn_phone_sig9(phone) = fn_phone_sig9($1)` (with the `length(...) = 9` guard, site-scoped,
  deterministic `ORDER BY created_at ASC LIMIT 1`) — the same predicate as every other marketer
  lookup. The in-memory double keys phones by sig9 to stay faithful. New regression test
  ("login-web accepts the phone in any valid format") covers 6 format variants end to end.
  Full suite green (672/672); typecheck clean. No schema or write-path changes.

## #11 — Non–site-owner marketers earned no commission; some brands had no default marketer — FIXED (migration 0103)
- **What:** marketer dashboards showed no commissions for many marketers (e.g. *joy*, *Mohane*).
- **Evidence (read-only, production):** of 807 profiles only 4 had `referred_by` set; commissions
  flowed **only** to site owners via the `sites.owner_user_id` fallback. 4 brands had **no** default
  marketer (`owner_user_id IS NULL`): invest254, muchwins, tamutraders, 66investors — so every
  deposit on those brands paid **0%**. Verified *moha* (madolar owner) already earned exactly 25%.
- **Root cause:** (1) 4 brands were never assigned a default marketer, so their deposits paid no
  commission; (2) `fn_pay_referral_commissions` (0081) only rooted at the default marketer for
  **unreferred** deposits — a sub-marketer referral could take the whole 25% and leave the default
  marketer with nothing, so the hierarchy wasn't guaranteed.
- **Model (confirmed with operator):** each brand has ONE **default marketer**; **every deposit pays
  25%** into the brand's **hierarchical** marketer tree, always rooted at the default marketer.
- **Resolution (0103):**
  * `fn_pay_referral_commissions` now **always roots the 25% differential chain at the brand's
    default marketer** — full 25% when unreferred; differential split (recruiter bulk + upline
    overrides, default marketer at root) when a sub-marketer referred the depositor. Totals always
    sum to exactly 25%. Self-pay blocked; idempotent via `(deposit_tx_id, beneficiary_user)`.
  * Default marketers assigned: **invest254 → joy**, **muchwins → sheila** (single-marketer brands
    auto-assigned generically). **tamutraders** — the lone marketer (a duplicate *joy*) was demoted
    to player per operator instruction; brand left with no default. **66investors** — no marketer
    exists; skipped.
  * Docs 09 §3 and 19 updated to the 25%-of-deposits hierarchical model.
- **Verification:** rolled-back e2e against the live schema — unreferred→owner 25%; sub-marketer
  referral→recruiter 20% + default 5%; owner self-deposit→no pay; sub-marketer self-deposit→default
  25%; idempotent re-run→0 new rows; all marketer totals == 25%. Referral + affiliate TS suites green.


## #12 — Post-outage pool starvation: every brand paid 100% losses — FIXED (anti-starvation floor, docs/25 §15.6)
- **What:** starting the day trading resumed after the Aug 26–Sep 10 paybill outage, **every** pool-mode
  brand paid **0 wins** — players lost 100% of trades. invest254's daily withdrawal pool had fallen to
  **KES 47.49** (4,749 cents), far below a single 250-KES minimum stake.
- **Evidence (read-only, production):**
  * `position_decision ⨝ positions` by EAT day: invest254 win rates were healthy before the outage
    (Aug 24–27: 66–77%, large payouts) then **0 wins** on Sep 10–11 (10 decisions). Same 0-win pattern
    on madolar (32 dec), muchwins (45 dec, all `digit`), 33traders, safitraders.
  * `withdrawal_pool` for invest254 collapsed 8.25M (Aug 25) → 3.2M (Sep 1–9) → **34,173 (Sep 10) →
    4,749 (Sep 11)** cents. `sites.default_daily_pool_cents` history mirrored it.
  * Reproduced the demand allocator exactly (muchwins/safitraders/33traders matched to the cent):
    invest254's EMA forecast had decayed to ~85k cents (from millions), and the per-brand cap
    `2.5 × required` meant **even a KES 10M envelope would fund invest254 only ~KES 2,023**.
  * Player **@bill** (invest254): on the funded day Aug 27 he had 45 trades, **35 wins (77.8%)** yet
    RTP **0.870** — confirming the edge invariant works when the pool is funded (players win, house
    still edges out); the failure was funding, not the edge.
- **Root cause:** the demand-based pool allocator (docs/25 §15) forecasts demand with a **reactive EMA**
  over recent daily pool turnover. The ~2-week payment outage drove turnover to ~0, decaying the EMA →
  `required = targetRtp × forecast → 0`, which (via the `capMult × required` cap and the cap-clamped
  §15.2 floor) starved each brand's `default_daily_pool_cents` to ~zero. In the controller, **every
  payout gate scales with the pool `amount`** — the cash fuse `available = amount − paid − reserved`
  and the per-player no-scoop share `playerShare × amount` — so a starved amount forces every decided
  win to clamp to a loss (`reserved ≤ stake → loss`, and for fixed-odds `digit` contracts `payout >
  playerShare × amount → loss`). A self-reinforcing death spiral: starved pool → 100% loss → players
  leave → turnover stays 0 → forecast stays 0.
- **Resolution:**
  * **Immediate (production, audited RPCs, never-reduce `max(current, floor)`):** re-funded today's
    `withdrawal_pool.amount` and `default_daily_pool_cents` for all 7 active-with-demand brands to
    `round(targetRtp × robust expected daily turnover)` — invest254 → **KES 70,130**, muchwins → KES
    44,752 (default kept at its higher 61,144), madolar → 19,755, 33traders → 12,307, safitraders →
    950, tamutraders → 1,306, cpfmarket → 238. Verified the structural clamp is gone (avail ≫ any win,
    `playerShare×amount` ≫ payouts).
  * **Code (branch `fix/pool-allocation-floor`):** added a guaranteed anti-starvation floor decoupled
    from the reactive forecast — `floor_i = max(configuredFloorCents, targetRtp × expectedTurnover_i)`,
    `expectedTurnover = max(EMA, robustExpectedTurnover(baseline))`, where `robustExpectedTurnover =
    max(p75(non-zero days), mean(last 7 non-zero days))`. Allocated before the water-fill, rationed only
    if `Σ floors > envelope` (`Σ alloc ≤ G` preserved). Floors gate on demonstrated demand, so
    never-active brands stay 0. Safe by construction: pool `amount` is only a ceiling — the controller's
    `paid + reserved ≤ ⌊targetRtp × turnover⌋` cap still bounds payout to `targetRtp × turnover`, so the
    edge invariant (RTP ≤ 1 − house_edge) is unchanged. `PlatformService.poolDemand` feeds the robust
    baseline over `baselineDays` (default 45) + `POOL_MIN_FLOOR_CENTS`; daily script surfaces the floor.
- **Verification:** shared pool suites green (40/40, incl. 7 new incident-scenario tests: outage-collapse,
  huge-envelope-no-longer-clamps, Σfloor>G rationing, floor-is-a-minimum, configured-floor gating,
  back-compat byte-for-byte no-op); engine pool/controller/game suites green (35/35); engine typecheck
  clean. **Live read-only dry-run** of the new allocator over production history: invest254 forecast
  still KES 851.8 but floor lifts suggested to **KES 70,130** (was KES 835 under the old allocator);
  muchwins floored at 44,752 then demand-topped to 61,144; dead brands 0; Σ ≤ envelope.
- **Operational follow-ups:** (1) redeploy engine/api so the console `distribute-dynamic` uses the floor
  (the scheduled §15.5 workflow picks it up on merge to main); (2) until deployed, do NOT run a manual
  dynamic distribution on the old deployed code — it would re-starve. Revisit #43 next.

## #12b — Defense-in-depth so pool starvation can never silently re-occur (docs/25 §15.7)
Follow-up to #12. The §15.6 allocation floor removes the *cause*; these three independent layers
guarantee a silent recurrence (from that cause or any other) is effectively impossible:
- **(A) Absolute allocation floor** — `POOL_MIN_FLOOR_CENTS` (repo var) → `configuredFloorCents`, wired
  into `pool-distribute.yml`. A hard global minimum for cases the robust baseline can't cover (outage
  longer than `baselineDays`, brand-new brands). Operator dial; default off.
- **(B) DB safety valve — ALWAYS ON (migration 0119, applied to prod).** `fn_pool_ensure_day` now seeds
  a pool-mode brand's day at `greatest(default_daily_pool_cents, ⌈min_stake × max_multiplier ÷ 0.15⌉)`,
  so a zero/mis-set/starved default can never again force 100% losses — independent of any allocator
  run. Money-safe (amount is only a ceiling; controller still caps payout at ⌊targetRtp × turnover⌋).
  Verified live (rolled-back tx): safitraders default 95k → seed 833,334; invest254 default 7.01M wins.
- **(C) Active monitor — closes the detection gap.** `scripts/pool_health_monitor.py` +
  `.github/workflows/pool-health.yml` (every 30 min). Unlike `winrate_monitor.py` (needs ≥50 samples —
  and starvation suppresses volume, so it stayed silent during #12), this watches the STRUCTURAL signal
  over a rolling 2h window (`POOL_STARVED`: available < one min stake with live trades; `ALL_LOSS`: ≥8
  live trades, 0 wins; `BELOW_VIABLE` warning) and pages Telegram. Verified against live prod: after the
  #12 re-fund it reports ✅ healthy and shows invest254 already paying wins again (1 win / 2 recent
  trades; avail 7,012,995 → 6,987,681).
- **APIs redeployed** (fly.io `invest254-engine-pm` + `invest254-api`, remote build from merged main) so
  the console `distribute-dynamic` path also uses the §15.6 floor; API health 200, engine WS up.

## #15 — Deriv/digits ~80% player losses: near-miss fired even for above-line players — FIXED (docs/25 §16)
- **What:** the deriv (digits) game paid ~7–20% wins (≈80–93% losses) — far below the ~50% an even/odd
  contract should pay (RTP 0.95 ⇒ ~50/50). Reported as "deriv bot making 80% losses".
- **Evidence (read-only prod + deterministic replay):** muchwins digits last 24h = 5 wins / 67 (7.5%).
  Replaying the 29 most-recent decisions from their stored `seed+nonce`: mean propensity roll 0.529
  (RNG **fair**), propensity losses 15/29 (52% ≈ fair 50/50), and **14/29 were would-be WINS** (roll < p)
  — of which the near-miss voided 12, cutting the win rate from ~48% to ~7%. Not RNG, not the pool
  (funded), not propensity: the near-miss lever.
- **Root cause:** the min-withdrawal near-miss (docs/25 goal-gradient) fired whenever
  `bal + payout ≥ W`, **regardless of whether the player was already at/above the withdrawal line**. So
  any player/bot trading with a funded balance ≥ W had ~85% of wins voided (fixed-odds digits) or held
  (rise/fall) — a blanket win-suppression instead of the intended "hold a player JUST BELOW the line as
  they approach it". Worsened by the pre-§16 line being the low legacy KES value (KES 2,000 ≈ $15), which
  nearly every funded player exceeded.
- **Fix:** the near-miss now engages ONLY on the crossing trade — `bal < W && bal + payout ≥ W` — in BOTH
  engines (`decidePoolOutcome` variable / curve+candlestick, and `decidePoolOutcomeFixed` fixed / deriv).
  A player already at/above the line wins normally and can withdraw (real withdrawals = social proof, as
  intended). Combined with §16's currency-native line ($200 for USD), the lever now engages only in the
  genuine goal-gradient band. The house edge is untouched (the RTP-budget cap `paid+reserved ≤ ⌊target×
  turnover⌋` still bounds payout).
- **Verification:** `pool.test.ts` — "near-miss fires ONLY on the crossing trade; above-line players win
  normally" (asserts above-line near-miss count == 0 and ~base win rate for BOTH engines; crossing still
  triggers; far-below unaffected). Existing crossing/far-below near-miss tests still pass. 17/17 pool,
  30/30 engine pool/game, engine+api typecheck clean.
