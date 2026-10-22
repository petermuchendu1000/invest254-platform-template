import { randomUUID } from "node:crypto";
import { type Cents, assertCents, lastDigit, priceAtRate, commitment } from "@invest254/shared";
import type { Direction, PriceAxis } from "@invest254/shared";
import {
  type Page, type PageQuery, clampLimit, decodeCursor, decodeKeyset, pageFrom,
} from "./paging.js";
import type { AdminBetSnapshot } from "./admin.js";

/**
 * GameRepository: the durable, money-atomic boundary. "Open" (debit stake + insert
 * position + ledger) and "settle" (credit payout + update position + ledger) are each
 * ONE atomic, idempotent transaction. It also owns the fairness day rows and the
 * open-position scan used by crash recovery. Two implementations satisfy the contract:
 *  - InMemoryGameRepository  — for tests/dev (single-threaded => atomic).
 *  - PgGameRepository        — calls the SECURITY DEFINER RPCs fn_open_position /
 *                              fn_settle_position / fn_ensure_game_day / fn_reveal_game_day
 *                              (migrations 0010-0012) and reads the leak-safe v_fairness view.
 */
export interface OpenArgs {
  userId: string; stakeCents: Cents; direction: Direction; entryRate: number;
  durationS: number; gameDayId: number | null; nonce: number; openedAtMs: number;
  /** game_config_versions.version that priced this position (migration 0028). */
  configVersion: number | null;
  /** Multi-tenant: the brand this position belongs to (undefined/null in single-tenant mode). */
  siteId?: string | null;
}
export interface SettleArgs { positionId: string; exitRate: number; result: "win" | "loss"; multiplier: number; payoutCents: Cents; }
export interface OpenResult {
  positionId: string; newBalance: Cents;
  /**
   * MetaTrader's TICKET: the short ascending integer a trader quotes (migration 0184).
   *
   * Read back from the row the money RPC just inserted, as its own SELECT — `fn_open_position`'s
   * signature is untouched (0182 explains why it must stay that way), and the column fills itself
   * from a sequence DEFAULT inside that same INSERT. Null only when the read-back could not be done,
   * which the surfaces render the way they already render an unstamped display price.
   */
  ticket: number | null;
}
/** Open args for a Phase-2 contract (digit/multiplier): OpenArgs + the contract kind & params. */
export interface OpenContractArgs extends OpenArgs { kind: "digit" | "multiplier"; contract: unknown; }
export interface SettleResult { settled: boolean; newBalance: Cents; }
/** A user's full wallet, as pushed over the WS `balance` frame. */
export interface WalletSnapshot { real: Cents; bonus: Cents; currency: string; }

/** A still-open position as persisted — the durable facts needed to recompute its outcome. */
export interface OpenPositionRow {
  id: string; userId: string; stakeCents: Cents; direction: Direction;
  durationS: number; openedAtMs: number; entryRate: number; gameDayId: number | null; nonce: number;
  /** Config version the position was opened under; null for rows predating migration 0028. */
  configVersion: number | null;
  /** Multi-tenant: the brand this position belongs to (null in single-tenant mode). */
  siteId?: string | null;
  /** Phase 2: contract kind ('rise_fall' | 'digit' | 'multiplier'); absent ⇒ legacy rise/fall. */
  kind?: string | null;
  /** Phase 2: per-kind contract params (jsonb). For digits: { kind, target, instrumentId, settleIndex }. */
  contract?: unknown;
  /**
   * The protective levels this position was carrying, as prices (migration 0183).
   *
   * Crash recovery re-arms a continuous position WITH its stop and target, which is the only reason
   * these are on the work list. Absent (not just null) on a repository that predates the columns,
   * so an older fake keeps compiling and recovery treats it as "no levels", which is what it was.
   */
  slPrice?: number | null;
  tpPrice?: number | null;
  /**
   * The ticket this position was opened under (migration 0184), so a position re-armed after a
   * restart comes back carrying the SAME number the trader has been quoting. Optional so an older
   * repository fake keeps compiling; absent reads as "unknown", exactly as it did before the column.
   */
  ticket?: number | null;
}

/** Public fairness record for a day (commitment always; seed only after reveal). */
export interface FairnessRecord {
  gameDayId: number | null; tradeDate: string; serverSeedHash: string;
  serverSeed: string | null; revealedAt: string | null;
}

/** A wallet ledger entry as shown in a player's history. */
export interface LedgerEntry {
  id: number; type: string; amountCents: Cents; balanceKind: string;
  refTable: string | null; refId: string | null; meta: unknown; createdAtMs: number;
}

/** A position as shown in a player's bet history (open or settled). */
export interface PositionRecord {
  id: string; userId: string; gameDayId: number | null; direction: Direction;
  stakeCents: Cents; entryRate: number; exitRate: number | null; multiplier: number | null;
  payoutCents: Cents | null; pnlCents: Cents | null; result: string | null;
  durationS: number; status: string; openedAtMs: number; settledAtMs: number | null;
  /**
   * The DISPLAY prices the contract opened and closed at (migration 0180), or null when unstamped.
   *
   * `entryRate`/`exitRate` above are curve rates; the terminal charts a price, and the price axis
   * re-anchors every UTC midnight, so a rate alone cannot be turned back into the number the player
   * saw. These are recorded at execution time from that day's own anchor. Display-only — nothing in
   * settlement reads them, and null simply means the screen shows "at market".
   */
  entryPrice: number | null; exitPrice: number | null;
  /** Instrument traded (migration 0182). Null means the brand's own symbol. */
  symbol: string | null;
  /**
   * MetaTrader's ticket (migration 0184): the number this trade is known by.
   *
   * `id` stays the uuid every internal path keys on; this is the one a trader reads, quotes and
   * sorts by. Null on a row written before the column existed, which the surfaces print as a dash
   * rather than inventing a number.
   */
  ticket: number | null;
}

/** A single position plus its day's public fairness data (seed hidden until reveal). */
export interface PositionDetail extends PositionRecord { fairness: FairnessRecord | null; }

/** Filters for a player's position history. */
export interface PositionListQuery extends PageQuery { status?: string | undefined; }

/**
 * One row of a player's DIGIT contract history (docs/34) — everything needed for a reviewable
 * receipt: type + barrier, stake, entry spot & tick, settle spot & settled digit & tick, payout, P/L.
 * The settled digit is the last pip of `exitRate` (pool path sets it via withLastPip; the statistical
 * path's quote ends in the fair digit), so no extra column is needed.
 */
export interface DigitHistoryRow {
  id: string; kind: string; target: number | null; instrumentId: string | null;
  openIndex: number | null; settleIndex: number | null;
  stakeCents: Cents; entryRate: number; exitRate: number | null; settleDigit: number | null;
  payoutCents: Cents | null; pnlCents: Cents | null; result: string | null; status: string;
  openedAtMs: number; settledAtMs: number | null;
  /** DEMO-1: staked from the demo (play-money) account. */
  demo?: boolean;
}

