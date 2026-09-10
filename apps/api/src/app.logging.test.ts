import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi } from "./testutil.js";
import { createLogger } from "@invest254/shared/logger";

/** The router logs EXACTLY one structured line per request (the enforced debug chokepoint) and
 *  always echoes an x-request-id header the client/support can correlate on. */
test("every request → one structured log line + x-request-id header", async () => {
  const lines: any[] = [];
  const logger = createLogger({ level: "debug", sink: (l) => lines.push(JSON.parse(l)) });
  const api = await startTestApi({ depsOverrides: { logger } });
  try {
    // 2xx → info
    const ok = await fetch(`${api.baseUrl}/api/v1/deposits/paybill/info`);
    assert.equal(ok.status, 200);
    assert.ok(ok.headers.get("x-request-id"), "x-request-id header present");

    // 4xx → warn (+ error code)
    const bad = await fetch(`${api.baseUrl}/api/v1/nope-not-a-route`);
    assert.equal(bad.status, 404);

    const okRec = lines.find((l) => l.path === "/api/v1/deposits/paybill/info");
    assert.ok(okRec, "info log emitted for the 200");
    assert.equal(okRec.level, "info");
    assert.equal(okRec.status, 200);
    assert.equal(okRec.method, "GET");
    assert.ok(okRec.requestId, "requestId bound on the log");
    assert.equal(typeof okRec.durationMs, "number");

    const badRec = lines.find((l) => l.path === "/api/v1/nope-not-a-route");
    assert.ok(badRec, "warn log emitted for the 404");
    assert.equal(badRec.level, "warn");
    assert.equal(badRec.status, 404);
    assert.equal(badRec.code, "NOT_FOUND");
  } finally { await api.close(); }
});

test("an inbound x-request-id is honoured (correlation across services)", async () => {
  const lines: any[] = [];
  const logger = createLogger({ level: "debug", sink: (l) => lines.push(JSON.parse(l)) });
  const api = await startTestApi({ depsOverrides: { logger } });
  try {
    const res = await fetch(`${api.baseUrl}/api/v1/deposits/paybill/info`, { headers: { "x-request-id": "corr-123" } });
    assert.equal(res.headers.get("x-request-id"), "corr-123");
    assert.ok(lines.find((l) => l.requestId === "corr-123"));
  } finally { await api.close(); }
});
