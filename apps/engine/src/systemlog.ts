import type { LogLevel } from "@invest254/shared";

/**
 * System-log persistence (docs/36, BUGLOG #33/#34) — the single place that writes structured log
 * events to `public.system_logs` for the owner-only System logs UI. Used by BOTH the API and the WS
 * engine so EVERY backend log line is captured, not just API requests.
 *
 * Two capture paths feed the same store:
 *   1. `loggerSink` — plug into `createLogger({ sink })`; persists the structured JSON line.
 *   2. `captureConsole` — monkey-patches `console.*` so the (many) direct `console.log/warn/error`
 *      calls across the engine + API boot are captured too. The engine has NO structured logger, so
 *      this is what surfaces its crash-recovery / seed-rotation / pool / payments / Daraja+MegaPay logs.
 *
 * Every write is fire-and-forget and fully guarded: a logging fault (DB down, serialization, patched
 * console re-entrancy) can NEVER block, throw into, or recurse a request or the game loop.
 */

const LEVEL_WEIGHT: Readonly<Record<string, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Minimal pg pool surface (node-postgres Pool satisfies it). */
export interface SystemLogPool {
  query: (sql: string, params?: unknown[]) => Promise<{ rows?: unknown[] }>;
}

export interface SystemLogPersister {
  /** Sink for `createLogger({ sink })`: keeps the stdout line + persists at/above the threshold. */
  loggerSink: (line: string, level: LogLevel) => void;
  /** Monkey-patch console.{log,info,warn,error,debug} to also persist (idempotent). */
  captureConsole: () => void;
  /** The active persist threshold level (for boot diagnostics). */
  readonly persistLevel: string;
}

function safeStr(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`;
  try { return JSON.stringify(a); } catch { return String(a); }
}

/**
 * @param pool durable store (the transaction pool). When null the persister is a stdout-only no-op
 *             (engine dev / in-memory mode) — still safe to install.
 * @param opts.app         which process wrote the line ('api' | 'engine') — a first-class filter column.
 * @param opts.persistLevel min level persisted to the DB (env LOG_PERSIST_LEVEL; default 'info').
 */
export function makeSystemLogPersister(
  pool: SystemLogPool | null,
  opts: { app: string; persistLevel?: string },
): SystemLogPersister {
  const app = opts.app;
  const persistLevel = (opts.persistLevel ?? process.env.LOG_PERSIST_LEVEL ?? "info").toLowerCase();
  const threshold = LEVEL_WEIGHT[persistLevel] ?? LEVEL_WEIGHT.info!;

  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const s = (v: unknown): string | null => (v == null ? null : String(v));

  function insert(rec: {
    t?: unknown; level: string; msg: string;
    requestId?: unknown; method?: unknown; path?: unknown; status?: unknown; durationMs?: unknown;
    ip?: unknown; userId?: unknown; role?: unknown; siteId?: unknown; fields: unknown;
  }): void {
    if (!pool) return;
    void pool.query(
      `insert into public.system_logs(t, app, level, msg, request_id, method, path, status, duration_ms, ip, user_id, role, site_id, fields)
       values (coalesce($1::timestamptz, now()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)`,
      [s(rec.t), app, rec.level, String(rec.msg ?? ""), s(rec.requestId), s(rec.method), s(rec.path),
       num(rec.status), num(rec.durationMs), s(rec.ip), s(rec.userId), s(rec.role), s(rec.siteId),
       JSON.stringify(rec.fields ?? {})],
    ).catch(() => { /* logging must never affect the process */ });
  }

  const loggerSink = (line: string, level: LogLevel): void => {
    if (level === "error") process.stderr.write(line + "\n"); else process.stdout.write(line + "\n");
    if ((LEVEL_WEIGHT[level] ?? 0) < threshold) return;
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      const { t, level: _lv, msg, requestId, method, path, status, durationMs, ip, userId, role, siteId, app: _app, ...rest } = r;
      insert({ t, level, msg: String(msg ?? ""), requestId, method, path, status, durationMs, ip, userId, role, siteId, fields: rest });
    } catch { /* non-JSON (LOG_PRETTY) — stdout already has it, skip persistence */ }
  };

  let captured = false;
  let reentrant = false;
  const captureConsole = (): void => {
    if (captured) return;
    captured = true;
    const orig = {
      log: console.log.bind(console), info: console.info.bind(console),
      warn: console.warn.bind(console), error: console.error.bind(console), debug: console.debug.bind(console),
    };
    const wrap = (level: LogLevel, write: (...a: unknown[]) => void) => (...args: unknown[]): void => {
      try { write(...args); } catch { /* never let logging throw */ }
      if (reentrant) return;                                   // guard against any patched-console recursion
      if ((LEVEL_WEIGHT[level] ?? 0) < threshold) return;
      reentrant = true;
      try { insert({ level, msg: args.map(safeStr).join(" "), fields: { via: "console" } }); }
      catch { /* ignore */ }
      finally { reentrant = false; }
    };
    console.log = wrap("info", orig.log);
    console.info = wrap("info", orig.info);
    console.warn = wrap("warn", orig.warn);
    console.error = wrap("error", orig.error);
    console.debug = wrap("debug", orig.debug);
  };

  return { loggerSink, captureConsole, persistLevel };
}
