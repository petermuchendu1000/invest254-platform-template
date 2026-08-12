import { randomUUID } from "node:crypto";
import { type Cents, assertCents } from "@invest254/shared";
import type { Direction } from "@invest254/shared";
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
export interface OpenResult { positionId: string; newBalance: Cents; }
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
}

/** A single position plus its day's public fairness data (seed hidden until reveal). */
export interface PositionDetail extends PositionRecord { fairness: FairnessRecord | null; }

/** Filters for a player's position history. */
export interface PositionListQuery extends PageQuery { status?: string | undefined; }

export interface GameRepository {
  getBalance(userId: string): Promise<Cents>;
  /** Full wallet snapshot (real + bonus + currency) for the real-time `balance` push. */
  getWalletSnapshot(userId: string): Promise<WalletSnapshot>;
  openPosition(a: OpenArgs): Promise<OpenResult>;
  settlePosition(a: SettleArgs): Promise<SettleResult>;
  /** Idempotently commit a game day (stores hash; seed stays hidden). Returns its id. `siteId` scopes it per brand. */
  ensureGameDay(tradeDate: string, serverSeedHash: string, siteId?: string): Promise<number | null>;
  /** Reveal a past day's seed (commitment- and past-only-checked in the DB). Returns whether it took effect. `siteId` scopes it per brand. */
  revealSeed(tradeDate: string, serverSeed: string, siteId?: string): Promise<boolean>;
  /** Durable seed version for a day (0 unless a superadmin forced a rotation; see `seed_overrides`, J5). `siteId` scopes it per brand. */
  getSeedVersion(tradeDate: string, siteId?: string): Promise<number>;
  /** All positions still open — the crash-recovery work list. */
  listOpenPositions(): Promise<OpenPositionRow[]>;
  /** Public fairness record for a day, or null if the day is unknown. */
  getFairness(tradeDate: string): Promise<FairnessRecord | null>;
  /** A player's wallet ledger, newest-first, cursor-paginated. `siteId` scopes it per brand. */
  listLedger(userId: string, q: PageQuery, siteId?: string): Promise<Page<LedgerEntry>>;
  /** A player's position history (optional status filter), newest-first, cursor-paginated. `siteId` scopes it per brand. */
  listPositions(userId: string, q: PositionListQuery, siteId?: string): Promise<Page<PositionRecord>>;
  /** A single owned position with its day's fairness data, or null if not found/owned. `siteId` scopes it per brand. */
  getPositionDetail(userId: string, positionId: string, siteId?: string): Promise<PositionDetail | null>;
}

/** Minimal query surface compatible with `pg`'s Pool/Client. */
export interface Querier { query(text: string, params: unknown[]): Promise<{ rows: any[] }>; }

interface MemPos {
  id: string; userId: string; stake: Cents; status: "open" | "settled";
  direction: Direction; durationS: number; openedAtMs: number; entryRate: number;
  gameDayId: number | null; nonce: number; configVersion: number | null; seq: number;
  siteId: string | null;
  exitRate: number | null; multiplier: number | null; payout: Cents | null; pnl: Cents | null;
  result: string | null; settledAtMs: number | null;
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
  private positions = new Map<string, MemPos>();
  private days = new Map<string, MemDay>();
  private seedVersions = new Map<string, number>();
  private nextDayId = 1;
  private posSeq = 0;
  private ledgerSeq = 0;
  readonly ledger: MemLedger[] = [];

  constructor(private readonly now: () => number = () => Date.now()) {}

  private pushLedger(userId: string, type: string, amount: Cents, balanceKind: string, refTable: string | null, refId: string | null, meta: unknown = null, siteId: string | null = null): void {
    this.ledger.push({ id: ++this.ledgerSeq, userId, type, amount, balanceKind, refTable, refId, meta, createdAtMs: this.now(), siteId });
  }

  seed(userId: string, amount: Cents): void { this.balances.set(userId, assertCents(amount)); this.pushLedger(userId, "seed", amount, "real", null, "seed"); }
  async getBalance(userId: string): Promise<Cents> { return this.balances.get(userId) ?? 0; }
  async getWalletSnapshot(userId: string): Promise<WalletSnapshot> {
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
    const bal = this.balances.get(a.userId);
    if (bal === undefined) throw new Error("WALLET_NOT_FOUND");
    if (bal < a.stakeCents) throw new Error("INSUFFICIENT_FUNDS");
    const next = bal - a.stakeCents; this.balances.set(a.userId, next);
    const id = randomUUID();
    this.positions.set(id, {
      id, userId: a.userId, stake: a.stakeCents, status: "open",
      direction: a.direction, durationS: a.durationS, openedAtMs: a.openedAtMs,
      entryRate: a.entryRate, gameDayId: a.gameDayId, nonce: a.nonce,
      configVersion: a.configVersion ?? null, seq: ++this.posSeq, siteId: a.siteId ?? null,
      exitRate: null, multiplier: null, payout: null, pnl: null, result: null, settledAtMs: null,
    });
    this.pushLedger(a.userId, "stake", -a.stakeCents, "real", "positions", id, null, a.siteId ?? null);
    return { positionId: id, newBalance: next };
  }

