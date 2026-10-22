import { test } from "node:test";
import assert from "node:assert/strict";
import { PendingOrders, RejectedOrder, type PendingOrder, type PendingOrderStore } from "./pending.js";

/**
 * The engine's half of a pending order: arming, refusing, filling once, and surviving a restart.
 * The trigger arithmetic itself is pinned in the shared package, which both sides call.
 */

interface Opened { order: PendingOrder; direction: string }

function harness(opts: { openFails?: boolean } = {}) {
  const opened: Opened[] = [];
  const writes: string[] = [];
  let live: PendingOrder[] = [];
  let n = 0;
  const store: PendingOrderStore = {
    insertPendingOrder: async (o) => { writes.push(`insert:${o.id}`); live.push(o); },
    markPendingFilled: async (id, pid) => { writes.push(`filled:${id}:${pid}`); live = live.filter((x) => x.id !== id); },
    markPendingCanceled: async (id) => { writes.push(`cancel:${id}`); live = live.filter((x) => x.id !== id); },
    listLivePendingOrders: async () => [...live],
  };
  const po = new PendingOrders(
    store,
    "site-1",
    async (order, direction) => {
      if (opts.openFails) throw new Error("INSUFFICIENT_FUNDS");
      opened.push({ order, direction });
      return { positionId: `pos-${opened.length}` };
    },
    () => 1_700_000_000_000,
    () => `ord-${++n}`,
  );
  return { po, opened, writes, store, liveRows: () => live };
}

const base = {
  userId: 'u1', symbol: 'XAUUSD', stakeCents: 25_000, durationS: 60, marketPrice: 3080,
} as const;

test('an order is armed, persisted, and listed for its owner alone', async () => {
  const { po, writes } = harness();
  const o = await po.place({ ...base, kind: 'buyLimit', triggerPrice: 3070 });
  assert.equal(o.kind, 'buyLimit');
  assert.equal(o.triggerPrice, 3070);
  assert.equal(po.size, 1);
  assert.deepEqual(po.list('u1').map((x) => x.id), [o.id]);
  assert.deepEqual(po.list('someone-else'), []);
  // Persisted, and not awaited by the caller.
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(writes, [`insert:${o.id}`]);
});

test('a level on the wrong side is refused, not armed', async () => {
  const { po } = harness();
  // A Buy Limit ABOVE the market would fill on the next tick, so it is a market order wearing the
  // wrong name. MetaTrader refuses it and so does this.
  await assert.rejects(
    () => po.place({ ...base, kind: 'buyLimit', triggerPrice: 3090 }),
    (e: unknown) => e instanceof RejectedOrder && e.code === 'INVALID_PRICE',
  );
  assert.equal(po.size, 0, 'and nothing was armed');
  // So is a volume of nothing.
  await assert.rejects(
    () => po.place({ ...base, kind: 'buyLimit', triggerPrice: 3070, stakeCents: 0 }),
    (e: unknown) => e instanceof RejectedOrder && e.code === 'INVALID_VOLUME',
  );
});

test('an order fills when the market reaches its level, and opens the position ONCE', async () => {
  const { po, opened, writes } = harness();
  const o = await po.place({ ...base, kind: 'buyLimit', triggerPrice: 3070 });
  // Not there yet.
  assert.deepEqual(await po.step('XAUUSD', 3075), []);
  assert.equal(opened.length, 0);
  // Reached.
  const done = await po.step('XAUUSD', 3069.5);
  assert.equal(done.length, 1);
  assert.equal(done[0]!.outcome.ok, true);
  assert.equal(opened.length, 1);
  assert.equal(opened[0]!.direction, 'buy', 'a Buy Limit opens a BUY');
  assert.equal(opened[0]!.order.stakeCents, 25_000);
  // Gone from the book, so the next tick cannot open a second position for it.
  assert.equal(po.size, 0);
  assert.deepEqual(await po.step('XAUUSD', 3000), []);
  assert.equal(opened.length, 1);
  await new Promise((r) => setImmediate(r));
  assert.ok(writes.includes(`filled:${o.id}:pos-1`));
});