export interface GameRepository {
  getBalance(userId: string): Promise<Cents>;
  /** Full wallet snapshot (real + bonus + currency) for the real-time `balance` push. */
  getWalletSnapshot(userId: string): Promise<WalletSnapshot>;
  openPosition(a: OpenArgs): Promise<OpenResult>;
  /** Open a Phase-2 contract (digit/multiplier). Same money movement as openPosition + records kind/contract. */
  openContract(a: OpenContractArgs): Promise<OpenResult>;
  settlePosition(a: SettleArgs): Promise<SettleResult>;
  /** Idempotently commit a game day (stores hash; seed stays hidden). Returns its id. `siteId` scopes it per brand. */
  ensureGameDay(tradeDate: string, serverSeedHash: string, siteId?: string): Promise<number | null>;
  /** Reveal a past day's seed (commitment- and past-only-checked in the DB). Returns whether it took effect. `siteId` scopes it per brand. */
  revealSeed(tradeDate: string, serverSeed: string, siteId?: string): Promise<boolean>;
  /** Durable seed version for a day (0 unless a superadmin forced a rotation; see `seed_overrides`, J5). `siteId` scopes it per brand. */
  getSeedVersion(tradeDate: string, siteId?: string): Promise<number>;
  /**
   * EVERY forced seed rotation, as tradeDate -> version.
   *
   * The candle chart reconstructs hundreds of past days at once, and each one must be derived under
   * the version it was actually traded at or the chart would show a history that never happened.
   * Fetching them one day at a time would be hundreds of round trips; `seed_overrides` only gains a
   * row when a superadmin forces a rotation, so reading the whole table is cheaper than one of those
   * queries. Optional so existing repository fakes keep compiling — absent means "no rotations".
   */
  listSeedVersions?(siteId?: string): Promise<Map<string, number>>;
  /** All positions still open — the crash-recovery work list. */
  listOpenPositions(): Promise<OpenPositionRow[]>;
  /** Public fairness record for a day, or null if the day is unknown. */
  getFairness(tradeDate: string): Promise<FairnessRecord | null>;
  /**
   * The commitment ALREADY stored for (day, brand), or null when the day has no row yet.
   *
   * Deliberately separate from `getFairness`, and deliberately site-scoped: `getFairness` queries
   * `v_fairness where trade_date = $1` with no brand filter and takes `rows[0]`, so on this
   * multi-tenant platform (18 brands, each with a row per trade date) it returns an arbitrary
   * brand's record. That is fine for the player-facing read it was written for and completely wrong
   * for this, where the question is "what did THIS brand publish for this day" and a wrong answer
   * would have the engine price a day against another brand's curve.
   */
  getCommittedSeedHash(tradeDate: string, siteId?: string): Promise<string | null>;
  /** A player's wallet ledger, newest-first, cursor-paginated. `siteId` scopes it per brand. */
  listLedger(userId: string, q: PageQuery, siteId?: string): Promise<Page<LedgerEntry>>;
  /** A player's position history (optional status filter), newest-first, cursor-paginated. `siteId` scopes it per brand. */
  listPositions(userId: string, q: PositionListQuery, siteId?: string): Promise<Page<PositionRecord>>;
  /** A player's DIGIT contract history (newest-first, cursor-paginated). `siteId` scopes it per brand. */
  listDigitHistory(userId: string, q: PageQuery, siteId?: string): Promise<Page<DigitHistoryRow>>;
  /** A single owned position with its day's fairness data, or null if not found/owned. `siteId` scopes it per brand. */
  getPositionDetail(userId: string, positionId: string, siteId?: string): Promise<PositionDetail | null>;
  /**
   * Record the DISPLAY prices a trade executed at (migration 0180) — `positions.entry_price` and,
   * once it has settled, `exit_price`.
   *
   * Strictly outside settlement. This runs as its own statements AFTER the atomic money RPC has
   * returned and committed, so it cannot fail, delay or alter a trade; the columns are nullable and
   * the client falls back to "at market", which is why a miss is a cosmetic non-event rather than
   * something to retry. Idempotent: it only fills a price that is still null, so calling it again
   * after settlement stamps the exit without disturbing the entry.
   *
   * Optional so the in-memory repository and every test fake keep compiling — absent means a brand
   * simply stores no display prices.
   */
  setExecutionPrices?(positionId: string, axis: PriceAxis, symbol?: string): Promise<void>;
  /**
   * Record the Stop Loss and Take Profit a trader set (migration 0183), so a restart does not lose
   * them and recovery can re-arm the position the way it was opened.
   *
   * Outside the money path, exactly like `setExecutionPrices`: its own UPDATE, after the atomic RPC,
   * never awaited by the caller. Unlike the display prices this is a plain overwrite rather than a
   * `coalesce` first-write-wins, because MOVING a level and CLEARING one are the whole feature.
   * Optional so the in-memory repository and existing fakes keep compiling.
   */
  setPositionLevels?(positionId: string, slPrice: number | null, tpPrice: number | null): Promise<void>;
}

/**
 * A pending order as the repository stores and returns one (migration 0185).
 *
 * Declared here rather than imported from `./pending.js` so the repository layer does not depend on
 * the engine's own types: this file is the boundary with the database, and the shape it reads back
 * is its own contract. `PendingOrders` consumes it structurally.
 */
export interface PendingOrderRecord {
  id: string;
  userId: string;
  kind: "buyLimit" | "sellLimit" | "buyStop" | "sellStop";
  symbol: string;
  stakeCents: number;
  triggerPrice: number;
  slPrice: number | null;
  tpPrice: number | null;
  durationS: number;
  createdAtMs: number;
}

/** What is written: the record plus the brand it belongs to. */
export type PendingOrderRow = PendingOrderRecord & { siteId: string | null };

/** Minimal query surface compatible with `pg`'s Pool/Client. */
export interface Querier { query(text: string, params: unknown[]): Promise<{ rows: any[] }>; }

interface MemPos {
  id: string; userId: string; stake: Cents; status: "open" | "settled";
  direction: Direction; durationS: number; openedAtMs: number; entryRate: number;
  gameDayId: number | null; nonce: number; configVersion: number | null; seq: number;
  siteId: string | null;
  exitRate: number | null; multiplier: number | null; payout: Cents | null; pnl: Cents | null;
  result: string | null; settledAtMs: number | null;
  /** DEMO-1: the bucket debited at open (settlement routes by this, like positions.demo). */
  demo?: boolean;
  /** Migration 0183's columns, so recovery can be exercised without a database. */
  slPrice?: number | null;
  tpPrice?: number | null;
  /** Migration 0184's ticket, allocated the same way the sequence does: ascending, from 100000. */
  ticket: number;
}
interface MemLedger {
  id: number; userId: string; type: string; amount: Cents; balanceKind: string;
  refTable: string | null; refId: string | null; meta: unknown; createdAtMs: number;
  siteId: string | null;
}
interface MemDay { id: number; tradeDate: string; serverSeedHash: string; serverSeed: string | null; revealedAt: string | null; siteId: string | null; }

