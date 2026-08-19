import { test } from "node:test";
import assert from "node:assert/strict";
import { SitesStore, SITES_CHANNEL } from "./sitesstore.js";
import type { Querier } from "./wallet.js";

/** Mutable in-memory `sites` table + a Querier that answers SitesStore's two queries. */
function fakeSites(initial: Array<{ id: string; pool_mode: boolean; status?: string }>) {
  const rows = new Map<string, { id: string; pool_mode: boolean; status: string }>();
  for (const s of initial) rows.set(s.id, { id: s.id, pool_mode: s.pool_mode, status: s.status ?? "active" });
  const q: Querier = {
    async query(text: string, params: unknown[]) {
      if (text.includes("where status = 'active'")) {
        return { rows: [...rows.values()].filter((r) => r.status === "active").map((r) => ({ id: r.id, pool_mode: r.pool_mode })) };
      }
      if (text.includes("where id = $1")) {
        const r = rows.get(String(params[0]));
        return { rows: r ? [{ pool_mode: r.pool_mode, status: r.status }] : [] };
      }
      return { rows: [] };
    },
  };
  const set = (id: string, patch: Partial<{ pool_mode: boolean; status: string }>) => {
    const cur = rows.get(id) ?? { id, pool_mode: false, status: "active" };
    rows.set(id, { ...cur, ...patch });
  };
  return { q, set };
}

/** Fake LISTEN client that lets the test push notifications. */
function fakeListen() {
  let notifyCb: ((m: { channel: string; payload?: string }) => void) | undefined;
  const client = {
    async query(_sql: string) { return {}; },
    on(event: string, cb: any) { if (event === "notification") notifyCb = cb; return client; },
    release() { /* noop */ },
  };
  return { connect: async () => client as any, notify: (payload: string) => notifyCb?.({ channel: SITES_CHANNEL, payload }) };
}

test("SitesStore: loads pool_mode for active brands (poll path)", async () => {
  const { q } = fakeSites([{ id: "A", pool_mode: true }, { id: "B", pool_mode: false }, { id: "C", pool_mode: true, status: "suspended" }]);
  const s = new SitesStore(q, { pollMs: 0 });
  await s.init();
  try {
    assert.equal(s.poolModeFor("A"), true);
    assert.equal(s.poolModeFor("B"), false);
    assert.equal(s.poolModeFor("C"), false, "non-active brand is not pool-mode");
    assert.equal(s.poolModeFor("unknown"), false);
    assert.equal(s.poolModeBrandCount(), 1);
  } finally { s.stop(); }
});

test("SitesStore: a LIVE toggle applies via notification (no redeploy) + onChange fires", async () => {
  const { q, set } = fakeSites([{ id: "A", pool_mode: false }]);
  const fl = fakeListen();
  const changes: Array<[string, boolean]> = [];
  const s = new SitesStore(q, { pollMs: 0, connect: fl.connect, onChange: (id, pm) => changes.push([id, pm]) });
  await s.init();
  try {
    assert.equal(s.poolModeFor("A"), false);
    set("A", { pool_mode: true });           // operator flips it ON in the DB
    await fl.notify("A");                     // trigger fires pg_notify('sites_changed','A')
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(s.poolModeFor("A"), true, "toggle picked up live");
    set("A", { pool_mode: false });
    await fl.notify("A");
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(s.poolModeFor("A"), false, "toggle OFF picked up live");
    assert.deepEqual(changes, [["A", true], ["A", false]], "onChange fired for each real flip");
  } finally { s.stop(); }
});

test("SitesStore: a NEW brand onboarded after boot is picked up on notify", async () => {
  const { q, set } = fakeSites([{ id: "A", pool_mode: true }]);
  const fl = fakeListen();
  const s = new SitesStore(q, { pollMs: 0, connect: fl.connect });
  await s.init();
  try {
    assert.equal(s.poolModeFor("NEW"), false);
    set("NEW", { pool_mode: true, status: "active" });  // brand inserted after boot
    await fl.notify("NEW");
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(s.poolModeFor("NEW"), true, "new brand's pool_mode is live");
  } finally { s.stop(); }
});

test("SitesStore: a brand set inactive is removed from the pool-mode set", async () => {
  const { q, set } = fakeSites([{ id: "A", pool_mode: true }]);
  const fl = fakeListen();
  const s = new SitesStore(q, { pollMs: 0, connect: fl.connect });
  await s.init();
  try {
    assert.equal(s.poolModeFor("A"), true);
    set("A", { status: "suspended" });
    await fl.notify("A");
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(s.poolModeFor("A"), false, "suspended brand no longer pool-mode");
  } finally { s.stop(); }
});

test("SitesStore: poll fallback re-reads all brands", async () => {
  const { q, set } = fakeSites([{ id: "A", pool_mode: false }]);
  const s = new SitesStore(q, { pollMs: 10 });  // no LISTEN; poll only
  await s.init();
  try {
    assert.equal(s.poolModeFor("A"), false);
    set("A", { pool_mode: true });
    await new Promise((r) => setTimeout(r, 25));  // let a poll cycle run
    assert.equal(s.poolModeFor("A"), true, "poll fallback picked up the change");
  } finally { s.stop(); }
});
