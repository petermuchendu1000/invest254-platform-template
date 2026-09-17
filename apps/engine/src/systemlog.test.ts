import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSystemLogPersister } from "./systemlog.js";

/** A pool that records every insert so we can assert what the persister wrote. */
function fakePool() {
  const inserts: Array<{ sql: string; params: unknown[] }> = [];
  return {
    inserts,
    query: async (sql: string, params?: unknown[]) => { inserts.push({ sql, params: params ?? [] }); return { rows: [] as unknown[] }; },
  };
}
const flush = () => new Promise((r) => setImmediate(r));
// insert param order: [t, app, level, msg, request_id, method, path, status, duration_ms, ip, user_id, role, site_id, fields]

test("loggerSink persists lines >= threshold with promoted columns + app; drops below-threshold", async () => {
  const pool = fakePool();
  const p = makeSystemLogPersister(pool as never, { app: "api", persistLevel: "info" });
  p.loggerSink(JSON.stringify({
    t: "2026-09-17T10:00:00Z", level: "warn", msg: "request rejected", requestId: "r1",
    method: "POST", path: "/x", status: 402, durationMs: 5, ip: "1.2.3.4", userId: "u1", role: "player", siteId: "s1", module: "http",
  }), "warn");
  p.loggerSink(JSON.stringify({ level: "debug", msg: "noise" }), "debug"); // below 'info' -> not persisted
  await flush();
  assert.equal(pool.inserts.length, 1, "only the warn line persisted");
  const pr = pool.inserts[0]!.params;
  assert.equal(pr[1], "api"); assert.equal(pr[2], "warn"); assert.equal(pr[3], "request rejected");
  assert.equal(pr[4], "r1"); assert.equal(pr[7], 402); assert.equal(pr[8], 5);
  const fields = JSON.parse(String(pr[13]));
  assert.equal(fields.module, "http", "unpromoted fields kept in jsonb");
  assert.ok(!("app" in fields) && !("msg" in fields) && !("status" in fields), "promoted keys not duplicated in fields");
});

test("captureConsole persists console.* (via:console), maps level, tags app; restores originals", async () => {
  const pool = fakePool();
  const orig = { log: console.log, error: console.error, warn: console.warn, debug: console.debug, info: console.info };
  const p = makeSystemLogPersister(pool as never, { app: "engine", persistLevel: "info" });
  p.captureConsole();
  try {
    console.log("[engine] recovery", { settled: 3 });
    console.error(new Error("boom"));
    console.debug("chatter");            // below 'info' -> not persisted
  } finally {
    Object.assign(console, orig);        // restore before assertions
  }
  await flush();
  assert.deepEqual(pool.inserts.map((i) => i.params[2]).sort(), ["error", "info"], "log->info, error->error; debug dropped");
  assert.ok(pool.inserts.every((i) => i.params[1] === "engine"), "tagged app=engine");
  const msgs = pool.inserts.map((i) => String(i.params[3]));
  assert.ok(msgs.some((m) => m.includes("recovery") && m.includes("settled")), "console args formatted into msg");
  assert.ok(msgs.some((m) => m.includes("boom")), "Error serialized into msg");
  assert.ok(pool.inserts.every((i) => JSON.parse(String(i.params[13])).via === "console"), "marked via:console");
});

test("a null pool is a safe stdout-only no-op (engine in-memory / no DB)", () => {
  const p = makeSystemLogPersister(null, { app: "api" });
  assert.doesNotThrow(() => p.loggerSink(JSON.stringify({ level: "error", msg: "x" }), "error"));
  assert.doesNotThrow(() => p.captureConsole());
});

test("captureConsole is idempotent (double install does not double-wrap)", async () => {
  const pool = fakePool();
  const orig = { log: console.log, error: console.error, warn: console.warn, debug: console.debug, info: console.info };
  const p = makeSystemLogPersister(pool as never, { app: "api", persistLevel: "info" });
  p.captureConsole(); p.captureConsole();
  try { console.warn("once"); } finally { Object.assign(console, orig); }
  await flush();
  assert.equal(pool.inserts.length, 1, "a single console.warn persists exactly one row");
});
