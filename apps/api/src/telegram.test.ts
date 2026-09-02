import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWithdrawalAlert, parseCallback, CB_APPROVE, CB_REJECT } from "./telegram.js";
import { processTelegramUpdate } from "./app.telegram.js";

function fake() {
  const calls = { alerts: [] as any[], answers: [] as any[], edits: [] as any[], messages: [] as any[] };
  const client = {
    async sendWithdrawalAlert(chatId: string, a: any) { calls.alerts.push({ chatId, a }); return { ok: true, messageId: 1 }; },
    async answerCallback(id: string, text: string) { calls.answers.push({ id, text }); },
    async editMessageText(chatId: string, mid: number, text: string) { calls.edits.push({ chatId, mid, text }); },
    async sendMessage(chatId: string, text: string) { calls.messages.push({ chatId, text }); return { ok: true }; },
    async setWebhook() { return { ok: true }; },
  };
  return { client, calls };
}
const payments = (pendingId: string) => ({
  async approveWithdrawal(tx: string) { return { approved: tx === pendingId }; },
  async rejectWithdrawal(tx: string) { return { reversed: tx === pendingId, newBalance: 0 }; },
});
const baseDeps = (client: any, extra: any = {}) => ({
  telegram: client, telegramChatIds: ["123"], payments: payments("PEND"),
  withdrawalActionActor: async () => "admin-1", ...extra,
});
const cbUpdate = (data: string, chatId = 123, fromId = 123) => ({
  callback_query: { id: "cb1", data, from: { id: fromId }, message: { chat: { id: chatId }, message_id: 5, text: "💸 Withdrawal request" } },
});

test("telegram: buildWithdrawalAlert has both buttons and callback_data within Telegram's 64-byte cap", () => {
  const a = buildWithdrawalAlert({ who: "jane", amountCents: 500_00, phone: "254722000099", txId: "af1caaa2-a1f7-4484-b1ec-24ab5cd02d54" });
  const kb = (a.reply_markup as any).inline_keyboard[0];
  assert.equal(kb.length, 2);
  assert.ok(kb[0].callback_data.startsWith(CB_APPROVE) && kb[1].callback_data.startsWith(CB_REJECT));
  for (const b of kb) assert.ok(Buffer.byteLength(b.callback_data, "utf8") <= 64, "callback_data must be <=64 bytes");
  assert.match(a.text, /KES 500/);
});

test("telegram: parseCallback round-trips and rejects junk", () => {
  assert.deepEqual(parseCallback(`${CB_APPROVE}tx-1`), { action: "approve", txId: "tx-1" });
  assert.deepEqual(parseCallback(`${CB_REJECT}tx-2`), { action: "reject", txId: "tx-2" });
  assert.equal(parseCallback("xx:tx"), null);
  assert.equal(parseCallback(""), null);
});

test("telegram: authorized APPROVE of a pending tx performs, answers, and edits the message", async () => {
  const { client, calls } = fake();
  const r = await processTelegramUpdate(cbUpdate(`${CB_APPROVE}PEND`), baseDeps(client));
  assert.equal(r.handled, "callback_approve_done");
  assert.match(calls.answers[0].text, /Approved/);
  assert.equal(calls.edits.length, 1);
  assert.match(calls.edits[0].text, /Approved/);
});

test("telegram: authorized REJECT of a pending tx returns funds", async () => {
  const { client, calls } = fake();
  const r = await processTelegramUpdate(cbUpdate(`${CB_REJECT}PEND`), baseDeps(client));
  assert.equal(r.handled, "callback_reject_done");
  assert.match(calls.answers[0].text, /Rejected/);
});

test("telegram: callback from an UNAUTHORIZED chat is refused and performs no action", async () => {
  const { client, calls } = fake();
  const r = await processTelegramUpdate(cbUpdate(`${CB_APPROVE}PEND`, 999, 999), baseDeps(client));
  assert.equal(r.handled, "callback_unauthorized");
  assert.match(calls.answers[0].text, /Not authorized/);
  assert.equal(calls.edits.length, 0);
});

test("telegram: malformed callback_data is rejected", async () => {
  const { client, calls } = fake();
  const r = await processTelegramUpdate(cbUpdate("garbage"), baseDeps(client));
  assert.equal(r.handled, "callback_bad_data");
  assert.match(calls.answers[0].text, /Unknown/);
});

test("telegram: already-actioned tx is an idempotent no-op with a clear message", async () => {
  const { client, calls } = fake();
  const r = await processTelegramUpdate(cbUpdate(`${CB_APPROVE}OTHER`), baseDeps(client));
  assert.equal(r.handled, "callback_noop");
  assert.match(calls.answers[0].text, /Already actioned/);
});

test("telegram: no configured actor -> safe refusal", async () => {
  const { client, calls } = fake();
  const r = await processTelegramUpdate(cbUpdate(`${CB_APPROVE}PEND`), baseDeps(client, { withdrawalActionActor: async () => null }));
  assert.equal(r.handled, "callback_no_actor");
  assert.match(calls.answers[0].text, /No admin actor/);
});

test("telegram: /start from an authorized chat replies with the chat id + authorized", async () => {
  const { client, calls } = fake();
  const r = await processTelegramUpdate({ message: { chat: { id: 123 }, text: "/start" } }, baseDeps(client));
  assert.equal(r.handled, "message");
  assert.match(calls.messages[0].text, /123/);
  assert.match(calls.messages[0].text, /authorized/);
});

test("telegram: message from an unauthorized chat returns its id + not-authorized hint", async () => {
  const { client, calls } = fake();
  await processTelegramUpdate({ message: { chat: { id: 777 }, text: "hi" } }, baseDeps(client));
  assert.match(calls.messages[0].text, /777/);
  assert.match(calls.messages[0].text, /Not yet authorized/);
});

test("telegram: garbage/empty updates never throw", async () => {
  const { client } = fake();
  assert.equal((await processTelegramUpdate({}, baseDeps(client))).handled, "ignored");
  assert.equal((await processTelegramUpdate(null, baseDeps(client))).handled, "ignored");
  assert.equal((await processTelegramUpdate({ callback_query: { id: "x" } }, baseDeps(client))).handled, "callback_unauthorized");
});