  async settlePosition(a: SettleArgs): Promise<SettleResult> {
    if (a.payoutCents < 0) throw new Error("INVALID_PAYOUT");
    const p = this.positions.get(a.positionId);
    if (!p) throw new Error("POSITION_NOT_FOUND");
    if (p.status !== "open") return { settled: false, newBalance: this.balances.get(p.userId) ?? 0 }; // idempotent
    p.status = "settled";
    p.exitRate = a.exitRate; p.multiplier = a.multiplier; p.payout = a.payoutCents;
    p.pnl = a.payoutCents - p.stake; p.result = a.result; p.settledAtMs = this.now();
    let bal = this.balances.get(p.userId) ?? 0;
    if (a.payoutCents > 0) { bal += a.payoutCents; this.balances.set(p.userId, bal); this.pushLedger(p.userId, "payout", a.payoutCents, "real", "positions", a.positionId, null, p.siteId); }
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

  async revealSeed(tradeDate: string, serverSeed: string, siteId?: string): Promise<boolean> {
    const day = this.days.get(dayKey(tradeDate, siteId));
    if (!day || day.revealedAt !== null) return false; // unknown or already revealed -> no-op
    day.serverSeed = serverSeed;
    day.revealedAt = new Date().toISOString();
    return true;
  }

  async getSeedVersion(tradeDate: string, siteId?: string): Promise<number> {
    return this.seedVersions.get(dayKey(tradeDate, siteId)) ?? 0;
  }

  /** Test/dev seam: force a day's seed version (mirrors the `seed_overrides` upsert, J5). */
  setSeedVersion(tradeDate: string, version: number, siteId?: string): void {
    this.seedVersions.set(dayKey(tradeDate, siteId), version);
  }

  async listOpenPositions(): Promise<OpenPositionRow[]> {
    const out: OpenPositionRow[] = [];
    for (const p of this.positions.values()) {
      if (p.status !== "open") continue;
      out.push({ id: p.id, userId: p.userId, stakeCents: p.stake, direction: p.direction, durationS: p.durationS, openedAtMs: p.openedAtMs, entryRate: p.entryRate, gameDayId: p.gameDayId, nonce: p.nonce, configVersion: p.configVersion, siteId: p.siteId });
    }
    return out;
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
  };
}

/** bigint columns arrive as strings from pg; values are < 2^53 so Number() is exact. */
const toCents = (v: unknown): Cents => (typeof v === "string" ? Number(v) : (v as number));
const toMs = (v: unknown): number => (v instanceof Date ? v.getTime() : new Date(String(v)).getTime());

export class PgGameRepository implements GameRepository {
  constructor(private readonly q: Querier) {}
  async getBalance(userId: string): Promise<Cents> {
    const r = await this.q.query("select real_balance from wallets where user_id = $1", [userId]);
    return r.rows.length ? toCents(r.rows[0].real_balance) : 0;
  }
  async getWalletSnapshot(userId: string): Promise<WalletSnapshot> {
    const r = await this.q.query(
      "select real_balance, bonus_balance, currency from wallets where user_id = $1",
      [userId],
    );
    if (!r.rows.length) return { real: 0, bonus: 0, currency: "KES" };
    const row = r.rows[0];
    return { real: toCents(row.real_balance), bonus: toCents(row.bonus_balance), currency: (row.currency as string) ?? "KES" };
  }
  async openPosition(a: OpenArgs): Promise<OpenResult> {
    // matches migration 0047: fn_open_position(user,stake,direction,entry_rate,duration_s,game_day,nonce,opened_at,config_version,site_id)
    const r = await this.q.query("select position_id, new_balance from fn_open_position($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [a.userId, a.stakeCents, a.direction, a.entryRate, a.durationS, a.gameDayId, a.nonce, new Date(a.openedAtMs).toISOString(), a.configVersion, a.siteId ?? null]);
    return { positionId: r.rows[0].position_id, newBalance: toCents(r.rows[0].new_balance) };
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
  async listOpenPositions(): Promise<OpenPositionRow[]> {
    const r = await this.q.query(
      "select id, user_id, stake, direction, duration_s, opened_at, entry_rate, game_day_id, nonce, config_version, site_id from positions where status = 'open' order by opened_at", []);
    return r.rows.map((x) => ({
      id: String(x.id), userId: String(x.user_id), stakeCents: toCents(x.stake), direction: x.direction as Direction,
      durationS: Number(x.duration_s), openedAtMs: toMs(x.opened_at), entryRate: Number(x.entry_rate),
      gameDayId: x.game_day_id === null || x.game_day_id === undefined ? null : Number(x.game_day_id), nonce: Number(x.nonce),
      configVersion: x.config_version === null || x.config_version === undefined ? null : Number(x.config_version),
      siteId: x.site_id === null || x.site_id === undefined ? null : String(x.site_id),
    }));
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
          and ($2::timestamptz is null or (created_at, id) < ($2::timestamptz, $3::bigint))
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
      `select id, user_id, game_day_id, direction, stake, entry_rate, exit_rate, multiplier, payout, pnl, result, duration_s, status, opened_at, settled_at
         from positions
        where user_id = $1
          and ($6::uuid is null or site_id = $6)
          and ($2::text is null or status = $2)
          and ($3::timestamptz is null or (opened_at, id) < ($3::timestamptz, $4::uuid))
        order by opened_at desc, id desc
        limit $5`,
      [userId, q.status ?? null, cur ? new Date(cur.tsMs).toISOString() : null, cur ? cur.id : null, limit + 1, siteId ?? null]);
    const rows: PositionRecord[] = r.rows.map(mapPositionRow);
    return pageFrom(rows, limit, (p) => encodeKeysetToken(p.openedAtMs, p.id));
  }

  async getPositionDetail(userId: string, positionId: string, siteId?: string): Promise<PositionDetail | null> {
    const r = await this.q.query(
      `select p.id, p.user_id, p.game_day_id, p.direction, p.stake, p.entry_rate, p.exit_rate, p.multiplier, p.payout, p.pnl, p.result, p.duration_s, p.status, p.opened_at, p.settled_at,
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
  };
}

/** Keyset token for Postgres cursors: `<createdAtMs>:<id>`. */
function encodeKeysetToken(tsMs: number, id: string | number): string { return `${tsMs}:${id}`; }
