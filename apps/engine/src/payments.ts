import { randomUUID } from "node:crypto";
import { type Cents, assertCents } from "@invest254/shared";
import type { Querier } from "./wallet.js";
import { type Page, type PageQuery, clampLimit, decodeCursor, decodeKeyset, pageFrom } from "./paging.js";

/**
 * PaymentRepository: durable, money-atomic boundary for deposits/withdrawals. Each method
 * maps 1:1 to a migration-0014 SECURITY DEFINER RPC (deposit credit; withdrawal
 * hold/approve/reject/complete-with-reversal), all idempotent. The in-memory implementation
 * mirrors the same contract for tests; both are exercised the same way by PaymentService.
 */
export interface CompleteResult { applied: boolean; status: string; newBalance: Cents; }
export interface CreateWithdrawalResult { txId: string; newBalance: Cents; }
/** Result of the marketer instant game->mpesa transfer path (see fn_marketer_game_withdraw). */
export interface GameWithdrawResult { isMarketer: boolean; txId?: string; newBalance?: Cents; mpesaBalanceCents?: Cents; }
/** Outcome of a player withdrawal request: an instant marketer transfer, or a normal (Daraja) hold. */
export type WithdrawalOutcome =
  | { mode: "marketer"; txId: string; newBalance: Cents; mpesaBalanceCents: Cents }
  | { mode: "daraja"; txId: string; newBalance: Cents };
export interface ApproveResult { approved: boolean; amountCents: Cents | null; phone: string | null; }
export interface TxRow { id: string; userId: string; kind: "deposit" | "withdrawal"; amountCents: Cents; status: string; phone: string; }

/** A transaction as shown in a player's payment history. */
export interface TransactionRecord {
  id: string; kind: "deposit" | "withdrawal"; amountCents: Cents; status: string;
  provider: string; phone: string; mpesaReceipt: string | null; createdAtMs: number;
}
/** Filters for a player's transaction history. */
export interface TxListQuery extends PageQuery { kind?: "deposit" | "withdrawal" | undefined; status?: string | undefined; }
/** A transaction as the admin back office sees it (J2). */
export interface AdminTxSnapshot { txId: string; userId: string; kind: "deposit" | "withdrawal"; amountCents: Cents; status: string; phone: string; mpesaReceipt: string | null; checkoutRequestId: string | null; createdAtMs: number; siteId?: string | null; }

/** A deposit still awaiting a terminal outcome — the reconciliation sweep's unit of work. */
export interface UnsettledDeposit { txId: string; checkoutRequestId: string; }

export interface PaymentRepository {
  getBalance(userId: string, siteId?: string): Promise<Cents>;
  createDeposit(userId: string, amountCents: Cents, phone: string, siteId?: string): Promise<string>;
  attachStk(txId: string, merchantRequestId: string, checkoutRequestId: string): Promise<boolean>;
  completeDeposit(checkoutRequestId: string, resultCode: number, resultDesc: string, receipt: string | null, raw: unknown): Promise<CompleteResult>;
  createWithdrawal(userId: string, amountCents: Cents, phone: string, minCents: Cents, siteId?: string): Promise<CreateWithdrawalResult>;
  /**
   * Marketer instant withdrawal: if this player's phone is a marketer, move the amount from the
   * game wallet into that phone's mpesa (marketer) wallet atomically and return the balances.
   * `isMarketer:false` means the caller should fall back to the normal (Daraja) withdrawal.
   */
  gameWithdraw(userId: string, amountCents: Cents): Promise<GameWithdrawResult>;
  approveWithdrawal(txId: string, adminId: string): Promise<ApproveResult>;
  rejectWithdrawal(txId: string, adminId: string): Promise<{ reversed: boolean; newBalance: Cents }>;
  completeWithdrawal(txId: string, resultCode: number, conversationId: string | null, receipt: string | null, raw: unknown): Promise<CompleteResult>;
  getTransaction(txId: string): Promise<TxRow | null>;
  /** A player's transaction history (optional kind/status filter), newest-first, cursor-paginated. `siteId` scopes it per brand. */
  listTransactions(userId: string, q: TxListQuery, siteId?: string): Promise<Page<TransactionRecord>>;
  /** Deposits still non-terminal after `olderThanMs` (oldest first) — input to the reconcile sweep. */
  listUnsettledDeposits(olderThanMs: number, limit: number): Promise<UnsettledDeposit[]>;
}

