import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPayoutAlert, buildPayoutText, buildDecisionText, buildTopicRecord,
  buildApprovalPrompt, parseApprovalToken, parseCallback,
  CB_W_APPROVE, CB_W_REJECT, CB_C_APPROVE, CB_C_REJECT, type PayoutAlert,
} from "./telegram.js";
import { processTelegramUpdate, type TelegramUpdateDeps } from "./app.telegram.js";

const UUID = "af1caaa2-a1f7-4484-b1ec-24ab5cd02d54";
const CUUID = "bb2dddd3-b2b8-4595-c2fd-35bc6de13e65";

const wAlert = (): PayoutAlert => ({
  kind: "withdrawal", reference: UUID, who: "jane", userType: "Player",
  client: "Invest254", amountCents: 500_00, phone: "254722000099", requestedAtMs: 1_700_000_000_000,
});
const cAlert = (): PayoutAlert => ({
  kind: "commission", reference: CUUID, who: "marktop", userType: "Marketer",
  client: "Tamu Traders", amountCents: 1_250_00, phone: "254711223344", requestedAtMs: 1_700_000_000_000,
});

// ── Pure builders ────────────────────────────────────────────────────────────────────────────
test("alert: withdrawal card is thorough, emoji-free, with two correctly-prefixed buttons ≤64B", () => {
  const a = buildPayoutAlert(wAlert());
  assert.match(a.text, /WITHDRAWAL REQUEST — AWAITING APPROVAL/);
  assert.match(a.text, /KES 500/);
  assert.match(a.text, /Client:<\/b> Invest254/);
  assert.match(a.text, /Requested by:<\/b> jane \(Player\)/);
  assert.match(a.text, /To M-Pesa:<\/b> 254722000099/);
  assert.match(a.text, /Reference:/);
  // No emojis / pictographs anywhere.
  assert.ok(!/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u2705\u274C\u270B\u{1F4B8}]/u.test(a.text), "must contain no emoji");
  const kb = (a.reply_markup as any).inline_keyboard[0];
  assert.equal(kb.length, 2);
  assert.equal(kb[0].text, "Approve");
  assert.equal(kb[1].text, "Reject");
  assert.ok(kb[0].callback_data.startsWith(CB_W_APPROVE) && kb[1].callback_data.startsWith(CB_W_REJECT));
  for (const b of kb) assert.ok(Buffer.byteLength(b.callback_data, "utf8") <= 64, "callback_data ≤64 bytes");
});

test("alert: commission card uses commission callbacks + marketer labelling", () => {
  const a = buildPayoutAlert(cAlert());
  assert.match(a.text, /COMMISSION PAYOUT — AWAITING APPROVAL/);
  assert.match(a.text, /Requested by:<\/b> marktop \(Marketer\)/);
  assert.match(a.text, /Marketer M-Pesa:<\/b> 254711223344/);
  const kb = (a.reply_markup as any).inline_keyboard[0];
  assert.ok(kb[0].callback_data.startsWith(CB_C_APPROVE) && kb[1].callback_data.startsWith(CB_C_REJECT));
});

test("alert: HTML-escapes dynamic fields (defends against injection in username/client)", () => {
  const a = buildPayoutText({ ...wAlert(), who: "<b>x</b>&", client: "A<C" });
  assert.match(a, /&lt;b&gt;x&lt;\/b&gt;&amp;/);
  assert.match(a, /A&lt;C/);
});

test("decision + topic text render actor and outcome", () => {
  const d = buildDecisionText(wAlert(), "approved", "zrinok", 1_700_000_000_000);
  assert.match(d, /WITHDRAWAL REQUEST — APPROVED/);
  assert.match(d, /Approved by zrinok/);
  const t = buildTopicRecord(cAlert(), "rejected", "zrinok", 1_700_000_000_000);
  assert.match(t, /Commission REJECTED/);
});

test("callback parsing: all four prefixes + junk", () => {
  assert.deepEqual(parseCallback(`${CB_W_APPROVE}${UUID}`), { kind: "withdrawal", action: "approve", id: UUID });
  assert.deepEqual(parseCallback(`${CB_W_REJECT}${UUID}`), { kind: "withdrawal", action: "reject", id: UUID });
  assert.deepEqual(parseCallback(`${CB_C_APPROVE}${CUUID}`), { kind: "commission", action: "approve", id: CUUID });
  assert.deepEqual(parseCallback(`${CB_C_REJECT}${CUUID}`), { kind: "commission", action: "reject", id: CUUID });
  assert.equal(parseCallback("xx:tx"), null);
  assert.equal(parseCallback(""), null);
});

test("approval token: round-trips kind/origMsgId/reference and rejects junk", () => {
  const p = buildApprovalPrompt(wAlert(), 42);
  assert.deepEqual(parseApprovalToken(p), { kind: "withdrawal", origMsgId: 42, reference: UUID });
  const pc = buildApprovalPrompt(cAlert(), 7);
  assert.deepEqual(parseApprovalToken(pc), { kind: "commission", origMsgId: 7, reference: CUUID });
  assert.equal(parseApprovalToken("just some text with no token"), null);
});

