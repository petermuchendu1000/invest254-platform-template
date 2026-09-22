import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryIdentityRepository } from "./identity.js";
import { InMemoryPaymentRepository } from "./payments.js";
import { InMemoryAdminRepository } from "./admin.js";
import { AdminService } from "./adminservice.js";
import { AffiliateService } from "./affiliateservice.js";

const HASH = "scrypt$32768$8$1$abcdefghijklmnop$abcdefghijklmnop"; // length >= 20 (repo gate)

/** Build an in-memory admin stack with identity + payments + admin service. */
function stack() {
  const identity = new InMemoryIdentityRepository();
  const payRepo = new InMemoryPaymentRepository();
  const admin = new AdminService(new InMemoryAdminRepository(identity, payRepo));
  return { identity, payRepo, admin, affiliate: new AffiliateService(identity) };
}

test("overview: deterministic aggregates over users, finance, affiliate and game", async () => {
  const { identity, payRepo, admin, affiliate } = stack();
  const adminId = (await identity.register("254700000001", "ops", HASH)).userId; identity.adminSetRole(adminId, "admin");
  const superId = (await identity.register("254700000002", "root", HASH)).userId; identity.adminSetRole(superId, "platform_superadmin");
  const p1 = (await identity.register("254700000003", "p_one", HASH)).userId;
  await identity.register("254700000004", "p_two", HASH);
  const mk = (await identity.register("254700000005", "mk_one", HASH)).userId;
  const code = (await affiliate.enroll(mk)).referralCode;
  const ref = (await identity.register("254700000006", "ref_one", HASH, code)).userId;

  // finance: one settled deposit (+100000) and one pending withdrawal (holds 30000) for p1.
  payRepo.seed(p1, 50_000);
  const dep = await payRepo.createDeposit(p1, 100_000, "254700000003");
  await payRepo.attachStk(dep, "m1", "chk1");
  await payRepo.completeDeposit("chk1", 0, "ok", "RCPT1", {});
  await payRepo.createWithdrawal(p1, 30_000, "254700000003", 1_000); // balance -> 120000, pending wd

  // game: two settled plays for the referred player; accrue affiliate commission.
  identity.recordSettledPlay(ref, "2026-06-10", 10_000, 2_500);
  identity.recordSettledPlay(ref, "2026-06-10", 5_000, 0);
  await affiliate.accrueDaily("2026-06-10"); // floor(0.2 * 12500) = 2500 accrued

  const ov = await admin.overview();
  assert.deepEqual(ov.users, { total: 6, active: 6, suspended: 0, banned: 0, players: 3, marketers: 1, admins: 2 });
  assert.equal(ov.finance.depositsCents, 100_000);
  assert.equal(ov.finance.withdrawalsCents, 0);
  assert.equal(ov.finance.pendingWithdrawals, 1);
  assert.equal(ov.finance.walletLiabilityCents, 120_000);
  assert.equal(ov.affiliate.marketers, 1);
  assert.equal(ov.affiliate.commissionAccruedCents, 2_500);
  assert.equal(ov.affiliate.commissionPaidCents, 0);
  assert.equal(ov.affiliate.pendingPayouts, 0);
  assert.deepEqual(ov.game, { settledPositions: 2, turnoverCents: 15_000, ggrCents: 12_500 });
});

test("listUsers: filters by role, status and search; getUserDetail returns balance + turnover", async () => {
  const { identity, payRepo, admin } = stack();
  const p1 = (await identity.register("254700000010", "alpha", HASH)).userId;
  await identity.register("254700000011", "beta", HASH);
  const adminId = (await identity.register("254700000012", "gamma", HASH)).userId; identity.adminSetRole(adminId, "admin");
  payRepo.seed(p1, 77_000);
  identity.recordSettledPlay(p1, "2026-06-10", 9_000, 1_000);

  assert.equal((await admin.listUsers({ role: "admin" })).items.length, 1);
  assert.equal((await admin.listUsers({ role: "player" })).items.length, 2);
  const search = await admin.listUsers({ q: "alph" });
  assert.equal(search.items.length, 1);
  assert.equal(search.items[0]!.username, "alpha");

  const detail = await admin.getUserDetail(p1);
  assert.equal(detail.username, "alpha");
  assert.equal(detail.realBalanceCents, 77_000);
  assert.equal(detail.turnoverCents, 9_000);
  assert.equal(detail.ggrCents, 8_000);
  await assert.rejects(admin.getUserDetail("00000000-0000-0000-0000-000000000000"), /USER_NOT_FOUND/);
});

