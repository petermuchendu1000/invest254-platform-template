import type { AddressInfo } from "node:net";
import { DEFAULT_CONFIG, normalizeHost, type Cents } from "@invest254/shared";
import {
  InMemoryEngagementRepository, InMemoryPaymentRepository, InMemoryGameRepository, StubDarajaClient,
  InMemoryIdentityRepository, PaymentService, AuthService, AffiliateService, AdminService, InMemoryAdminRepository, PlatformService, InMemoryPlatformRepository, maskHandle,
  NotificationService, InMemoryNotificationRepository,
  type FairnessRecord, type AuthClaims, type Verifier,
} from "@invest254/engine";
import { createApp, type ApiDeps, type WalletBalance, type Brand } from "./app.js";
import type { MarketerRepo, MarketerRow, MarketerProfile, MarketerLedgerRow, WithdrawResult } from "./app.marketers.js";
import type { SupportDeps, SupportStore, SupportConversation, SupportMessageRow } from "./app.support.js";
import type { PlatformOnboardDeps, OnboardInput, OnboardResult } from "./app.platform.js";
import type { EmbedFn, KbHit, LlmFn, LlmMessage, SupportBrandInfo } from "@invest254/shared";
import { createHash } from "node:crypto";

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

// ── Support-chat fakes (deterministic; no ONNX, no network) ─────────────────────────────
const EMBED_DIMS = 384;
/** Deterministic zero-model embedder: token-hashed bag-of-words, L2-normalised (mirrors the
 *  Python `hash_embed` used by the DB e2e). Lexical, not semantic, but perfect for asserting
 *  the retrieval pipeline (cosine ordering + scoping) with hand-crafted chunks. */
export function makeHashEmbed(dims = EMBED_DIMS): EmbedFn {
  return async (texts: string[]) =>
    texts.map((t) => {
      const v = new Array<number>(dims).fill(0);
      for (const tok of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        const h = createHash("sha256").update(tok).digest();
        const idx = h.readUInt32BE(0) % dims;
        v[idx]! += (h[8]! & 1) === 0 ? 1 : -1;
      }
      let norm = 0;
      for (const x of v) norm += x * x;
      norm = Math.sqrt(norm) || 1;
      return v.map((x) => x / norm);
    });
}

const dot = (a: number[], b: number[]): number => {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
};

export interface SeedChunk { siteId: string | null; source: string; heading?: string | null; content: string; }

export interface SupportHarness {
  deps: SupportDeps;
  store: SupportStore;
  /** Seed KB chunks (site_id null = shared). Vectors are computed with the hash embedder. */
  seedKb(chunks: SeedChunk[]): Promise<void>;
  /** Swap the LLM at runtime (default echoes an em-dash answer that quotes the top context). */
  setLlm(fn: LlmFn): void;
  llmCalls: LlmMessage[][];
  conversations: Map<string, SupportConversation>;
  messages: Map<string, SupportMessageRow[]>;
}

