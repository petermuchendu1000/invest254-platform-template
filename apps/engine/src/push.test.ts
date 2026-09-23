import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PushService,
  InMemoryPushSubscriptionRepository,
  mayReceiveWithdrawalAlert,
  type AlertRecipientProfile,
  type WebPushTransport,
  type PushSubscriptionRow,
  type PushSendResult,
} from "./push.js";

/** A capturing transport: records every send; endpoints containing "gone" simulate HTTP 410. */
function makeTransport() {
  const sends: Array<{ endpoint: string; payload: any }> = [];
  const transport: WebPushTransport = {
    publicKey: () => "VAPID_PUB",
    async send(sub: PushSubscriptionRow, payload: string): Promise<PushSendResult> {
      sends.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
      if (sub.endpoint.includes("gone")) return { ok: false, statusCode: 410, gone: true };
      if (sub.endpoint.includes("boom")) throw new Error("network");
      return { ok: true, statusCode: 201 };
    },
  };
  return { transport, sends };
}

const SITE_A = "00000000-0000-0000-0000-000000000001";
const SITE_B = "22222222-2222-2222-2222-222222222222";

function sub(endpoint: string, siteId: string | null, userId = "admin-1"): PushSubscriptionRow {
  return { userId, siteId, endpoint, p256dh: "p256", auth: "auth" };
}

const P1 = "10000000-0000-0000-0000-00000000000a", P2 = "10000000-0000-0000-0000-00000000000b";
const prof = (role: string, siteId: string | null, platformId: string | null = null, status = "active"): AlertRecipientProfile =>
  ({ role, status, siteId, platformId });
/** A repo whose subscribers have LIVE profiles (SITE_A on P1, SITE_B on P2). */
function repoWith(profiles: Record<string, AlertRecipientProfile>): InMemoryPushSubscriptionRepository {
  const r = new InMemoryPushSubscriptionRepository({ platformOfSite: (s) => (s === SITE_A ? P1 : s === SITE_B ? P2 : null) });
  for (const [u, p] of Object.entries(profiles)) r._setProfile(u, p);
  return r;
}

test("buildWithdrawalPayload carries amount, requester handle, actions and a highlight deep-link", async () => {
  const repo = new InMemoryPushSubscriptionRepository();
  const { transport } = makeTransport();
  const svc = new PushService(repo, transport, {
    resolveHandle: async () => "jane_doe",
    appBaseUrl: "https://admin.invest254.com/",
  });
  const p = await svc.buildWithdrawalPayload({ txId: "tx-42", userId: "u-9", amountCents: 500_000, phone: "254722000099", siteId: SITE_A });
  assert.equal(p.type, "withdrawal_requested");
  assert.equal(p.txId, "tx-42");
  assert.equal(p.amountCents, 500_000);
  assert.match(p.title, /KES 5,000/);
  assert.match(p.body, /jane_doe/);
  assert.match(p.body, /254722000099/);
  assert.deepEqual(p.actions.map((a) => a.action), ["approve", "reject"]);
  assert.deepEqual(p.actions.map((a) => a.title), ["Approve", "Reject"]);
  // deep-link has no double slash and highlights the exact tx
  assert.equal(p.url, "https://admin.invest254.com/admin/withdrawals?highlight=tx-42");
});

test("buildWithdrawalPayload falls back to a generic label when the handle resolver throws", async () => {
  const svc = new PushService(new InMemoryPushSubscriptionRepository(), makeTransport().transport, {
    resolveHandle: async () => { throw new Error("db down"); },
  });
  const p = await svc.buildWithdrawalPayload({ txId: "t", userId: "u", amountCents: 100_00, phone: "2547", siteId: undefined });
  assert.match(p.body, /A player requested/);
});

test("notifyWithdrawalRequested fans out to every matching admin device", async () => {
  const repo = repoWith({ "admin-a": prof("admin", SITE_A), "super-1": prof("platform_superadmin", SITE_A), "admin-b": prof("admin", SITE_B) });
  repo._seed(sub("https://push/site-a", SITE_A, "admin-a"));
  repo._seed(sub("https://push/platform", null, "super-1"));
  repo._seed(sub("https://push/site-b", SITE_B, "admin-b"));
  const { transport, sends } = makeTransport();
  const svc = new PushService(repo, transport);

  const res = await svc.notifyWithdrawalRequested({ txId: "tx1", userId: "p1", amountCents: 200_000, phone: "2547", siteId: SITE_A });
  // site-a admin + platform admin get it; site-b admin does NOT
  const endpoints = sends.map((s) => s.endpoint).sort();
  assert.deepEqual(endpoints, ["https://push/platform", "https://push/site-a"]);
  assert.equal(res.recipients, 2);
  assert.equal(res.sent, 2);
  assert.equal(res.failed, 0);
});