/** Composite day key so two brands can each own the same trade_date (mirrors unique(site_id, trade_date)). */
const dayKey = (tradeDate: string, siteId?: string | null): string => `${siteId ?? ""}:${tradeDate}`;

/**
 * Rows written before per-site stamping carry `siteId: null`; the DB backfilled them to the
 * default site (migration 0045), so the in-memory repo treats null as the default site too.
 * Keeps legacy single-tenant callers (and older tests) visible under a default-scoped read.
 */
const SITE_A_LEGACY = "00000000-0000-0000-0000-000000000001";

export class InMemoryGameRepository implements GameRepository {
  private balances = new Map<string, Cents>();
  /** Non-withdrawable demo bucket for marketer accounts (migration 0084). Mirrors wallets.demo_balance. */
  private demo = new Map<string, Cents>();
  /** Marketer (demo) accounts — the repo is authoritative for money routing, exactly like the DB RPC. */
  private marketers = new Set<string>();
  /** DEMO-1: players whose wallet is in demo mode (mirrors wallets.account_mode = 'demo'). */
  private demoMode = new Set<string>();
  private positions = new Map<string, MemPos>();
  private contractMeta = new Map<string, { kind: string; contract: unknown }>();
  private days = new Map<string, MemDay>();
  private seedVersions = new Map<string, number>();
  private nextDayId = 1;
  private posSeq = 0;
  /**
   * The in-memory stand-in for `position_ticket_seq` (migration 0184), starting where the sequence
   * starts so a ticket looks the same against this repository as against Postgres.
   */
  private ticketSeq = 100_000;
  private ledgerSeq = 0;
  readonly ledger: MemLedger[] = [];

  constructor(private readonly now: () => number = () => Date.now()) {}

  private pushLedger(userId: string, type: string, amount: Cents, balanceKind: string, refTable: string | null, refId: string | null, meta: unknown = null, siteId: string | null = null): void {
    this.ledger.push({ id: ++this.ledgerSeq, userId, type, amount, balanceKind, refTable, refId, meta, createdAtMs: this.now(), siteId });
  }

  seed(userId: string, amount: Cents): void { this.balances.set(userId, assertCents(amount)); this.pushLedger(userId, "seed", amount, "real", null, "seed"); }
  /** Mark a user as a marketer/demo account (mirrors fn_is_marketer_account). */
  markMarketer(userId: string): void { this.marketers.add(userId); }
  /** Seed a marketer's non-withdrawable demo balance. */
  seedDemo(userId: string, amount: Cents): void { this.demo.set(userId, assertCents(amount)); this.pushLedger(userId, "seed", amount, "demo", null, "seed"); }
  /** DEMO-1: switch a player's account mode (mirrors fn_set_account_mode; marketers are always demo). */
  setDemoMode(userId: string, on: boolean): void { if (on) this.demoMode.add(userId); else this.demoMode.delete(userId); }
  /** Demo bucket? Marketer OR wallet in demo mode (mirrors fn_account_is_demo, migration 0123). */
  private isMarketer(userId: string): boolean { return this.marketers.has(userId) || this.demoMode.has(userId); }
  /** The account's spendable game balance: demo for marketers, real for players (mirrors getBalance SQL). */
  async getBalance(userId: string): Promise<Cents> {
    return (this.isMarketer(userId) ? this.demo.get(userId) : this.balances.get(userId)) ?? 0;
  }
  async getWalletSnapshot(userId: string): Promise<WalletSnapshot> {
    if (this.isMarketer(userId)) return { real: this.demo.get(userId) ?? 0, bonus: 0, currency: "KES" };
    return { real: this.balances.get(userId) ?? 0, bonus: 0, currency: "KES" };
  }

  /** All of a user's positions projected for the admin activity timeline (J7). */
  adminBetsOf(userId: string): AdminBetSnapshot[] {
    const out: AdminBetSnapshot[] = [];
    for (const p of this.positions.values()) {
      if (p.userId !== userId) continue;
      out.push({
        id: p.id, status: p.status, direction: p.direction, stakeCents: p.stake,
        payoutCents: p.payout, pnlCents: p.pnl, multiplier: p.multiplier, result: p.result,
        openedAtMs: p.openedAtMs, settledAtMs: p.settledAtMs, gameDayId: p.gameDayId,
      });
    }
    return out;
  }

  async openPosition(a: OpenArgs): Promise<OpenResult> {
    if (a.stakeCents <= 0) throw new Error("INVALID_STAKE");
    // Marketer stakes debit the non-withdrawable demo bucket ONLY (never dip into real) — migration 0084.
    const marketer = this.isMarketer(a.userId);
    const book = marketer ? this.demo : this.balances;
    const kind = marketer ? "demo" : "real";
    const bal = book.get(a.userId);
    if (bal === undefined) throw new Error("WALLET_NOT_FOUND");
    if (bal < a.stakeCents) throw new Error("INSUFFICIENT_FUNDS");
    const next = bal - a.stakeCents; book.set(a.userId, next);
    const id = randomUUID();
    const ticket = this.ticketSeq++;
    this.positions.set(id, {
      id, userId: a.userId, stake: a.stakeCents, status: "open",
      direction: a.direction, durationS: a.durationS, openedAtMs: a.openedAtMs,
      entryRate: a.entryRate, gameDayId: a.gameDayId, nonce: a.nonce,
      configVersion: a.configVersion ?? null, seq: ++this.posSeq, siteId: a.siteId ?? null,
      exitRate: null, multiplier: null, payout: null, pnl: null, result: null, settledAtMs: null, demo: marketer,
      ticket,
    });
    this.pushLedger(a.userId, "stake", -a.stakeCents, kind, "positions", id, null, a.siteId ?? null);
    return { positionId: id, newBalance: next, ticket };
  }

  async openContract(a: OpenContractArgs): Promise<OpenResult> {
    // Money movement is identical to openPosition; we only additionally record the contract kind/params.
    const r = await this.openPosition(a);
    this.contractMeta.set(r.positionId, { kind: a.kind, contract: a.contract });
    return r;
  }

  async settlePosition(a: SettleArgs): Promise<SettleResult> {
    if (a.payoutCents < 0) throw new Error("INVALID_PAYOUT");
    const p = this.positions.get(a.positionId);
    if (!p) throw new Error("POSITION_NOT_FOUND");
    if (p.status !== "open") return { settled: false, newBalance: (this.isMarketer(p.userId) ? this.demo.get(p.userId) : this.balances.get(p.userId)) ?? 0 }; // idempotent
    p.status = "settled";
    p.exitRate = a.exitRate; p.multiplier = a.multiplier; p.payout = a.payoutCents;
    p.pnl = a.payoutCents - p.stake; p.result = a.result; p.settledAtMs = this.now();
    // Marketer payouts credit the demo bucket ONLY — a demo win can never become real cash (migration 0084).
    const marketer = p.demo ?? this.isMarketer(p.userId); // route by the bucket stored at open (0123)
    const book = marketer ? this.demo : this.balances;
    const kind = marketer ? "demo" : "real";
    let bal = book.get(p.userId) ?? 0;
    if (a.payoutCents > 0) { bal += a.payoutCents; book.set(p.userId, bal); this.pushLedger(p.userId, "payout", a.payoutCents, kind, "positions", a.positionId, null, p.siteId); }
    return { settled: true, newBalance: bal };
  }