/** Build the in-memory support deps: hash embedder, seedable KB, recording store, fake LLM. */
export function makeSupportHarness(brandOf: (siteId: string) => SupportBrandInfo): SupportHarness {
  const embed = makeHashEmbed();
  const kb: Array<{ siteId: string | null; source: string; heading: string | null; content: string; vector: number[] }> = [];
  const llmCalls: LlmMessage[][] = [];
  let llm: LlmFn = async (messages) => {
    // Default: quote the first context line and deliberately include an em dash so tests can
    // prove the transport strips it. If no context, answer with an uncertain line.
    const sys = messages[0]?.content ?? "";
    const m = sys.match(/\n\[1\][^\n]*\n([^\n]+)/);
    return m ? `Here is what I found \u2014 ${m[1]}` : "I am not certain about that, let me connect you with a human.";
  };

  const conversations = new Map<string, SupportConversation>();
  const messages = new Map<string, SupportMessageRow[]>();
  let cseq = 0, mseq = 0;
  const now = () => new Date().toISOString();

  const store: SupportStore = {
    async start(siteId, opts) {
      const id = `c0000000-0000-0000-0000-${String(++cseq).padStart(12, "0")}`;
      conversations.set(id, {
        id, siteId, userId: opts.userId ?? null, visitorId: opts.visitorId ?? null,
        status: "open", escalated: false, contactEmail: null, contactPhone: null,
        createdAt: now(), lastAt: now(),
      });
      messages.set(id, []);
      return id;
    },
    async log(conversationId, role, content, sources, confidence) {
      const conv = conversations.get(conversationId);
      if (!conv) throw new Error("CONVERSATION_NOT_FOUND");
      const id = `d0000000-0000-0000-0000-${String(++mseq).padStart(12, "0")}`;
      (messages.get(conversationId) ?? []).push({
        id, conversationId, siteId: conv.siteId, role, content, sources, confidence, createdAt: now(),
      });
      conv.lastAt = now();
      return id;
    },
    async escalate(conversationId, contact) {
      const conv = conversations.get(conversationId);
      if (!conv) throw new Error("CONVERSATION_NOT_FOUND");
      conv.escalated = true;
      conv.status = "escalated";
      conv.contactEmail = contact.email ?? conv.contactEmail;
      conv.contactPhone = contact.phone ?? conv.contactPhone;
      conv.lastAt = now();
    },
    async getConversation(conversationId) {
      return conversations.get(conversationId) ?? null;
    },
    async listMessages(conversationId) {
      return (messages.get(conversationId) ?? []).slice();
    },
    async listConversations(scope, opts) {
      return [...conversations.values()]
        .filter((c) => scope === null || c.siteId === scope)
        .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
        .slice(0, opts.limit);
    },
  };

  const searchKb = async (siteId: string, embedding: number[], k: number): Promise<KbHit[]> =>
    kb
      .filter((c) => c.siteId === null || c.siteId === siteId)
      .map((c) => ({ source: c.source, heading: c.heading, content: c.content, distance: 1 - dot(c.vector, embedding) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, k);

  const deps: SupportDeps = {
    store,
    embed,
    searchKb,
    llm: (messages2, opts) => { llmCalls.push(messages2); return llm(messages2, opts); },
    brandInfo: async (siteId) => brandOf(siteId),
  };

  return {
    deps,
    store,
    async seedKb(chunks) {
      const vectors = await embed(chunks.map((c) => c.content));
      chunks.forEach((c, i) => kb.push({ siteId: c.siteId, source: c.source, heading: c.heading ?? null, content: c.content, vector: vectors[i]! }));
    },
    setLlm(fn) { llm = fn; },
    llmCalls,
    conversations,
    messages,
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
/** Resolve a brand by primary host or slug (mirrors the Pg resolver in server.ts, incl. www-fold). */
export function resolveTestBrand(hostOrSlug: string): Brand | null {
  const k = normalizeHost(hostOrSlug);
  if (!k) return null;
  for (const b of Object.values(TEST_BRANDS)) if (b.slug === k) return b;
  for (const [host, b] of Object.entries(TEST_BRANDS)) if (normalizeHost(host) === k) return b;
  return null;
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
  /** The in-memory platform repo, so tests can seed brands + marketer rollup rows (Task R). */
  platformRepo: InMemoryPlatformRepository;
  /** Support-chat fakes (seed KB, swap LLM, inspect recorded conversations/messages). */
  support: SupportHarness;
  /** Instant-onboarding fake: recorded inputs + the in-memory deps. */
  onboard: { calls: OnboardInput[]; deps: PlatformOnboardDeps };
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
  const platformRepo = new InMemoryPlatformRepository();
  const platform = new PlatformService(platformRepo);
  const notifications = new NotificationService(new InMemoryNotificationRepository());

  // Support-chat harness: resolve brand facts from the seeded test brands (default fallback).
  const support = makeSupportHarness((siteId) => {
    const b = Object.values(TEST_BRANDS).find((x) => x.siteId === siteId);
    return { name: b?.name ?? "Invest254", supportEmail: b?.supportEmail ?? null, currency: b?.currency ?? "KES" };
  });

  // Instant-onboarding harness: an in-memory PlatformOnboardDeps that records inputs and returns
  // a deterministic provision result (no real Cloudflare/Namecheap calls).
  const onboardCalls: OnboardInput[] = [];
  const onboardDeps: PlatformOnboardDeps = {
    domainConfigured: true,
    async onboard(input: OnboardInput): Promise<OnboardResult> {
      onboardCalls.push(input);
      const host = input.primaryDomain ? input.primaryDomain.trim().toLowerCase() : null;
      const brand = {
        siteId: `site-${input.slug}`, slug: input.slug, name: input.name, primaryDomain: host,
        currency: input.currency ?? "KES", status: "active", resolvesByHost: Boolean(host),
      };
      const domain = input.provisionDomain && host
        ? { domain: host, zoneId: "z-test", nameServers: ["a.ns.cloudflare.com", "b.ns.cloudflare.com"], zoneStatus: "pending", nameserversUpdated: true, pages: [{ name: host, status: "initializing" }, { name: `www.${host}`, status: "initializing" }], note: "test" }
        : null;
      return { siteId: brand.siteId, brand, domain };
    },
    async domainStatus(d: string) {
      return { domain: d, zoneStatus: "pending", pages: [{ name: d, status: "initializing" }], active: false };
    },
  };

  const deps: ApiDeps = {
    verifier: stubVerifier(),
    auth,
    affiliate,
    admin,
    platform,
    notifications,
    marketers: makeInMemoryMarketerRepo(),
    config: () => DEFAULT_CONFIG,
    fairnessById: async (id) => fairness.get(id) ?? null,
    brandByHost: async (host) => resolveTestBrand(host),
    payments,
    resolveHandle,
    walletBalance: async (userId, siteId): Promise<WalletBalance> =>
      ({ real: await payRepo.getBalance(userId, siteId), bonus: bonus.get(userId) ?? 0, currency: "KES" }),
    ledger: (userId, q, siteId) => gameRepo.listLedger(userId, q, siteId),
    positions: (userId, q, siteId) => gameRepo.listPositions(userId, q, siteId),
    positionDetail: (userId, id, siteId) => gameRepo.getPositionDetail(userId, id, siteId),
    transactions: (userId, q, siteId) => payRepo.listTransactions(userId, q, siteId),
    support: support.deps,
    platformOnboard: onboardDeps,
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
    platformRepo,
    support,
    onboard: { calls: onboardCalls, deps: onboardDeps },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
