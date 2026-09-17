import { test } from "node:test";
import assert from "node:assert/strict";
import { SharedSiteConfigListener } from "./siteconfiglisten.js";
import { SITE_CONFIG_CHANNEL, type ListenClient } from "./gameconfig.js";

/** A fake LISTEN client that records `listen` + lets a test push notifications/errors. */
function fakeClient() {
  let notify: ((msg: { channel: string; payload?: string }) => void) | undefined;
  let onErr: ((e: Error) => void) | undefined;
  const c: ListenClient & { emit(payload?: string): void; fail(e: Error): void; released: boolean; listened: string[] } = {
    listened: [],
    released: false,
    query: async (sql: string) => { if (/^listen /i.test(sql)) c.listened.push(sql.replace(/^listen\s+/i, "")); return {}; },
    on: (event: "notification" | "error", cb: never) => { if (event === "notification") notify = cb as never; else onErr = cb as never; return c; },
    release: () => { c.released = true; },
    emit: (payload?: string) => notify?.(payload === undefined ? { channel: SITE_CONFIG_CHANNEL } : { channel: SITE_CONFIG_CHANNEL, payload }),
    fail: (e: Error) => onErr?.(e),
  };
  return c;
}
const flush = () => new Promise((r) => setImmediate(r));

test("opens ONE connection for many brands and dispatches by payload", async () => {
  const client = fakeClient();
  let connects = 0;
  const L = new SharedSiteConfigListener({ connect: async () => { connects++; return client; }, onError: () => {} });
  const hits: Record<string, number> = { A: 0, B: 0, C: 0 };
  L.register("A", () => { hits.A!++; });
  L.register("B", () => { hits.B!++; });
  L.register("C", () => { hits.C!++; });
  await flush();
  assert.equal(connects, 1, "one shared connection for all brands");
  assert.deepEqual(client.listened, [SITE_CONFIG_CHANNEL]);
  assert.equal(L.size(), 3);
  // Initial resync fires every handler once (a change may have landed before LISTEN armed).
  assert.deepEqual(hits, { A: 1, B: 1, C: 1 });

  client.emit("B");                       // only brand B changed
  assert.deepEqual(hits, { A: 1, B: 2, C: 1 }, "payload dispatch hits only that brand");
  client.emit(undefined);                 // no payload -> refresh all
  assert.deepEqual(hits, { A: 2, B: 3, C: 2 });
  client.emit("ZZZ");                      // unknown brand -> no-op, no throw
  assert.deepEqual(hits, { A: 2, B: 3, C: 2 });
});

test("a handler throwing never breaks dispatch to the others", async () => {
  const client = fakeClient();
  const L = new SharedSiteConfigListener({ connect: async () => client, onError: () => {} });
  let bHit = 0;
  L.register("A", () => { throw new Error("boom"); });
  L.register("B", () => { bHit++; });
  await flush();
  bHit = 0;                                // reset after the initial resync
  assert.doesNotThrow(() => client.emit(undefined));
  assert.equal(bHit, 1, "B still refreshed despite A throwing");
});

test("reconnects after a connection error (backoff), re-listening", async () => {
  let connects = 0;
  let current = fakeClient();
  const L = new SharedSiteConfigListener({
    connect: async () => { connects++; current = fakeClient(); return current; },
    reconnectMs: 5, onError: () => {},
  });
  L.register("A", () => {});
  await flush();
  assert.equal(connects, 1);
  current.fail(new Error("dropped"));                // connection error -> drop + schedule reconnect
  assert.equal(current.released, true, "the dead client is released");
  await new Promise((r) => setTimeout(r, 15));
  await flush();
  assert.equal(connects, 2, "reconnected once");
  assert.deepEqual(current.listened, [SITE_CONFIG_CHANNEL], "re-armed LISTEN on the new connection");
  L.stop();
});

test("stop() prevents further reconnects", async () => {
  let connects = 0;
  let current = fakeClient();
  const L = new SharedSiteConfigListener({ connect: async () => { connects++; current = fakeClient(); return current; }, reconnectMs: 5, onError: () => {} });
  L.register("A", () => {});
  await flush();
  L.stop();
  current.fail(new Error("dropped"));
  await new Promise((r) => setTimeout(r, 15));
  await flush();
  assert.equal(connects, 1, "no reconnect after stop()");
});