interface MemTx { id: string; userId: string; kind: "deposit" | "withdrawal"; amount: Cents; status: string; phone: string; checkoutId?: string; seq: number; createdAtMs: number; receipt: string | null; siteId?: string | null; }
interface MemLedger { userId: string; type: string; amount: Cents; ref: string; }

export class InMemoryPaymentRepository implements PaymentRepository {
  private balances = new Map<string, Cents>();
  private txns = new Map<string, MemTx>();
  private byCheckout = new Map<string, string>();
  private txSeq = 0;
  readonly ledger: MemLedger[] = [];

  constructor(private readonly now: () => number = () => Date.now()) {}

  seed(userId: string, cents: Cents): void { this.balances.set(userId, assertCents(cents)); }
  async getBalance(userId: string, _siteId?: string): Promise<Cents> { return this.balances.get(userId) ?? 0; }

  async createDeposit(userId: string, amountCents: Cents, phone: string, siteId?: string): Promise<string> {
    if (amountCents <= 0) throw new Error("INVALID_AMOUNT");
    if (!this.balances.has(userId)) throw new Error("WALLET_NOT_FOUND");
    const id = randomUUID();
    this.txns.set(id, { id, userId, kind: "deposit", amount: amountCents, status: "pending", phone, seq: ++this.txSeq, createdAtMs: this.now(), receipt: null, siteId: siteId ?? null });
    return id;
  }
  async attachStk(txId: string, _merchant: string, checkoutId: string): Promise<boolean> {
    const tx = this.txns.get(txId);
    if (!tx || tx.kind !== "deposit" || tx.status !== "pending") return false;
    tx.status = "processing"; tx.checkoutId = checkoutId; this.byCheckout.set(checkoutId, txId);
    return true;
  }
  async completeDeposit(checkoutId: string, resultCode: number, _desc: string, receipt: string | null, _raw: unknown): Promise<CompleteResult> {
    const txId = this.byCheckout.get(checkoutId);
    const tx = txId ? this.txns.get(txId) : undefined;
    if (!tx) throw new Error("TX_NOT_FOUND");
    if (tx.status === "success" || tx.status === "failed") return { applied: false, status: tx.status, newBalance: await this.getBalance(tx.userId) };
    if (resultCode === 0) {
      tx.status = "success"; tx.receipt = receipt;
      const bal = (this.balances.get(tx.userId) ?? 0) + tx.amount; this.balances.set(tx.userId, bal);
      this.ledger.push({ userId: tx.userId, type: "deposit", amount: tx.amount, ref: `transactions:${tx.id}` });
      return { applied: true, status: "success", newBalance: bal };
    }
    tx.status = "failed";
    return { applied: true, status: "failed", newBalance: await this.getBalance(tx.userId) };
  }

  async listUnsettledDeposits(olderThanMs: number, limit: number): Promise<UnsettledDeposit[]> {
    const cutoff = this.now() - olderThanMs;
    return [...this.txns.values()]
      .filter((t) => t.kind === "deposit" && (t.status === "pending" || t.status === "processing") && !!t.checkoutId && t.createdAtMs <= cutoff)
      .sort((a, b) => a.createdAtMs - b.createdAtMs || a.seq - b.seq)
      .slice(0, limit)
      .map((t) => ({ txId: t.id, checkoutRequestId: t.checkoutId! }));
  }

