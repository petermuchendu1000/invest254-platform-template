/**
 * sweeps.ts — a liveness registry for the in-process background sweeps (BUGLOG #162).
 *
 * THE DEFECT THIS CLOSES. Every sweep in `apps/api/src/server.ts` reports only when it has
 * something to say: `if (r.settled || r.errors)`, `if (n > 0)`, `if (r.warnings.length > 0)`. The
 * three "armed" lines that did exist went through the module-scoped `log`, whose sink is
 * `process.stdout` — NOT the `system_logs` sink — so none of them reached the only durable,
 * queryable record. A silent sweep layer is therefore the normal appearance of a healthy system,
 * and it is also the exact appearance of:
 *   - `POOL_HEALTH_INTERVAL_MS` / `TICKET_ESCALATE_INTERVAL_MS` set to 0 in Fly secrets,
 *   - `deps.poolHealth` / `deps.tickets` / `deps.billing` undefined, so the arm block never ran,
 *   - a sweep that armed and then stopped firing.
 * The ones that matter most are money: the deposit reconcilers are what settle a deposit whose
 * provider callback never arrived, and the pool monitor is what notices that players are losing
 * 100% of their stakes. We moved pool-health OFF a GitHub cron precisely because that cron failed
 * silently (6 firings out of 48 — BUGLOG #160); shipping it onto a timer whose death is equally
 * silent would have swapped one invisible failure for another.
 *
 * WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT.
 *   - It is an IN-PROCESS registry. A live process is the only thing that can honestly say whether
 *     its own timers are firing, so it is also the only thing that pages. `auto_stop_machines`
 *     (fly.api.toml) stops surplus machines while `min_machines_running = 1` keeps one awake; a
 *     stopped machine's heartbeat row goes stale legitimately, so paging off the TABLE would
 *     manufacture false alarms. Each process watches itself; the ones it cannot see are the ones
 *     that are not running, and Fly's own `/api/v1/health` check covers a process that is gone.
 *   - `persist` is the durable record for the owner UI and for SQL, keyed per (app, machine, name).
 *     It is never the alerting input.
 *
 * IT CAN NEVER THROW AND NEVER BLOCKS. Same contract as the logger (packages/shared/src/logger.ts)
 * and the system-log persister, and for the same reason: these calls sit inside the `.then` of a
 * money sweep. `persist` and `page` are fire-and-forget; every entry point is wrapped. A fault in
 * observability must not become a fault in the thing being observed.
 *
 * Pure except for the injected `persist`/`page`/`now` — no imports, no timers of its own (a
 * watchdog timer would be one more timer that can die), no side effects at import.
 */

/**
 * - `pending`  armed, not yet due for its first run. The honest state for the first seconds of a
 *              boot, and the reason a fresh process does not page for sweeps that are merely young.
 * - `ok`       ran within tolerance, last run succeeded.
 * - `failing`  ran within tolerance, last run threw. The timer is alive; the work is not.
 * - `stale`    has not run inside tolerance. Dominates `failing`: "we have not heard from it" is
 *              worse news than "it told us it failed", because it also covers "it will never run
 *              again".
 */
export type SweepStatus = "pending" | "ok" | "failing" | "stale";

export interface SweepRegistration {
  /** Nominal cadence (the `setInterval` period), in ms. */
  everyMs: number;
  /** When the first run is due, in ms after arming. Defaults to `everyMs`. */
  firstRunMs?: number;
}

export interface SweepState {
  name: string;
  everyMs: number;
  firstRunMs: number;
  armedAtMs: number;
  runs: number;
  failures: number;
  lastRunAtMs: number | null;
  lastOkAtMs: number | null;
  lastErrorAtMs: number | null;
  lastError: string | null;
  /** Computed at snapshot time (see `SweepStatus`). */
  status: SweepStatus;
  /** Since the last run, or since arming when it has never run. */
  ageMs: number;
  /** The age past which this sweep counts as late. */
  toleranceMs: number;
}

