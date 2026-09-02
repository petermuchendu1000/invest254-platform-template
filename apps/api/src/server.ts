import {
  PgGameRepository, PgEngagementRepository, PgPaymentRepository, PgIdentityRepository,
  PaymentService, AuthService, AffiliateService, AdminService, PgAdminRepository, PlatformService, PgPlatformRepository, makeDarajaClientFromConfig, loadDarajaConfigFromDb, makeVerifier,
  NotificationService, PgNotificationRepository,
  PushService, PgPushSubscriptionRepository,
  GameConfigStore, mapConfigRow, makePgPools,
  type GameRepository, type EngagementRepository, type PaymentRepository,
  type Querier, type FairnessRecord, type ListenClient,
} from "@invest254/engine";
import { createApp, type ApiDeps, type WalletBalance, type BonusStatus, type Brand } from "./app.js";
import { normalizeHost, PlatformGate, enforcedValue, type VersionedGameConfig, type Cents } from "@invest254/shared";
import { BrandOriginAllowlist } from "./cors.js";
import { makePgMarketerRepo } from "./marketers.pg.js";
import { makePgReferralRepo } from "./referral.pg.js";
import { makePgSupportDeps } from "./support.pg.js";
import { makeDomainProvisioner } from "./domains.js";
import { makeWebPushTransport } from "./webpush.js";
import { makeResendSender, buildWithdrawalEmail } from "./email.js";
import { makeTelegramClient } from "./telegram.js";
import { signWithdrawalAction } from "./withdrawalactionlink.js";
import type { PlatformOnboardDeps, OnboardInput, OnboardResult } from "./app.platform.js";

/**
 * Production bootstrap for the HTTP API. Wires the Postgres-backed repositories, the
 * PaymentService (atomic 0014 RPCs + Daraja provider) and the Supabase JWT
 * verifier from the environment, then listens.
 *
 * `fairnessById`/`walletBalance` read leak-safe views/columns directly (single indexed
 * lookups) rather than widening the engine repository contract for two read paths.
 */
const PORT = Number(process.env.PORT ?? 8081);

/** Map a marketer_expenses row (from the 0068 RPCs) to the MarketerExpenseRow DTO. */
function mapExpenseRow(x: Record<string, unknown>) {
  const created = x.created_at;
  return {
    id: String(x.id),
    category: String(x.category),
    amountCents: Number(x.amount_cents) || 0,
    note: x.note == null ? null : String(x.note),
    createdAtMs: created instanceof Date ? created.getTime() : new Date(String(created)).getTime(),
    createdBy: x.created_by == null ? null : String(x.created_by),
  };
}