test("F-48: a withdrawal with no known brand alerts ONLY the system owner (was: every admin device)", async () => {
  const repo = repoWith({ "admin-a": prof("admin", SITE_A), "admin-b": prof("admin", SITE_B), owner: prof("platform_superadmin", SITE_A) });
  repo._seed(sub("https://push/a", SITE_A, "admin-a"));
  repo._seed(sub("https://push/b", SITE_B, "admin-b"));
  repo._seed(sub("https://push/p", null, "owner"));
  const { transport, sends } = makeTransport();
  const svc = new PushService(repo, transport);
  const res = await svc.notifyWithdrawalRequested({ txId: "t", userId: "p", amountCents: 100_000, phone: "2547", siteId: undefined });
  assert.equal(res.recipients, 1);
  assert.deepEqual(sends.map((x) => x.endpoint), ["https://push/p"]);
});

test("gone (404/410) subscriptions are pruned so the table self-heals", async () => {
  const repo = repoWith({ "admin-1": prof("platform_superadmin", SITE_A) });
  repo._seed(sub("https://push/live", null));
  repo._seed(sub("https://push/gone-1", null));
  const { transport } = makeTransport();
  const svc = new PushService(repo, transport);
  const res = await svc.notifyWithdrawalRequested({ txId: "t", userId: "p", amountCents: 100_000, phone: "2547", siteId: undefined });
  assert.equal(res.sent, 1);
  assert.equal(res.failed, 1);
  assert.equal(res.pruned, 1);
  const left = repo._all().map((r) => r.endpoint);
  assert.deepEqual(left, ["https://push/live"]);
});

test("a transport throw is isolated (fail-open) and never rejects", async () => {
  const repo = repoWith({ "admin-1": prof("platform_superadmin", SITE_A) });
  repo._seed(sub("https://push/live", null));
  repo._seed(sub("https://push/boom", null)); // transport throws for this one
  const svc = new PushService(repo, makeTransport().transport);
  const res = await svc.notifyWithdrawalRequested({ txId: "t", userId: "p", amountCents: 100_000, phone: "2547", siteId: undefined });
  assert.equal(res.sent, 1);
  assert.equal(res.failed, 1);
  // both rows survive: a transient network error must not prune a live subscription
  assert.equal(repo._all().length, 2);
});

test("no matching subscriptions is a no-op (not an error)", async () => {
  const svc = new PushService(new InMemoryPushSubscriptionRepository(), makeTransport().transport);
  const res = await svc.notifyWithdrawalRequested({ txId: "t", userId: "p", amountCents: 100_000, phone: "2547", siteId: SITE_A });
  assert.deepEqual(res, { sent: 0, failed: 0, pruned: 0, recipients: 0 });
});

test("a repo read failure fails open (returns zeros, never throws)", async () => {
  const brokenRepo = {
    async upsert() {},
    async removeByEndpoint() { return 0; },
    async removeForUser() { return 0; },
    async listForWithdrawalSite(): Promise<PushSubscriptionRow[]> { throw new Error("db down"); },
  };
  const svc = new PushService(brokenRepo, makeTransport().transport);
  const res = await svc.notifyWithdrawalRequested({ txId: "t", userId: "p", amountCents: 100_000, phone: "2547", siteId: SITE_A });
  assert.deepEqual(res, { sent: 0, failed: 0, pruned: 0, recipients: 0 });
});

test("upsert + owner-bound removeForUser round-trip through the service", async () => {
  const repo = new InMemoryPushSubscriptionRepository();
  const svc = new PushService(repo, makeTransport().transport);
  await svc.upsert(sub("https://push/x", null));
  await svc.upsert(sub("https://push/x", SITE_A)); // same endpoint -> update, not duplicate
  assert.equal(repo._all().length, 1);
  assert.equal(repo._all()[0]!.siteId, SITE_A);
  const removed = await svc.removeForUser("https://push/x", "admin-1");
  assert.equal(removed, 1);
  assert.equal(repo._all().length, 0);
});