// ── Webhook flows ──────────────────────────────────────────────────────────────────────────────
function fake() {
  const calls = {
    alerts: [] as any[], forceReplies: [] as any[], answers: [] as any[],
    edits: [] as any[], messages: [] as any[], deletes: [] as any[],
    approvedW: [] as any[], rejectedW: [] as any[], approvedC: [] as any[], rejectedC: [] as any[],
    verifies: [] as string[],
  };
  const telegram = {
    async sendPayoutAlert(chatId: string, a: any, t?: number) { calls.alerts.push({ chatId, a, t }); return { ok: true, messageId: 100 }; },
    async sendForceReply(chatId: string, text: string) { calls.forceReplies.push({ chatId, text }); return { ok: true, messageId: 200 }; },
    async sendMessage(chatId: string, text: string, t?: number) { calls.messages.push({ chatId, text, t }); return { ok: true, messageId: 300 }; },
    async answerCallback(id: string, text: string) { calls.answers.push({ id, text }); },
    async editMessageText(chatId: string, mid: number, text: string) { calls.edits.push({ chatId, mid, text }); },
    async deleteMessage(chatId: string, mid: number) { calls.deletes.push({ chatId, mid }); },
    async setWebhook() { return { ok: true }; },
  };
  const deps: TelegramUpdateDeps = {
    telegram: telegram as any,
    telegramChatIds: ["123"],
    payments: {
      async approveWithdrawal(tx: string) { calls.approvedW.push(tx); return { approved: tx === UUID }; },
      async rejectWithdrawal(tx: string) { calls.rejectedW.push(tx); return { reversed: tx === UUID, newBalance: 0 }; },
    } as any,
    commission: {
      async approve(id: string) { calls.approvedC.push(id); return { approved: id === CUUID }; },
      async reject(id: string) { calls.rejectedC.push(id); return { rejected: id === CUUID }; },
    },
    describe: async (kind, id) => (kind === "withdrawal" && id === UUID) ? wAlert() : (kind === "commission" && id === CUUID) ? cAlert() : null,
    verifyApprovalPassword: async (pw) => { calls.verifies.push(pw); return pw === "correct-horse"; },
    resolveActor: async () => "admin-uuid",
    resolveActorName: async () => "zrinok",
    forumChatId: "-100999",
    topics: { approved: 11, rejected: 22 },
  };
  return { deps, calls };
}

const cbApprove = (data: string, chatId = 123, fromId = 123) => ({
  callback_query: { id: "cb1", data, from: { id: fromId }, message: { chat: { id: chatId }, message_id: 5, text: "card" } },
});
const replyWith = (pw: string, promptText: string, chatId = 123, fromId = 123) => ({
  message: { message_id: 6, chat: { id: chatId }, from: { id: fromId }, text: pw, reply_to_message: { message_id: 200, text: promptText } },
});

test("webhook: tapping Approve does NOT execute — it opens a password prompt", async () => {
  const { deps, calls } = fake();
  const r = await processTelegramUpdate(cbApprove(`${CB_W_APPROVE}${UUID}`), deps);
  assert.equal(r.handled, "callback_withdrawal_approve_prompt");
  assert.equal(calls.approvedW.length, 0, "must not approve on tap");
  assert.equal(calls.forceReplies.length, 1);
  assert.match(calls.forceReplies[0].text, /Authorization reference/);
  assert.match(calls.answers[0].text, /password/i);
});

test("webhook: correct password reply approves, deletes password + prompt, edits card, posts topic", async () => {
  const { deps, calls } = fake();
  const prompt = buildApprovalPrompt(wAlert(), 5);
  const r = await processTelegramUpdate(replyWith("correct-horse", prompt), deps);
  assert.equal(r.handled, "reply_withdrawal_approve_done");
  assert.deepEqual(calls.approvedW, [UUID]);
  // password message (6) and prompt message (200) both deleted
  assert.ok(calls.deletes.some((d) => d.mid === 6), "password message deleted");
  assert.ok(calls.deletes.some((d) => d.mid === 200), "prompt message deleted");
  // original card (5) edited to APPROVED
  assert.ok(calls.edits.some((e) => e.mid === 5 && /APPROVED/.test(e.text)));
  // approved topic (11) received a record
  assert.ok(calls.messages.some((m) => m.t === 11 && /APPROVED/.test(m.text)));
});

test("webhook: wrong password deletes the password message and does NOT approve", async () => {
  const { deps, calls } = fake();
  const prompt = buildApprovalPrompt(wAlert(), 5);
  const r = await processTelegramUpdate(replyWith("nope", prompt), deps);
  assert.equal(r.handled, "reply_bad_password");
  assert.equal(calls.approvedW.length, 0);
  assert.ok(calls.deletes.some((d) => d.mid === 6), "password message deleted even on failure");
  assert.ok(calls.messages.some((m) => /Incorrect password/.test(m.text)));
});