test("setUserStatus: hierarchy guards, self-action, validation, and audit", async () => {
  const { identity, admin } = stack();
  const player = (await identity.register("254700000020", "victim", HASH)).userId;
  const staff = (await identity.register("254700000021", "staff", HASH)).userId; identity.adminSetRole(staff, "admin");
  const actor = "11111111-1111-1111-1111-111111111111";

  // admin suspends a player -> ok + audited + status flips
  const r = await admin.setUserStatus(actor, "admin", player, "suspended", "abuse");
  assert.deepEqual(r, { userId: player, status: "suspended" });
  assert.equal(identity.adminUser(player)!.status, "suspended");

  await assert.rejects(admin.setUserStatus("99", "player", player, "active", null), /NOT_AUTHORIZED/);
  await assert.rejects(admin.setUserStatus(actor, "admin", player, "nope", null), /INVALID_STATUS/);
  await assert.rejects(admin.setUserStatus(actor, "admin", actor, "banned", null), /NO_SELF_ACTION/);
  await assert.rejects(admin.setUserStatus(actor, "admin", staff, "suspended", null), /INSUFFICIENT_PRIVILEGE/);
  // a superadmin may act on an admin
  assert.equal((await admin.setUserStatus("super", "platform_superadmin", staff, "suspended", null)).status, "suspended");

  const audit = await admin.listAudit({});
  assert.equal(audit.items.length, 2); // the two successful mutations, newest first
  assert.equal(audit.items[0]!.action, "user.status");
  assert.equal(audit.items[0]!.targetId, staff);
  assert.equal(audit.items[1]!.targetId, player);
});

test("setCommissionRate: sets rate, rejects non-affiliate and out-of-range", async () => {
  const { identity, admin, affiliate } = stack();
  const mk = (await identity.register("254700000030", "mk_rate", HASH)).userId;
  await affiliate.enroll(mk);
  const plain = (await identity.register("254700000031", "plain", HASH)).userId;

  const r = await admin.setCommissionRate("actor", "admin", mk, 0.35);
  assert.deepEqual(r, { userId: mk, commissionRate: 0.35 });
  assert.equal(identity.adminAffiliate(mk)!.commissionRate, 0.35);
  await assert.rejects(admin.setCommissionRate("actor", "admin", plain, 0.4), /NOT_AFFILIATE/);
  await assert.rejects(admin.setCommissionRate("actor", "admin", mk, 1.5), /INVALID_RATE/);
  await assert.rejects(admin.setCommissionRate("actor", "player", mk, 0.4), /NOT_AUTHORIZED/);
});

test("listWithdrawals: lists withdrawal transactions, filterable by status", async () => {
  const { identity, payRepo, admin } = stack();
  const p1 = (await identity.register("254700000040", "wd_user", HASH)).userId;
  payRepo.seed(p1, 200_000);
  await payRepo.createWithdrawal(p1, 30_000, "254700000040", 1_000);
  await payRepo.createWithdrawal(p1, 20_000, "254700000040", 1_000);

  const all = await admin.listWithdrawals({});
  assert.equal(all.items.length, 2);
  assert.ok(all.items.every((w) => w.status === "pending"));
  assert.equal((await admin.listWithdrawals({ status: "success" })).items.length, 0);
});

