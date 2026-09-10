/**
 * Structured, dependency-free logger shared by the API + engine (browser code uses console).
 *
 * Goals (for admin/developer debugging):
 *   - ONE consistent shape: `{ t, level, msg, ...bindings, ...fields }` emitted as a single JSON line
 *     (aggregator-friendly) — or a compact human line when `pretty` is on (local dev).
 *   - Leveled + env-gated: LOG_LEVEL=debug|info|warn|error (default "info"). Below-threshold calls are
 *     cheap no-ops.
 *   - Child loggers carry bound context (module, requestId, userId, siteId, …) so every line in a flow
 *     is correlated without re-passing the same fields.
 *   - SECRET/PII SAFE: sensitive keys (tokens, passwords, api keys, PINs, connection strings, …) are
 *     redacted and phone/MSISDN values are masked — a money system must never leak these to logs.
 *   - NEVER throws and never blocks: a logging fault must not affect request handling.
 *
 * This module has no external dependencies and no side effects at import time.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export interface LogFields { [key: string]: unknown }

const LEVEL_WEIGHT: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** Resolve the active level from an env map (default "info"; unknown values fall back to "info"). */
export function resolveLogLevel(env: Record<string, string | undefined> = {}): LogLevel {
  const raw = String(env.LOG_LEVEL ?? "").trim().toLowerCase();
  return (LEVELS as readonly string[]).includes(raw) ? (raw as LogLevel) : "info";
}

// ── Redaction ──────────────────────────────────────────────────────────────────────────────────
// Keys whose VALUE is a secret/credential → replaced wholesale. Matched case-insensitively against
// the key name (also tolerant of separators, e.g. api_key / apiKey / api-key).
const SENSITIVE_KEY = /^(pass(word)?|pin|otp|token|access_?token|refresh_?token|id_?token|authorization|auth|bearer|api_?key|secret|consumer_?secret|client_?secret|passkey|security_?credential|service_?role_?key|anon_?key|publishable_?key|jwt|session|cookie|set_?cookie|x_?user_?id|credential|db_?url|database_?url|connection_?string|dsn|private_?key)$/i;
// Keys that hold a phone/MSISDN → masked (keep enough to identify, hide the subscriber digits).
const PHONE_KEY = /^(phone|phone_?raw|msisdn|party_?a|party_?b|mobile|tel|number)$/i;

const MAX_DEPTH = 6;
const MAX_ARRAY = 50;
const MAX_STRING = 2000;

const normKey = (k: string): string => k.replace(/[-_\s]/g, "").toLowerCase();

/** Mask a phone/MSISDN keeping only enough to correlate (e.g. 254712345678 → 254***678). */
export function maskPhone(v: unknown): string {
  const s = String(v ?? "");
  const digits = s.replace(/\D/g, "");
  if (digits.length < 6) return digits ? "***" : "";
  return `${digits.slice(0, 3)}***${digits.slice(-3)}`;
}

/** Deep-copy `value`, redacting sensitive keys and masking phones. Bounded in depth/size so a log
 *  line can never explode. Exported for tests. `keyHint` is the key this value was found under. */
export function redactValue(value: unknown, keyHint?: string, depth = 0): unknown {
  if (keyHint) {
    const nk = normKey(keyHint);
    if (SENSITIVE_KEY.test(keyHint) || SENSITIVE_KEY.test(nk)) return "[REDACTED]";
    if ((PHONE_KEY.test(keyHint) || PHONE_KEY.test(nk)) && (typeof value === "string" || typeof value === "number")) {
      return maskPhone(value);
    }
  }
  if (value == null) return value;
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[+${value.length - MAX_STRING}]` : value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return typeof value === "bigint" ? value.toString() : value;
  if (value instanceof Error) return serializeError(value);
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return "[Object depth limit]";
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY).map((v) => redactValue(v, undefined, depth + 1));
    if (value.length > MAX_ARRAY) out.push(`…[+${value.length - MAX_ARRAY} more]`);
    return out;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactValue(v, k, depth + 1);
    return out;
  }
  return String(value);
}

/** Serialize an Error into a loggable object (name/message/stack + any enumerable own props). */
export function serializeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { message: String(err) };
  const base: Record<string, unknown> = { name: err.name, message: err.message };
  if (err.stack) base.stack = err.stack;
  for (const [k, v] of Object.entries(err)) if (!(k in base)) base[k] = redactValue(v, k, 1);
  return base;
}

function redactFields(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) out[k] = redactValue(v, k, 1);
  return out;
}

// ── Logger ─────────────────────────────────────────────────────────────────────────────────────
export interface Logger {
  readonly level: LogLevel;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  /** `fields` may be a plain object OR an Error (serialized under `err`). */
  error(msg: string, fields?: LogFields | Error): void;
  /** A logger that always includes `bindings` (merged over the parent's). */
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  bindings?: LogFields;
  /** Where a formatted line goes. Default: stderr for error, stdout otherwise. Injectable for tests. */
  sink?: (line: string, level: LogLevel) => void;
  /** Human-readable single line instead of JSON (default from LOG_PRETTY / non-production TTY). */
  pretty?: boolean;
  /** Clock (timezone-aware). Default `() => new Date()`. */
  now?: () => Date;
}

function defaultSink(line: string, level: LogLevel): void {
  try {
    if (level === "error") process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
  } catch { /* logging must never throw */ }
}

function format(pretty: boolean, level: LogLevel, msg: string, t: string, merged: LogFields): string {
  const record = { t, level, msg, ...redactFields(merged) };
  if (!pretty) {
    try { return JSON.stringify(record); }
    catch { return JSON.stringify({ t, level, msg, logError: "unserializable fields" }); }
  }
  const time = t.slice(11, 23);
  const rest = Object.entries(record).filter(([k]) => !["t", "level", "msg"].includes(k));
  const tail = rest.length ? " " + rest.map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ") : "";
  return `${time} ${level.toUpperCase().padEnd(5)} ${msg}${tail}`;
}

/** Create a logger. In production pass nothing (env-driven); tests can inject `sink`, `now`, `level`. */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const env = (typeof process !== "undefined" ? process.env : {}) as Record<string, string | undefined>;
  const level: LogLevel = opts.level ?? resolveLogLevel(env);
  const pretty = opts.pretty ?? (String(env.LOG_PRETTY ?? "") === "1" || String(env.LOG_PRETTY ?? "").toLowerCase() === "true");
  const sink = opts.sink ?? defaultSink;
  const now = opts.now ?? (() => new Date());
  const bindings = opts.bindings ?? {};
  const threshold = LEVEL_WEIGHT[level];

  const emit = (lvl: LogLevel, msg: string, fields?: LogFields | Error): void => {
    if (LEVEL_WEIGHT[lvl] < threshold) return;
    try {
      const extra: LogFields = fields instanceof Error ? { err: serializeError(fields) } : (fields ?? {});
      const line = format(pretty, lvl, msg, now().toISOString(), { ...bindings, ...extra });
      sink(line, lvl);
    } catch { /* never throw from logging */ }
  };

  return {
    level,
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (childBindings) => createLogger({ ...opts, level, bindings: { ...bindings, ...childBindings } }),
  };
}

/** A shared default logger (env-driven). Prefer a `child({ module: … })` per module for context. */
export const logger: Logger = createLogger();