  async createWithdrawal(userId: string, amountCents: Cents, phone: string, minCents: Cents, siteId?: string): Promise<CreateWithdrawalResult> {
    if (amountCents <= 0) throw new Error("INVALID_AMOUNT");
    if (amountCents < minCents) throw new Error("BELOW_MIN");
    const bal = this.balances.get(userId);
    if (bal === undefined) throw new Error("WALLET_NOT_FOUND");
    if (bal < amountCents) throw new Error("INSUFFICIENT_FUNDS");
    const next = bal - amountCents; this.balances.set(userId, next);
    const id = randomUUID();
    this.txns.set(id, { id, userId, kind: "withdrawal", amount: amountCents, status: "pending", phone, seq: ++this.txSeq, createdAtMs: this.now(), receipt: null, siteId: siteId ?? null });
    this.ledger.push({ userId, type: "withdrawal", amount: -amountCents, ref: `transactions:${id}` });
    return { txId: id, newBalance: next };
  }
  /**
   * In-memory mirror of fn_marketer_game_withdraw (0036): when a marketer phone is registered
   * via markAsMarketer(), the amount moves instantly from the game wallet into the marketer
   * wallet (recorded via the injected hook so tests can mirror the marketer ledger); otherwise
   * falls through to the normal (Daraja) path. Guards mirror the SQL: active-only, positive
   * amount, sufficient funds.
   */
  private marketerPhones = new Map<string, string>(); // local phone -> marketer id
  /** Test hook: register a phone as an active marketer wallet (mirrors the marketers table). */
  markAsMarketer(phone: string, marketerId: string): void { this.marketerPhones.set(phone, marketerId); }
  /** Test hook: invoked with the credited marketer id/amount so tests can mirror fn_marketer_credit. */
  onMarketerCredit: ((marketerId: string, amountCents: Cents, ref: string) => void) | null = null;
  private phones = new Map<string, string>(); // userId -> local phone (seed via setPhone)
  /** Test hook: set the player's profile phone (local 0XXXXXXXXX form). */
  setPhone(userId: string, phone: string): void { this.phones.set(userId, phone); }
  async gameWithdraw(userId: string, amountCents: Cents): Promise<GameWithdrawResult> {
    const phone = this.phones.get(userId);
    const marketerId = phone ? this.marketerPhones.get(phone) : undefined;
    if (!marketerId) return { isMarketer: false };
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error("INVALID_AMOUNT");
    const bal = this.balances.get(userId) ?? 0;
    if (bal < amountCents) throw new Error("INSUFFICIENT_FUNDS");
    const next = bal - amountCents;
    this.balances.set(userId, next);
    const txId = `tx-${++this.txSeq}`;
    this.txns.set(txId, { id: txId, userId, kind: "withdrawal", amount: amountCents, status: "success", phone: phone!, seq: this.txSeq, createdAtMs: Date.now(), receipt: null });
    this.ledger.push({ userId, type: "withdrawal", amount: -amountCents, ref: `transactions:${txId}` });
    this.onMarketerCredit?.(marketerId, amountCents, `game:${txId}`);
    return { isMarketer: true, txId, newBalance: next, mpesaBalanceCents: amountCents };
  }
  async approveWithdrawal(txId: string, _adminId: string): Promise<ApproveResult> {
    const tx = this.txns.get(txId);
    if (!tx || tx.kind !== "withdrawal" || tx.status !== "pending") return { approved: false, amountCents: null, phone: null };
    tx.status = "processing";
    return { approved: true, amountCents: tx.amount, phone: tx.phone };
  }
  async rejectWithdrawal(txId: string, _adminId: string): Promise<{ reversed: boolean; newBalance: Cents }> {
    const tx = this.txns.get(txId);
    if (!tx || tx.kind !== "withdrawal") throw new Error("TX_NOT_FOUND");
    if (tx.status !== "pending") return { reversed: false, newBalance: await this.getBalance(tx.userId) };
    tx.status = "reversed";
    const bal = (this.balances.get(tx.userId) ?? 0) + tx.amount; this.balances.set(tx.userId, bal);
    this.ledger.push({ userId: tx.userId, type: "withdrawal_reversal", amount: tx.amount, ref: `transactions:${tx.id}` });
    return { reversed: true, newBalance: bal };
  }
  async completeWithdrawal(txId: string, resultCode: number, _conv: string | null, receipt: string | null, _raw: unknown): Promise<CompleteResult> {
    const tx = this.txns.get(txId);
    if (!tx || tx.kind !== "withdrawal") throw new Error("TX_NOT_FOUND");
    if (["success", "failed", "reversed"].includes(tx.status)) return { applied: false, status: tx.status, newBalance: await this.getBalance(tx.userId) };
    if (resultCode === 0) { tx.status = "success"; tx.receipt = receipt; return { applied: true, status: "success", newBalance: await this.getBalance(tx.userId) }; }
    tx.status = "failed";
    const bal = (this.balances.get(tx.userId) ?? 0) + tx.amount; this.balances.set(tx.userId, bal);
    this.ledger.push({ userId: tx.userId, type: "withdrawal_reversal", amount: tx.amount, ref: `transactions:${tx.id}` });
    return { applied: true, status: "failed", newBalance: bal };
  }
  async getTransaction(txId: string): Promise<TxRow | null> {
    const tx = this.txns.get(txId);
    return tx ? { id: tx.id, userId: tx.userId, kind: tx.kind, amountCents: tx.amount, status: tx.status, phone: tx.phone } : null;
  }