test("adjustBalance: credit/debit with mandatory reason, guards, overdraw and audit (J3)", async () => {
  const { identity, payRepo, admin } = stack();
  const p = (await identity.register("254700000050", "adj_user", HASH)).userId;
  payRepo.seed(p, 10_000);

  const credit = await admin.adjustBalance("actor", "admin", p, 5_000, "goodwill");
  assert.deepEqual(credit, { userId: p, amountCents: 5_000, newBalanceCents: 15_000, direction: "credit" });
  assert.equal(await payRepo.getBalance(p), 15_000);

  const debit = await admin.adjustBalance("actor", "platform_superadmin", p, -3_000, "correction");
  assert.deepEqual(debit, { userId: p, amountCents: -3_000, newBalanceCents: 12_000, direction: "debit" });

  await assert.rejects(admin.adjustBalance("actor", "admin", p, -1_000_000, "too much"), /INSUFFICIENT_FUNDS/);
  await assert.rejects(admin.adjustBalance("actor", "admin", p, 1_000, "   "), /REASON_REQUIRED/);
  await assert.rejects(admin.adjustBalance("actor", "admin", p, 0, "noop"), /INVALID_AMOUNT/);
  await assert.rejects(admin.adjustBalance("actor", "player", p, 1_000, "x"), /NOT_AUTHORIZED/);
  await assert.rejects(admin.adjustBalance("actor", "admin", "00000000-0000-0000-0000-000000000000", 1_000, "x"), /USER_NOT_FOUND/);

  const audit = await admin.listAudit({});
  assert.equal(audit.items.length, 2); // only the two successful mutations, newest first
  assert.equal(audit.items[0]!.action, "balance.adjust");
  assert.deepEqual(audit.items[0]!.detail as Record<string, unknown>, { amount: -3_000, reason: "correction", before: 15_000, after: 12_000 });
});

test("deposits monitor: lists deposits (with STK fields) and reconcile flags stale non-terminal pushes (J3)", async () => {
  const identity = new InMemoryIdentityRepository();
  const oldTime = Date.UTC(2020, 0, 1); // timestamps deposits in the distant past => stale vs any window
  const payRepo = new InMemoryPaymentRepository(() => oldTime);
  const admin = new AdminService(new InMemoryAdminRepository(identity, payRepo));
  const p = (await identity.register("254700000060", "dep_user", HASH)).userId;
  payRepo.seed(p, 0);

  const ok = await payRepo.createDeposit(p, 100_000, "254700000060");
  await payRepo.attachStk(ok, "m1", "chk-ok");
  await payRepo.completeDeposit("chk-ok", 0, "ok", "RCPT9", {}); // -> success, receipt set
  const stuck = await payRepo.createDeposit(p, 50_000, "254700000060");
  await payRepo.attachStk(stuck, "m2", "chk-stuck"); // -> processing
  await payRepo.createDeposit(p, 20_000, "254700000060"); // -> pending

  const list = await admin.listDeposits({});
  assert.equal(list.items.length, 3);
  const success = list.items.find((d) => d.status === "success")!;
  assert.equal(success.mpesaReceipt, "RCPT9");
  assert.equal(success.checkoutRequestId, "chk-ok");
  assert.equal((await admin.listDeposits({ status: "processing" })).items.length, 1);

  const rec = await admin.depositsReconcile(15);
  assert.equal(rec.staleMinutes, 15);
  assert.deepEqual(rec.summary, [
    { status: "pending", count: 1, amountCents: 20_000 },
    { status: "processing", count: 1, amountCents: 50_000 },
    { status: "success", count: 1, amountCents: 100_000 },
  ]);
  assert.equal(rec.stale.length, 2); // pending + processing only; success is terminal
  assert.ok(rec.stale.every((d) => d.status === "pending" || d.status === "processing"));
});

