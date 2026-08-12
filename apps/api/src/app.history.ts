import type { LedgerEntry, PositionRecord, PositionDetail, TransactionRecord, FairnessRecord } from "@invest254/engine";
import { Router, ApiError, requireAuth, requireSite, type Ctx } from "./http.js";
import type { ApiDeps } from "./app.js";

/**
 * Player history reads (Issue F2): wallet ledger, position history + single position
 * (with provable-fairness data), and transaction history. All are authenticated,
 * scoped to the caller's own `userId` (no cross-user access), newest-first, and
 * cursor-paginated via the repository `Page<T>` contract. This module owns only
 * transport concerns: auth, query parsing/validation, and serialization.
 */

const BASE = "/api/v1";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse an optional `?limit=`; undefined when absent (repo applies its default/cap). */
function parseLimit(ctx: Ctx): number | undefined {
  const raw = ctx.query.get("limit");
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new ApiError("INVALID_LIMIT", "limit must be a positive integer", 400);
  return Math.floor(n);
}

const cursorOf = (ctx: Ctx): string | null => ctx.query.get("cursor");

// ─────────────────────────── DTOs (caller owns the rows; userId omitted) ───────────────────────────

const ledgerDto = (e: LedgerEntry) => ({
  id: e.id, type: e.type, amountCents: e.amountCents, balanceKind: e.balanceKind,
  refTable: e.refTable, refId: e.refId, meta: e.meta, ts: e.createdAtMs,
});

const positionDto = (p: PositionRecord) => ({
  id: p.id, gameDayId: p.gameDayId, direction: p.direction, stakeCents: p.stakeCents,
  entryRate: p.entryRate, exitRate: p.exitRate, multiplier: p.multiplier,
  payoutCents: p.payoutCents, pnlCents: p.pnlCents, result: p.result,
  durationS: p.durationS, status: p.status, openedAt: p.openedAtMs, settledAt: p.settledAtMs,
});

const fairnessDto = (f: FairnessRecord) => ({
  gameDayId: f.gameDayId, tradeDate: f.tradeDate, serverSeedHash: f.serverSeedHash,
  serverSeed: f.serverSeed, revealedAt: f.revealedAt,
});

const positionDetailDto = (d: PositionDetail) => ({ ...positionDto(d), fairness: d.fairness ? fairnessDto(d.fairness) : null });

const transactionDto = (t: TransactionRecord) => ({
  id: t.id, kind: t.kind, amountCents: t.amountCents, status: t.status,
  provider: t.provider, phone: t.phone, mpesaReceipt: t.mpesaReceipt, ts: t.createdAtMs,
});

// ─────────────────────────── routes ───────────────────────────

export function registerHistoryRoutes(router: Router, deps: ApiDeps): void {
  const auth = requireAuth(deps.verifier);
  const site = requireSite();

  router.get(`${BASE}/wallet/ledger`, auth, site, async (ctx: Ctx) => {
    const page = await deps.ledger(ctx.claims!.userId, { limit: parseLimit(ctx), cursor: cursorOf(ctx) }, ctx.siteId);
    return { items: page.items.map(ledgerDto), nextCursor: page.nextCursor };
  });

  router.get(`${BASE}/positions`, auth, site, async (ctx: Ctx) => {
    const status = ctx.query.get("status") ?? undefined;
    const page = await deps.positions(ctx.claims!.userId, { limit: parseLimit(ctx), cursor: cursorOf(ctx), status }, ctx.siteId);
    return { items: page.items.map(positionDto), nextCursor: page.nextCursor };
  });

  router.get(`${BASE}/positions/:id`, auth, site, async (ctx: Ctx) => {
    const id = ctx.params.id!;
    if (!UUID_RE.test(id)) throw new ApiError("INVALID_ID", "position id must be a UUID", 400);
    const detail = await deps.positionDetail(ctx.claims!.userId, id, ctx.siteId);
    if (!detail) throw new ApiError("NOT_FOUND", `position ${id} not found`, 404);
    return positionDetailDto(detail);
  });

  router.get(`${BASE}/transactions`, auth, site, async (ctx: Ctx) => {
    const kindRaw = ctx.query.get("kind");
    if (kindRaw !== null && kindRaw !== "deposit" && kindRaw !== "withdrawal") {
      throw new ApiError("INVALID_KIND", "kind must be 'deposit' or 'withdrawal'", 400);
    }
    const status = ctx.query.get("status") ?? undefined;
    const page = await deps.transactions(ctx.claims!.userId, {
      limit: parseLimit(ctx), cursor: cursorOf(ctx), kind: kindRaw ?? undefined, status,
    }, ctx.siteId);
    return { items: page.items.map(transactionDto), nextCursor: page.nextCursor };
  });
}
