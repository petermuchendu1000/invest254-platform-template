import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "@invest254/shared";
import { SiteGameConfigStore, SITE_CONFIG_CHANNEL, type ListenClient } from "./gameconfig.js";
import type { Querier } from "./wallet.js";

const SITE = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

/** Build a `site_game_config`-shaped DB row (same columns as game_config) from a partial override. */
function row(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    house_edge: "0.75", max_multiplier: "5.0", min_stake: "25000", max_stake: "5000000",
    min_withdrawal: "25000", default_duration_s: 10, tick_rate_ms: 150, drift_bias: "0.3",
    volatility: "1.0", target_win_rate: "0.125", version: "1", ...over,
  };
}

/**
 * Fake Querier for ONE brand's site config, mirroring the shape migration 0046 creates.
 * Asserts every query is scoped by this brand's site_id (params[0]) — a cross-site read is a bug.
 */
function fakeSiteDb(siteId: string, initial = row()) {
  const state = { current: initial, history: new Map<number, Record<string, unknown>>() };
  state.history.set(Number(initial.version), initial);
  const q: Querier = {
    async query(text: string, params: unknown[] = []) {
      assert.equal(params[0], siteId, "site config query must be scoped to the store's site_id");
      if (text.includes("from site_game_config_versions")) {
        const hit = state.history.get(Number(params[1]));
        return { rows: hit ? [hit] : [] };
      }
      if (text.includes("from site_game_config")) return { rows: [state.current] };
      return { rows: [] };
    },
  };
  const save = (over: Record<string, unknown>) => {
    const next = { ...state.current, ...over, version: String(Number(state.current.version) + 1) };
    state.current = next;
    state.history.set(Number(next.version), next);
    return next;
  };
  return { q, state, save };
}

/** Fake LISTEN client: captures the store's handlers and lets a test emit a NOTIFY. */
function fakeListen() {
  let onNote: ((m: { channel: string; payload?: string }) => void) | undefined;
  const client: ListenClient = {
    async query() { return { rows: [] }; },
    on(event: string, cb: (arg: never) => void) {
      if (event === "notification") onNote = cb as (m: { channel: string; payload?: string }) => void;
      return client;
    },
    release() {},
  };
  const ready = async () => { for (let i = 0; i < 50 && !onNote; i++) await new Promise((r) => setTimeout(r, 2)); };
  const emit = (payload: string) => onNote?.({ channel: SITE_CONFIG_CHANNEL, payload });
  return { connect: async () => client, ready, emit };
}

test("site config store: loads THIS brand's site_game_config row (not DEFAULT_CONFIG)", async () => {
  const { q } = fakeSiteDb(SITE, row({
    house_edge: "0.05", max_multiplier: "12", min_stake: "10000", target_win_rate: "0.2", version: "7",
  }));
  const store = new SiteGameConfigStore(SITE, q, { pollMs: 0 });
  const cfg = await store.init();
  try {
    assert.equal(cfg.version, 7);
    assert.equal(cfg.houseEdge, 0.05);
    assert.equal(cfg.maxMultiplier, 12);
    assert.equal(cfg.minStakeCents, 10000);
    assert.equal(cfg.targetWinRate, 0.2);
    assert.notDeepEqual({ ...cfg, version: undefined }, { ...DEFAULT_CONFIG, version: undefined });
  } finally { store.stop(); }
});

test("site config store: refresh picks up a saved change and notifies subscribers (idempotent)", async () => {
  const { q, save } = fakeSiteDb(SITE);
  const store = new SiteGameConfigStore(SITE, q, { pollMs: 0 });
  await store.init();
  try {
    const seen: { from: number; to: number }[] = [];
    store.subscribe((next, prev) => seen.push({ from: prev.version, to: next.version }));
    save({ tick_rate_ms: 500, min_stake: "50000" });
    await store.refresh();
    assert.equal(store.active().version, 2);
    assert.equal(store.active().tickRateMs, 500);
    assert.equal(store.active().minStakeCents, 50000);
    assert.deepEqual(seen, [{ from: 1, to: 2 }]);
    await store.refresh();               // same version -> no re-notify
    assert.equal(seen.length, 1);
  } finally { store.stop(); }
});

test("site config store: an infeasible per-brand config is rejected; last good stays live", async () => {
  const { q, save } = fakeSiteDb(SITE);
  const errors: string[] = [];
  const store = new SiteGameConfigStore(SITE, q, { pollMs: 0, onError: (e, ctx) => errors.push(`${ctx}: ${e.message}`) });
  await store.init();
  try {
    save({ target_win_rate: "0.01" });   // RTP 0.25 @ 1% win => mean multiple 25 > cap 5 => infeasible
    await store.refresh();
    assert.equal(store.active().version, 1, "must keep serving the last solvable config");
    assert.equal(store.active().targetWinRate, 0.125);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /rejected site_game_config v2/);
    assert.match(errors[0]!, /site 1111/);
  } finally { store.stop(); }
});

test("site config store: forVersion resolves this brand's history", async () => {
  const { q, save } = fakeSiteDb(SITE);
  const store = new SiteGameConfigStore(SITE, q, { pollMs: 0 });
  await store.init();
  try {
    save({ volatility: "2.0" });
    await store.refresh();
    assert.equal(store.active().version, 2);
    const v1 = await store.forVersion(1);
    assert.equal(v1.version, 1);
    assert.equal(v1.volatility, 1.0);    // old position re-prices under the version it opened with
  } finally { store.stop(); }
});

test("site config store: NOTIFY for THIS brand refreshes; another brand's payload is ignored", async () => {
  const { q, save } = fakeSiteDb(SITE);
  const listen = fakeListen();
  const store = new SiteGameConfigStore(SITE, q, { pollMs: 0, connect: listen.connect });
  await store.init();
  await listen.ready();
  try {
    assert.equal(store.active().version, 1);
    // A different brand changed -> our store must NOT refresh.
    save({ tick_rate_ms: 999 });
    listen.emit(OTHER);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(store.active().version, 1, "another brand's NOTIFY must be ignored");
    // Our brand changed -> refresh on the push.
    listen.emit(SITE);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(store.active().version, 2);
    assert.equal(store.active().tickRateMs, 999);
  } finally { store.stop(); }
});