  async ensureGameDay(tradeDate: string, serverSeedHash: string, siteId?: string): Promise<number | null> {
    const k = dayKey(tradeDate, siteId);
    const existing = this.days.get(k);
    if (existing) return existing.id;
    const day: MemDay = { id: this.nextDayId++, tradeDate, serverSeedHash, serverSeed: null, revealedAt: null, siteId: siteId ?? null };
    this.days.set(k, day);
    return day.id;
  }

  async getCommittedSeedHash(tradeDate: string, siteId?: string): Promise<string | null> {
    return this.days.get(dayKey(tradeDate, siteId))?.serverSeedHash ?? null;
  }

  async revealSeed(tradeDate: string, serverSeed: string, siteId?: string): Promise<boolean> {
    const day = this.days.get(dayKey(tradeDate, siteId));
    if (!day || day.revealedAt !== null) return false; // unknown or already revealed -> no-op
    /**
     * The revealed seed MUST hash to the commitment that was published for this day.
     *
     * This mirror used to accept any seed at all, which made it strictly more permissive than
     * production on the one check the whole provable-fairness mechanism rests on:
     * `fn_reveal_game_day` (0048) applies its update only
     * `where server_seed_hash = encode(digest(p_seed,'sha256'),'hex')`. Every test exercising a
     * reveal was therefore passing for free, and a bug that revealed a day under the WRONG seed —
     * the exact failure a master-seed rotation causes — was invisible here while being permanent in
     * production. A mirror that is laxer than the real thing is worse than no mirror: it reports
     * success for code that cannot work.
     *
     * (The RPC additionally requires `p_date < current_date`. That is deliberately NOT mirrored:
     * these tests drive a synthetic clock, so a real-calendar comparison would make them depend on
     * the day they are run.)
     */
    if (commitment(serverSeed) !== day.serverSeedHash) return false;
    day.serverSeed = serverSeed;
    day.revealedAt = new Date().toISOString();
    return true;
  }

  async getSeedVersion(tradeDate: string, siteId?: string): Promise<number> {
    return this.seedVersions.get(dayKey(tradeDate, siteId)) ?? 0;
  }

  async listSeedVersions(siteId?: string): Promise<Map<string, number>> {
    const prefix = `${siteId ?? ""}:`;
    const out = new Map<string, number>();
    for (const [key, version] of this.seedVersions) {
      if (key.startsWith(prefix)) out.set(key.slice(prefix.length), version);
    }
    return out;
  }

  /** Test/dev seam: force a day's seed version (mirrors the `seed_overrides` upsert, J5). */
  setSeedVersion(tradeDate: string, version: number, siteId?: string): void {
    this.seedVersions.set(dayKey(tradeDate, siteId), version);
  }

  async listOpenPositions(): Promise<OpenPositionRow[]> {
    const out: OpenPositionRow[] = [];
    for (const p of this.positions.values()) {
      if (p.status !== "open") continue;
      const meta = this.contractMeta.get(p.id);
      out.push({ id: p.id, userId: p.userId, stakeCents: p.stake, direction: p.direction, durationS: p.durationS, openedAtMs: p.openedAtMs, entryRate: p.entryRate, gameDayId: p.gameDayId, nonce: p.nonce, configVersion: p.configVersion, siteId: p.siteId, kind: meta?.kind ?? "rise_fall", contract: meta?.contract ?? null, slPrice: p.slPrice ?? null, tpPrice: p.tpPrice ?? null, ticket: p.ticket ?? null });
    }
    return out;
  }

  /** Mirrors PgGameRepository.setPositionLevels: open positions only, last write wins. */
  async setPositionLevels(positionId: string, slPrice: number | null, tpPrice: number | null): Promise<void> {
    const p = this.positions.get(positionId);
    if (!p || p.status !== "open") return;
    p.slPrice = slPrice;
    p.tpPrice = tpPrice;
  }

  /**
   * Pending orders (0185), mirrored so a development engine behaves like a deployed one.
   *
   * It survives nothing, because this repository survives nothing: the point is that the engine's
   * own recovery path is exercised rather than skipped, and that an order placed against this
   * repository is listed, filled and cancelled by exactly the code that will run against Postgres.
   */
  private readonly pendingOrders = new Map<string, PendingOrderRow & { filled: boolean; canceled: boolean }>();

  async insertPendingOrder(o: PendingOrderRow): Promise<void> {
    if (this.pendingOrders.has(o.id)) return;
    this.pendingOrders.set(o.id, { ...o, filled: false, canceled: false });
  }

  async markPendingFilled(id: string, _positionId: string): Promise<void> {
    const o = this.pendingOrders.get(id);
    if (!o || o.filled || o.canceled) return;
    o.filled = true;
  }

  async markPendingCanceled(id: string): Promise<void> {
    const o = this.pendingOrders.get(id);
    if (!o || o.filled || o.canceled) return;
    o.canceled = true;
  }

  async listLivePendingOrders(siteId: string | null): Promise<PendingOrderRecord[]> {
    return [...this.pendingOrders.values()]
      .filter((o) => !o.filled && !o.canceled && (siteId === null || o.siteId === siteId))
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .map(({ siteId: _s, filled: _f, canceled: _c, ...rest }) => rest);
  }

  async getFairness(tradeDate: string): Promise<FairnessRecord | null> {
    // Single-tenant callers pass no site; scan for the first day with this trade date.
    let day: MemDay | undefined;
    for (const d of this.days.values()) { if (d.tradeDate === tradeDate) { day = d; break; } }
    if (!day) return null;
    // mirror v_fairness: expose seed only after reveal
    return { gameDayId: day.id, tradeDate: day.tradeDate, serverSeedHash: day.serverSeedHash, serverSeed: day.revealedAt ? day.serverSeed : null, revealedAt: day.revealedAt };
  }

  async listLedger(userId: string, q: PageQuery, siteId?: string): Promise<Page<LedgerEntry>> {
    const limit = clampLimit(q.limit);
    const after = numCursor(q.cursor);
    const rows = this.ledger
      .filter((l) => l.userId === userId && (siteId === undefined || (l.siteId ?? SITE_A_LEGACY) === siteId) && (after === null || l.id < after))
      .sort((a, b) => b.id - a.id)
      .slice(0, limit + 1);
    const page = pageFrom(rows, limit, (l) => String(l.id));
    return { items: page.items.map(toLedgerEntry), nextCursor: page.nextCursor };
  }

