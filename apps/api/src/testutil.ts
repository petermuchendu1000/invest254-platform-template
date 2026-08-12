import type { AddressInfo } from "node:net";
import { DEFAULT_CONFIG, type Cents } from "@invest254/shared";
import {
  InMemoryEngagementRepository, InMemoryPaymentRepository, InMemoryGameRepository, StubDarajaClient,
  InMemoryIdentityRepository, PaymentService, AuthService, AffiliateService, AdminService, InMemoryAdminRepository, maskHandle,
  NotificationService, InMemoryNotificationRepository,
  type FairnessRecord, type AuthClaims, type Verifier,
} from "@invest254/engine";
import { createApp, type ApiDeps, type WalletBalance, type Brand } from "./app.js";
import type { MarketerRepo, MarketerRow, MarketerProfile, MarketerLedgerRow, WithdrawResult } from "./app.marketers.js";

/** In-memory MarketerRepo mirroring the SQL RPCs (0033): overdraw guard, idempotency, initials. */
export function makeInMemoryMarketerRepo(): MarketerRepo {
  interface Rec { id: string; name: string; phone: string; status: string; created_at: string; updated_at: string; balance: number; fuliza: number; airtime: number; }
  const byId = new Map<string, Rec>();
  const byPhone = new Map<string, string>();
  const ledgers = new Map<string, MarketerLedgerRow[]>();
  const refs = new Map<string, { balance: number; ledgerId: number }>();
  const pins = new Map<string, string>();
  let mseq = 0, lseq = 0;
  const now = () => new Date().toISOString();
  const parts = (n: string) => n.trim().split(/\s+/).filter(Boolean);
  const firstName = (n: string) => parts(n)[0] ?? "";
  const initials = (n: string) => { const p = parts(n); return p.length === 0 ? "" : p.length === 1 ? p[0]!.slice(0, 2).toUpperCase() : (p[0]![0]! + p[p.length - 1]![0]!).toUpperCase(); };
  const profileOf = (m: Rec): MarketerProfile => ({ id: m.id, name: m.name, first_name: firstName(m.name), initials: initials(m.name), phone: m.phone, status: m.status, balance_cents: m.balance, available_fuliza_cents: m.fuliza, airtime_balance_cents: m.airtime, currency: "KES" });
  const push = (id: string, entry_type: string, amount_cents: number, balance_after_cents: number, ref: string | null, meta: unknown): number => {
    const row: MarketerLedgerRow = { id: ++lseq, entry_type, amount_cents, balance_after_cents, ref, meta: meta ?? {}, created_at: now() };
    (ledgers.get(id) ?? []).push(row);
    return row.id;
  };
  return {
    async create(name: string, phone: string): Promise<MarketerRow> {
      const existing = byPhone.get(phone);
      if (existing) { const m = byId.get(existing)!; m.name = name; m.updated_at = now(); return { id: m.id, name: m.name, phone: m.phone, status: m.status, created_at: m.created_at, updated_at: m.updated_at }; }
      const id = `m-${++mseq}`; const ts = now();
      const m: Rec = { id, name, phone, status: "active", created_at: ts, updated_at: ts, balance: 0, fuliza: 0, airtime: 0 };
      byId.set(id, m); byPhone.set(phone, id); ledgers.set(id, []);
      return { id, name, phone, status: "active", created_at: ts, updated_at: ts };
    },
    async list(limit: number): Promise<MarketerProfile[]> {
      return [...byId.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit).map(profileOf);
    },
    async profile(id: string): Promise<MarketerProfile | null> { const m = byId.get(id); return m ? profileOf(m) : null; },
    async profileByPhone(phone: string): Promise<MarketerProfile | null> { const id = byPhone.get(phone); const m = id ? byId.get(id) : undefined; return m ? profileOf(m) : null; },
    async credit(id: string, amountCents: number, ref: string | null, meta: unknown): Promise<number> {
      if (amountCents <= 0) throw new Error("AMOUNT_MUST_BE_POSITIVE");
      if (ref && refs.has(ref)) return refs.get(ref)!.balance;
      const m = byId.get(id); if (!m) throw new Error("MARKETER_NOT_FOUND");
      m.balance += amountCents; m.updated_at = now();
      const lid = push(id, "credit", amountCents, m.balance, ref, meta);
      if (ref) refs.set(ref, { balance: m.balance, ledgerId: lid });
      return m.balance;
    },
    async withdraw(id: string, amountCents: number, ref: string | null, meta: unknown, _method: string): Promise<WithdrawResult> {
      if (amountCents <= 0) throw new Error("AMOUNT_MUST_BE_POSITIVE");
      if (ref && refs.has(ref)) { const e = refs.get(ref)!; return { idempotent: true, balance_cents: e.balance, ledger_id: e.ledgerId }; }
      const m = byId.get(id); if (!m) throw new Error("MARKETER_NOT_FOUND");
      if (m.status !== "active") throw new Error(`MARKETER_NOT_ACTIVE:${m.status}`);
      if (m.balance < amountCents) throw new Error(`INSUFFICIENT_FUNDS: have ${m.balance}, need ${amountCents}`);
      m.balance -= amountCents; m.updated_at = now();
      const lid = push(id, "withdrawal", -amountCents, m.balance, ref, meta);
      if (ref) refs.set(ref, { balance: m.balance, ledgerId: lid });
      return { idempotent: false, balance_cents: m.balance, withdrawal_id: `w-${lid}`, ledger_id: lid };
    },
    async setFuliza(id: string, amountCents: number): Promise<number> { if (amountCents < 0) throw new Error("AMOUNT_MUST_BE_NONNEGATIVE"); const m = byId.get(id); if (!m) throw new Error("MARKETER_NOT_FOUND"); m.fuliza = amountCents; m.updated_at = now(); return amountCents; },
    async setAirtime(id: string, amountCents: number): Promise<number> { if (amountCents < 0) throw new Error("AMOUNT_MUST_BE_NONNEGATIVE"); const m = byId.get(id); if (!m) throw new Error("MARKETER_NOT_FOUND"); m.airtime = amountCents; m.updated_at = now(); return amountCents; },
    async statement(id: string, limit: number): Promise<MarketerLedgerRow[]> { return (ledgers.get(id) ?? []).slice().reverse().slice(0, limit); },
    async setPin(id: string, pin: string): Promise<void> { if (!/^\d{4,6}$/.test(pin)) throw new Error("INVALID_PIN"); if (!byId.has(id)) throw new Error("MARKETER_NOT_FOUND"); pins.set(id, pin); },
    async login(phone: string, pin: string): Promise<string | null> {
      const id = byPhone.get(phone); if (!id) return null;
      const m = byId.get(id)!; if (!pins.has(id) || m.status !== "active") return null;
      return pins.get(id) === pin ? id : null;
    },
    async changePin(id: string, currentPin: string, newPin: string): Promise<void> {
      if (!/^\d{4,6}$/.test(newPin)) throw new Error("INVALID_PIN");
      if (!pins.has(id)) throw new Error("NO_PIN_SET");
      if (pins.get(id) !== currentPin) throw new Error("INVALID_CREDENTIALS");
      pins.set(id, newPin);
    },
    async setStatus(id: string, status: string): Promise<string> {
      if (!["active", "suspended", "disabled"].includes(status)) throw new Error("INVALID_STATUS");
      const m = byId.get(id); if (!m) throw new Error("MARKETER_NOT_FOUND");
      m.status = status; m.updated_at = now(); return status;
    },
  };
}