test("webhook: Reject executes immediately (no password), edits card + posts rejected topic", async () => {
  const { deps, calls } = fake();
  const r = await processTelegramUpdate(cbApprove(`${CB_W_REJECT}${UUID}`), deps);
  assert.equal(r.handled, "callback_withdrawal_reject_done");
  assert.deepEqual(calls.rejectedW, [UUID]);
  assert.ok(calls.edits.some((e) => e.mid === 5 && /REJECTED/.test(e.text)));
  assert.ok(calls.messages.some((m) => m.t === 22 && /REJECTED/.test(m.text)));
});

test("webhook: commission approve via password reply approves+marks paid", async () => {
  const { deps, calls } = fake();
  const prompt = buildApprovalPrompt(cAlert(), 5);
  const r = await processTelegramUpdate(replyWith("correct-horse", prompt), deps);
  assert.equal(r.handled, "reply_commission_approve_done");
  assert.deepEqual(calls.approvedC, [CUUID]);
});

test("webhook: unauthorized user cannot act", async () => {
  const { deps, calls } = fake();
  const r = await processTelegramUpdate(cbApprove(`${CB_W_APPROVE}${UUID}`, 999, 999), deps);
  assert.equal(r.handled, "callback_unauthorized");
  assert.equal(calls.forceReplies.length, 0);
});

test("webhook: unauthorized password reply is deleted and ignored (no verify, no approve)", async () => {
  const { deps, calls } = fake();
  const prompt = buildApprovalPrompt(wAlert(), 5);
  const r = await processTelegramUpdate(replyWith("correct-horse", prompt, 999, 999), deps);
  assert.equal(r.handled, "reply_unauthorized");
  assert.equal(calls.verifies.length, 0);
  assert.equal(calls.approvedW.length, 0);
  assert.ok(calls.deletes.some((d) => d.mid === 6));
});

test("webhook: idempotent — approving an already-actioned record reports noop", async () => {
  const { deps, calls } = fake();
  // reference the describe knows but payments says not-pending (use a different id the describe maps to null → noop path)
  const prompt = buildApprovalPrompt({ ...wAlert(), reference: "00000000-0000-0000-0000-000000000000" }, 5);
  const r = await processTelegramUpdate(replyWith("correct-horse", prompt), deps);
  assert.equal(r.handled, "reply_noop");
  assert.ok(calls.messages.some((m) => /Already actioned/.test(m.text)));
});

// ── Commands (DB-truth views) ────────────────────────────────────────────────────────────────
const cmd = (text: string, chatId = 123, fromId = 123) => ({
  message: { message_id: 9, chat: { id: chatId }, from: { id: fromId }, text },
});

test("command /pending lists the live queue with actionable cards", async () => {
  const { deps, calls } = fake();
  deps.listPending = async () => [wAlert(), cAlert()];
  const r = await processTelegramUpdate(cmd("/pending"), deps);
  assert.equal(r.handled, "cmd_pending");
  assert.ok(calls.messages.some((m) => /PENDING APPROVALS — 2 waiting/.test(m.text)), "header with count");
  assert.equal(calls.alerts.length, 2, "one actionable card per pending item");
});

test("command /pending with empty queue says caught up", async () => {
  const { deps, calls } = fake();
  deps.listPending = async () => [];
  const r = await processTelegramUpdate(cmd("/pending"), deps);
  assert.equal(r.handled, "cmd_pending");
  assert.ok(calls.messages.some((m) => /caught up/.test(m.text)));
  assert.equal(calls.alerts.length, 0);
});

test("command /history shows grouped recent decisions (DB truth, stale-proof)", async () => {
  const { deps, calls } = fake();
  deps.listRecent = async () => [
    { kind: "withdrawal", reference: UUID, who: "stanley", userType: "Player", client: "Invest254", amountCents: 200000, decision: "approved", actor: "Jay", atMs: 1_700_000_000_000 },
    { kind: "commission", reference: CUUID, who: "marktop", userType: "Marketer", client: "Tamu Traders", amountCents: 125000, decision: "rejected", actor: "zrinok", atMs: 1_700_000_000_000 },
  ];
  const r = await processTelegramUpdate(cmd("/history"), deps);
  assert.equal(r.handled, "cmd_history");
  const msg = calls.messages.map((m) => m.text).join("\n");
  assert.match(msg, /RECENT DECISIONS/);
  assert.match(msg, /Approved \(1\)/);
  assert.match(msg, /Rejected \(1\)/);
  assert.match(msg, /by Jay/);
});

test("command /help echoes chat id + authorization; /pending refused for unauthorized", async () => {
  const { deps, calls } = fake();
  deps.listPending = async () => [wAlert()];
  assert.equal((await processTelegramUpdate(cmd("/help"), deps)).handled, "cmd_help");
  assert.ok(calls.messages.some((m) => /authorized/.test(m.text)));
  const r = await processTelegramUpdate(cmd("/pending", 999, 999), deps);
  assert.equal(r.handled, "cmd_unauthorized");
  assert.ok(calls.messages.some((m) => /Not authorized/.test(m.text)));
});