export interface SweepRegistry {
  /** Record that a sweep's timers are installed. Idempotent on `name` (re-arming resets tolerance). */
  arm(name: string, reg: SweepRegistration): void;
  /** Record a completed run. */
  ok(name: string): void;
  /** Record a failed run. */
  fail(name: string, err: unknown): void;
  /** Every armed sweep with its status resolved as of `nowMs` (default: the injected clock). */
  snapshot(nowMs?: number): SweepState[];
  /** Just the late ones — what `page` is built from. */
  stale(nowMs?: number): SweepState[];
}

export interface SweepRegistryOptions {
  /** Injectable clock (ms). Default `Date.now`. */
  now?: () => number;
  /** Durable upsert of one sweep's state. Fire-and-forget; must not reject into the caller. */
  persist?: (state: SweepState) => void;
  /** Operator page. Fire-and-forget. */
  page?: (text: string) => void;
  /**
   * Slack on top of the cadence before a sweep is called late. A sweep is late at
   * `period * lateFactor + graceMs`, so one missed tick plus jitter is tolerated: the 15 s fast
   * re-verify lane is late at 60 s, a 5-minute reconciler at 10.5 min, the 30-minute pool monitor
   * at 60.5 min. Tight enough that a dead timer surfaces within one further cadence, loose enough
   * that a slow database or a busy event loop is not an alert.
   */
  lateFactor?: number;
  graceMs?: number;
  /** Smallest gap between durable writes for the SAME sweep. A status change always writes. */
  minPersistMs?: number;
  /** Smallest gap between pages for an UNCHANGED set of late sweeps. A new name always pages. */
  alertCooldownMs?: number;
}

export const DEFAULT_LATE_FACTOR = 2;
export const DEFAULT_GRACE_MS = 30_000;
const DEFAULT_MIN_PERSIST_MS = 60_000;
const DEFAULT_ALERT_COOLDOWN_MS = 3_600_000;

/** The timestamps a status verdict needs — in memory, or read back from `sweep_heartbeats`. */
export interface SweepTimings {
  everyMs: number;
  firstRunMs: number;
  armedAtMs: number;
  lastRunAtMs: number | null;
  lastErrorAtMs: number | null;
}

/**
 * THE staleness rule, in one place. The owner-facing read path needs it as much as the registry
 * does, and for a sharper reason: the `status` column is only as fresh as the last write, so a
 * machine whose process died leaves a row frozen at 'ok'. Recomputing from the timestamps is what
 * stops a dead sweep rendering green. Expressing it in SQL instead would have put the same
 * tolerance in two places, free to drift.
 */
export function resolveSweepStatus(
  t: SweepTimings,
  nowMs: number,
  opts: { lateFactor?: number; graceMs?: number } = {},
): { status: SweepStatus; ageMs: number; toleranceMs: number } {
  const lateFactor = Number.isFinite(opts.lateFactor) && (opts.lateFactor as number) >= 1 ? (opts.lateFactor as number) : DEFAULT_LATE_FACTOR;
  const graceMs = Number.isFinite(opts.graceMs) && (opts.graceMs as number) >= 0 ? (opts.graceMs as number) : DEFAULT_GRACE_MS;
  // Tolerance is measured against whichever period the NEXT run is due on: a sweep whose first run
  // is 45 s away but whose cadence is 30 min must not be called late at 2 minutes once running.
  const period = t.lastRunAtMs == null ? t.firstRunMs : t.everyMs;
  const toleranceMs = period * lateFactor + graceMs;
  const since = nowMs - (t.lastRunAtMs ?? t.armedAtMs);
  const ageMs = since > 0 ? since : 0;
  const status: SweepStatus = ageMs > toleranceMs ? "stale"
    : t.lastRunAtMs == null ? "pending"
      : t.lastErrorAtMs != null && t.lastErrorAtMs >= t.lastRunAtMs ? "failing"
        : "ok";
  return { status, ageMs, toleranceMs };
}