test("reports: per-day & per-user finance with date-range filtering (J4)", async () => {
  const identity = new InMemoryIdentityRepository();
  let clockMs = Date.UTC(2026, 5, 10, 9, 0, 0); // mutable clock -> deterministic transaction dates
  const payRepo = new InMemoryPaymentRepository(() => clockMs);
  const admin = new AdminService(new InMemoryAdminRepository(identity, payRepo));

  const a = (await identity.register("254700000070", "alice", HASH)).userId;
  const b = (await identity.register("254700000071", "bob", HASH)).userId;
  payRepo.seed(a, 0);
  payRepo.seed(b, 0);

  const deposit = async (uid: string, cents: number, chk: string): Promise<void> => {
    const id = await payRepo.createDeposit(uid, cents, "254700000000");
    await payRepo.attachStk(id, "m", chk);
    await payRepo.completeDeposit(chk, 0, "ok", "RCPT", {});
  };
  const withdraw = async (uid: string, cents: number): Promise<void> => {
    const { txId } = await payRepo.createWithdrawal(uid, cents, "254700000000", 1);
    await payRepo.approveWithdrawal(txId, "ops");
    await payRepo.completeWithdrawal(txId, 0, null, "RCPT", {});
  };

  // Day 2026-06-10: alice deposits 100000 then withdraws 40000; two settled plays.
  clockMs = Date.UTC(2026, 5, 10, 9, 0, 0);
  await deposit(a, 100_000, "c1");
  await withdraw(a, 40_000);
  identity.recordSettledPlay(a, "2026-06-10", 10_000, 3_000); // turnover 10000, ggr 7000
  identity.recordSettledPlay(b, "2026-06-10", 5_000, 5_000);  // turnover 5000,  ggr 0

  // Day 2026-06-11: bob deposits 60000; one settled play for alice.
  clockMs = Date.UTC(2026, 5, 11, 9, 0, 0);
  await deposit(b, 60_000, "c2");
  identity.recordSettledPlay(a, "2026-06-11", 2_000, 0);      // turnover 2000, ggr 2000

  const daily = await admin.reportDaily({});
  assert.equal(daily.length, 2);
  assert.deepEqual(daily[0], { date: "2026-06-10", depositsCents: 100_000, withdrawalsCents: 40_000, turnoverCents: 15_000, ggrCents: 7_000 });
  assert.deepEqual(daily[1], { date: "2026-06-11", depositsCents: 60_000, withdrawalsCents: 0, turnoverCents: 2_000, ggrCents: 2_000 });

  // Inclusive range bound keeps only the later day.
  const d11 = await admin.reportDaily({ from: "2026-06-11" });
  assert.deepEqual(d11.map((r) => r.date), ["2026-06-11"]);

  // Per-user ordered by GGR desc: alice (9000) before bob (0).
  const byUser = await admin.reportByUser({});
  assert.equal(byUser.length, 2);
  assert.equal(byUser[0]!.username, "alice");
  assert.deepEqual(byUser[0], { userId: a, username: "alice", depositsCents: 100_000, withdrawalsCents: 40_000, turnoverCents: 12_000, ggrCents: 9_000 });
  assert.equal(byUser[1]!.username, "bob");
  assert.deepEqual(byUser[1], { userId: b, username: "bob", depositsCents: 60_000, withdrawalsCents: 0, turnoverCents: 5_000, ggrCents: 0 });
});

test("listUsers: enriched with wallet balance, lifetime cash flow, bets and last transaction", async () => {
  const { identity, payRepo, admin } = stack();
  const p = (await identity.register("254700000070", "rich_user", HASH)).userId;
  payRepo.seed(p, 0);

  // one SUCCESS deposit (+100000) and one still-PENDING deposit (20000, not counted in lifetime)
  const dep = await payRepo.createDeposit(p, 100_000, "254700000070");
  await payRepo.attachStk(dep, "m1", "chk-a");
  await payRepo.completeDeposit("chk-a", 0, "ok", "RCPT-A", {});
  await payRepo.createDeposit(p, 20_000, "254700000070"); // pending -> excluded from depositsCents

  // one SUCCESS withdrawal (-40000) fully settled
  const wd = await payRepo.createWithdrawal(p, 40_000, "254700000070", 1_000);
  await payRepo.approveWithdrawal(wd.txId, "actor");
  await payRepo.completeWithdrawal(wd.txId, 0, null, "WD-RCPT", {});

  // two settled bets -> turnover 15000, ggr = 15000 - 9000 = 6000
  identity.recordSettledPlay(p, "2026-06-10", 10_000, 6_000);
  identity.recordSettledPlay(p, "2026-06-10", 5_000, 3_000);

  const page = await admin.listUsers({ q: "rich_user" });
  assert.equal(page.items.length, 1);
  const row = page.items[0]!;
  assert.equal(row.username, "rich_user");
  assert.equal(row.realBalanceCents, 60_000); // 100000 dep - 40000 wd
  assert.equal(row.depositsCents, 100_000); // success only
  assert.equal(row.withdrawalsCents, 40_000); // success only
  assert.equal(row.netDepositsCents, 60_000); // deposits - withdrawals
  assert.equal(row.turnoverCents, 15_000);
  assert.equal(row.ggrCents, 6_000);
  assert.equal(row.betCount, 2);
  assert.ok(row.lastTxAtMs !== null, "lastTxAtMs populated");
  assert.ok(row.lastTxKind === "deposit" || row.lastTxKind === "withdrawal", "lastTxKind set");
  assert.ok(row.lastTxAmountCents !== null, "lastTxAmountCents set");
  assert.ok(row.lastActiveAtMs !== null, "lastActiveAtMs set");

  // getUserDetail returns the same enriched shape + referredBy
  const detail = await admin.getUserDetail(p);
  assert.equal(detail.depositsCents, 100_000);
  assert.equal(detail.withdrawalsCents, 40_000);
  assert.equal(detail.betCount, 2);
  assert.equal(detail.referredBy, null);
});

