import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PushService,
  InMemoryPushSubscriptionRepository,
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
  const repo = new InMemoryPushSubscriptionRepository();
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

test("undefined siteId (single-tenant/unknown brand) alerts every admin device", async () => {
  const repo = new InMemoryPushSubscriptionRepository();
  repo._seed(sub("https://push/a", SITE_A));
  repo._seed(sub("https://push/b", SITE_B));
  repo._seed(sub("https://push/p", null));
  const { transport, sends } = makeTransport();
  const svc = new PushService(repo, transport);
  const res = await svc.notifyWithdrawalRequested({ txId: "t", userId: "p", amountCents: 100_000, phone: "2547", siteId: undefined });
  assert.equal(res.recipients, 3);
  assert.equal(sends.length, 3);
});

test("gone (404/410) subscriptions are pruned so the table self-heals", async () => {
  const repo = new InMemoryPushSubscriptionRepository();
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
  const repo = new InMemoryPushSubscriptionRepository();
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
    async listForWithdrawalSite(): Promise<PushSubscriptionRow[]> { throw new Error("db down"); },
  };
  const svc = new PushService(brokenRepo, makeTransport().transport);
  const res = await svc.notifyWithdrawalRequested({ txId: "t", userId: "p", amountCents: 100_000, phone: "2547", siteId: SITE_A });
  assert.deepEqual(res, { sent: 0, failed: 0, pruned: 0, recipients: 0 });
});

test("upsert + removeByEndpoint round-trip through the service", async () => {
  const repo = new InMemoryPushSubscriptionRepository();
  const svc = new PushService(repo, makeTransport().transport);
  await svc.upsert(sub("https://push/x", null));
  await svc.upsert(sub("https://push/x", SITE_A)); // same endpoint -> update, not duplicate
  assert.equal(repo._all().length, 1);
  assert.equal(repo._all()[0]!.siteId, SITE_A);
  const removed = await svc.removeByEndpoint("https://push/x");
  assert.equal(removed, 1);
  assert.equal(repo._all().length, 0);
});
