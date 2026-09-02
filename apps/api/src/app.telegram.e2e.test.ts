import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestApi, TEST_USER, TEST_ADMIN, type TestApi } from "./testutil.js";
import { CB_W_APPROVE, CB_W_REJECT, type TelegramClient, type PayoutAlert } from "./telegram.js";

/** Capturing fake bot client so the e2e can assert exactly what the webhook told Telegram to do. */
function fakeTelegram() {
  const cap = { answers: [] as string[], forceReplies: [] as string[], edits: [] as string[], deletes: [] as number[], messages: [] as string[] };
  const client: TelegramClient = {
    async sendPayoutAlert() { return { ok: true, messageId: 1 }; },
    async sendForceReply(_c, text) { cap.forceReplies.push(text); return { ok: true, messageId: 200 }; },
    async sendMessage(_c, text) { cap.messages.push(text); return { ok: true }; },
    async answerCallback(_id, text) { cap.answers.push(text); },
    async editMessageText(_c, _m, text) { cap.edits.push(text); },
    async deleteMessage(_c, m) { cap.deletes.push(m); },
    async setWebhook() { return { ok: true }; },
  };
  return { client, cap };
}

const SECRET = "tg-webhook-secret";
const PASSWORD = "secret";
const json = (r: Response) => r.json() as Promise<any>;

async function harness(): Promise<{ api: TestApi; cap: ReturnType<typeof fakeTelegram>["cap"] }> {
  const { client, cap } = fakeTelegram();
  const api = await startTestApi({
    startingBalanceCents: 1_000_000,
    depsOverrides: {
      telegram: client, telegramChatIds: ["123"], telegramWebhookSecret: SECRET,
      withdrawalActionActor: async () => TEST_ADMIN,
      verifyApprovalPassword: async (pw) => pw === PASSWORD,
      resolveActorName: async () => "zrinok",
      describePayout: async (kind, id): Promise<PayoutAlert> => ({
        kind, reference: id, who: "tester", userType: "Player", client: "TestBrand",
        amountCents: 50_000, phone: "254722000099",
      }),
    },
  });
  return { api, cap };
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
const cb = (data: string, chatId = 123) => ({ callback_query: { id: "cb1", data, from: { id: chatId }, message: { chat: { id: chatId }, message_id: 7, text: "card" } } });
const reply = (pw: string, promptText: string, chatId = 123) => ({
  message: { message_id: 8, chat: { id: chatId }, from: { id: chatId }, text: pw, reply_to_message: { message_id: 200, text: promptText } },
});

test("telegram webhook: wrong/missing secret token -> 403 (authenticity gate)", async () => {
  const { api } = await harness();
  try {
    assert.equal((await webhook(api, cb(`${CB_W_APPROVE}x`), null)).status, 403);
    assert.equal((await webhook(api, cb(`${CB_W_APPROVE}x`), "wrong")).status, 403);
  } finally { await api.close(); }
});

test("telegram webhook: Approve tap opens a password prompt and does NOT approve", async () => {
  const { api, cap } = await harness();
  try {
    const tx = await pending(api);
    const res = await webhook(api, cb(`${CB_W_APPROVE}${tx}`), SECRET);
    assert.equal(res.status, 200);
    assert.equal(cap.forceReplies.length, 1, "a force-reply prompt was sent");
    assert.match(cap.answers.at(-1)!, /password/i);
    // The withdrawal is still pending: a Reject would still work (proves it wasn't approved on tap).
    const rej = await webhook(api, cb(`${CB_W_REJECT}${tx}`), SECRET);
    assert.equal(rej.status, 200);
    assert.match(cap.answers.at(-1)!, /Rejected/);
  } finally { await api.close(); }
});

test("telegram webhook: correct password reply approves; wrong password does not", async () => {
  const { api, cap } = await harness();
  try {
    const tx = await pending(api);
    await webhook(api, cb(`${CB_W_APPROVE}${tx}`), SECRET);
    const prompt = cap.forceReplies.at(-1)!; // captured prompt carries the authorization token
    // Wrong password: message deleted, not approved.
    await webhook(api, reply("nope", prompt), SECRET);
    assert.ok(cap.deletes.includes(8), "wrong password message deleted");
    assert.ok(cap.messages.some((m) => /Incorrect password/.test(m)));
    // Correct password: approves; card edited to APPROVED.
    await webhook(api, reply(PASSWORD, prompt), SECRET);
    assert.ok(cap.edits.some((t) => /APPROVED/.test(t)), "card updated to APPROVED");
    // Now already actioned: a reject reports noop.
    await webhook(api, cb(`${CB_W_REJECT}${tx}`), SECRET);
    assert.match(cap.answers.at(-1)!, /Already actioned|no longer pending/);
  } finally { await api.close(); }
});

test("telegram webhook: Reject tap returns funds immediately (no password)", async () => {
  const { api, cap } = await harness();
  try {
    const tx = await pending(api);
    const res = await webhook(api, cb(`${CB_W_REJECT}${tx}`), SECRET);
    assert.equal(res.status, 200);
    assert.match(cap.answers.at(-1)!, /Rejected/);
  } finally { await api.close(); }
});

test("telegram webhook: unauthorized chat cannot act (still 200, refused)", async () => {
  const { api, cap } = await harness();
  try {
    const tx = await pending(api);
    const res = await webhook(api, cb(`${CB_W_APPROVE}${tx}`, 999), SECRET);
    assert.equal(res.status, 200);
    assert.match(cap.answers.at(-1)!, /Not authorized/);
  } finally { await api.close(); }
});
