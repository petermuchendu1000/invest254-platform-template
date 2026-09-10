import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger, resolveLogLevel, maskPhone, redactValue, serializeError, type LogLevel } from "./logger.js";

/** Capture emitted lines (parsed) via an injected sink. */
function capture(level: LogLevel = "debug") {
  const lines: Array<{ level: LogLevel; rec: any }> = [];
  const logger = createLogger({
    level,
    sink: (line, lvl) => lines.push({ level: lvl, rec: JSON.parse(line) }),
    now: () => new Date("2026-09-10T04:00:00.000Z"),
    bindings: { app: "test" },
  });
  return { logger, lines };
}

test("logger: respects the level threshold (below-threshold is a no-op)", () => {
  const { logger, lines } = capture("warn");
  logger.debug("d"); logger.info("i"); logger.warn("w"); logger.error("e");
  assert.deepEqual(lines.map((l) => l.rec.msg), ["w", "e"]);
  assert.deepEqual(lines.map((l) => l.level), ["warn", "error"]);
});

test("logger: JSON shape carries t/level/msg + bindings + fields", () => {
  const { logger, lines } = capture();
  logger.info("hello", { requestId: "r1", n: 3 });
  assert.deepEqual(lines[0]!.rec, { t: "2026-09-10T04:00:00.000Z", level: "info", msg: "hello", app: "test", requestId: "r1", n: 3 });
});

test("logger: redacts secrets and masks phones (deeply)", () => {
  const { logger, lines } = capture();
  logger.info("req", {
    Authorization: "Bearer abc", api_key: "MGPY123", password: "hunter2",
    phone: "254712345678", nested: { service_role_key: "eyJ...", msisdn: "0712345678", amount: 5000 },
    arr: [{ token: "t" }],
  });
  const r = lines[0]!.rec;
  assert.equal(r.Authorization, "[REDACTED]");
  assert.equal(r.api_key, "[REDACTED]");
  assert.equal(r.password, "[REDACTED]");
  assert.equal(r.phone, "254***678");
  assert.equal(r.nested.service_role_key, "[REDACTED]");
  assert.equal(r.nested.msisdn, "071***678");
  assert.equal(r.nested.amount, 5000);           // non-sensitive kept
  assert.equal(r.arr[0].token, "[REDACTED]");
});

test("logger: error(msg, Error) serializes name/message/stack under err", () => {
  const { logger, lines } = capture();
  logger.error("boom", new Error("kaboom"));
  const err = lines[0]!.rec.err;
  assert.equal(err.name, "Error");
  assert.equal(err.message, "kaboom");
  assert.ok(typeof err.stack === "string" && err.stack.includes("kaboom"));
});

test("logger: child merges bindings over the parent", () => {
  const { logger, lines } = capture();
  logger.child({ module: "pay", requestId: "r9" }).info("x", { requestId: "override" });
  const r = lines[0]!.rec;
  assert.equal(r.module, "pay");
  assert.equal(r.requestId, "override"); // per-call field wins over binding
  assert.equal(r.app, "test");
});

test("logger: never throws on circular fields (bounded by depth)", () => {
  const { logger, lines } = capture();
  const a: any = {}; a.self = a;
  assert.doesNotThrow(() => logger.info("circular", { a }));
  assert.equal(lines[0]!.rec.msg, "circular");
  // The self-reference is truncated at the depth limit rather than crashing JSON.stringify.
  assert.ok(JSON.stringify(lines[0]!.rec).includes("Object depth limit"));
});

test("resolveLogLevel + maskPhone helpers", () => {
  assert.equal(resolveLogLevel({}), "info");
  assert.equal(resolveLogLevel({ LOG_LEVEL: "debug" }), "debug");
  assert.equal(resolveLogLevel({ LOG_LEVEL: "nonsense" }), "info");
  assert.equal(maskPhone("254712345678"), "254***678");
  assert.equal(maskPhone("123"), "***");
  assert.equal(maskPhone(""), "");
  assert.deepEqual(serializeError("plain string"), { message: "plain string" });
  assert.equal(redactValue("v", "apiKey"), "[REDACTED]"); // camelCase key normalised
});