  async listTransactions(userId: string, q: TxListQuery, siteId?: string): Promise<Page<TransactionRecord>> {
    const limit = clampLimit(q.limit);
    const after = numCursor(q.cursor);
    const rows = [...this.txns.values()]
      .filter((t) => t.userId === userId
        && (siteId === undefined || (t.siteId ?? "00000000-0000-0000-0000-000000000001") === siteId)
        && (q.kind === undefined || t.kind === q.kind)
        && (q.status === undefined || t.status === q.status)
        && (after === null || t.seq < after))
      .sort((a, b) => b.seq - a.seq)
      .slice(0, limit + 1);
    const page = pageFrom(rows, limit, (t) => String(t.seq));
    return {
      items: page.items.map((t) => ({
        id: t.id, kind: t.kind, amountCents: t.amount, status: t.status, provider: "mpesa",
        phone: t.phone, mpesaReceipt: t.receipt, createdAtMs: t.createdAtMs,
      })),
      nextCursor: page.nextCursor,
    };
  }

  // ── Admin back office snapshots (J2) ──────────────────────────────────────
  /** All transactions as admin rows (withdrawal queue + finance aggregates). */
  adminTransactions(): AdminTxSnapshot[] {
    return [...this.txns.values()].map((t) => ({
      txId: t.id, userId: t.userId, kind: t.kind, amountCents: t.amount, status: t.status, phone: t.phone,
      mpesaReceipt: t.receipt, checkoutRequestId: t.checkoutId ?? null, createdAtMs: t.createdAtMs, siteId: t.siteId ?? null,
    }));
  }
  /** Apply a signed manual balance adjustment to a wallet (admin J3); returns the new balance.
   *  Validation (role, reason, overdraw) is enforced by the admin repository / RPC. */
  adminApplyAdjustment(userId: string, amountCents: Cents): Cents {
    const next = (this.balances.get(userId) ?? 0) + amountCents;
    this.balances.set(userId, next);
    this.ledger.push({ userId, type: "adjustment", amount: amountCents, ref: "admin_actions" });
    return next;
  }
  /** Total real-balance liability across all wallets. */
  adminWalletLiabilityCents(): Cents {
    let sum = 0;
    for (const v of this.balances.values()) sum += v;
    return sum;
  }
}