// ── Issue 1 / F-48 ────────────────────────────────────────────────────────────────────────────
test("F-48: unsubscribe is owner-bound — another admin cannot silence this device", async () => {
  const repo = new InMemoryPushSubscriptionRepository();
  const svc = new PushService(repo, makeTransport().transport);
  await svc.upsert(sub("https://push/victim", SITE_A, "victim"));
  assert.equal(await svc.removeForUser("https://push/victim", "attacker"), 0, "someone else's endpoint is untouched");
  assert.equal(repo._all().length, 1);
  assert.equal(await svc.removeForUser("https://push/victim", "victim"), 1);
});

test("F-48: recipients follow the LIVE profile, never the brand stored at opt-in", async () => {
  const repo = repoWith({
    stale: prof("admin", SITE_B),                 // subscribed while on brand A, since moved to brand B
    claimless: prof("admin", SITE_B),             // subscribed with a claimless token (stored site null)
    demoted: prof("player", SITE_A),              // subscribed as admin of A, since demoted
    suspended: prof("admin", SITE_A, null, "suspended"),
    pa1: prof("platform_admin", SITE_B, P1),      // platform admin of P1 (home brand on another platform)
    pa2: prof("platform_admin", SITE_A, P2),      // platform admin of P2
    owner: prof("platform_superadmin", SITE_B),
    genuine: prof("admin", SITE_A),
  });
  repo._seed(sub("https://push/stale", SITE_A, "stale"));
  repo._seed(sub("https://push/claimless", null, "claimless"));
  repo._seed(sub("https://push/demoted", SITE_A, "demoted"));
  repo._seed(sub("https://push/suspended", SITE_A, "suspended"));
  repo._seed(sub("https://push/pa1", SITE_B, "pa1"));
  repo._seed(sub("https://push/pa2", null, "pa2"));
  repo._seed(sub("https://push/owner", SITE_B, "owner"));
  repo._seed(sub("https://push/genuine", SITE_A, "genuine"));
  repo._seed(sub("https://push/ghost", null, "no-profile"));
  const onA = (await repo.listForWithdrawalSite(SITE_A)).map((r) => r.endpoint).sort();
  assert.deepEqual(onA, ["https://push/genuine", "https://push/owner", "https://push/pa1"]);
  const onB = (await repo.listForWithdrawalSite(SITE_B)).map((r) => r.endpoint).sort();
  assert.deepEqual(onB, ["https://push/claimless", "https://push/owner", "https://push/pa2", "https://push/stale"]);
});

test("F-48: mayReceiveWithdrawalAlert truth table", () => {
  const A = SITE_A;
  assert.equal(mayReceiveWithdrawalAlert(null, A, P1), false, "unknown subscriber");
  assert.equal(mayReceiveWithdrawalAlert(prof("platform_superadmin", null), undefined, null), true, "owner, unknown brand");
  assert.equal(mayReceiveWithdrawalAlert(prof("platform_superadmin", null, null, "banned"), A, P1), false, "banned owner account");
  assert.equal(mayReceiveWithdrawalAlert(prof("admin", A), A, P1), true);
  assert.equal(mayReceiveWithdrawalAlert(prof("admin", A), undefined, null), false, "site admin, unknown brand");
  assert.equal(mayReceiveWithdrawalAlert(prof("admin", SITE_B), A, P1), false);
  assert.equal(mayReceiveWithdrawalAlert(prof("platform_admin", null, P1), A, P1), true);
  assert.equal(mayReceiveWithdrawalAlert(prof("platform_admin", null, P2), A, P1), false, "other platform");
  assert.equal(mayReceiveWithdrawalAlert(prof("platform_admin", null, null), A, null), false, "claimless platform admin");
  assert.equal(mayReceiveWithdrawalAlert(prof("platform_admin", null, P1), A, null), false, "brand with no platform");
  for (const r of ["player", "marketer", "superadmin", "user"]) assert.equal(mayReceiveWithdrawalAlert(prof(r, A, P1), A, P1), false, r);
});