/**
 * In-memory test harness: builds an app from REAL engine services backed by in-memory
 * repositories, listens on an ephemeral port, and returns the base URL + a close fn + the
 * underlying fakes so tests can pre-seed and assert. No Postgres, no real network.
 *
 * The stub verifier accepts a `<userId>` or `<userId>:<role>` bearer token so player and
 * finance-admin routes can be exercised without minting JWTs.
 * in the harness (rateLimitMs:0) — its time-based behaviour is covered by unit tests.
 */
export function stubVerifier(): Verifier {
  return async (token: string): Promise<AuthClaims> => {
    if (!token) throw new Error("TOKEN_REQUIRED");
    // `<userId>` | `<userId>:<role>` | `<userId>:<role>:<siteId>` — the optional 3rd segment
    // lets tests exercise the JWT `site` claim that requireSite reads.
    const [userId, role, site] = token.split(":");
    if (!userId) throw new Error("TOKEN_INVALID");
    return { userId, role: role || "player", ...(site ? { site } : {}), raw: {} };
  };
}

export const TEST_USER = "u-test";
export const TEST_ADMIN = "u-admin";

/** Two brands on one deployment, for site-scoping tests (docs/22 Task E). */
export const SITE_A = "00000000-0000-0000-0000-000000000001";
export const SITE_B = "22222222-2222-2222-2222-222222222222";
export const TEST_BRANDS: Record<string, Brand> = {
  "invest254.com": {
    siteId: SITE_A, slug: "invest254", name: "Invest254", wordmarkText: "invest254.com",
    logoUrl: null, faviconUrl: null, colorPrimary: "#22c55e", colorBg: "#0a0a0a", colorAccent: "#06b6d4",
    theme: "dark", currency: "KES", locale: "en-KE", licenceLine: "Operated under licence.", supportEmail: null,
  },
  "brandb.example": {
    siteId: SITE_B, slug: "brandb", name: "Brand B", wordmarkText: null,
    logoUrl: null, faviconUrl: null, colorPrimary: "#f97316", colorBg: "#111111", colorAccent: "#a855f7",
    theme: "light", currency: "KES", locale: "en-KE", licenceLine: null, supportEmail: "support@brandb.example",
  },
};
/** Resolve a brand by primary host or slug (mirrors the Pg resolver in server.ts). */
export function resolveTestBrand(hostOrSlug: string): Brand | null {
  const k = hostOrSlug.trim().toLowerCase();
  return TEST_BRANDS[k] ?? Object.values(TEST_BRANDS).find((b) => b.slug === k) ?? null;
}

