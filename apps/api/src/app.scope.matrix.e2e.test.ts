import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startTestApi, TEST_USER, SITE_A, SITE_B, type TestApi } from "./testutil.js";
import { createRouter } from "./app.js";
import { BillingService, InMemoryBillingRepository, StubDarajaClient } from "@invest254/engine";

/**
 * ISSUE 1 / F-44 — cross-tenant ATTACK MATRIX over EVERY id-addressed operator route.
 *
 * The route list is read from the REAL router (Router.listRoutes), not hand-maintained, so a new
 * id-addressed /admin, /platform, /tickets, /addons or /support route is automatically attacked here —
 * and fails CI unless it is refused. Two attackers:
 *   - ATTACKER_SITE  : brand B's site admin (the tier with the largest surface);
 *   - ATTACKER_PLAT  : the platform admin of ANOTHER platform (beta), which brand A is not in.
 * Every target is a REAL brand-A entity (user, marketer, notification, withdrawal, advance, support
 * conversation, ticket, brand, platform) wherever the in-memory harness can seed one. Bodies are VALID,
 * so a refusal can never come from input validation masking a missing scope check: only 403 / 404 pass;
 * any 2xx (or 400/409/500) is a failure. Afterwards brand A's state is proven untouched.
 */
const json = (r: Response): Promise<any> => r.json() as Promise<any>;
function req(api: TestApi, method: string, path: string, token?: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  return fetch(`${api.baseUrl}${path}`, init);
}
const DEFAULT_PLATFORM = "10000000-0000-0000-0000-000000000001";
const BILL_INV_A = "30000000-0000-0000-0000-00000000000a";
const OWNER = "owner:platform_superadmin";
const ADMIN_A = `adm-a:admin:${SITE_A}`;
const ATTACKER_SITE = `atk:admin:${SITE_B}`;
const PASSWORD = "sup3r-secret";

interface Seed {
  userA: string; affA: string; marketerA: string; notifA: number; withdrawalA: string; advanceA: string;
  convA: string; ticketA: string | null; betaPlatform: string; attackerPlat: string; chatA: string; kycA: string;
}

async function seed(api: TestApi): Promise<Seed> {
  const reg = async (phone: string, username: string): Promise<string> => {
    const r = await req(api, "POST", "/api/v1/auth/register", undefined, { phone, username, password: "Password1", site: "invest254" });
    assert.equal(r.status, 201, `register ${username}`);
    return (await json(r)).userId as string;
  };
  const userA = await reg("0711900001", "victimA");
  const affA = await reg("0711900002", "affA");
  assert.equal((await req(api, "POST", "/api/v1/affiliate/enroll", `${affA}:player:${SITE_A}`)).status, 200);
  const marketerA = (await json(await req(api, "POST", "/api/v1/admin/marketers", ADMIN_A, { name: "Victim Marketer", phone: "0722900001" }))).id as string;
  assert.equal((await req(api, "POST", `/api/v1/admin/marketers/${marketerA}/pin`, ADMIN_A, { pin: "2468" })).status, 200);
  assert.equal((await req(api, "POST", `/api/v1/admin/marketers/${marketerA}/credit`, ADMIN_A, { amountCents: 50_000 })).status, 200);
  const notifA = (await json(await req(api, "POST", `/api/v1/admin/users/${userA}/notifications`, ADMIN_A, { title: "Hello", level: "info" }))).id as number;
  const w = await req(api, "POST", "/api/v1/withdrawals", TEST_USER, { amount: 50_000, phone: "0733000111" });
  assert.equal(w.status, 202, "brand-A withdrawal seeded");
  const withdrawalA = (await json(w)).transactionId as string;
  const adv = await req(api, "POST", "/api/v1/affiliate/advances", `${affA}:marketer:${SITE_A}`, { amountCents: 10_000, reason: "seed" });
  assert.equal(adv.status, 200, "brand-A advance request seeded");
  const advanceA = (await json(adv)).id as string;
  const conv = await req(api, "POST", "/api/v1/support/conversations", undefined, { site: "invest254" });
  const convA = conv.status === 201 ? ((await json(conv)).conversationId as string) : randomUUID();
  const t = await req(api, "POST", "/api/v1/tickets", ADMIN_A, { subject: "seed", urgency: "low", platformId: DEFAULT_PLATFORM, siteId: SITE_A });
  const ticketA = t.status === 201 ? ((await json(t)).id ?? (await Promise.resolve(null))) as string | null : null;
  const beta = await req(api, "POST", "/api/v1/platform/platforms", OWNER, { slug: "beta", name: "Beta" });
  const betaPlatform = (await json(beta)).platformId as string;
  const attackerPlat = `pa-beta:platform_admin:${SITE_B}:${betaPlatform}`;
  // CHAT-1 / ACCT-1: a brand-A live chat thread and identity submission.
  const pA = `${userA}:player:${SITE_A}`;
  const chat = await req(api, "POST", "/api/v1/chat/messages", pA, { body: "help me" });
  assert.equal(chat.status, 201, "brand-A chat seeded");
  const chatA = (await json(chat)).threadId as string;
  const up = async () => (await json(await fetch(`${api.baseUrl}/api/v1/kyc/files`, { method: "POST", headers: { authorization: `Bearer ${pA}`, "content-type": "image/jpeg" }, body: Buffer.alloc(32, 1) }))).id as string;
  const front = await up(); const selfie = await up();
  const k = await req(api, "POST", "/api/v1/kyc", pA, { docType: "national_id", fullName: "Victim A", idNumber: "12345678", dateOfBirth: "1990-01-01", frontId: front, selfieId: selfie });
  assert.equal(k.status, 201, "brand-A identity submission seeded");
  const kycA = (await json(k)).id as string;
  return { userA, affA, marketerA, notifA, withdrawalA, advanceA, convA, ticketA, betaPlatform, attackerPlat, chatA, kycA };
}

