import test from "node:test";
import assert from "node:assert/strict";
import {
  XAUUSD, CurveGenerator, DEFAULT_VERSIONED_CONFIG, dateKeyUTC, dayStartMs, deriveSiteDaySeed,
  priceOf, valueOfRate, toTick, type PriceAxis,
} from "@invest254/shared";
import { MarketHistory } from "./markethistory.js";
import { PgGameRepository, type GameRepository, type Querier, type OpenArgs, type SettleArgs } from "./wallet.js";
import { withPriceStamp } from "./pricestamp.js";

/**
 * Display-price stamping (migration 0180).
 *
 * Two things are being protected here, and they pull in opposite directions. The prices must be
 * RIGHT — each anchored to the UTC day its own timestamp falls on, because the engine re-anchors the
 * price axis at every midnight — and they must be HARMLESS, meaning no failure, slowness or
 * unavailability of the display write can touch a trade. Every test below is one or the other.
 */

const DAY_MS = 86_400_000;

/** Two days with deliberately different anchors, so a day mix-up cannot pass as a rounding error. */
const ANCHORS: Record<string, { base: number; openValue: number }> = {
  "2026-06-17": { base: 2761.47, openValue: 0.2 },
  "2026-06-18": { base: 2724.28, openValue: -0.1 },
};

const axis: PriceAxis = { instrument: XAUUSD, anchorFor: (k) => ANCHORS[k] ?? null };

/** What the chart would have drawn — computed independently of the code under test. */
const expected = (dateKey: string, rate: number): number => {
  const a = ANCHORS[dateKey]!;
  return toTick(XAUUSD, priceOf(XAUUSD, a.base, a.openValue, valueOfRate(rate)));
};

interface Row {
  opened_at: Date;
  settled_at: Date | null;
  entry_rate: string;
  exit_rate: string | null;
  entry_price: string | null;
  exit_price: string | null;
}