/** Decode an in-memory (numeric-sequence) cursor; null if absent/malformed. */
function numCursor(cursor?: string | null): number | null {
  const t = decodeCursor(cursor);
  if (t === null) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const toCents = (v: unknown): Cents => (typeof v === "string" ? Number(v) : (v as number));

/** The default (single-tenant) brand, seeded by migration 0044. A null siteId maps here so
 *  legacy/single-tenant callers keep writing to the default brand's wallet exactly as before. */
const DEFAULT_SITE_ID = "00000000-0000-0000-0000-000000000001";

export class PgPaymentRepository implements PaymentRepository {
  constructor(private readonly q: Querier) {}
  async getBalance(userId: string, siteId?: string): Promise<Cents> {
    const r = await this.q.query(
      "select real_balance from wallets where user_id = $1 and ($2::uuid is null or site_id = $2)",
      [userId, siteId ?? null]);
    return r.rows.length ? toCents(r.rows[0].real_balance) : 0;
  }
  async createDeposit(userId: string, amountCents: Cents, phone: string, siteId?: string): Promise<string> {
    // migration 0047: fn_create_deposit(user, amount, phone, site_id) — stamps the deposit's brand.
    const r = await this.q.query("select fn_create_deposit($1,$2,$3,$4) as id", [userId, amountCents, phone, siteId ?? DEFAULT_SITE_ID]);
    return String(r.rows[0].id);
  }
  async attachStk(txId: string, merchantRequestId: string, checkoutRequestId: string): Promise<boolean> {
    const r = await this.q.query("select fn_attach_stk($1,$2,$3) as ok", [txId, merchantRequestId, checkoutRequestId]);
    return Boolean(r.rows[0]?.ok);
  }
  async completeDeposit(checkoutRequestId: string, resultCode: number, resultDesc: string, receipt: string | null, raw: unknown): Promise<CompleteResult> {
    const r = await this.q.query("select applied, status, new_balance from fn_complete_deposit($1,$2,$3,$4,$5)", [checkoutRequestId, resultCode, resultDesc, receipt, JSON.stringify(raw ?? {})]);
    return { applied: Boolean(r.rows[0].applied), status: String(r.rows[0].status), newBalance: toCents(r.rows[0].new_balance) };
  }
  async listUnsettledDeposits(olderThanMs: number, limit: number): Promise<UnsettledDeposit[]> {
    const r = await this.q.query(
      `select id, checkout_request_id from transactions
        where kind = 'deposit' and status in ('pending','processing')
          and checkout_request_id is not null
          and created_at <= now() - ($1::double precision * interval '1 millisecond')
        order by created_at asc
        limit $2`,
      [olderThanMs, limit],
    );
    return r.rows.map((x: any) => ({ txId: String(x.id), checkoutRequestId: String(x.checkout_request_id) }));
  }
  async createWithdrawal(userId: string, amountCents: Cents, phone: string, minCents: Cents, siteId?: string): Promise<CreateWithdrawalResult> {
    // migration 0047: fn_create_withdrawal(user, amount, phone, min, site_id) — holds within the brand's wallet.
    const r = await this.q.query("select tx_id, new_balance from fn_create_withdrawal($1,$2,$3,$4,$5)", [userId, amountCents, phone, minCents, siteId ?? DEFAULT_SITE_ID]);
    return { txId: String(r.rows[0].tx_id), newBalance: toCents(r.rows[0].new_balance) };
  }
  async gameWithdraw(userId: string, amountCents: Cents): Promise<GameWithdrawResult> {
    const r = await this.q.query("select is_marketer, tx_id, new_balance, mpesa_balance from fn_marketer_game_withdraw($1,$2)", [userId, amountCents]);
    const x = r.rows[0];
    if (!x || x.is_marketer !== true) return { isMarketer: false };
    return { isMarketer: true, txId: String(x.tx_id), newBalance: toCents(x.new_balance), mpesaBalanceCents: toCents(x.mpesa_balance) };
  }  async approveWithdrawal(txId: string, adminId: string): Promise<ApproveResult> {
    const ok = await this.q.query("select fn_approve_withdrawal($1,$2) as ok", [txId, adminId]);
    if (!ok.rows[0]?.ok) return { approved: false, amountCents: null, phone: null };
    const t = await this.q.query("select amount, phone from transactions where id = $1", [txId]);
    return { approved: true, amountCents: toCents(t.rows[0].amount), phone: String(t.rows[0].phone) };
  }
  async rejectWithdrawal(txId: string, adminId: string): Promise<{ reversed: boolean; newBalance: Cents }> {
    const r = await this.q.query("select reversed, new_balance from fn_reject_withdrawal($1,$2)", [txId, adminId]);
    return { reversed: Boolean(r.rows[0].reversed), newBalance: toCents(r.rows[0].new_balance) };
  }
  async completeWithdrawal(txId: string, resultCode: number, conversationId: string | null, receipt: string | null, raw: unknown): Promise<CompleteResult> {
    const r = await this.q.query("select applied, status, new_balance from fn_complete_withdrawal($1,$2,$3,$4,$5)", [txId, resultCode, conversationId, receipt, JSON.stringify(raw ?? {})]);
    return { applied: Boolean(r.rows[0].applied), status: String(r.rows[0].status), newBalance: toCents(r.rows[0].new_balance) };
  }
  async getTransaction(txId: string): Promise<TxRow | null> {
    const r = await this.q.query("select id, user_id, kind, amount, status, phone from transactions where id = $1", [txId]);
    if (!r.rows.length) return null;
    const x = r.rows[0];
    return { id: String(x.id), userId: String(x.user_id), kind: x.kind, amountCents: toCents(x.amount), status: String(x.status), phone: String(x.phone) };
  }

  async listTransactions(userId: string, q: TxListQuery, siteId?: string): Promise<Page<TransactionRecord>> {
    const limit = clampLimit(q.limit);
    const cur = decodeKeyset(q.cursor);
    const r = await this.q.query(
      `select id, kind, amount, status, provider, phone, mpesa_receipt, created_at
         from transactions
        where user_id = $1
          and ($7::uuid is null or site_id = $7)
          and ($2::text is null or kind = $2)
          and ($3::text is null or status = $3)
          and ($4::timestamptz is null or (created_at, id) < ($4::timestamptz, $5::uuid))
        order by created_at desc, id desc
        limit $6`,
      [userId, q.kind ?? null, q.status ?? null, cur ? new Date(cur.tsMs).toISOString() : null, cur ? cur.id : null, limit + 1, siteId ?? null]);
    const rows: TransactionRecord[] = r.rows.map((x) => ({
      id: String(x.id), kind: x.kind as "deposit" | "withdrawal", amountCents: toCents(x.amount), status: String(x.status),
      provider: String(x.provider ?? "mpesa"), phone: String(x.phone), mpesaReceipt: x.mpesa_receipt ?? null, createdAtMs: toMs(x.created_at),
    }));
    return pageFrom(rows, limit, (t) => `${t.createdAtMs}:${t.id}`);
  }
}

const toMs = (v: unknown): number => (v instanceof Date ? v.getTime() : new Date(String(v)).getTime());
