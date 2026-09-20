import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_ADMIN, SITE_A, type TestApi } from "./testutil.js";

/**
 * Issue 1 #3 — per-platform registrar (Namecheap) config API surface.
 * Verifies the endpoints are wired, gated to platform admins (+ system owner), and that the GET
 * returns the autofilled egress IP to whitelist and never echoes the saved API key. (Cross-platform
 * scoping + encryption-at-rest are proven at the DB layer by e2e_registrar_config.py.)
 * Token scheme: <userId>:<role>:<siteId>:<platformId>.
 */
const json = (r: Response): Promise<any> => r.json() as Promise<any>;
function reqf(api: TestApi, method: string, path: string, token: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const init: RequestInit = { method, headers };
  if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  return fetch(`${api.baseUrl}${path}`, init);
}
const CFG = "/api/v1/platform/registrar/config";
const PA1        = `${TEST_ADMIN}:platform_admin:${SITE_A}:plat-1`;
const SITE_ADMIN = `${TEST_ADMIN}:admin:${SITE_A}`;
const SYSTEM     = `${TEST_ADMIN}:platform_superadmin`;
const PLAYER     = `${TEST_ADMIN}:player:${SITE_A}`;

test("registrar config: platform admin reads/writes its own; egress IP returned; secret never echoed", async () => {
  const api = await startTestApi();
  try {
    // GET (empty)
    let r = await reqf(api, "GET", CFG, PA1);
    assert.equal(r.status, 200, "platform admin may read");
    let b = await json(r);
    assert.equal(b.exists, false, "no config yet");
    assert.equal(typeof b.egressIp, "string", "egress IP to whitelist is autofilled");
    assert.equal(b.encryptionConfigured, true, "encryption configured flag present");

    // PUT save
    r = await reqf(api, "PUT", CFG, PA1, { apiUser: "muchendu", userName: "muchendu", apiKey: "SUPERSECRETKEY-9f8c98cb860" });
    assert.equal(r.status, 200, "platform admin may write");
    b = await json(r);
    assert.equal(b.hasSecret, true, "secret stored");

    // GET reflects saved settings + masked secret, never the key itself
    r = await reqf(api, "GET", CFG, PA1); b = await json(r);
    assert.equal(b.exists, true);
    assert.equal(b.hasSecret, true);
    assert.equal(b.settings.api_user, "muchendu");
    assert.ok(!JSON.stringify(b).includes("SUPERSECRETKEY"), "API key is never returned to the client");

    // Test-connection endpoint is reachable and returns a structured result
    r = await reqf(api, "POST", `${CFG}/test`, PA1, { apiUser: "muchendu", apiKey: "k" });
    assert.equal(r.status, 200);
    b = await json(r);
    assert.equal(typeof b.ok, "boolean");
    assert.equal(typeof b.egressIp, "string");

    // System owner may also read (targets default platform)
    assert.equal((await reqf(api, "GET", CFG, SYSTEM)).status, 200, "system owner may read");

    // Lower roles are denied the registrar surface
    assert.equal((await reqf(api, "GET", CFG, SITE_ADMIN)).status, 403, "site admin denied");
    assert.equal((await reqf(api, "GET", CFG, PLAYER)).status, 403, "player denied");
  } finally { await api.close(); }
});