async function buildDeps(): Promise<ApiDeps> {
  const baseVerifier = makeVerifier();
  const usingDb = Boolean(process.env.DATABASE_URL);
  if (usingDb && !baseVerifier) {
    throw new Error("AUTH: a JWT verifier is required when DATABASE_URL is set (set SUPABASE_JWT_SECRET or SUPABASE_JWKS_URL)");
  }
  if (!usingDb) throw new Error("DATABASE_URL is required to run the API server");

  const { Pool } = await import("pg");
  // Split pools (docs/25 Phase 5): queries via the TRANSACTION pooler (:6543); the single
  // game_config LISTEN connection via the SESSION pooler (:5432). See makePgPools.
  const { queryPool, listenPool } = makePgPools(Pool, (m) => console.log(`[api] ${m}`));
  const pool = queryPool;
  const q = pool as unknown as Querier;

  // Live game configuration for the public GET /game/config. Same store the WS engine uses,
  // so the limits the browser validates against are the limits the engine enforces.
  const gameConfig = new GameConfigStore(q, {
    pollMs: Number(process.env.CONFIG_POLL_MS ?? 15_000),
    connect: async () => (await listenPool.connect()) as unknown as ListenClient,
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

  // Site-aware minimum withdrawal (multi-tenant). GET /game/config serves each brand its own
  // `site_game_config.min_withdrawal` (via gameConfigForSite below), so the browser validates
  // against the brand's floor. This resolver reads that SAME per-brand row — keyed by the
  // withdrawing request's `siteId` — so the server enforces the identical floor and never rejects
  // a client-valid amount as BELOW_MIN. Falls back to the platform-default `game_config` (exactly
  // GET /game/config's own fallback) when the site has no row or the value is unusable, so a
  // missing/bad per-brand value can never open the floor below the safe default.
  const siteMinWithdrawalCents = async (siteId: string | undefined): Promise<Cents> => {
    const fallback = gameConfig.active().minWithdrawalCents;
    if (!siteId) return fallback;
    try {
      const r = await q.query(
        "select min_withdrawal from site_game_config where site_id = $1::uuid limit 1",
        [siteId],
      );
      if (r.rows.length) {
        const v = Math.round(Number((r.rows[0] as Record<string, unknown>).min_withdrawal));
        if (Number.isInteger(v) && v > 0) return v as Cents;
      }
    } catch (err) {
      console.error(`[api] site min_withdrawal lookup failed for ${siteId}:`, (err as Error).message);
    }
    return fallback;
  };

  // Per-brand withdrawal kill switch (0067). Read live from `sites.withdrawals_enabled` so an
  // owner/admin toggle in the panel halts payouts on the very next request with no redeploy.
  // Fail-open (enabled) on a missing row or a transient error, so a glitch never blocks payouts.
  const siteWithdrawalsEnabled = async (siteId: string | undefined): Promise<boolean> => {
    if (!siteId) return true;
    try {
      const r = await q.query("select withdrawals_enabled from sites where id = $1::uuid", [siteId]);
      if (r.rows.length) return (r.rows[0] as Record<string, unknown>).withdrawals_enabled !== false;
    } catch (err) {
      console.error(`[api] withdrawals_enabled lookup failed for ${siteId}:`, (err as Error).message);
    }
    return true;
  };

  // Per-brand STK AccountReference: the prompt shows the DEPOSITING brand's account (its name),
  // not a hardcoded "Invest254". Cached per site (brand names are effectively static at runtime).
  const brandRefCache = new Map<string, string>();
  const siteAccountRef = async (siteId?: string): Promise<string> => {
    const id = siteId ?? "00000000-0000-0000-0000-000000000001";
    const cached = brandRefCache.get(id);
    if (cached) return cached;
    try {
      const r = await q.query("select name, slug from sites where id = $1", [id]);
      const row = r.rows[0] as { name?: string; slug?: string } | undefined;
      const ref = (row?.name || row?.slug || "Invest254");
      brandRefCache.set(id, ref);
      return ref;
    } catch { return "Invest254"; }
  };

  // Platform-wide master switches + GLOBAL economy overrides (migrations 0092/0099). 5s cache; fails
  // open on read error. Constructed here (before PaymentService) so the global min/max-deposit and
  // min-withdrawal enforcement can read platformGate.economy(). Reused as the app dep below.
  const platformGate = new PlatformGate((sql: string, p?: unknown[]) => q.query(sql, p ?? []));

  // Real-time admin withdrawal alerts (Issue 1). Constructed before PaymentService so the
  // onWithdrawalRequested hook can fan a pending request out to every opted-in admin device as a
  // Web Push with Approve/Reject actions. Absent (null) when VAPID keys aren't configured — the
  // /admin/push/* routes and the fan-out then stay dormant, so push is purely additive.
  const pushTransport = makeWebPushTransport();
  const pushService = pushTransport
    ? new PushService(new PgPushSubscriptionRepository(q), pushTransport, {
        resolveHandle: (userId) => resolveHandle(userId),
        appBaseUrl: process.env.PUBLIC_WEB_URL || process.env.APP_BASE_URL || "",
      })
    : undefined;
  if (pushService) console.log("[api] admin web-push enabled (withdrawal alerts with Approve/Reject actions)");

  // Email alerts (Issue 1): the reliable, login-free channel — a withdrawal request emails the
  // admin(s) with one-tap Approve/Reject magic links. Dormant unless RESEND_API_KEY + EMAIL_FROM +
  // ADMIN_ALERT_EMAILS are set. Signed with SUPABASE_JWT_SECRET (no new secret needed).
  const emailSender = makeResendSender();
  const actionSecret = process.env.SUPABASE_JWT_SECRET;
  const apiPublicUrl = (process.env.API_PUBLIC_URL || "https://invest254-api.fly.dev").replace(/\/+$/, "");
  const alertEmails = (process.env.ADMIN_ALERT_EMAILS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (emailSender && alertEmails.length > 0) console.log(`[api] admin withdrawal EMAIL alerts enabled -> ${alertEmails.length} recipient(s)`);

  // Records who approved/rejected a withdrawal actioned from an email link (approved_by FK -> profiles).
  const resolveActionActor = async (): Promise<string | null> => {
    const override = process.env.WITHDRAWAL_ACTION_ADMIN_ID?.trim();
    if (override) return override;
    try {
      const r = await q.query("select id from profiles where role in ('admin','superadmin') and status = 'active' order by (role = 'superadmin') desc, created_at asc limit 1", []);
      return r.rows[0] ? String(r.rows[0].id) : null;
    } catch { return null; }
  };

  async function emailWithdrawalAlert(e: { txId: string; userId: string; amountCents: number; phone: string }): Promise<void> {
    if (!emailSender || !actionSecret || alertEmails.length === 0) return;
    try {
      const who = await resolveHandle(e.userId);
      const approveUrl = `${apiPublicUrl}/api/v1/w/act?token=${signWithdrawalAction(e.txId, "approve", actionSecret)}`;
      const rejectUrl = `${apiPublicUrl}/api/v1/w/act?token=${signWithdrawalAction(e.txId, "reject", actionSecret)}`;
      const mail = buildWithdrawalEmail({ who, amountCents: e.amountCents, phone: e.phone, txId: e.txId, approveUrl, rejectUrl });
      const r = await emailSender.send({ to: alertEmails, ...mail });
      if (!r.ok) console.warn("[api] withdrawal alert email failed:", r.error);
    } catch (err) { console.warn("[api] withdrawal alert email error:", (err as Error).message); }
  }

  // Telegram channel (Issue 1): instant push with inline Approve/Reject. The callback is handled by
  // /api/v1/telegram/webhook. Dormant unless TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_IDS are set.
  const telegram = makeTelegramClient();
  const telegramChatIds = (process.env.TELEGRAM_CHAT_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const telegramWebhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (telegram && telegramChatIds.length > 0) console.log(`[api] admin TELEGRAM alerts enabled -> ${telegramChatIds.length} chat(s)`);
  async function telegramWithdrawalAlert(e: { txId: string; userId: string; amountCents: number; phone: string }): Promise<void> {
    if (!telegram || telegramChatIds.length === 0) return;
    try {
      const who = await resolveHandle(e.userId);
      await Promise.all(telegramChatIds.map((chatId) =>
        telegram.sendWithdrawalAlert(chatId, { who, amountCents: e.amountCents, phone: e.phone, txId: e.txId })
          .then((r) => { if (!r.ok) console.warn("[api] telegram alert failed:", r.error); })));
    } catch (err) { console.warn("[api] telegram alert error:", (err as Error).message); }
  }

  const payments = new PaymentService(payRepo, daraja, {
    // Verify STK callbacks against Safaricom (STKPushQuery) before crediting — defeats forged
    // callbacks. Set MPESA_VERIFY_CALLBACKS=false only if the callback source is otherwise trusted.
    verifyStkCallbacks: process.env.MPESA_VERIFY_CALLBACKS !== "false",
    // Site-aware STK AccountReference (multi-tenant): "Account no. <Brand>" per depositing brand.
    accountRefForSite: (siteId) => siteAccountRef(siteId),
    // Per-brand withdrawal floor: enforce the withdrawing site's own min so client and server agree.
    minWithdrawalForSite: (siteId) => siteMinWithdrawalCents(siteId),
    // Per-brand withdrawal kill switch: refuse ALL withdrawal initiations for a site when disabled.
    withdrawalsEnabledForSite: (siteId) => siteWithdrawalsEnabled(siteId),
    // Process-wide fallback (single-tenant / default brand, and if the per-site lookup yields nothing):
    // the platform-default game_config, read live so an admin edit gates the next withdrawal with no redeploy.
    minWithdrawalProvider: () => gameConfig.active().minWithdrawalCents,
    // Platform GLOBAL economy (0099) — enforced values win over all per-site/provider values. Return a
    // non-positive sentinel (0) / null when a field isn't enforced so PaymentService defers to the chain.
    minDepositForGlobal: async () => enforcedValue((await platformGate.economy()).payments, "minDepositCents") ?? 0,
    maxDepositForGlobal: async () => enforcedValue((await platformGate.economy()).payments, "maxDepositCents"),
    minWithdrawalForGlobal: async () => enforcedValue((await platformGate.economy()).payments, "minWithdrawalCents") ?? 0,
    events: {
      onWithdrawalSuccess: ({ userId, amountCents }) => {
        void resolveHandle(userId)
      },
      // Fire-and-forget: push a real-time Approve/Reject alert to admins. Never awaited and fully
      // isolated so a push outage can't slow down or fail the player's withdrawal request.
      onWithdrawalRequested: (e) => {
        // Fire all channels, fire-and-forget: email + Telegram (login-free) + web push (if enabled).
        void emailWithdrawalAlert(e);
        void telegramWithdrawalAlert(e);
        if (pushService) void pushService.notifyWithdrawalRequested(e).catch((err) => {
          console.warn("[api] admin withdrawal push failed:", (err as Error).message);
        });
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
  // Force-logout enforcement (0097): wrap the JWT verifier so a PRIVILEGED token issued before the
  // account's sessions_valid_after epoch is rejected (→ 401 in requireAuth → re-login). This gives
  // every authenticated route the force-logout for free with no call-site changes. Non-privileged
  // (player) tokens skip the DB read entirely, so high-volume traffic is unaffected. A DB error in
  // the check fails CLOSED for privileged tokens (safer than admitting a possibly-revoked session).
  const verifier = baseVerifier
    ? (async (token: string) => {
        const claims = await baseVerifier(token);
        await auth.assertSessionValid(claims.userId, claims.role, (claims.raw as { iat?: unknown })?.iat);
        return claims;
      })
    : null;
  const affiliate = new AffiliateService(identity, daraja);
  const admin = new AdminService(new PgAdminRepository(q));
  const platform = new PlatformService(new PgPlatformRepository(q));
  const notifications = new NotificationService(new PgNotificationRepository(q));
  const support = makePgSupportDeps(q);
  if (support) console.log("[api] support chat enabled (RAG over migration 0057)");

  // Instant client onboarding: upsert the brand + economy (service_role SQL, works without the
  // platform-console RPCs) and optionally provision its domain across Cloudflare + Namecheap.
  const provisioner = makeDomainProvisioner();
  if (provisioner) console.log(`[api] domain provisioning enabled (Cloudflare Pages project '${provisioner.pagesProject}')`);
  const platformOnboard: PlatformOnboardDeps = {
    domainConfigured: Boolean(provisioner),
    async onboard(input: OnboardInput): Promise<OnboardResult> {
      const f = {
        name: input.name,
        primary_domain: input.primaryDomain ? input.primaryDomain.trim().toLowerCase() : null,
        currency: input.currency ?? "KES",
        locale: input.locale ?? "en-KE",
        theme: input.theme ?? "dark",
        color_primary: input.colors?.primary ?? "#22c55e",
        color_bg: input.colors?.bg ?? "#0a0a0a",
        color_accent: input.colors?.accent ?? "#06b6d4",
        wordmark_text: input.wordmarkText ?? input.primaryDomain ?? input.name,
        licence_line: input.licenceLine ?? null,
        support_email: input.supportEmail ?? null,
        status: "active",
      };
      const existing = await q.query("select id from sites where slug = $1", [input.slug]);
      let siteId: string;
      if (existing.rows.length) {
        siteId = String(existing.rows[0].id);
        const sets = Object.keys(f).map((k, i) => `${k} = $${i + 2}`).join(", ");
        await q.query(`update sites set ${sets}, updated_at = now() where id = $1`, [siteId, ...Object.values(f)]);
      } else {
        const cols = ["slug", ...Object.keys(f)];
        const ph = cols.map((_, i) => `$${i + 1}`).join(", ");
        const r = await q.query(`insert into sites (${cols.join(", ")}) values (${ph}) returning id`, [input.slug, ...Object.values(f)]);
        siteId = String(r.rows[0].id);
      }
      const g = input.game ?? {};
      await q.query(
        `insert into site_game_config (site_id, house_edge, max_multiplier, min_stake, max_stake, min_withdrawal,
           default_duration_s, tick_rate_ms, drift_bias, volatility, target_win_rate)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (site_id) do update set house_edge=excluded.house_edge, max_multiplier=excluded.max_multiplier,
           min_stake=excluded.min_stake, max_stake=excluded.max_stake, min_withdrawal=excluded.min_withdrawal,
           default_duration_s=excluded.default_duration_s, tick_rate_ms=excluded.tick_rate_ms, drift_bias=excluded.drift_bias,
           volatility=excluded.volatility, target_win_rate=excluded.target_win_rate, version = site_game_config.version + 1, updated_at = now()`,
        [siteId, g.houseEdge ?? 0.75, g.maxMultiplier ?? 5.0, g.minStake ?? 25000, g.maxStake ?? 5000000,
         g.minWithdrawal ?? 25000, g.defaultDurationS ?? 10, g.tickRateMs ?? 150, g.driftBias ?? 0.30, g.volatility ?? 1.0, g.targetWinRate ?? 0.125],
      );
      const host = f.primary_domain;
      const resolves = host
        ? (await q.query("select 1 from sites where status='active' and lower(primary_domain)=$1 and id=$2", [host, siteId])).rows.length > 0
        : false;
      const brand = { siteId, slug: input.slug, name: f.name, primaryDomain: host, currency: f.currency, status: f.status, resolvesByHost: resolves };
      let domainResult = null as OnboardResult["domain"];
      if (input.provisionDomain && provisioner && host) domainResult = await provisioner.provision(host);
      return { siteId, brand, domain: domainResult };
    },
    async domainStatus(d: string) {
      if (!provisioner) throw new Error("NOT_CONFIGURED: domain provisioning is not configured");
      return provisioner.status(d);
    },
  };

  // Multi-tenant CORS (GAP 3): allow every ACTIVE brand domain automatically. Cached in memory and
  // refreshed from `sites`, so the preflight decision is synchronous and hardening
  // CORS_ALLOWED_ORIGINS never locks a client out. Seeded once here before the server accepts traffic.
  const brandCors = new BrandOriginAllowlist(async () => {
    const r = await q.query(
      "select primary_domain from sites where status = 'active' and primary_domain is not null", []);
    return r.rows.map((x: Record<string, unknown>) => String(x.primary_domain));
  });
  await brandCors.init();
  console.log(`[api] CORS: ${brandCors.size} active brand origin(s) allowed dynamically`);

  return {
    verifier,
    auth,
    affiliate,
    admin,
    platform,
    notifications,
    push: pushService,
    actionSecret: process.env.SUPABASE_JWT_SECRET,
    withdrawalActionActor: resolveActionActor,
    telegram: telegram ?? undefined,
    telegramChatIds,
    telegramWebhookSecret,
    corsAllowOrigin: (origin: string) => brandCors.allows(origin),
    marketers: makePgMarketerRepo((sql, params) => q.query(sql, params ?? [])),
    referral: makePgReferralRepo((sql, params) => q.query(sql, params ?? [])),
    marketerExpenses: {
      async add(actorId, actorRole, siteId, marketerUserId, category, amountCents, note) {
        const r = await q.query(
          "select id, category, amount_cents, note, created_at, created_by from fn_admin_add_marketer_expense($1,$2,$3::uuid,$4::uuid,$5,$6,$7)",
          [actorId, actorRole, siteId, marketerUserId, category, amountCents, note]);
        return mapExpenseRow(r.rows[0]);
      },
      async list(marketerUserId, limit) {
        const r = await q.query(
          "select id, category, amount_cents, note, created_at, created_by from fn_marketer_expenses($1::uuid,$2)",
          [marketerUserId, limit]);
        return r.rows.map(mapExpenseRow);
      },
    },
    config: () => gameConfig.active(),
    // Brand-aware public config: resolve a site ref (slug|domain|id) -> that brand's live
    // site_game_config (the row the engine prices from), so GET /game/config matches the engine's
    // limits/cap per brand. Mirrors brandByHost's resolver (apex + www + slug + id). Null => fallback.
    gameConfigForSite: async (ref: string): Promise<VersionedGameConfig | null> => {
      const h = normalizeHost(ref);
      if (!h) return null;
      const r = await q.query(
        `select c.house_edge, c.max_multiplier, c.min_stake, c.max_stake, c.min_withdrawal,
                c.default_duration_s, c.tick_rate_ms, c.drift_bias, c.volatility, c.target_win_rate, c.version
           from site_game_config c join sites s on s.id = c.site_id
          where s.status = 'active'
            and (lower(s.slug) = $1
                 or lower(s.primary_domain) = $1
                 or regexp_replace(lower(s.primary_domain), '^www\\.', '') = $1
                 or lower(s.id::text) = $1)
          limit 1`,
        [h],
      );
      if (!r.rows.length) return null;
      return mapConfigRow(r.rows[0] as Record<string, unknown>);
    },
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
      const h = normalizeHost(host);
      if (!h) return null;
      const r = await q.query(
        `select id, slug, name, wordmark_text, logo_url, favicon_url, color_primary, color_bg,
                color_accent, theme, currency, locale, licence_line, support_email, theme_tokens
           from sites
          where status = 'active'
            and (lower(slug) = $1
                 or lower(primary_domain) = $1
                 or regexp_replace(lower(primary_domain), '^www\\.', '') = $1)
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
        themeTokens: (x.theme_tokens as Record<string, string> | null) ?? null,
      };
    },
    payments,
    platformGate,
    resolveHandle,
    walletBalance: async (userId: string, siteId?: string): Promise<WalletBalance> => {
      // Spendable balance must match the game engine's source of truth (PgGameRepository
      // .getWalletSnapshot, migration 0084): marketer/demo accounts spend the DEMO bucket, players
      // spend real_balance. Previously this returned real_balance unconditionally, so a marketer's
      // /wallet reported 0 while the game WS (correctly) showed their demo balance. Any refetch of
      // ['wallet'] — e.g. the invalidation fired by a withdrawal — then clobbered the live balance
      // with 0 until a full refresh re-seeded it from the socket. Surfacing demo as `real` here
      // makes the REST wallet authoritative and consistent with the socket.
      const r = await q.query(
        `select case when fn_is_marketer_account(user_id) then demo_balance else real_balance end as real_balance,
                bonus_balance, currency
           from wallets where user_id = $1 and ($2::uuid is null or site_id = $2)`,
        [userId, siteId ?? null]);
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
    ledger: (userId, qy, siteId) => repo.listLedger(userId, qy, siteId),
    positions: (userId, qy, siteId) => repo.listPositions(userId, qy, siteId),
    positionDetail: (userId, id, siteId) => repo.getPositionDetail(userId, id, siteId),
    transactions: (userId, qy, siteId) => payRepo.listTransactions(userId, qy, siteId),
    // Support chat (docs/11, migration 0057): enabled only when the free embedder + LLM creds
    // are configured; otherwise the /support routes stay unregistered (unchanged behaviour).
    ...(support ? { support } : {}),
    platformOnboard,
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