export interface TestApi {
  baseUrl: string;
  deps: ApiDeps;
  identity: InMemoryIdentityRepository;
  engage: InMemoryEngagementRepository;
  payRepo: InMemoryPaymentRepository;
  gameRepo: InMemoryGameRepository;
  daraja: StubDarajaClient;
  fairness: Map<number, FairnessRecord>;
  bonus: Map<string, Cents>;
  withdrawalSuccesses: Array<{ userId: string; amountCents: Cents }>;
  notifications: NotificationService;
  marketers: MarketerRepo;
  close(): Promise<void>;
}

export interface TestApiOptions { startingBalanceCents?: Cents; depsOverrides?: Partial<ApiDeps>; }

export async function startTestApi(opts: TestApiOptions = {}): Promise<TestApi> {
  const engage = new InMemoryEngagementRepository();
  engage.setUsername(TEST_USER, "tester");

  const payRepo = new InMemoryPaymentRepository();
  payRepo.seed(TEST_USER, opts.startingBalanceCents ?? 1_000_000); // KES 10,000
  const gameRepo = new InMemoryGameRepository();
  gameRepo.seed(TEST_USER, opts.startingBalanceCents ?? 1_000_000);
  const daraja = new StubDarajaClient();
  const withdrawalSuccesses: Array<{ userId: string; amountCents: Cents }> = [];

  const resolveHandle = async (userId: string): Promise<string> =>
    (await engage.getUsername(userId)) ?? `guest_${userId.slice(0, 6)}`;

  const payments = new PaymentService(payRepo, daraja, {
    events: {
      onWithdrawalSuccess: (e) => {
        withdrawalSuccesses.push(e);
      },
    },
  });


  const fairness = new Map<number, FairnessRecord>([
    [1, { gameDayId: 1, tradeDate: "2026-06-17", serverSeedHash: "hash-yesterday", serverSeed: "revealed-seed-yesterday", revealedAt: "2026-06-18T00:00:00.000Z" }],
    [2, { gameDayId: 2, tradeDate: "2026-06-18", serverSeedHash: "hash-today", serverSeed: null, revealedAt: null }],
  ]);
  const bonus = new Map<string, Cents>();

  const identity = new InMemoryIdentityRepository();
  const auth = new AuthService(identity, { jwtSecret: "test-secret-which-is-long-enough-123456", jwtTtlSeconds: 3600 });
  const affiliate = new AffiliateService(identity, daraja);
  const admin = new AdminService(new InMemoryAdminRepository(identity, payRepo, engage, gameRepo));
  const notifications = new NotificationService(new InMemoryNotificationRepository());

  const deps: ApiDeps = {
    verifier: stubVerifier(),
    auth,
    affiliate,
    admin,
    notifications,
    marketers: makeInMemoryMarketerRepo(),
    config: () => DEFAULT_CONFIG,
    fairnessById: async (id) => fairness.get(id) ?? null,
    brandByHost: async (host) => resolveTestBrand(host),
    payments,
    resolveHandle,
    walletBalance: async (userId): Promise<WalletBalance> =>
      ({ real: await payRepo.getBalance(userId), bonus: bonus.get(userId) ?? 0, currency: "KES" }),
    ledger: (userId, q) => gameRepo.listLedger(userId, q),
    positions: (userId, q) => gameRepo.listPositions(userId, q),
    positionDetail: (userId, id) => gameRepo.getPositionDetail(userId, id),
    transactions: (userId, q) => payRepo.listTransactions(userId, q),
    ...opts.depsOverrides,
  };

  const server = createApp(deps);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    deps, identity, engage, payRepo, gameRepo, daraja, fairness, bonus, withdrawalSuccesses,
    notifications,
    marketers: deps.marketers,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