  async listPositions(userId: string, q: PositionListQuery, siteId?: string): Promise<Page<PositionRecord>> {
    const limit = clampLimit(q.limit);
    const after = numCursor(q.cursor);
    const rows = [...this.positions.values()]
      .filter((p) => p.userId === userId && (siteId === undefined || (p.siteId ?? SITE_A_LEGACY) === siteId) && (q.status === undefined || p.status === q.status) && (after === null || p.seq < after))
      .sort((a, b) => b.seq - a.seq)
      .slice(0, limit + 1);
    const page = pageFrom(rows, limit, (p) => String(p.seq));
    return { items: page.items.map(toPositionRecord), nextCursor: page.nextCursor };
  }

  async listDigitHistory(userId: string, q: PageQuery, siteId?: string): Promise<Page<DigitHistoryRow>> {
    const limit = clampLimit(q.limit);
    const after = numCursor(q.cursor);
    const rows = [...this.positions.values()]
      .filter((p) => p.userId === userId
        && (siteId === undefined || (p.siteId ?? SITE_A_LEGACY) === siteId)
        && this.contractMeta.get(p.id)?.kind === "digit"
        && (after === null || p.seq < after))
      .sort((a, b) => b.seq - a.seq)
      .slice(0, limit + 1);
    const page = pageFrom(rows, limit, (p) => String(p.seq));
    return {
      items: page.items.map((p) => {
        const c = (this.contractMeta.get(p.id)?.contract ?? {}) as Record<string, unknown>;
        return digitRow({
          id: p.id, contract: c, stake: p.stake, entryRate: p.entryRate, exitRate: p.exitRate,
          payout: p.payout, pnl: p.pnl, result: p.result, status: p.status, openedAtMs: p.openedAtMs, settledAtMs: p.settledAtMs,
        });
      }),
      nextCursor: page.nextCursor,
    };
  }

  async getPositionDetail(userId: string, positionId: string, siteId?: string): Promise<PositionDetail | null> {
    const p = this.positions.get(positionId);
    if (!p || p.userId !== userId) return null;
    if (siteId !== undefined && (p.siteId ?? SITE_A_LEGACY) !== siteId) return null;
    let fairness: FairnessRecord | null = null;
    if (p.gameDayId !== null) {
      for (const day of this.days.values()) {
        if (day.id !== p.gameDayId) continue;
        fairness = { gameDayId: day.id, tradeDate: day.tradeDate, serverSeedHash: day.serverSeedHash, serverSeed: day.revealedAt ? day.serverSeed : null, revealedAt: day.revealedAt };
        break;
      }
    }
    return { ...toPositionRecord(p), fairness };
  }
}

