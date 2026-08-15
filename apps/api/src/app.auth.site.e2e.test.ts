import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, SITE_A, SITE_B, type TestApi } from "./testutil.js";

/**
 * GAP 1 END-TO-END — brand-scoped register/login through the real HTTP API.
 *
 * The platform runs ONE shared API host for every brand domain, so a browser on tamutraders.com
 * never reveals its brand to the API by itself. The web therefore resolves its brand server-side
 * (GET /site/brand) and passes it back explicitly as `site` on every register/login call
 * (apps/web/src/lib/auth/useAuthActions.ts). These tests prove the API half of that contract:
 * `site` (slug|domain, any case) → the correct `site_id`, stamped into BOTH the response and the
 * issued JWT's `site` claim, with per-site identity isolation and safe fallbacks.
 *
 * Harness note: the API issues a real HS256 JWT while the test verifier is a stub, so we read the
 * `site` claim straight off the token (base64url-decode the payload) to prove resolveSiteId → the
 * minted claim end-to-end, exactly as the live verifier would see it.
 */

const json = (r: Response): Promise<any> => r.json() as Promise<any>;

function post(api: TestApi, path: string, body: unknown): Promise<Response> {
  return fetch(`${api.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Decode a JWT payload without verifying (the harness verifier is a stub; the token is a real JWT). */
function claims(token: string): Record<string, any> {
  const seg = token.split(".")[1];
  assert.ok(seg, "token must be a JWT with a payload segment");
  return JSON.parse(Buffer.from(seg, "base64url").toString("utf8")) as Record<string, any>;
}

const REG = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  phone: "0712345678", username: "alice", password: "Password1", ...over,
});

// ── register: brand resolution + claim stamping ──────────────────────────────────────────────
test("register with site=<slug> scopes the account and stamps the JWT site claim", async () => {
  const api = await startTestApi();
  try {
    const res = await post(api, "/api/v1/auth/register", REG({ site: "brandb" }));
    assert.equal(res.status, 201);
    const b = await json(res);
    assert.equal(b.role, "player");
    assert.equal(b.site, SITE_B, "response echoes the scoped brand");
    assert.equal(claims(b.token).site, SITE_B, "issued token binds to Brand B");
  } finally { await api.close(); }
});

test("register with site=<primary_domain> resolves the same brand", async () => {
  const api = await startTestApi();
  try {
    const b = await json(await post(api, "/api/v1/auth/register", REG({ site: "brandb.example" })));
    assert.equal(b.site, SITE_B);
    assert.equal(claims(b.token).site, SITE_B);
  } finally { await api.close(); }
});

test("register with site is case-insensitive", async () => {
  const api = await startTestApi();
  try {
    const b = await json(await post(api, "/api/v1/auth/register", REG({ site: "BRANDB" })));
    assert.equal(b.site, SITE_B);
    assert.equal(claims(b.token).site, SITE_B);
  } finally { await api.close(); }
});

test("register with site=<default slug> stamps the default site explicitly", async () => {
  const api = await startTestApi();
  try {
    const b = await json(await post(api, "/api/v1/auth/register", REG({ site: "invest254" })));
    assert.equal(b.site, SITE_A);
    assert.equal(claims(b.token).site, SITE_A);
  } finally { await api.close(); }
});

test("register without a brand ref → default site, token carries no site claim (legacy behaviour)", async () => {
  const api = await startTestApi();
  try {
    const b = await json(await post(api, "/api/v1/auth/register", REG()));
    assert.equal(b.site, undefined, "no brand ref → response omits site");
    assert.equal(claims(b.token).site, undefined, "no brand ref → no site claim");
  } finally { await api.close(); }
});

// ── login: brand scoping ─────────────────────────────────────────────────────────────────────
test("login with site=<slug> returns a brand-scoped token", async () => {
  const api = await startTestApi();
  try {
    await post(api, "/api/v1/auth/register", REG({ phone: "0712000333", username: "loginb", site: "brandb" }));
    const res = await post(api, "/api/v1/auth/login", { phone: "0712000333", password: "Password1", site: "brandb" });
    assert.equal(res.status, 200);
    const b = await json(res);
    assert.equal(b.site, SITE_B);
    assert.equal(claims(b.token).site, SITE_B);
  } finally { await api.close(); }
});

test("login into the wrong brand fails; the correct brand succeeds (per-site credentials)", async () => {
  const api = await startTestApi();
  try {
    await post(api, "/api/v1/auth/register", REG({ phone: "0712000444", username: "brandbonly", site: "brandb" }));
    const wrong = await post(api, "/api/v1/auth/login", { phone: "0712000444", password: "Password1", site: "invest254" });
    assert.equal(wrong.status, 401, "same phone/password but a different brand is a different account");
    assert.equal((await json(wrong)).error.code, "INVALID_CREDENTIALS");
    const right = await post(api, "/api/v1/auth/login", { phone: "0712000444", password: "Password1", site: "brandb" });
    assert.equal(right.status, 200);
    assert.equal((await json(right)).site, SITE_B);
  } finally { await api.close(); }
});

// ── per-site identity isolation ──────────────────────────────────────────────────────────────
test("per-site identity: the same phone registers independently on two brands", async () => {
  const api = await startTestApi();
  try {
    const a = await post(api, "/api/v1/auth/register", REG({ phone: "0712000222", username: "samep", site: "invest254" }));
    assert.equal(a.status, 201);
    assert.equal(claims((await json(a)).token).site, SITE_A);

    const b = await post(api, "/api/v1/auth/register", REG({ phone: "0712000222", username: "samep", site: "brandb" }));
    assert.equal(b.status, 201, "the same phone can register on a different brand");
    assert.equal((await json(b)).site, SITE_B);

    const dup = await post(api, "/api/v1/auth/register", REG({ phone: "0712000222", username: "other", site: "brandb" }));
    assert.equal(dup.status, 409, "re-registering that phone on the SAME brand is rejected");
    assert.equal((await json(dup)).error.code, "PHONE_TAKEN");
  } finally { await api.close(); }
});

// ── robustness + backward compatibility ──────────────────────────────────────────────────────
test("unknown brand ref falls back to the default site (never trusts client input, never 500s)", async () => {
  const api = await startTestApi();
  try {
    const res = await post(api, "/api/v1/auth/register", REG({ phone: "0712000555", username: "nobrand", site: "does-not-exist.example" }));
    assert.equal(res.status, 201);
    const b = await json(res);
    assert.equal(b.site, undefined, "unknown ref → no scoped brand");
    assert.equal(claims(b.token).site, undefined);
  } finally { await api.close(); }
});

test("host still resolves the brand (backward compat) and explicit site wins over host", async () => {
  const api = await startTestApi();
  try {
    const h = await json(await post(api, "/api/v1/auth/register", REG({ phone: "0712000666", username: "hostb", host: "brandb.example" })));
    assert.equal(h.site, SITE_B, "legacy host-only path keeps working");
    assert.equal(claims(h.token).site, SITE_B);

    const both = await json(await post(api, "/api/v1/auth/register", REG({ phone: "0712000777", username: "bothb", site: "brandb", host: "invest254.com" })));
    assert.equal(both.site, SITE_B, "explicit site takes priority over host");
    assert.equal(claims(both.token).site, SITE_B);
  } finally { await api.close(); }
});