test("listTransactions: unified deposits+withdrawals with username, filters, search and pagination", async () => {
  const { identity, payRepo, admin } = stack();
  const a = (await identity.register("254700000080", "tx_alice", HASH)).userId;
  const b = (await identity.register("254700000081", "tx_bob", HASH)).userId;
  payRepo.seed(a, 500_000);
  payRepo.seed(b, 500_000);

  // alice: 2 deposits (one success, one pending), 1 withdrawal
  const da = await payRepo.createDeposit(a, 100_000, "254700000080");
  await payRepo.attachStk(da, "m1", "chk-a1");
  await payRepo.completeDeposit("chk-a1", 0, "ok", "RCPT-A1", {});
  await payRepo.createDeposit(a, 30_000, "254700000080"); // pending
  await payRepo.createWithdrawal(a, 20_000, "254700000080", 1_000); // pending withdrawal
  // bob: 1 deposit
  await payRepo.createDeposit(b, 50_000, "254700000081"); // pending

  // unified feed: all 4 transactions, newest-first, username populated
  const all = await admin.listTransactions({});
  assert.equal(all.items.length, 4);
  assert.ok(all.items.every((t) => t.username === "tx_alice" || t.username === "tx_bob"), "usernames joined");
  assert.ok(all.items.every((t) => t.kind === "deposit" || t.kind === "withdrawal"), "kinds valid");
  // newest-first ordering by createdAtMs
  for (let i = 1; i < all.items.length; i++) {
    assert.ok(all.items[i - 1]!.createdAtMs >= all.items[i]!.createdAtMs, "descending by time");
  }

  // filter by kind
  const deps = await admin.listTransactions({ kind: "deposit" });
  assert.equal(deps.items.length, 3);
  assert.ok(deps.items.every((t) => t.kind === "deposit"));
  const wds = await admin.listTransactions({ kind: "withdrawal" });
  assert.equal(wds.items.length, 1);
  assert.equal(wds.items[0]!.kind, "withdrawal");

  // filter by status (only the one success deposit)
  const success = await admin.listTransactions({ status: "success" });
  assert.equal(success.items.length, 1);
  assert.equal(success.items[0]!.status, "success");
  assert.equal(success.items[0]!.mpesaReceipt, "RCPT-A1");

  // search by username substring
  const bobOnly = await admin.listTransactions({ q: "bob" });
  assert.equal(bobOnly.items.length, 1);
  assert.equal(bobOnly.items[0]!.username, "tx_bob");

  // keyset pagination: page of 2 then the rest, no overlap
  const p1 = await admin.listTransactions({ limit: 2 });
  assert.equal(p1.items.length, 2);
  assert.ok(p1.nextCursor, "has nextCursor");
  const p2 = await admin.listTransactions({ limit: 2, cursor: p1.nextCursor! });
  const ids1 = new Set(p1.items.map((t) => t.txId));
  assert.ok(p2.items.every((t) => !ids1.has(t.txId)), "no overlap across pages");
});

test("listUsers: numeric threshold filters (balance range, deposits, bets)", async () => {
  const { identity, payRepo, admin } = stack();
  const A = (await identity.register("254700000090", "whale", HASH)).userId;
  const B = (await identity.register("254700000091", "minnow", HASH)).userId;
  const C = (await identity.register("254700000092", "lurker", HASH)).userId;

  // A: 100000 deposit (success) + 3 settled bets
  payRepo.seed(A, 0);
  const da = await payRepo.createDeposit(A, 100_000, "254700000090");
  await payRepo.attachStk(da, "m1", "chk-A"); await payRepo.completeDeposit("chk-A", 0, "ok", "R-A", {});
  identity.recordSettledPlay(A, "2026-06-10", 5_000, 0);
  identity.recordSettledPlay(A, "2026-06-10", 5_000, 0);
  identity.recordSettledPlay(A, "2026-06-10", 5_000, 0);
  // B: 5000 deposit (success), 0 bets
  payRepo.seed(B, 0);
  const db = await payRepo.createDeposit(B, 5_000, "254700000091");
  await payRepo.attachStk(db, "m2", "chk-B"); await payRepo.completeDeposit("chk-B", 0, "ok", "R-B", {});
  // C: nothing (balance 0, no deposits, no bets)
  payRepo.seed(C, 0);

  const names = async (q: Parameters<typeof admin.listUsers>[0]) =>
    (await admin.listUsers(q)).items.map((x) => x.username).sort();

  assert.deepEqual(await names({ minBalanceCents: 10_000 }), ["whale"]);
  assert.deepEqual(await names({ maxBalanceCents: 6_000 }), ["lurker", "minnow"]);
  assert.deepEqual(await names({ minDepositsCents: 1 }), ["minnow", "whale"]);
  assert.deepEqual(await names({ minBets: 1 }), ["whale"]);
  assert.deepEqual(await names({ minBets: 5 }), []);
  // combined: depositors with a balance over 10k → only the whale
  assert.deepEqual(await names({ minDepositsCents: 1, minBalanceCents: 10_000 }), ["whale"]);
  // balance range window [4000, 6000] → only the minnow
  assert.deepEqual(await names({ minBalanceCents: 4_000, maxBalanceCents: 6_000 }), ["minnow"]);
});