/** Decode an in-memory (numeric-sequence) cursor; null if absent/malformed. */
function numCursor(cursor?: string | null): number | null {
  const t = decodeCursor(cursor);
  if (t === null) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function toLedgerEntry(l: MemLedger): LedgerEntry {
  return { id: l.id, type: l.type, amountCents: l.amount, balanceKind: l.balanceKind, refTable: l.refTable, refId: l.refId, meta: l.meta, createdAtMs: l.createdAtMs };
}

function toPositionRecord(p: MemPos): PositionRecord {
  return {
    id: p.id, userId: p.userId, gameDayId: p.gameDayId, direction: p.direction, stakeCents: p.stake,
    entryRate: p.entryRate, exitRate: p.exitRate, multiplier: p.multiplier, payoutCents: p.payout,
    pnlCents: p.pnl, result: p.result, durationS: p.durationS, status: p.status,
    openedAtMs: p.openedAtMs, settledAtMs: p.settledAtMs,
    // The dev/test repository stores no display prices: there is no day chain behind it to anchor
    // them to, and "at market" is the honest fallback (migration 0180).
    entryPrice: null, exitPrice: null, symbol: null,
    ticket: p.ticket ?? null,
  };
}

/** bigint columns arrive as strings from pg; values are < 2^53 so Number() is exact. */
const toCents = (v: unknown): Cents => (typeof v === "string" ? Number(v) : (v as number));
const toMs = (v: unknown): number => (v instanceof Date ? v.getTime() : new Date(String(v)).getTime());

export class PgGameRepository implements GameRepository {
  constructor(private readonly q: Querier) {}
  async getBalance(userId: string): Promise<Cents> {
    // Spendable game balance: the demo bucket for marketer/demo accounts, real_balance otherwise
    // (migration 0084). fn_is_marketer_account is the one canonical predicate, shared with the money RPCs.
    const r = await this.q.query(
      // DEMO-1: demo bucket for marketers AND players in demo mode (fn_account_is_demo, migration 0123).
      // 0176: a marketer in PRACTICE mode spends their separate practice bucket, never the funny money.
      "select case when fn_is_marketer_account(user_id) and marketer_practice then practice_balance " +
      "when fn_is_marketer_account(user_id) or account_mode = 'demo' then demo_balance else real_balance end as bal " +
      "from wallets where user_id = $1",
      [userId]);
    return r.rows.length ? toCents(r.rows[0].bal) : 0;
  }
  async getWalletSnapshot(userId: string): Promise<WalletSnapshot> {
    const r = await this.q.query(
      "select real_balance, bonus_balance, demo_balance, practice_balance, currency, " +
      "(fn_is_marketer_account(user_id) or account_mode = 'demo') as is_demo_bucket, " +
      "(fn_is_marketer_account(user_id) and marketer_practice) as is_practice from wallets where user_id = $1",
      [userId],
    );
    if (!r.rows.length) return { real: 0, bonus: 0, currency: "KES" };
    const row = r.rows[0];
    // Marketer/demo accounts spend the demo bucket; surface it as `real` so the client shows the
    // one spendable game balance (migration 0084). Their real_balance is 0 and non-withdrawable anyway.
    // 0176: a marketer in practice spends the practice bucket, kept separate from their funny money.
    const spendable = row.is_practice === true
      ? toCents(row.practice_balance)
      : row.is_demo_bucket === true ? toCents(row.demo_balance) : toCents(row.real_balance);
    // DEMO-1: in demo mode the bonus bucket is not spendable (demo stakes never touch it).
    return { real: spendable, bonus: row.is_demo_bucket === true ? 0 : toCents(row.bonus_balance), currency: (row.currency as string) ?? "KES" };
  }
  async openPosition(a: OpenArgs): Promise<OpenResult> {
    // matches migration 0047: fn_open_position(user,stake,direction,entry_rate,duration_s,game_day,nonce,opened_at,config_version,site_id)
    const r = await this.q.query("select position_id, new_balance from fn_open_position($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [a.userId, a.stakeCents, a.direction, a.entryRate, a.durationS, a.gameDayId, a.nonce, new Date(a.openedAtMs).toISOString(), a.configVersion, a.siteId ?? null]);
    const positionId = String(r.rows[0].position_id);
    return { positionId, newBalance: toCents(r.rows[0].new_balance), ticket: await this.readTicket(positionId) };
  }
  async openContract(a: OpenContractArgs): Promise<OpenResult> {
    // migration 0113: fn_open_contract(user,stake,kind,contract,direction,entry_rate,duration_s,game_day,nonce,opened_at,config_version,site_id)
    const r = await this.q.query(
      "select position_id, new_balance from fn_open_contract($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
      [a.userId, a.stakeCents, a.kind, JSON.stringify(a.contract ?? {}), a.direction, a.entryRate, a.durationS, a.gameDayId, a.nonce, new Date(a.openedAtMs).toISOString(), a.configVersion, a.siteId ?? null]);
    const positionId = String(r.rows[0].position_id);
    return { positionId, newBalance: toCents(r.rows[0].new_balance), ticket: await this.readTicket(positionId) };
  }

  /**
   * Read back the ticket the sequence DEFAULT just allocated (migration 0184).
   *
   * Its OWN statement, after the money RPC has returned and committed, for the reason 0184 spells
   * out: `fn_open_position`'s ten-argument signature cannot change, so the ticket cannot come back
   * through it. Folding the read into the same statement with a CTE would not work either — under
   * READ COMMITTED a join does not see the row the function inserted in that same command.
   *
   * A primary-key lookup, so it is the cheapest query the open path makes. It NEVER fails the open:
   * the money has already moved, and refusing a trade that succeeded because its display number
   * could not be read would be the worse outcome by a wide margin. A null ticket renders as a dash,
   * exactly like an unstamped display price.
   */
  private async readTicket(positionId: string): Promise<number | null> {
    try {
      const r = await this.q.query("select ticket from positions where id = $1::uuid", [positionId]);
      const t = r.rows[0]?.ticket;
      return t === null || t === undefined ? null : Number(t);
    } catch {
      return null;
    }
  }
  async settlePosition(a: SettleArgs): Promise<SettleResult> {
    const r = await this.q.query("select settled, new_balance from fn_settle_position($1,$2,$3,$4,$5)",
      [a.positionId, a.exitRate, a.result, a.multiplier, a.payoutCents]);
    return { settled: r.rows[0].settled, newBalance: toCents(r.rows[0].new_balance) };
  }
  async ensureGameDay(tradeDate: string, serverSeedHash: string, siteId?: string): Promise<number | null> {
    // migration 0048: fn_ensure_game_day(date, hash, site_id) — per-site game day.
    const r = await this.q.query("select fn_ensure_game_day($1,$2,$3) as id", [tradeDate, serverSeedHash, siteId ?? null]);
    const id = r.rows[0]?.id;
    return id === null || id === undefined ? null : Number(id);
  }
  async revealSeed(tradeDate: string, serverSeed: string, siteId?: string): Promise<boolean> {
    // migration 0048: fn_reveal_game_day(date, seed, site_id) — scoped to one brand.
    const r = await this.q.query("select fn_reveal_game_day($1,$2,$3) as ok", [tradeDate, serverSeed, siteId ?? null]);
    return Boolean(r.rows[0]?.ok);
  }
  async getSeedVersion(_tradeDate: string, _siteId?: string): Promise<number> {
    // seed_overrides is not yet site-scoped (see docs/22 Task B); forced rotation is superadmin-rare.
    const r = await this.q.query("select version from seed_overrides where trade_date = $1", [_tradeDate]);
    return r.rows.length ? Number(r.rows[0].version) : 0;
  }

  async listSeedVersions(_siteId?: string): Promise<Map<string, number>> {
    // Not site-scoped yet, matching getSeedVersion above. The table holds one row per forced
    // rotation, so it stays small enough to read whole.
    const r = await this.q.query("select trade_date, version from seed_overrides", []);
    const out = new Map<string, number>();
    for (const row of r.rows) out.set(String(row.trade_date).slice(0, 10), Number(row.version));
    return out;
  }
  async listOpenPositions(): Promise<OpenPositionRow[]> {
    const r = await this.q.query(
      "select id, user_id, stake, direction, duration_s, opened_at, entry_rate, game_day_id, nonce, config_version, site_id, kind, contract, sl_price, tp_price, ticket from positions where status = 'open' order by opened_at", []);
    return r.rows.map((x) => ({
      id: String(x.id), userId: String(x.user_id), stakeCents: toCents(x.stake), direction: x.direction as Direction,
      durationS: Number(x.duration_s), openedAtMs: toMs(x.opened_at), entryRate: Number(x.entry_rate),
      gameDayId: x.game_day_id === null || x.game_day_id === undefined ? null : Number(x.game_day_id), nonce: Number(x.nonce),
      configVersion: x.config_version === null || x.config_version === undefined ? null : Number(x.config_version),
      siteId: x.site_id === null || x.site_id === undefined ? null : String(x.site_id),
      kind: (x.kind ?? "rise_fall") as string,
      contract: x.contract ?? null,
      slPrice: x.sl_price === null || x.sl_price === undefined ? null : Number(x.sl_price),
      tpPrice: x.tp_price === null || x.tp_price === undefined ? null : Number(x.tp_price),
      ticket: x.ticket === null || x.ticket === undefined ? null : Number(x.ticket),
    }));
  }
  async getCommittedSeedHash(tradeDate: string, siteId?: string): Promise<string | null> {
    // Scoped to the brand, unlike getFairness below — see the interface comment for why that
    // distinction is load-bearing rather than stylistic.
    const r = await this.q.query(
      `select server_seed_hash from game_days
        where trade_date = $1 and ($2::uuid is null or site_id = $2)
        limit 1`, [tradeDate, siteId ?? null]);
    const v = r.rows[0]?.server_seed_hash;
    return v == null ? null : String(v);
  }

  async getFairness(tradeDate: string): Promise<FairnessRecord | null> {
    const r = await this.q.query("select id, trade_date, server_seed_hash, server_seed, revealed_at from v_fairness where trade_date = $1", [tradeDate]);
    if (!r.rows.length) return null;
    const x = r.rows[0];
    return {
      gameDayId: x.id === null || x.id === undefined ? null : Number(x.id),
      tradeDate: x.trade_date instanceof Date ? x.trade_date.toISOString().slice(0, 10) : String(x.trade_date),
      serverSeedHash: String(x.server_seed_hash), serverSeed: x.server_seed ?? null,
      revealedAt: x.revealed_at ? (x.revealed_at instanceof Date ? x.revealed_at.toISOString() : String(x.revealed_at)) : null,
    };
  }

  async listLedger(userId: string, q: PageQuery, siteId?: string): Promise<Page<LedgerEntry>> {
    const limit = clampLimit(q.limit);
    const cur = decodeKeyset(q.cursor);
    const r = await this.q.query(
      `select id, type, amount, balance_kind, ref_table, ref_id, meta, created_at
         from ledger_entries
        where user_id = $1
          and ($5::uuid is null or site_id = $5)
          and ($2::timestamptz is null or (created_at, id) < (coalesce((select k.created_at from ledger_entries k where k.id = $3::bigint and k.user_id = $1), $2::timestamptz), $3::bigint))
        order by created_at desc, id desc
        limit $4`,
      [userId, cur ? new Date(cur.tsMs).toISOString() : null, cur ? cur.id : null, limit + 1, siteId ?? null]);
    const rows: LedgerEntry[] = r.rows.map((x) => ({
      id: Number(x.id), type: String(x.type), amountCents: toCents(x.amount), balanceKind: String(x.balance_kind),
      refTable: x.ref_table ?? null, refId: x.ref_id ?? null, meta: x.meta ?? null, createdAtMs: toMs(x.created_at),
    }));
    return pageFrom(rows, limit, (e) => encodeKeysetToken(e.createdAtMs, e.id));
  }

  async listPositions(userId: string, q: PositionListQuery, siteId?: string): Promise<Page<PositionRecord>> {
    const limit = clampLimit(q.limit);
    const cur = decodeKeyset(q.cursor);
    const r = await this.q.query(
      `select id, user_id, game_day_id, direction, stake, entry_rate, exit_rate, entry_price, exit_price, symbol, ticket, multiplier, payout, pnl, result, duration_s, status, opened_at, settled_at
         from positions
        where user_id = $1
          and ($6::uuid is null or site_id = $6)
          and ($2::text is null or status = $2)
          and ($3::timestamptz is null or (opened_at, id) < (coalesce((select k.opened_at from positions k where k.id = $4::uuid and k.user_id = $1), $3::timestamptz), $4::uuid))
        order by opened_at desc, id desc
        limit $5`,
      [userId, q.status ?? null, cur ? new Date(cur.tsMs).toISOString() : null, cur ? cur.id : null, limit + 1, siteId ?? null]);
    const rows: PositionRecord[] = r.rows.map(mapPositionRow);
    return pageFrom(rows, limit, (p) => encodeKeysetToken(p.openedAtMs, p.id));
  }

  async listDigitHistory(userId: string, q: PageQuery, siteId?: string): Promise<Page<DigitHistoryRow>> {
    const limit = clampLimit(q.limit);
    const cur = decodeKeyset(q.cursor);
    const r = await this.q.query(
      // A MARKETER's account_mode stays 'demo', so their funny-money (REAL) trades are stored demo=true
      // and their practice-bucket trades demo=false/practice=true (0176). The client presents the funny
      // money as the Real account, so the DEMO tag must follow `practice` for a marketer — not `demo`,
      // which would wrongly tag every real trade and miss every practice one. Players are unchanged.
      `select id, stake, entry_rate, exit_rate, payout, pnl, result, status, opened_at, settled_at, contract,
              (case when fn_is_marketer_account(user_id) then coalesce(practice, false) else demo end) as demo
         from positions
        where user_id = $1 and kind = 'digit'
          and ($4::uuid is null or site_id = $4)
          and ($2::timestamptz is null or (opened_at, id) < (coalesce((select k.opened_at from positions k where k.id = $3::uuid and k.user_id = $1), $2::timestamptz), $3::uuid))
        order by opened_at desc, id desc
        limit $5`,
      [userId, cur ? new Date(cur.tsMs).toISOString() : null, cur ? cur.id : null, siteId ?? null, limit + 1]);
    const rows = r.rows.map((x: any) => digitRow({
      id: String(x.id), contract: (x.contract ?? {}) as Record<string, unknown>,
      stake: toCents(x.stake), entryRate: Number(x.entry_rate), exitRate: x.exit_rate == null ? null : Number(x.exit_rate),
      payout: x.payout == null ? null : toCents(x.payout), pnl: x.pnl == null ? null : toCents(x.pnl),
      result: x.result ?? null, status: String(x.status), openedAtMs: toMs(x.opened_at),
      settledAtMs: x.settled_at ? toMs(x.settled_at) : null, demo: x.demo === true,
    }));
    return pageFrom(rows, limit, (d) => encodeKeysetToken(d.openedAtMs, d.id));
  }

  async getPositionDetail(userId: string, positionId: string, siteId?: string): Promise<PositionDetail | null> {
    const r = await this.q.query(
      `select p.id, p.user_id, p.game_day_id, p.direction, p.stake, p.entry_rate, p.exit_rate, p.entry_price, p.exit_price, p.symbol, p.ticket, p.multiplier, p.payout, p.pnl, p.result, p.duration_s, p.status, p.opened_at, p.settled_at,
              f.id as f_id, f.trade_date as f_trade_date, f.server_seed_hash as f_hash, f.server_seed as f_seed, f.revealed_at as f_revealed
         from positions p
         left join v_fairness f on f.id = p.game_day_id
        where p.id = $1::uuid and p.user_id = $2
          and ($3::uuid is null or p.site_id = $3)`,
      [positionId, userId, siteId ?? null]);
    if (!r.rows.length) return null;
    const x = r.rows[0];
    const fairness: FairnessRecord | null = x.f_id === null || x.f_id === undefined ? null : {
      gameDayId: Number(x.f_id),
      tradeDate: x.f_trade_date instanceof Date ? x.f_trade_date.toISOString().slice(0, 10) : String(x.f_trade_date),
      serverSeedHash: String(x.f_hash), serverSeed: x.f_seed ?? null,
      revealedAt: x.f_revealed ? (x.f_revealed instanceof Date ? x.f_revealed.toISOString() : String(x.f_revealed)) : null,
    };
    return { ...mapPositionRow(x), fairness };
  }

  /**
   * Stamp the display prices this trade executed at (migration 0180).
   *
   * Reads the row rather than taking the rates as arguments, for two reasons. The exit price must be
   * placed on the axis of the day it SETTLED on — a contract opened at 23:59:58 settles after
   * midnight against the next day's anchor — and only the row carries the `settled_at` the database
   * recorded; and crash recovery settles positions long after their nominal expiry, where "now" is
   * the wrong day entirely. The row is the one source that is right in both cases.
   *
   * `coalesce` in the UPDATE makes this idempotent and makes a first-stamped price permanent: the
   * open call fills the entry, the settle call fills the exit, and neither can overwrite the other
   * if the day chain is later rebuilt under a different config.
   */
  async setExecutionPrices(positionId: string, axis: PriceAxis, symbol?: string): Promise<void> {
    const r = await this.q.query(
      "select opened_at, settled_at, entry_rate, exit_rate, entry_price, exit_price, symbol from positions where id = $1::uuid",
      [positionId]);
    if (!r.rows.length) return;
    const x = r.rows[0];
    const entry = x.entry_price === null || x.entry_price === undefined
      ? priceAtRate(axis, toMs(x.opened_at), Number(x.entry_rate))
      : null;
    const exit = (x.exit_price === null || x.exit_price === undefined) && x.exit_rate !== null && x.exit_rate !== undefined && x.settled_at
      ? priceAtRate(axis, toMs(x.settled_at), Number(x.exit_rate))
      : null;
    /**
     * The instrument, on the same UPDATE (migration 0182).
     *
     * It rides here rather than in the money RPC for the reason this whole wrapper exists: the
     * atomic open and settle are called with exactly the arguments they always were. `coalesce`
     * makes it first-write-wins like the prices, so a later stamp cannot relabel a settled trade.
     */
    const sym = (x.symbol === null || x.symbol === undefined) && symbol ? symbol : null;
    if (entry === null && exit === null && sym === null) return;
    await this.q.query(
      "update positions set entry_price = coalesce(entry_price, $2), exit_price = coalesce(exit_price, $3), symbol = coalesce(symbol, $4) where id = $1::uuid",
      [positionId, entry, exit, sym]);
  }

  /**
   * The trader's protective levels, written straight (migration 0183).
   *
   * A plain assignment rather than the `coalesce` the display prices use: moving a stop and clearing
   * one are what Modify position IS, so the last write has to win and null has to mean "not set".
   * Scoped to an OPEN position so a late write cannot annotate a settled receipt.
   */
  async setPositionLevels(positionId: string, slPrice: number | null, tpPrice: number | null): Promise<void> {
    await this.q.query(
      "update positions set sl_price = $2, tp_price = $3 where id = $1::uuid and status = 'open'",
      [positionId, slPrice, tpPrice]);
  }

  // ── Pending orders (migration 0185) ────────────────────────────────────────────────────────────
  // An order is an INSTRUCTION, never an amount: nothing here debits anyone, and the only thing a
  // row ever causes is the same `fn_open_position` a market order calls, once, after the engine has
  // already removed it from its own book. See apps/engine/src/pending.ts.

  async insertPendingOrder(o: PendingOrderRow): Promise<void> {
    await this.q.query(
      `insert into pending_orders
         (id, site_id, user_id, kind, symbol, stake_cents, trigger_price, sl_price, tp_price, duration_s, created_at)
       values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, to_timestamp($11 / 1000.0))
       on conflict (id) do nothing`,
      [o.id, o.siteId, o.userId, o.kind, o.symbol, o.stakeCents, o.triggerPrice,
       o.slPrice, o.tpPrice, o.durationS, o.createdAtMs]);
  }

  /**
   * Stamp the fill. Guarded on the order still being live, so a replay after a restart cannot mark
   * one order filled by two different positions, and `filled_position_id` records which it became.
   */
  async markPendingFilled(id: string, positionId: string): Promise<void> {
    await this.q.query(
      `update pending_orders set filled_at = now(), filled_position_id = $2::uuid
        where id = $1::uuid and filled_at is null and canceled_at is null`,
      [id, positionId]);
  }

  async markPendingCanceled(id: string): Promise<void> {
    await this.q.query(
      `update pending_orders set canceled_at = now()
        where id = $1::uuid and filled_at is null and canceled_at is null`,
      [id]);
  }

  /** Boot: everything still waiting for this brand, so a deploy does not disarm it. */
  async listLivePendingOrders(siteId: string | null): Promise<PendingOrderRecord[]> {
    const { rows } = await this.q.query(
      `select id, user_id, kind, symbol, stake_cents, trigger_price, sl_price, tp_price,
              duration_s, created_at
         from pending_orders
        where filled_at is null and canceled_at is null
          and ($1::uuid is null or site_id = $1::uuid)
        order by created_at asc`,
      [siteId]);
    return rows.map((x: any) => ({
      id: String(x.id),
      userId: String(x.user_id),
      kind: String(x.kind) as PendingOrderRecord["kind"],
      symbol: String(x.symbol),
      stakeCents: Number(x.stake_cents),
      triggerPrice: Number(x.trigger_price),
      slPrice: x.sl_price === null || x.sl_price === undefined ? null : Number(x.sl_price),
      tpPrice: x.tp_price === null || x.tp_price === undefined ? null : Number(x.tp_price),
      durationS: Number(x.duration_s),
      createdAtMs: toMs(x.created_at),
    }));
  }
}

/** Map a raw `positions` row (optionally joined) into the public PositionRecord. */
function mapPositionRow(x: any): PositionRecord {
  return {
    id: String(x.id), userId: String(x.user_id),
    gameDayId: x.game_day_id === null || x.game_day_id === undefined ? null : Number(x.game_day_id),
    direction: x.direction as Direction, stakeCents: toCents(x.stake), entryRate: Number(x.entry_rate),
    exitRate: x.exit_rate === null || x.exit_rate === undefined ? null : Number(x.exit_rate),
    multiplier: x.multiplier === null || x.multiplier === undefined ? null : Number(x.multiplier),
    payoutCents: x.payout === null || x.payout === undefined ? null : toCents(x.payout),
    pnlCents: x.pnl === null || x.pnl === undefined ? null : toCents(x.pnl),
    result: x.result ?? null, durationS: Number(x.duration_s), status: String(x.status),
    openedAtMs: toMs(x.opened_at), settledAtMs: x.settled_at ? toMs(x.settled_at) : null,
    // Display prices (0180). Absent on a row written before the stamper existed, and on a brand that
    // charts a line rather than candles — both read back as null, which the client shows as "at market".
    entryPrice: x.entry_price === null || x.entry_price === undefined ? null : Number(x.entry_price),
    exitPrice: x.exit_price === null || x.exit_price === undefined ? null : Number(x.exit_price),
    // The instrument (0182). Null on any row written before the column, which the client reads as
    // the brand's own symbol: exactly what every row meant before this existed.
    symbol: x.symbol === null || x.symbol === undefined ? null : String(x.symbol),
    // The ticket (0184). Null only on a row that predates the column; every row written since
    // carries one, because the sequence DEFAULT fires inside the money RPC's own INSERT.
    ticket: x.ticket === null || x.ticket === undefined ? null : Number(x.ticket),
  };
}

/** Keyset token for Postgres cursors: `<createdAtMs>:<id>`. */
function encodeKeysetToken(tsMs: number, id: string | number): string { return `${tsMs}:${id}`; }

/** Build a DigitHistoryRow from a position's stored fields + its `contract` params. The settled digit
 *  is the last pip of the (persisted) exit spot, so it is correct for BOTH the pool and statistical
 *  paths without any extra column. */
function digitRow(o: { id: string; contract: Record<string, unknown>; stake: Cents; entryRate: number; exitRate: number | null; payout: Cents | null; pnl: Cents | null; result: string | null; status: string; openedAtMs: number; settledAtMs: number | null; demo?: boolean }): DigitHistoryRow {
  const num = (v: unknown): number | null => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : null);
  return {
    id: o.id,
    kind: String(o.contract.kind ?? ""),
    target: num(o.contract.target),
    instrumentId: o.contract.instrumentId != null ? String(o.contract.instrumentId) : null,
    openIndex: num(o.contract.openIndex),
    settleIndex: num(o.contract.settleIndex),
    stakeCents: o.stake, entryRate: o.entryRate, exitRate: o.exitRate,
    settleDigit: o.exitRate == null ? null : lastDigit(o.exitRate),
    payoutCents: o.payout, pnlCents: o.pnl, result: o.result, status: o.status,
    openedAtMs: o.openedAtMs, settledAtMs: o.settledAtMs, demo: o.demo === true,
  };
}
