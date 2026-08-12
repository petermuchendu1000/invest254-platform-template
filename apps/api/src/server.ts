import {
  PgGameRepository, PgEngagementRepository, PgPaymentRepository, PgIdentityRepository,
  PaymentService, AuthService, AffiliateService, AdminService, PgAdminRepository, makeDarajaClientFromConfig, loadDarajaConfigFromDb, makeVerifier,
  NotificationService, PgNotificationRepository,
  GameConfigStore,
  type GameRepository, type EngagementRepository, type PaymentRepository,
  type Querier, type FairnessRecord, type ListenClient,
} from "@invest254/engine";
import { createApp, type ApiDeps, type WalletBalance, type BonusStatus, type Brand } from "./app.js";
import { makePgMarketerRepo } from "./marketers.pg.js";

/**
 * Production bootstrap for the HTTP API. Wires the Postgres-backed repositories, the
 * PaymentService (atomic 0014 RPCs + Daraja provider) and the Supabase JWT
 * verifier from the environment, then listens.
 *
 * `fairnessById`/`walletBalance` read leak-safe views/columns directly (single indexed
 * lookups) rather than widening the engine repository contract for two read paths.
 */
const PORT = Number(process.env.PORT ?? 8081);

async function buildDeps(): Promise<ApiDeps> {
  const verifier = makeVerifier();
  const usingDb = Boolean(process.env.DATABASE_URL);
  if (usingDb && !verifier) {
    throw new Error("AUTH: a JWT verifier is required when DATABASE_URL is set (set SUPABASE_JWT_SECRET or SUPABASE_JWKS_URL)");
  }
  if (!usingDb) throw new Error("DATABASE_URL is required to run the API server");

  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = pool as unknown as Querier;

  // Live game configuration for the public GET /game/config. Same store the WS engine uses,
  // so the limits the browser validates against are the limits the engine enforces.
  const gameConfig = new GameConfigStore(q, {
    pollMs: Number(process.env.CONFIG_POLL_MS ?? 15_000),
    connect: async () => (await pool.connect()) as unknown as ListenClient,
    onError: (err: Error, ctx: string) => console.error(`[api] config ${ctx}:`, err.message),
  });
  await gameConfig.init();
  console.log(`[api] game_config v${gameConfig.active().version} loaded from database`);

  const repo: GameRepository = new PgGameRepository(q);
  const engage: EngagementRepository = new PgEngagementRepository(q);
  const payRepo: PaymentRepository = new PgPaymentRepository(q);

  const resolveHandle = async (userId: string): Promise<string> =>
    (await engage.getUsername(userId)) ?? `guest_${userId.slice(0, 6)}`;

  // M-Pesa config is admin-managed in the DB (table 0024); fall back to env per field.
  const daraja = makeDarajaClientFromConfig(await loadDarajaConfigFromDb(q));
  const payments = new PaymentService(payRepo, daraja, {
    // Verify STK callbacks against Safaricom (STKPushQuery) before crediting — defeats forged
    // callbacks. Set MPESA_VERIFY_CALLBACKS=false only if the callback source is otherwise trusted.
    verifyStkCallbacks: process.env.MPESA_VERIFY_CALLBACKS !== "false",
    // Live minimum withdrawal: read straight from the same game_config store the engine uses,
    // so an admin's edit in the panel gates the very next withdrawal with no redeploy.
    minWithdrawalProvider: () => gameConfig.active().minWithdrawalCents,
    events: {
      onWithdrawalSuccess: ({ userId, amountCents }) => {
        void resolveHandle(userId)
      },
    },
  });


  // Self-managed auth issues HS256 tokens signed with SUPABASE_JWT_SECRET — the same secret
  // makeVerifier checks. Asymmetric (JWKS) verification can't verify our self-issued tokens.
  const jwtSecret = process.env.SUPABASE_JWT_SECRET;
  if (!jwtSecret) {
    throw new Error("AUTH: SUPABASE_JWT_SECRET is required for self-managed register/login (HS256 issuance)");
  }
  const identity = new PgIdentityRepository(q);
  const auth = new AuthService(identity, {
    jwtSecret,
    // No-OTP password reset is account takeover unless verified — opt in deliberately.
    allowUnverifiedPasswordReset: process.env.ALLOW_UNVERIFIED_PASSWORD_RESET === "true",
    ...(process.env.SUPABASE_JWT_ISSUER ? { issuer: process.env.SUPABASE_JWT_ISSUER } : {}),
    ...(process.env.SUPABASE_JWT_AUD ? { audience: process.env.SUPABASE_JWT_AUD } : {}),
  });
  const affiliate = new AffiliateService(identity, daraja);
  const admin = new AdminService(new PgAdminRepository(q));
  const notifications = new NotificationService(new PgNotificationRepository(q));

  return {
    verifier,
    auth,
    affiliate,
    admin,
    notifications,
    marketers: makePgMarketerRepo((sql, params) => q.query(sql, params ?? [])),
    config: () => gameConfig.active(),
    fairnessById: async (gameDayId: number): Promise<FairnessRecord | null> => {
      const r = await q.query(
        "select id, trade_date, server_seed_hash, server_seed, revealed_at from v_fairness where id = $1",
        [gameDayId],
      );
      if (!r.rows.length) return null;
      const x = r.rows[0];
      return {
        gameDayId: x.id === null || x.id === undefined ? null : Number(x.id),
        tradeDate: x.trade_date instanceof Date ? x.trade_date.toISOString().slice(0, 10) : String(x.trade_date),
        serverSeedHash: String(x.server_seed_hash),
        serverSeed: x.server_seed ?? null,
        revealedAt: x.revealed_at ? (x.revealed_at instanceof Date ? x.revealed_at.toISOString() : String(x.revealed_at)) : null,
      };
    },
    brandByHost: async (host: string): Promise<Brand | null> => {
      const h = host.trim().toLowerCase();
      const r = await q.query(
        `select id, slug, name, wordmark_text, logo_url, favicon_url, color_primary, color_bg,
                color_accent, theme, currency, locale, licence_line, support_email
           from sites
          where status = 'active' and (lower(primary_domain) = $1 or lower(slug) = $1)
          limit 1`,
        [h],
      );
      if (!r.rows.length) return null;
      const x = r.rows[0] as Record<string, unknown>;
      return {
        siteId: String(x.id), slug: String(x.slug), name: String(x.name),
        wordmarkText: (x.wordmark_text as string | null) ?? null,
        logoUrl: (x.logo_url as string | null) ?? null,
        faviconUrl: (x.favicon_url as string | null) ?? null,
        colorPrimary: String(x.color_primary), colorBg: String(x.color_bg), colorAccent: String(x.color_accent),
        theme: String(x.theme) as "dark" | "light" | "auto",
        currency: String(x.currency), locale: String(x.locale),
        licenceLine: (x.licence_line as string | null) ?? null,
        supportEmail: (x.support_email as string | null) ?? null,
      };
    },
    payments,
    resolveHandle,
    walletBalance: async (userId: string): Promise<WalletBalance> => {
      const r = await q.query("select real_balance, bonus_balance, currency from wallets where user_id = $1", [userId]);
      const toCents = (v: unknown): number => (typeof v === "string" ? Number(v) : (v as number)) || 0;
      const base = !r.rows.length
        ? { real: 0, bonus: 0, currency: "KES" }
        : { real: toCents(r.rows[0].real_balance), bonus: toCents(r.rows[0].bonus_balance), currency: String(r.rows[0].currency ?? "KES") };
      // Active deposit bonuses with wagering progress (migration 0037). Fail-open: if the
      // RPC is not yet deployed the wallet still returns balances without bonus detail.
      try {
        const b = await q.query(
          "select bonus_id, amount, wagering_x, wagered, required, remaining, status, created_at from fn_wallet_bonus_status($1)",
          [userId]);
        const bonuses: BonusStatus[] = b.rows.map((x: Record<string, unknown>) => ({
          bonusId: String(x.bonus_id), amount: toCents(x.amount), wageringX: Number(x.wagering_x),
          wagered: toCents(x.wagered), required: toCents(x.required), remaining: toCents(x.remaining),
          status: String(x.status),
          createdAt: x.created_at instanceof Date ? x.created_at.toISOString() : String(x.created_at),
        }));
        return { ...base, bonuses };
      } catch {
        return base;
      }
    },
    ledger: (userId, qy) => repo.listLedger(userId, qy),
    positions: (userId, qy) => repo.listPositions(userId, qy),
    positionDetail: (userId, id) => repo.getPositionDetail(userId, id),
    transactions: (userId, qy) => payRepo.listTransactions(userId, qy),
  };
}

const deps = await buildDeps();
const server = createApp(deps);
server.listen(PORT, () => {
  console.log(`[api] listening on http://localhost:${PORT}  auth=${deps.verifier ? "jwt" : "dev"}`);
});

// Deposit reconciliation sweep: settles deposits whose STK callback never arrived (or whose
// verification was inconclusive) using Safaricom's authoritative STKPushQuery status, so no paid
// deposit is left stranded and no unpaid one is credited. Set to 0 to disable.
const RECONCILE_MS = Number(process.env.DEPOSIT_RECONCILE_INTERVAL_MS ?? 300_000);
if (Number.isFinite(RECONCILE_MS) && RECONCILE_MS > 0) {
  const timer = setInterval(() => {
    void deps.payments
      .reconcileDeposits()
      .then((r) => { if (r.settled || r.errors) console.log("[payments] reconcile", r); })
      .catch((err: unknown) => console.error("[payments] reconcile sweep failed:", (err as Error).message));
  }, RECONCILE_MS);
  timer.unref();
  console.log(`[api] deposit reconciliation every ${Math.round(RECONCILE_MS / 1000)}s`);
}
