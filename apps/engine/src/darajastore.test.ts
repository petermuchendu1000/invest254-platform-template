import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeDarajaClientFromConfig, missingDarajaCredentials,
  StubDarajaClient, HttpDarajaClient, UnconfiguredDarajaClient,
  type DarajaConfig,
} from "./daraja.js";
import { DarajaConfigStore } from "./darajastore.js";
import type { Querier } from "./wallet.js";
import type { ListenClient } from "./gameconfig.js";

// ── Fixtures ────────────────────────────────────────────────────────────────
const FULL_CFG: DarajaConfig = {
  env: "production", consumerKey: "k", consumerSecret: "s", shortcode: "4267946", passkey: "pk",
  stkCallbackUrl: "https://cb", b2cInitiator: "init", b2cSecurityCredential: "sec",
  b2cResultUrl: "https://r", b2cTimeoutUrl: "https://t",
};

/** A mpesa_config DB row (snake_case, matching loadDarajaConfigFromDb's SELECT). */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    environment: "production", shortcode: "4267946", consumer_key: "k", consumer_secret: "s",
    passkey: "pk", stk_callback_url: "https://cb", b2c_initiator: "init",
    b2c_security_credential: "sec", b2c_result_url: "https://r", b2c_timeout_url: "https://t",
    ...over,
  };
}

class FakeQuerier implements Querier {
  queries = 0;
  constructor(public current: Record<string, unknown> | null) {}
  async query(text: string, _params: unknown[]): Promise<{ rows: any[] }> {
    if (/from\s+mpesa_config/i.test(text)) {
      this.queries += 1;
      return { rows: this.current ? [this.current] : [] };
    }
    return { rows: [] };
  }
}

class FakeListen implements ListenClient {
  handlers: Record<string, (msg: { channel: string; payload?: string }) => void> = {};
  listened: string[] = [];
  async query(sql: string, _params?: unknown[]): Promise<unknown> { this.listened.push(sql); return { rows: [] }; }
  on(event: "notification" | "error", cb: any): unknown { this.handlers[event] = cb; return this; }
  release(): void { /* noop */ }
  fire(channel: string): void { this.handlers["notification"]?.({ channel }); }
}

const tick = () => new Promise((r) => setImmediate(r));

// ── Production guard (Fix 2) ──────────────────────────────────────────────────

test("missingDarajaCredentials lists exactly the empty required fields", () => {
  assert.deepEqual(missingDarajaCredentials(FULL_CFG), []);
  assert.deepEqual(
    missingDarajaCredentials({ ...FULL_CFG, passkey: "" }),
    ["passkey"],
  );
  assert.deepEqual(
    missingDarajaCredentials({ ...FULL_CFG, consumerKey: "", shortcode: "" }),
    ["consumerKey", "shortcode"],
  );
});

test("makeDarajaClientFromConfig: production + incomplete => UnconfiguredDarajaClient that FAILS LOUDLY (never a stub)", async () => {
  const c = makeDarajaClientFromConfig(
    { env: "production", consumerKey: "k", consumerSecret: "s", shortcode: "4267946" /* no passkey */ },
    {} as NodeJS.ProcessEnv,
  );
  assert.ok(c instanceof UnconfiguredDarajaClient);
  assert.ok(!(c instanceof StubDarajaClient));
  await assert.rejects(() => c.stkPush({ amountCents: 5_000, msisdn: "254712345678", accountRef: "Invest254", desc: "Deposit" }), /MPESA_NOT_CONFIGURED:passkey/);
  await assert.rejects(() => c.stkPushQuery("co-x"), /MPESA_NOT_CONFIGURED/);
  await assert.rejects(() => c.b2cPayment({ amountCents: 20_000, msisdn: "254712345678", remarks: "w" }), /MPESA_NOT_CONFIGURED/);
});

test("makeDarajaClientFromConfig: sandbox/dev + incomplete => StubDarajaClient (deterministic, offline)", () => {
  assert.ok(makeDarajaClientFromConfig({}, {} as NodeJS.ProcessEnv) instanceof StubDarajaClient); // env defaults to sandbox
  assert.ok(makeDarajaClientFromConfig({ env: "sandbox", consumerKey: "k" }, {} as NodeJS.ProcessEnv) instanceof StubDarajaClient);
});