/** A Querier over one in-memory positions row, recording the UPDATEs it is asked to make. */
function fakeDb(row: Row) {
  const updates: unknown[][] = [];
  const q: Querier = {
    async query(text, params) {
      if (text.startsWith("select opened_at")) return { rows: [row] };
      if (text.startsWith("update positions set entry_price")) {
        updates.push(params);
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
  return { q, updates };
}

test("setExecutionPrices: each price is anchored to the day ITS OWN timestamp falls on", async () => {
  // Opened just before midnight on the 17th, settled just after it on the 18th — the case a
  // single "today's anchor" would get wrong, and get wrong plausibly.
  const openedAt = new Date(Date.UTC(2026, 5, 17, 23, 59, 58));
  const settledAt = new Date(openedAt.getTime() + 5_000);
  assert.equal(settledAt.toISOString().slice(0, 10), "2026-06-18");

  const { q, updates } = fakeDb({
    opened_at: openedAt, settled_at: settledAt,
    entry_rate: "0.21", exit_rate: "0.25", entry_price: null, exit_price: null,
  });

  await new PgGameRepository(q).setExecutionPrices("p1", axis);

  assert.equal(updates.length, 1);
  const [id, entry, exit] = updates[0]!;
  assert.equal(id, "p1");
  assert.equal(entry, expected("2026-06-17", 0.21));
  assert.equal(exit, expected("2026-06-18", 0.25));
  // And the whole point: the two days really do disagree, so the test above has teeth.
  assert.notEqual(expected("2026-06-17", 0.25), expected("2026-06-18", 0.25));
});

test("setExecutionPrices: fills only what is missing, and never overwrites", async () => {
  const openedAt = new Date(Date.UTC(2026, 5, 17, 12, 0, 0));
  const { q, updates } = fakeDb({
    opened_at: openedAt, settled_at: new Date(openedAt.getTime() + 5_000),
    entry_rate: "0.21", exit_rate: "0.25", entry_price: "2700.00000", exit_price: null,
  });

  await new PgGameRepository(q).setExecutionPrices("p1", axis);

  // Entry already stamped: passed as null so the UPDATE's coalesce keeps the stored value.
  const [, entry, exit] = updates[0]!;
  assert.equal(entry, null);
  assert.equal(exit, expected("2026-06-17", 0.25));
});

test("setExecutionPrices: an open position gets an entry price and no exit", async () => {
  const openedAt = new Date(Date.UTC(2026, 5, 17, 12, 0, 0));
  const { q, updates } = fakeDb({
    opened_at: openedAt, settled_at: null,
    entry_rate: "0.21", exit_rate: null, entry_price: null, exit_price: null,
  });

  await new PgGameRepository(q).setExecutionPrices("p1", axis);

  const [, entry, exit] = updates[0]!;
  assert.equal(entry, expected("2026-06-17", 0.21));
  assert.equal(exit, null);
});

test("setExecutionPrices: a day off the chain is left null, never guessed", async () => {
  // A trade older than the retained history has no anchor. Writing SOME price here would be the
  // original bug: a plausible number that was never on screen.
  const openedAt = new Date(Date.UTC(2020, 0, 1, 12, 0, 0));
  const { q, updates } = fakeDb({
    opened_at: openedAt, settled_at: new Date(openedAt.getTime() + 5_000),
    entry_rate: "0.21", exit_rate: "0.25", entry_price: null, exit_price: null,
  });

  await new PgGameRepository(q).setExecutionPrices("p1", axis);

  assert.equal(updates.length, 0, "no anchor for either day ⇒ no UPDATE at all");
});

test("setExecutionPrices: nothing to do ⇒ no UPDATE issued", async () => {
  const { q, updates } = fakeDb({
    opened_at: new Date(Date.UTC(2026, 5, 17, 12, 0, 0)),
    settled_at: new Date(Date.UTC(2026, 5, 17, 12, 0, 5)),
    entry_rate: "0.21", exit_rate: "0.25", entry_price: "2700.00000", exit_price: "2701.00000",
  });
  await new PgGameRepository(q).setExecutionPrices("p1", axis);
  assert.equal(updates.length, 0);
});

test("setExecutionPrices: a missing row is a no-op, not a throw", async () => {
  const q: Querier = { async query() { return { rows: [] }; } };
  await new PgGameRepository(q).setExecutionPrices("gone", axis);
});

test("listPositions / mapPositionRow: prices come back as numbers, absent ones as null", async () => {
  const q: Querier = {
    async query() {
      return { rows: [{
        id: "p1", user_id: "u", game_day_id: "7", direction: "buy", stake: "20000",
        entry_rate: "0.21", exit_rate: "0.25", entry_price: "2761.47000", exit_price: null,
        multiplier: null, payout: null, pnl: null, result: "win",
        duration_s: 10, status: "settled", opened_at: new Date(5000), settled_at: new Date(6000),
      }] };
    },
  };
  const page = await new PgGameRepository(q).listPositions("u", { limit: 10 });
  assert.equal(page.items[0]!.entryPrice, 2761.47);
  assert.equal(page.items[0]!.exitPrice, null);
});

// ───────────────────────── the wrapper: harmless by construction ─────────────────────────

/** A repository that records the money calls and lets a test fail the display write at will. */
function fakeRepo(opts: { stampThrows?: boolean } = {}) {
  const calls: string[] = [];
  const stamped: string[] = [];
  const repo = {
    async openPosition(_a: OpenArgs) { calls.push("open"); return { positionId: "p1", newBalance: 100 }; },
    async openContract() { calls.push("contract"); return { positionId: "p2", newBalance: 100 }; },
    async settlePosition(_a: SettleArgs) { calls.push("settle"); return { settled: true, newBalance: 200 }; },
    async setExecutionPrices(positionId: string) {
      if (opts.stampThrows) throw new Error("db down");
      stamped.push(positionId);
    },
  } as unknown as GameRepository;
  return { repo, calls, stamped };
}

const openArgs: OpenArgs = {
  userId: "u", stakeCents: 20_000, direction: "buy", entryRate: 0.21, durationS: 10,
  gameDayId: 7, nonce: 1, openedAtMs: Date.UTC(2026, 5, 17, 12, 0, 0), configVersion: 1,
};

/** Let the fire-and-forget stamp settle before asserting on it. */
const flush = () => new Promise<void>((r) => setImmediate(r));

test("withPriceStamp: stamps each opened and settled position, by its own id", async () => {
  const { repo, calls, stamped } = fakeRepo();
  const wrapped = withPriceStamp(repo, { axis: () => axis });

  assert.equal((await wrapped.openPosition(openArgs)).positionId, "p1");
  assert.equal((await wrapped.openContract({ ...openArgs, kind: "digit", contract: {} } as never)).positionId, "p2");
  await wrapped.settlePosition({ positionId: "p9", exitRate: 0.25, result: "win", multiplier: 2, payoutCents: 40_000 });
  await flush();

  assert.deepEqual(calls, ["open", "contract", "settle"], "the money calls pass through unchanged");
  assert.deepEqual(stamped, ["p1", "p2", "p9"]);
});

test("withPriceStamp: a failing stamp cannot fail a trade", async () => {
  const errors: string[] = [];
  const { repo } = fakeRepo({ stampThrows: true });
  const wrapped = withPriceStamp(repo, { axis: () => axis, onError: (_e, ctx) => errors.push(ctx) });

  // The trade must resolve exactly as it would have, and the failure must surface as a log.
  const r = await wrapped.openPosition(openArgs);
  await flush();
  assert.equal(r.positionId, "p1");
  assert.deepEqual(errors, ["price-stamp p1"]);
});

test("withPriceStamp: a never-resolving stamp cannot delay a trade", async () => {
  const repo = {
    async openPosition() { return { positionId: "p1", newBalance: 100 }; },
    async openContract() { return { positionId: "p2", newBalance: 100 }; },
    async settlePosition() { return { settled: true, newBalance: 200 }; },
    setExecutionPrices: () => new Promise<void>(() => { /* never settles */ }),
  } as unknown as GameRepository;

  // Would hang if the wrapper awaited the stamp.
  const r = await withPriceStamp(repo, { axis: () => axis }).openPosition(openArgs);
  assert.equal(r.positionId, "p1");
});

test("withPriceStamp: a repository that cannot stamp is handed back untouched", () => {
  const repo = {
    async openPosition() { return { positionId: "p1", newBalance: 0 }; },
    async openContract() { return { positionId: "p2", newBalance: 0 }; },
    async settlePosition() { return { settled: true, newBalance: 0 }; },
  } as unknown as GameRepository;
  assert.equal(withPriceStamp(repo, { axis: () => axis }), repo);
});

test("withPriceStamp: methods it does not override still work", async () => {
  // Object.create, not a spread — a spread would drop every prototype method of a class instance.
  const q: Querier = { async query() { return { rows: [{ bal: "12345" }] }; } };
  const wrapped = withPriceStamp(new PgGameRepository(q), { axis: () => axis });
  assert.equal(await wrapped.getBalance("u"), 12345);
});

test("withPriceStamp: the axis is read per call, so a rebuilt day chain is picked up", async () => {
  let reads = 0;
  const { repo } = fakeRepo();
  const wrapped = withPriceStamp(repo, { axis: () => { reads++; return axis; } });
  await wrapped.openPosition(openArgs);
  await wrapped.openPosition(openArgs);
  await flush();
  assert.equal(reads, 2);
});

test("a settled contract's prices differ by exactly the curve move, scaled", async () => {
  // The relationship the whole feature rests on: price = base + scale × (value − dayOpenValue), so
  // two rates on the SAME day differ by scale × Δvalue and nothing else.
  const openedAt = Date.UTC(2026, 5, 17, 10, 0, 0);
  const { q, updates } = fakeDb({
    opened_at: new Date(openedAt), settled_at: new Date(openedAt + 10_000),
    entry_rate: "0.20", exit_rate: "0.30", entry_price: null, exit_price: null,
  });
  await new PgGameRepository(q).setExecutionPrices("p1", axis);
  const [, entry, exit] = updates[0]!;
  const move = XAUUSD.scale * (valueOfRate(0.3) - valueOfRate(0.2));
  assert.ok(Math.abs((exit as number) - (entry as number) - move) < 0.02, "within one tick of the scaled move");
  // Same day ⇒ same anchor, so this holds across the day boundary only by accident. Guard it.
  assert.ok(openedAt + 10_000 < openedAt + DAY_MS);
});

// ───────── end to end: the stamped price is the price the CHART drew ─────────

test("a stamped price lands inside the minute candle the chart drew for that moment", async () => {
  // The claim worth proving is not that the arithmetic round-trips — it is that the number written
  // onto a trade is the number the player was looking at. So: take a real brand's day chain, read a
  // rate off its live curve at a chosen second, stamp a position at that second through the real
  // repository code, and check the result falls inside the M1 candle that same day chain serves for
  // the minute containing it. If the stamp and the chart ever used different anchors, this fails.
  const MASTER = "pricestamp-master-seed";
  const SITE = "00000000-0000-0000-0000-00000000c0de";
  const NOW = Date.UTC(2026, 2, 18, 13, 47, 29);
  const history = new MarketHistory(
    (dateKey) => deriveSiteDaySeed(MASTER, SITE, dateKey, 0),
    () => DEFAULT_VERSIONED_CONFIG,
    { now: () => NOW },
  );

  const dateKey = dateKeyUTC(NOW);
  const atMs = dayStartMs(dateKey) + 10 * 3_600_000 + 90_000; // 10:01:30Z — a closed minute
  const curve = new CurveGenerator(deriveSiteDaySeed(MASTER, SITE, dateKey, 0), DEFAULT_VERSIONED_CONFIG, "market");
  const rate = curve.rate((atMs - dayStartMs(dateKey)) / 1000);

  const { q, updates } = fakeDb({
    opened_at: new Date(atMs), settled_at: null,
    entry_rate: String(rate), exit_rate: null, entry_price: null, exit_price: null,
  });
  await new PgGameRepository(q).setExecutionPrices("p1", history.axis());
  const stamped = updates[0]![1] as number;

  const minuteS = Math.floor(atMs / 60_000) * 60;
  const bar = history.candles("M1", 2000).find((b) => b.time === minuteS);
  assert.ok(bar, "the chart serves a candle for that minute");
  assert.ok(
    stamped >= bar!.low - 0.01 && stamped <= bar!.high + 0.01,
    `stamped ${stamped} outside the drawn candle [${bar!.low}, ${bar!.high}]`,
  );
});
