import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, type TestApi } from "./testutil.js";
import type { LiveSession, LiveSessionStore, LiveSettings } from "./livesessions.pg.js";

/**
 * The live-session routes are gated by the gate the MARKETER DASHBOARD authenticates through, and
 * they hand the store a `profiles.id`.
 *
 * This is a regression test for a bug that made the whole feature invisible. There are two things
 * called a marketer here: `public.marketers` (the field-agent till app, its own table and PIN
 * login, token subject = `marketers.id`) and a `profiles` row with role='marketer' (the affiliate
 * who earns `deposit_commissions` and reads /dashboard). The routes were first written beside the
 * till app's, behind `requireMarketer` — so the dashboard's own marketer got 403 NOT_MARKETER, the
 * panel rendered nothing, and Start Live never appeared. Everything a session touches
 * (`marketer_live_sessions.marketer_id`, `community_posts.author_id`,
 * `deposit_commissions.beneficiary_user`) is a `profiles.id`, so the id passed through is asserted
 * here too — a till-app id would have failed the foreign key with a 500.
 */

const SETTINGS: LiveSettings = {
  enabled: true, sessionMinutes: 60, marginMinutes: 10, extendMinutes: 30, maxSessionsDaily: 0,
};

/** Records which (siteId, marketerId) each call received, so the test can assert the identity. */
function spyStore() {
  const calls: Array<{ op: string; siteId: string; marketerId: string }> = [];
  const session = (id: string): LiveSession => ({
    id, startedAt: new Date().toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString(),
    endedAt: null, streamUrl: null, marginMinutes: 10, live: true, earnedCents: 0, deposits: 0,
  });
  const store: LiveSessionStore = {
    settings: async () => SETTINGS,
    saveSettings: async (_s, p) => ({ ...SETTINGS, ...p }),
    current: async (siteId, marketerId) => { calls.push({ op: "current", siteId, marketerId }); return null; },
    start: async (siteId, marketerId) => { calls.push({ op: "start", siteId, marketerId }); return session("s1"); },
    end: async (siteId, marketerId) => { calls.push({ op: "end", siteId, marketerId }); return session("s1"); },
    extend: async (siteId, marketerId) => { calls.push({ op: "extend", siteId, marketerId }); return session("s1"); },
    history: async (siteId, marketerId) => { calls.push({ op: "history", siteId, marketerId }); return []; },
  };
  return { store, calls };
}

const json = (res: Response): Promise<any> => res.json() as Promise<any>;

function req(api: TestApi, method: string, path: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;
  return fetch(`${api.baseUrl}${path}`, { method, headers });
}

async function marketer(api: TestApi): Promise<string> {
  const res = await fetch(`${api.baseUrl}/api/v1/auth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone: "0712345678", username: "alice", password: "1234" }),
  });
  assert.equal(res.status, 201);
  const userId = (await json(res)).userId as string;
  assert.equal((await req(api, "POST", "/api/v1/affiliate/enroll", userId)).status, 200);
  return userId;
}

test("affiliate live sessions: the dashboard's marketer reaches them, and the store gets that marketer's own id", async () => {
  const { store, calls } = spyStore();
  const api = await startTestApi({ depsOverrides: { liveSessions: store } });
  try {
    const userId = await marketer(api);
    const token = `${userId}:marketer`;

    const view = await req(api, "GET", "/api/v1/affiliate/live", token);
    assert.equal(view.status, 200, "the dashboard's own marketer is let in (was 403 NOT_MARKETER)");
    const body = await json(view);
    assert.equal(body.settings.enabled, true, "the brand's rules come back, which is what un-hides the panel");

    assert.equal((await req(api, "POST", "/api/v1/affiliate/live/start", token)).status, 200);
    assert.equal((await req(api, "POST", "/api/v1/affiliate/live/extend", token)).status, 200);
    assert.equal((await req(api, "POST", "/api/v1/affiliate/live/end", token)).status, 200);

    // EVERY call carries the caller's profiles.id — the id marketer_live_sessions.marketer_id,
    // community_posts.author_id and deposit_commissions.beneficiary_user all reference.
    assert.ok(calls.length >= 5, "every route reached the store");
    for (const c of calls) assert.equal(c.marketerId, userId, `${c.op} keyed by the profile id`);
  } finally { await api.close(); }
});

test("affiliate live sessions: a plain player is refused, and an unconfigured store answers 503", async () => {
  const { store } = spyStore();
  const api = await startTestApi({ depsOverrides: { liveSessions: store } });
  try {
    const res = await fetch(`${api.baseUrl}/api/v1/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "0722000000", username: "bob", password: "1234" }),
    });
    const playerId = (await json(res)).userId as string;
    assert.equal((await req(api, "GET", "/api/v1/affiliate/live", playerId)).status, 403, "a player is not a marketer");
    assert.equal((await req(api, "POST", "/api/v1/affiliate/live/start", playerId)).status, 403);
    assert.equal((await req(api, "GET", "/api/v1/affiliate/live")).status, 401, "and no token is 401");
  } finally { await api.close(); }

  // Without the store the routes refuse with a 503 rather than a 500 — an app that never wired it
  // keeps working, which is why `liveSessions` is optional on ApiDeps.
  const bare = await startTestApi();
  try {
    const userId = await marketer(bare);
    assert.equal((await req(bare, "GET", "/api/v1/affiliate/live", `${userId}:marketer`)).status, 503);
  } finally { await bare.close(); }
});
