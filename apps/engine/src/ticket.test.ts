import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_VERSIONED_CONFIG } from "@invest254/shared";
import { InMemoryGameRepository, PgGameRepository, type Querier } from "./wallet.js";
import { GameServer } from "./game.js";
import { SeedManager } from "./daycontext.js";
import { RecoveryService } from "./recovery.js";
import { StaticConfigProvider } from "./gameconfig.js";

/**
 * MetaTrader's TICKET (migration 0184).
 *
 * `positions.id` is a uuid, so every surface that named a trade printed its first eight hex
 * characters. A hex fragment is not a ticket: it does not order, it cannot be read out over a phone
 * call to support, and it is the one identifier a trader is ever asked for. MetaTrader's own is a
 * short ascending integer (`328674`, docs/mt5/09-toolbox.md 313).
 *
 * The properties that make it worth having are the ones pinned here: it exists from the instant the
 * trade does, it ascends, it is unique, it survives a restart, and it cannot cost anybody a trade.
 */

const MASTER = "ticket-test-master";
const OPTS = { calibrationSamples: 4000 };

test("a ticket is allocated with the money and ascends, trade by trade", async () => {
  const repo = new InMemoryGameRepository();
  repo.seed("u", 1_000_000);
  const a = await repo.openPosition({ userId: "u", stakeCents: 25_000, direction: "buy", entryRate: 0.2, durationS: 10, gameDayId: null, nonce: 1, openedAtMs: 0, configVersion: 1 });
  const b = await repo.openPosition({ userId: "u", stakeCents: 25_000, direction: "sell", entryRate: 0.2, durationS: 10, gameDayId: null, nonce: 2, openedAtMs: 1, configVersion: 1 });
  const c = await repo.openPosition({ userId: "u", stakeCents: 25_000, direction: "buy", entryRate: 0.2, durationS: 10, gameDayId: null, nonce: 3, openedAtMs: 2, configVersion: 1 });

  // Six figures from the first trade, the way MetaTrader's read, rather than counting up from 1.
  assert.equal(a.ticket, 100_000);
  // Strictly consecutive: a trader reading two tickets can tell which trade came first. This is the
  // whole reason the hex fragment could not stand in for one.
  assert.deepEqual([b.ticket, c.ticket], [100_001, 100_002]);

  const open = await repo.listOpenPositions();
  const tickets = open.map((p) => p.ticket);
  assert.deepEqual(new Set(tickets).size, 3, "tickets are unique");
  assert.deepEqual(
    (await repo.listPositions("u", {})).items.map((p) => p.ticket).sort(),
    [100_000, 100_001, 100_002],
    "the ticket is on the history record too, not only on the open position",
  );
});

test("the position the engine hands back carries the ticket the database allocated", async () => {
  const cfg = { ...DEFAULT_VERSIONED_CONFIG, defaultDurationS: 10 };
  const repo = new InMemoryGameRepository();
  repo.seed("u", 1_000_000);
  const clock = { ms: 0 };
  const seeds = new SeedManager(MASTER, new StaticConfigProvider(cfg), repo, () => clock.ms, OPTS);
  await seeds.init();
  const game = new GameServer(() => seeds.getActive(), repo, () => cfg, () => clock.ms);

  const { position } = await game.openPosition({ userId: "u", stakeCents: 25_000, direction: "buy" });
  assert.equal(position.ticket, 100_000);
  // And it is on the frame builder's source, which is what puts it on screen.
  assert.deepEqual(game.openPositionsOf("u").map((p) => p.ticket), [100_000]);
});

test("a restart does not renumber a live position", async () => {
  const cfg = { ...DEFAULT_VERSIONED_CONFIG, defaultDurationS: 10 };
  const config = new StaticConfigProvider(cfg);
  const repo = new InMemoryGameRepository();
  repo.seed("u", 1_000_000);
  const clock = { ms: 0 };

  const seeds1 = new SeedManager(MASTER, config, repo, () => clock.ms, OPTS);
  await seeds1.init();
  const game1 = new GameServer(() => seeds1.getActive(), repo, () => cfg, () => clock.ms);
  clock.ms = 1_000;
  const { position: before } = await game1.openPosition({ userId: "u", stakeCents: 25_000, direction: "buy" });

  // Crash: a fresh process boots with only the durable repository. The engine restarts on every
  // deploy, so this is the routine case, not the exotic one.
  clock.ms = 3_000; // still in flight (opened at 1000, 10s)
  const seeds2 = new SeedManager(MASTER, config, repo, () => clock.ms, OPTS);
  await seeds2.init();
  const game2 = new GameServer(() => seeds2.getActive(), repo, () => cfg, () => clock.ms);
  await new RecoveryService(repo, seeds2, game2, () => clock.ms).recover();

  const after = game2.openPositionsOf("u");
  assert.equal(after.length, 1);
  assert.equal(
    after[0]!.ticket, before.ticket,
    "the trader is still quoting the number they were quoting before the deploy",
  );
});

test("Pg: the ticket is read back outside the money path and can never cost a trade", async () => {
  // The read-back is its own statement AFTER the RPC has returned and committed, because
  // fn_open_position's ten-argument signature cannot change (migration 0182 spells out why adding a
  // defaulted parameter would create an ambiguous overload). So if the read fails, the money has
  // already moved: refusing a trade that succeeded, because a display number could not be fetched,
  // would be far worse than printing a dash.
  const fake: Querier = {
    async query(text) {
      if (text.includes("fn_open_position")) return { rows: [{ position_id: "p-1", new_balance: "80000" }] };
      if (text.includes("select ticket from positions")) throw new Error("connection terminated");
      return { rows: [] };
    },
  };
  const r = new PgGameRepository(fake);
  const o = await r.openPosition({ userId: "u", stakeCents: 20_000, direction: "buy", entryRate: 0.21, durationS: 10, gameDayId: null, nonce: 7, openedAtMs: 0, configVersion: 1 });
  assert.deepEqual(o, { positionId: "p-1", newBalance: 80_000, ticket: null });
});

test("Pg: a row written before the column reads as no ticket, not as a wrong one", async () => {
  const fake: Querier = {
    async query(text) {
      if (text.includes("fn_open_position")) return { rows: [{ position_id: "p-1", new_balance: "80000" }] };
      if (text.includes("select ticket from positions")) return { rows: [{ ticket: null }] };
      return { rows: [] };
    },
  };
  const r = new PgGameRepository(fake);
  assert.equal((await r.openPosition({ userId: "u", stakeCents: 20_000, direction: "buy", entryRate: 0.21, durationS: 10, gameDayId: null, nonce: 7, openedAtMs: 0, configVersion: 1 })).ticket, null);
});