test("makeDarajaClientFromConfig: complete => HttpDarajaClient (both envs)", () => {
  assert.ok(makeDarajaClientFromConfig(FULL_CFG, {} as NodeJS.ProcessEnv) instanceof HttpDarajaClient);
  assert.ok(makeDarajaClientFromConfig({ ...FULL_CFG, env: "sandbox" }, {} as NodeJS.ProcessEnv) instanceof HttpDarajaClient);
});

// ── DarajaConfigStore live reload (Fix 1) ─────────────────────────────────────

test("DarajaConfigStore.init loads DB config and builds the real client when complete", async () => {
  const q = new FakeQuerier(row());
  const store = new DarajaConfigStore(q, { pollMs: 0, env: {} as NodeJS.ProcessEnv });
  await store.init();
  assert.equal(store.isLoaded(), true);
  assert.equal(store.client().constructor.name, "HttpDarajaClient");
  store.stop();
});

test("DarajaConfigStore: production row missing passkey => delegated calls fail with MPESA_NOT_CONFIGURED", async () => {
  const q = new FakeQuerier(row({ passkey: "" }));
  const store = new DarajaConfigStore(q, { pollMs: 0, env: {} as NodeJS.ProcessEnv });
  await store.init();
  assert.equal(store.client().constructor.name, "UnconfiguredDarajaClient");
  await assert.rejects(() => store.stkPush({ amountCents: 5_000, msisdn: "254712345678", accountRef: "Invest254", desc: "Deposit" }), /MPESA_NOT_CONFIGURED:passkey/);
  // The reconciliation path must NOT be able to fake a paid status.
  await assert.rejects(() => store.stkPushQuery("co-x"), /MPESA_NOT_CONFIGURED/);
  store.stop();
});

test("DarajaConfigStore.refresh hot-swaps the client when the passkey is added (the real fix)", async () => {
  const q = new FakeQuerier(row({ passkey: "" }));
  const store = new DarajaConfigStore(q, { pollMs: 0, env: {} as NodeJS.ProcessEnv });
  await store.init();
  assert.equal(store.client().constructor.name, "UnconfiguredDarajaClient");
  // Admin sets the matching Lipa na M-Pesa passkey for shortcode 4267946.
  q.current = row({ passkey: "the-real-passkey" });
  await store.refresh();
  assert.equal(store.client().constructor.name, "HttpDarajaClient"); // now real, no redeploy needed
  store.stop();
});

test("DarajaConfigStore.refresh is a no-op when the config is unchanged (stable client instance)", async () => {
  const q = new FakeQuerier(row());
  const store = new DarajaConfigStore(q, { pollMs: 0, env: {} as NodeJS.ProcessEnv });
  await store.init();
  const c1 = store.client();
  await store.refresh();
  await store.refresh();
  assert.equal(store.client(), c1); // same instance — no needless rebuild (preserves OAuth token cache)
  store.stop();
});

test("DarajaConfigStore: a LISTEN notification triggers a re-read and swap", async () => {
  const q = new FakeQuerier(row({ passkey: "" }));
  const listen = new FakeListen();
  const store = new DarajaConfigStore(q, { pollMs: 0, env: {} as NodeJS.ProcessEnv, connect: async () => listen });
  await store.init();
  await tick(); // let startListening arm
  assert.ok(listen.listened.some((s) => /listen\s+mpesa_config_changed/i.test(s)));
  assert.equal(store.client().constructor.name, "UnconfiguredDarajaClient");
  const before = q.queries;
  // Admin edits the row; DB trigger fires pg_notify -> our handler must re-read.
  q.current = row({ passkey: "pk" });
  listen.fire("mpesa_config_changed");
  await tick();
  await store.refresh(); // ensure the fire-and-forget refresh settled
  assert.ok(q.queries > before, "notification should have caused a fresh DB read");
  assert.equal(store.client().constructor.name, "HttpDarajaClient");
  store.stop();
});

test("DarajaConfigStore: a notification on an unrelated channel is ignored", async () => {
  const q = new FakeQuerier(row());
  const listen = new FakeListen();
  const store = new DarajaConfigStore(q, { pollMs: 0, env: {} as NodeJS.ProcessEnv, connect: async () => listen });
  await store.init();
  await tick();
  const before = q.queries;
  listen.fire("some_other_channel");
  await tick();
  assert.equal(q.queries, before, "unrelated channel must not trigger a re-read");
  store.stop();
});