test("resetBalanceToLastFunded: restores the real wallet to the most recent successful deposit", async () => {
  const identity = new InMemoryIdentityRepository();
  let now = 1_000_000;
  const payRepo = new InMemoryPaymentRepository(() => now);
  const admin = new AdminService(new InMemoryAdminRepository(identity, payRepo));
  const uid = (await identity.register("254700000200", "reset_user", HASH)).userId;
  payRepo.seed(uid, 0);

  // Two successful deposits at distinct times: 100k then 50k (50k is the "last funded").
  const d1 = await payRepo.createDeposit(uid, 100_000, "254700000200");
  await payRepo.attachStk(d1, "m1", "chk-r1"); await payRepo.completeDeposit("chk-r1", 0, "ok", "R1", {});
  now += 5_000;
  const d2 = await payRepo.createDeposit(uid, 50_000, "254700000200");
  await payRepo.attachStk(d2, "m2", "chk-r2"); await payRepo.completeDeposit("chk-r2", 0, "ok", "R2", {});
  assert.equal(await payRepo.getBalance(uid), 150_000);

  // Simulate a system issue corrupting the balance, then reset to last funded.
  payRepo.adminApplyAdjustment(uid, 900_000); // balance now 1,050,000
  const res = await admin.resetBalanceToLastFunded("actor", "admin", uid, "settlement bug correction");
  assert.equal(res.lastFundedCents, 50_000);
  assert.equal(res.previousBalanceCents, 1_050_000);
  assert.equal(res.newBalanceCents, 50_000);
  assert.equal(await payRepo.getBalance(uid), 50_000);

  // detail/list expose the last funded amount so the UI can preview the reset target.
  const detail = await admin.getUserDetail(uid);
  assert.equal(detail.lastFundedCents, 50_000);

  // audit trail records the reset.
  const audit = await admin.listAudit({});
  assert.ok(audit.items.some((a) => a.action === "balance.reset_last_funded" && a.targetId === uid));
});

test("resetBalanceToLastFunded: guards (no funding, reason, role, superadmin)", async () => {
  const { identity, payRepo, admin } = stack();
  const nofund = (await identity.register("254700000210", "nofund", HASH)).userId;
  payRepo.seed(nofund, 5_000);
  await assert.rejects(admin.resetBalanceToLastFunded("actor", "admin", nofund, "x"), /NO_FUNDING/);

  const u = (await identity.register("254700000211", "hasfund", HASH)).userId;
  payRepo.seed(u, 0);
  const d = await payRepo.createDeposit(u, 20_000, "254700000211");
  await payRepo.attachStk(d, "m", "chk-g"); await payRepo.completeDeposit("chk-g", 0, "ok", "RG", {});
  await assert.rejects(admin.resetBalanceToLastFunded("actor", "admin", u, "   "), /REASON_REQUIRED/);
  await assert.rejects(admin.resetBalanceToLastFunded("actor", "player", u, "x"), /NOT_AUTHORIZED/);

  const sup = (await identity.register("254700000212", "root2", HASH)).userId; identity.adminSetRole(sup, "platform_superadmin");
  await assert.rejects(admin.resetBalanceToLastFunded("actor", "admin", sup, "x"), /SUPERADMIN_PROTECTED/);
});
