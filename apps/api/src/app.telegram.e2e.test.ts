import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_USER, TEST_ADMIN, type TestApi } from "./testutil.js";
import { CB_APPROVE, CB_REJECT, type TelegramClient } from "./telegram.js";

/** Capturing fake bot client so the e2e can assert what the webhook told Telegram to do. */
function fakeTelegram() {
  const answers: string[] = [];
  const client: TelegramClient = {
    async sendWithdrawalAlert() { return { ok: true, messageId: 1 }; },
    async answerCallback(_id, text) { answers.push(text); },
    async editMessageText() {},
    async sendMessage() { return { ok: true }; },
    async setWebhook() { return { ok: true }; },
  };
  return { client, answers };
}

const SECRET = "tg-webhook-secret";
const json = (r: Response) => r.json() as Promise<any>;

async function harness(): Promise<{ api: TestApi; answers: string[] }> {
  const { client, answers } = fakeTelegram();
  const api = await startTestApi({
    startingBalanceCents: 1_000_000,
    depsOverrides: { telegram: client, telegramChatIds: ["123"], telegramWebhookSecret: SECRET, withdrawalActionActor: async () => TEST_ADMIN },
  });
  return { api, answers };
}
async function pending(api: TestApi): Promise<string> {
  const r = await fetch(`${api.baseUrl}/api/v1/withdrawals`, {
    method: "POST", headers: { authorization: `Bearer ${TEST_USER}`, "content-type": "application/json" },
    body: JSON.stringify({ amount: 50_000, phone: "0722000099" }),
  });
  assert.equal(r.status, 202);
  return (await json(r)).transactionId as string;
}
function webhook(api: TestApi, body: unknown, secret: string | null) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== null) headers["x-telegram-bot-api-secret-token"] = secret;
  return fetch(`${api.baseUrl}/api/v1/telegram/webhook`, { method: "POST", headers, body: JSON.stringify(body) });
}
const cb = (data: string, chatId = 123) => ({ callback_query: { id: "cb1", data, from: { id: chatId }, message: { chat: { id: chatId }, message_id: 7, text: "Withdrawal" } } });

test("telegram webhook: wrong/missing secret token -> 403 (Telegram authenticity gate)", async () => {
  const { api } = await harness();
  try {
    assert.equal((await webhook(api, cb(`${CB_APPROVE}x`), null)).status, 403);
    assert.equal((await webhook(api, cb(`${CB_APPROVE}x`), "wrong")).status, 403);
  } finally { await api.close(); }
});

test("telegram webhook: authorized Approve tap actually approves a pending withdrawal (200)", async () => {
  const { api, answers } = await harness();
  try {
    const tx = await pending(api);
    const res = await webhook(api, cb(`${CB_APPROVE}${tx}`), SECRET);
    assert.equal(res.status, 200);
    assert.deepEqual(await json(res), { ok: true });
    assert.match(answers.at(-1)!, /Approved/);
    // idempotent second tap
    await webhook(api, cb(`${CB_APPROVE}${tx}`), SECRET);
    assert.match(answers.at(-1)!, /Already actioned/);
  } finally { await api.close(); }
});

test("telegram webhook: Reject tap returns the funds", async () => {
  const { api, answers } = await harness();
  try {
    const tx = await pending(api);
    const res = await webhook(api, cb(`${CB_REJECT}${tx}`), SECRET);
    assert.equal(res.status, 200);
    assert.match(answers.at(-1)!, /Rejected/);
  } finally { await api.close(); }
});

test("telegram webhook: unauthorized chat cannot act (still 200, but refused)", async () => {
  const { api, answers } = await harness();
  try {
    const tx = await pending(api);
    const res = await webhook(api, cb(`${CB_APPROVE}${tx}`, 999), SECRET);
    assert.equal(res.status, 200);
    assert.match(answers.at(-1)!, /Not authorized/);
  } finally { await api.close(); }
});