/** First line of an error, bounded — this lands in a text column and in a Telegram message. */
export function describeError(err: unknown): string {
  const raw = err instanceof Error ? (err.message || err.name) : String(err ?? "");
  const line = raw.split("\n", 1)[0]!.trim();
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

/** `93s` / `7m` / `3h` / `2d` — compact enough for an alert line and a table cell. */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * The operator page. Named so it is greppable next to the starvation alert, and it leads with the
 * consequence rather than the mechanism: "a background job stopped" means nothing to somebody woken
 * at 3am, "deposits may not be settling" is the thing they have to act on.
 */
export function buildStaleSweepAlert(stale: readonly SweepState[], opts?: { app?: string; machine?: string }): string {
  const where = [opts?.app, opts?.machine].filter((x) => x && x !== "local").join(" ");
  const head = `⚠️ BACKGROUND JOB STOPPED${where ? ` (${where})` : ""} — ${stale.length} job${stale.length === 1 ? "" : "s"} overdue.`;
  const lines = stale.map((s) => {
    const last = s.lastRunAtMs == null ? "has NEVER run" : `last ran ${formatAge(s.ageMs)} ago`;
    const due = `expected every ${formatAge(s.everyMs)}`;
    const why = s.lastError ? ` — last error: ${s.lastError}` : "";
    return `• ${s.name}: ${last} (${due})${why}`;
  });
  return [head, ...lines, "", "Work this job was doing is not happening. Check the API process and its interval env vars."].join("\n");
}

interface Entry extends Omit<SweepState, "status" | "ageMs" | "toleranceMs"> {
  lastPersistAtMs: number;
  lastPersistedStatus: SweepStatus | null;
}

export function makeSweepRegistry(opts: SweepRegistryOptions = {}): SweepRegistry {
  const now = opts.now ?? (() => Date.now());
  const lateFactor = Number.isFinite(opts.lateFactor) && (opts.lateFactor as number) >= 1 ? (opts.lateFactor as number) : DEFAULT_LATE_FACTOR;
  const graceMs = Number.isFinite(opts.graceMs) && (opts.graceMs as number) >= 0 ? (opts.graceMs as number) : DEFAULT_GRACE_MS;
  const minPersistMs = Number.isFinite(opts.minPersistMs) && (opts.minPersistMs as number) >= 0 ? (opts.minPersistMs as number) : DEFAULT_MIN_PERSIST_MS;
  const cooldownMs = Number.isFinite(opts.alertCooldownMs) && (opts.alertCooldownMs as number) >= 0 ? (opts.alertCooldownMs as number) : DEFAULT_ALERT_COOLDOWN_MS;

  const entries = new Map<string, Entry>();
  let lastAlertAtMs = 0;
  let lastAlertKey = "";

  const resolve = (e: Entry, nowMs: number): SweepState => {
    const { status, ageMs, toleranceMs } = resolveSweepStatus(e, nowMs, { lateFactor, graceMs });
    return {
      name: e.name, everyMs: e.everyMs, firstRunMs: e.firstRunMs, armedAtMs: e.armedAtMs,
      runs: e.runs, failures: e.failures,
      lastRunAtMs: e.lastRunAtMs, lastOkAtMs: e.lastOkAtMs, lastErrorAtMs: e.lastErrorAtMs, lastError: e.lastError,
      status, ageMs, toleranceMs,
    };
  };

  /**
   * Write through at most once per `minPersistMs` per sweep — unless the status moved, which is news.
   *
   * CAPPED AT HALF THE TOLERANCE, and that cap is load-bearing. The owner's board recomputes the
   * verdict from the stored `last_run_at`, so the row has to stay fresh enough for that verdict to
   * be valid. At a flat 60 s the 15-second fast re-verify lane — whose tolerance is also 60 s
   * (15 × 2 + 30) — wrote a row that was routinely as stale as its own staleness threshold, and the
   * board rendered a perfectly healthy sweep as STOPPED. Observed in production on the first run:
   * ages oscillating 2s → 60s while `runs` climbed in bursts, with zero failures.
   *
   * Paging never had this problem (it reads the in-memory value, which every tick updates), so the
   * alert was right while the board was wrong — the worse way round, because a board that cries
   * wolf is exactly what this feature exists not to be.
   */
  const maybePersist = (e: Entry, nowMs: number): void => {
    if (!opts.persist) return;
    const state = resolve(e, nowMs);
    const changed = state.status !== e.lastPersistedStatus;
    const everyMs = Math.min(minPersistMs, Math.max(1_000, Math.floor(state.toleranceMs / 2)));
    if (!changed && nowMs - e.lastPersistAtMs < everyMs) return;
    e.lastPersistAtMs = nowMs;
    e.lastPersistedStatus = state.status;
    try { opts.persist(state); } catch { /* observability must never break the observed */ }
  };

  /**
   * Evaluated on every recorded run rather than on a timer of its own — a watchdog timer is just
   * one more thing that can stop, and would be the single point of failure for the whole scheme.
   * Any ONE sweep still firing is enough to notice that the others have stopped.
   */
  const maybeAlert = (nowMs: number): void => {
    if (!opts.page) return;
    const late = [...entries.values()].map((e) => resolve(e, nowMs)).filter((s) => s.status === "stale");
    if (late.length === 0) { lastAlertKey = ""; return; }   // recovered: the next lapse pages at once
    const key = late.map((s) => s.name).sort().join(",");
    if (key === lastAlertKey && nowMs - lastAlertAtMs < cooldownMs) return;
    lastAlertAtMs = nowMs;
    lastAlertKey = key;
    late.sort((a, b) => b.ageMs - a.ageMs);
    try { opts.page(buildStaleSweepAlert(late)); } catch { /* never throw from alerting */ }
  };

  const record = (name: string, at: number, err: unknown): void => {
    const e = entries.get(name);
    if (!e) return;                                         // a run from a sweep that never armed
    e.runs += 1;
    e.lastRunAtMs = at;
    if (err === undefined) { e.lastOkAtMs = at; }
    else { e.failures += 1; e.lastErrorAtMs = at; e.lastError = describeError(err); }
    maybePersist(e, at);
    maybeAlert(at);
  };

  const snapshot = (nowMs?: number): SweepState[] => {
    try {
      const at = nowMs ?? now();
      return [...entries.values()].map((e) => resolve(e, at)).sort((a, b) => a.name.localeCompare(b.name));
    } catch { return []; }
  };

  return {
    arm(name, reg) {
      try {
        const at = now();
        const everyMs = Number.isFinite(reg.everyMs) && reg.everyMs > 0 ? reg.everyMs : 0;
        if (!everyMs) return;                               // a disabled sweep is not a late one
        const firstRunMs = Number.isFinite(reg.firstRunMs) && (reg.firstRunMs as number) >= 0 ? (reg.firstRunMs as number) : everyMs;
        const prev = entries.get(name);
        const e: Entry = {
          name, everyMs, firstRunMs, armedAtMs: at,
          runs: prev?.runs ?? 0, failures: prev?.failures ?? 0,
          lastRunAtMs: prev?.lastRunAtMs ?? null, lastOkAtMs: prev?.lastOkAtMs ?? null,
          lastErrorAtMs: prev?.lastErrorAtMs ?? null, lastError: prev?.lastError ?? null,
          lastPersistAtMs: 0, lastPersistedStatus: null,
        };
        entries.set(name, e);
        maybePersist(e, at);                                // "armed at boot" is itself the signal
      } catch { /* never throw */ }
    },
    ok(name) {
      try { record(name, now(), undefined); } catch { /* never throw */ }
    },
    fail(name, err) {
      try { record(name, now(), err ?? new Error("unknown")); } catch { /* never throw */ }
    },
    snapshot,
    stale(nowMs) {
      return snapshot(nowMs).filter((s) => s.status === "stale");
    },
  };
}