test('another symbol s price never fills this symbol s order', async () => {
  const { po, opened } = harness();
  await po.place({ ...base, kind: 'buyLimit', triggerPrice: 3070 });
  await po.step('EURUSD', 1.0);
  assert.equal(opened.length, 0);
  assert.equal(po.size, 1);
});

test('a fill that fails leaves the order armed, rather than losing it', async () => {
  const { po } = harness({ openFails: true });
  await po.place({ ...base, kind: 'sellStop', triggerPrice: 3070 });
  const done = await po.step('XAUUSD', 3069);
  assert.equal(done.length, 1);
  assert.equal(done[0]!.outcome.ok, false);
  assert.match((done[0]!.outcome as { reason: string }).reason, /INSUFFICIENT_FUNDS/);
  assert.equal(po.size, 1, 'still waiting: a fill that could not be made is not a fill');
});

test('the four types open the side they name', async () => {
  for (const [kind, trigger, price, direction] of [
    ['buyLimit', 3070, 3069, 'buy'],
    ['sellStop', 3070, 3069, 'sell'],
    ['sellLimit', 3090, 3091, 'sell'],
    ['buyStop', 3090, 3091, 'buy'],
  ] as const) {
    const { po, opened } = harness();
    await po.place({ ...base, kind, triggerPrice: trigger });
    await po.step('XAUUSD', price);
    assert.equal(opened.length, 1, kind);
    assert.equal(opened[0]!.direction, direction, kind);
  }
});

test('only the trader who armed an order can cancel it', async () => {
  const { po, writes } = harness();
  const o = await po.place({ ...base, kind: 'buyLimit', triggerPrice: 3070 });
  await assert.rejects(
    () => po.cancel(o.id, 'someone-else'),
    (e: unknown) => e instanceof RejectedOrder && e.code === 'NOT_YOURS',
  );
  assert.equal(po.size, 1);
  await po.cancel(o.id, 'u1');
  assert.equal(po.size, 0);
  await assert.rejects(
    () => po.cancel(o.id, 'u1'),
    (e: unknown) => e instanceof RejectedOrder && e.code === 'NOT_FOUND',
  );
  await new Promise((r) => setImmediate(r));
  assert.ok(writes.includes(`cancel:${o.id}`));
});

test('a restart re-arms what was waiting, which is the whole point of persisting them', async () => {
  const { po, store, liveRows } = harness();
  await po.place({ ...base, kind: 'buyLimit', triggerPrice: 3070 });
  await po.place({ ...base, kind: 'sellLimit', triggerPrice: 3090 });
  await new Promise((r) => setImmediate(r));
  assert.equal(liveRows().length, 2);

  // A new engine, as a deploy makes.
  const opened: string[] = [];
  const fresh = new PendingOrders(store, 'site-1', async (o) => { opened.push(o.id); return { positionId: 'p' }; });
  assert.equal(await fresh.recover(), 2);
  assert.equal(fresh.size, 2);
  // And they still fill.
  await fresh.step('XAUUSD', 3069);
  assert.equal(opened.length, 1);
});

test('an order carries its protective levels, so the position it opens is already protected', async () => {
  const { po, opened } = harness();
  await po.place({ ...base, kind: 'buyLimit', triggerPrice: 3070, slPrice: 3060, tpPrice: 3100 });
  await po.step('XAUUSD', 3069);
  assert.equal(opened[0]!.order.slPrice, 3060);
  assert.equal(opened[0]!.order.tpPrice, 3100);
  // A level that is not a number is stored as "not set", never as NaN.
  const { po: po2, opened: opened2 } = harness();
  await po2.place({ ...base, kind: 'buyLimit', triggerPrice: 3070, slPrice: Number.NaN });
  await po2.step('XAUUSD', 3069);
  assert.equal(opened2[0]!.order.slPrice, null);
});
