import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi } from "./testutil.js";

/**
 * Issue 3 — information-disclosure hardening on the HTTP edge.
 * These lock in that the API does not reflect attacker-supplied paths, does not advertise the
 * dev-auth headers, and marks responses no-store.
 */
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

test("404 does not reflect the requested path and is generic", async () => {
  const api = await startTestApi();
  try {
    const res = await fetch(`${api.baseUrl}/api/v1/this-route-does-not-exist-<script>`);
    assert.equal(res.status, 404);
    const body = await json(res);
    assert.equal(body.error.code, "NOT_FOUND");
    assert.doesNotMatch(JSON.stringify(body), /this-route-does-not-exist/, "must not echo the path back");
    assert.doesNotMatch(JSON.stringify(body), /script/);
  } finally { await api.close(); }
});

test("405 keeps its status + code but does not reflect method/path", async () => {
  const api = await startTestApi();
  try {
    const res = await fetch(`${api.baseUrl}/api/v1/health`, { method: "POST" });
    assert.equal(res.status, 405);
    const body = await json(res);
    assert.equal(body.error.code, "METHOD_NOT_ALLOWED");
    assert.doesNotMatch(JSON.stringify(body), /\/api\/v1\/health/, "must not echo the path");
  } finally { await api.close(); }
});

test("JSON responses are marked no-store", async () => {
  const api = await startTestApi();
  try {
    const res = await fetch(`${api.baseUrl}/api/v1/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
  } finally { await api.close(); }
});

test("CORS no longer advertises the dev-auth headers", async () => {
  const api = await startTestApi();
  try {
    const res = await fetch(`${api.baseUrl}/api/v1/health`, {
      method: "OPTIONS", headers: { origin: "https://example.com" },
    });
    const allow = res.headers.get("access-control-allow-headers") ?? "";
    assert.match(allow, /Authorization/);
    assert.match(allow, /Content-Type/);
    assert.doesNotMatch(allow, /X-User-Id/i, "dev-auth header must not be advertised");
    assert.doesNotMatch(allow, /X-User-Role/i);
  } finally { await api.close(); }
});

test("GET /site/brand for an unknown host does not reflect the host", async () => {
  const api = await startTestApi();
  try {
    const res = await fetch(`${api.baseUrl}/api/v1/site/brand?host=${encodeURIComponent("evil-<probe>.example")}`);
    assert.equal(res.status, 404);
    const body = await json(res);
    assert.equal(body.error.code, "SITE_NOT_FOUND");
    assert.doesNotMatch(JSON.stringify(body), /evil-|probe/, "must not echo the supplied host");
  } finally { await api.close(); }
});