/** Concrete URL + a VALID body for each route pattern, targeting brand-A entities. */
function instantiate(path: string, s: Seed): { url: string; body: unknown; seeded: boolean } {
  let seeded = true;
  const id = ((): string => {
    if (/\/admin\/(users|wallets)\/:id/.test(path)) return s.userA;
    if (/\/admin\/(affiliates\/:id|marketers\/:id\/(make|clear)-default)/.test(path)) return s.affA;
    if (/\/admin\/marketers\/:id/.test(path)) return s.marketerA;
    if (/\/admin\/notifications\/:id/.test(path)) return String(s.notifA);
    if (/\/admin\/withdrawals\/:id/.test(path)) return s.withdrawalA;
    if (/\/admin\/affiliate\/advances\/:id/.test(path)) return s.advanceA;
    if (/\/platform\/payment-scopes\//.test(path)) return SITE_A;   // PAY-1: brand A's payment scope
    if (/\/platform\/billing\/invoices\/:id/.test(path)) return BILL_INV_A;   // BILL-1: platform A's invoice
    if (/\/platform\/billing\/accounts\/:id/.test(path)) return DEFAULT_PLATFORM;
    if (/\/platform\/sites\/:id/.test(path)) return SITE_A;
    if (/\/platform\/(platforms|subscriptions)\/:id/.test(path)) return DEFAULT_PLATFORM;
    if (/\/support\/conversations\/:id/.test(path)) return s.convA;
    if (/\/admin\/chat\/threads\/:id/.test(path)) return s.chatA;
    if (/\/admin\/kyc\/:id/.test(path)) return s.kycA;
    if (/\/tickets\/:id/.test(path) && s.ticketA) return s.ticketA;
    if (/\/addons\/requests\/:id/.test(path)) { seeded = false; return "1"; }
    seeded = false; return randomUUID();       // affiliate/commission payouts: not seedable in-memory
  })();
  const url = path.replace(":type", "site").replace(":id", id).replace(":uid", s.userA).replace(":userId", s.affA).replace(":code", "mpesa");
  const tail = path.split("/").slice(-1)[0]!;
  const bodies: Record<string, unknown> = {
    suspend: { reason: "x" }, ban: { reason: "x" }, reactivate: { reason: "x" }, delete: {},
    role: { role: "marketer" }, details: { username: "pwned_name" }, rate: { rate: 0.3 },
    adjust: { amountCents: 100, direction: "credit", reason: "x" }, clear: { reason: "x", kind: "real" },
    "reset-balance": { reason: "x" }, overrides: { winRate: 0.1 }, notifications: { title: "pwned" },
    resolve: {}, credit: { amountCents: 100 }, withdraw: { amountCents: 100 }, fuliza: { amountCents: 100 },
    airtime: { amountCents: 100 }, pin: { pin: "9999" }, status: { status: "disabled", reason: "x" },
    pay: { phone: "0712345678" },   // BILL-1: a valid phone, so only scope can refuse
    approve: { password: PASSWORD }, reject: { reason: "x" }, "mark-paid": { password: PASSWORD }, paid: { ref: "x" },
    messages: { message: "hi" }, escalate: { email: "a@b.co", note: "x" }, comments: { body: "x" },
    balance: { amountCents: 100, direction: "credit", reason: "x" }, assign: { platformId: s.betaPlatform },
    impersonate: {}, theme: { tokens: { primary: "#000" } }, config: { house_edge: 0.05 }, owner: { ownerUserId: null },
    plan: { planKey: "enterprise" }, payment: { amountCents: 1 }, decide: { decision: "approve" }, decision: { decision: "approved" }, read: {},
    marketer: { siteId: SITE_B }, global: { enabled: true }, site: { siteId: SITE_A, enabled: true }, test: {},
    revoke: {}, "make-default": {}, "clear-default": {}, activate: { payoutsEnabled: false }, deactivate: {}, remove: {},
    ":code": { enabled: false, environment: "production", shortcode: "600111", consumer_key: "k", consumer_secret: "s" },
    ":id": { name: "pwned", phone: "0799000999" },   // PATCH /admin/marketers/:id, PATCH /platform/{sites,platforms}/:id
  };
  return { url, body: bodies[tail] ?? {}, seeded };
}

test("F-44 matrix: every id-addressed operator route refuses a cross-tenant attacker; brand A is untouched", async () => {
  const billRepo = new InMemoryBillingRepository();
  billRepo.invoicesById.set(BILL_INV_A, { id: BILL_INV_A, number: "TRIO-2026-00001", platformId: DEFAULT_PLATFORM, platformName: "Default", kind: "renewal",
    status: "open", issuedAt: "", dueAt: "", periodStart: null, periodEnd: null, totalCents: 100000, amountPaidCents: 0, amountDueCents: 100000,
    overdue: false, paidAt: null, currency: "KES", planKey: null, subtotalCents: 100000, taxRateBp: 0, taxCents: 0, voidedAt: null, statusReason: null,
    notes: null, lines: [], payments: [], seller: {} as never });
  const billing = new BillingService(billRepo, { daraja: () => new StubDarajaClient() });
  const api = await startTestApi({ startingBalanceCents: 1_000_000, depsOverrides: { verifyApprovalPassword: async (pw) => pw === PASSWORD, billing } });
  try {
    const s = await seed(api);
    billRepo.actorPlatform.set("pa-beta", s.betaPlatform);   // the attacker is a real platform admin — of ANOTHER platform
    const routes = createRouter(api.deps).listRoutes()
      .filter((r) => r.path.includes(":") && /^\/api\/v1\/(admin|platform|tickets|addons|support)\//.test(r.path));
    assert.ok(routes.length >= 70, `expected the full operator surface, got ${routes.length}`);

    const walletBefore = await json(await req(api, "GET", `/api/v1/admin/users/${s.userA}`, ADMIN_A));
    const breaches: string[] = [];
    let probes = 0;
    for (const r of routes) {
      const { url, body, seeded } = instantiate(r.path, s);
      for (const [who, tok] of [["site-admin(B)", ATTACKER_SITE], ["platform-admin(beta)", s.attackerPlat]] as const) {
        const res = await req(api, r.method, url, tok, r.method === "GET" ? undefined : body);
        probes++;
        if (res.status !== 403 && res.status !== 404) {
          const code = await res.json().then((j: any) => j?.error?.code ?? "").catch(() => "");
          breaches.push(`${who} ${r.method} ${r.path} -> ${res.status} ${code}${seeded ? "" : " (unseeded target)"}`);
        }
      }
    }
    assert.deepEqual(breaches, [], `cross-tenant probes not refused (${breaches.length}/${probes}):\n${breaches.join("\n")}`);

    // ── brand A's state is exactly as before ──
    const m = await json(await req(api, "GET", `/api/v1/admin/marketers/${s.marketerA}`, ADMIN_A));
    assert.equal(m.status, "active", "marketer status untouched");
    assert.equal(m.balance_cents, 50_000, "marketer balance untouched (no credit/withdraw)");
    assert.equal((await req(api, "POST", "/api/v1/marketers/auth/login", undefined, { phone: "0722900001", pin: "2468" })).status, 200,
      "marketer PIN untouched (no takeover)");
    const u = await json(await req(api, "GET", `/api/v1/admin/users/${s.userA}`, ADMIN_A));
    assert.equal(u.status, "active", "victim user status untouched");
    assert.equal(u.realBalanceCents ?? u.real_balance, walletBefore.realBalanceCents ?? walletBefore.real_balance, "victim wallet untouched");
    const notes = await json(await req(api, "GET", `/api/v1/admin/users/${s.userA}/notifications`, ADMIN_A));
    assert.ok(notes.items.some((n: any) => n.id === s.notifA && !n.resolvedAtMs && !n.resolved_at), "victim notification not cleared");
    assert.ok(!notes.items.some((n: any) => n.title === "pwned"), "no notification injected");
    const adv = await json(await req(api, "GET", "/api/v1/admin/affiliate/advances", ADMIN_A));
    assert.ok(adv.items.some((a: any) => a.id === s.advanceA && a.status === "requested"), "advance still pending");
  } finally { await api.close(); }
});

test("F-44: owner-only reads (audit trail, global M-Pesa config) refuse a site admin", async () => {
  const api = await startTestApi();
  try {
    for (const p of ["/api/v1/admin/audit", "/api/v1/admin/mpesa-config"]) {
      assert.equal((await req(api, "GET", p, ATTACKER_SITE)).status, 403, p);
      assert.equal((await req(api, "GET", p, OWNER)).status, 200, p);
    }
  } finally { await api.close(); }
});

test("F-44 regression guard: the SAME routes still work for the target's own brand admin", async () => {
  const api = await startTestApi({ startingBalanceCents: 1_000_000 });
  try {
    const s = await seed(api);
    assert.equal((await req(api, "GET", `/api/v1/admin/users/${s.userA}`, ADMIN_A)).status, 200);
    assert.equal((await req(api, "GET", `/api/v1/admin/users/${s.userA}/activity`, ADMIN_A)).status, 200);
    assert.equal((await req(api, "GET", `/api/v1/admin/users/${s.userA}/overrides`, ADMIN_A)).status, 200);
    assert.equal((await req(api, "GET", `/api/v1/admin/marketers/${s.marketerA}/statement`, ADMIN_A)).status, 200);
    assert.equal((await req(api, "PATCH", `/api/v1/admin/marketers/${s.marketerA}/fuliza`, ADMIN_A, { amountCents: 500 })).status, 200);
    assert.equal((await req(api, "POST", `/api/v1/admin/notifications/${s.notifA}/resolve`, ADMIN_A)).status, 200);
    const exp = await req(api, "POST", "/api/v1/admin/affiliate/expenses", ADMIN_A, { marketerUserId: s.affA, category: "fuel", amountCents: 1000 });
    assert.equal(exp.status, 200, "own-brand expense accepted");
    assert.equal((await req(api, "GET", `/api/v1/admin/affiliate/expenses?marketerUserId=${s.affA}`, ADMIN_A)).status, 200);
    // ... and the cross-brand expense routes (body/query-addressed, not in the :id matrix) are refused.
    assert.equal((await req(api, "POST", "/api/v1/admin/affiliate/expenses", ATTACKER_SITE, { marketerUserId: s.affA, category: "fuel", amountCents: 1000 })).status, 403);
    assert.equal((await req(api, "GET", `/api/v1/admin/affiliate/expenses?marketerUserId=${s.affA}`, ATTACKER_SITE)).status, 403);
    // The system owner is unrestricted.
    assert.equal((await req(api, "GET", `/api/v1/admin/marketers/${s.marketerA}`, OWNER)).status, 200);
  } finally { await api.close(); }
});
