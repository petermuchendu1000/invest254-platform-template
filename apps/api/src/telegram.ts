/**
 * Telegram bot channel for withdrawal alerts (Issue 1) — instant lock-screen push with inline
 * Approve/Reject buttons. On a pending withdrawal we send a message with an inline keyboard; tapping
 * a button delivers a callback_query to our webhook (see app.telegram.ts), which performs the action.
 *
 * Transport-agnostic surface so tests inject a fake. Concrete client uses the Bot API over HTTPS and
 * is enabled by TELEGRAM_BOT_TOKEN; returns null when unset so the feature stays dormant.
 */
import type { Cents } from "@invest254/shared";

/** callback_data is capped at 64 bytes — keep it tiny: 'wa:'/'wr:' + txId(36) = 39 bytes. */
export const CB_APPROVE = "wa:";
export const CB_REJECT = "wr:";

export interface TelegramSendResult { ok: boolean; error?: string | undefined; messageId?: number | undefined }

export interface TelegramClient {
  sendWithdrawalAlert(chatId: string, a: { who: string; amountCents: Cents; phone: string; txId: string }): Promise<TelegramSendResult>;
  answerCallback(callbackQueryId: string, text: string): Promise<void>;
  editMessageText(chatId: string, messageId: number, text: string): Promise<void>;
  sendMessage(chatId: string, text: string): Promise<TelegramSendResult>;
  setWebhook(url: string, secretToken: string): Promise<{ ok: boolean; error?: string }>;
}

const fmtKes = (cents: Cents): string => {
  const kes = cents / 100;
  const s = Number.isInteger(kes) ? kes.toLocaleString("en-KE") : kes.toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `KES ${s}`;
};
/** Escape for Telegram HTML parse mode (dynamic, user-controlled fields are escaped). */
const escHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The alert text (Telegram HTML) + inline keyboard for a withdrawal (pure, unit-testable). */
export function buildWithdrawalAlert(a: { who: string; amountCents: Cents; phone: string; txId: string }): { text: string; reply_markup: unknown } {
  const text =
    `💸 <b>Withdrawal request</b>\n\n` +
    `<b>${escHtml(fmtKes(a.amountCents))}</b>\n` +
    `From: ${escHtml(a.who)}\n` +
    `To M-Pesa: ${escHtml(a.phone)}\n\n` +
    `Approve to pay out, or reject to return the funds.`;
  const reply_markup = {
    inline_keyboard: [[
      { text: "✅ Approve", callback_data: `${CB_APPROVE}${a.txId}` },
      { text: "✋ Reject", callback_data: `${CB_REJECT}${a.txId}` },
    ]],
  };
  return { text, reply_markup };
}

/** Parse a callback_data string into an action, or null if unrecognised. */
export function parseCallback(data: string): { action: "approve" | "reject"; txId: string } | null {
  if (data.startsWith(CB_APPROVE)) return { action: "approve", txId: data.slice(CB_APPROVE.length) };
  if (data.startsWith(CB_REJECT)) return { action: "reject", txId: data.slice(CB_REJECT.length) };
  return null;
}

export function makeTelegramClient(fetchImpl: typeof fetch = fetch): TelegramClient | null {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return null;
  const base = `https://api.telegram.org/bot${token}`;
  async function call(method: string, body: unknown): Promise<any> {
    const res = await fetchImpl(`${base}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return res.json().catch(() => ({ ok: false }));
  }
  return {
    async sendWithdrawalAlert(chatId, a) {
      const { text, reply_markup } = buildWithdrawalAlert(a);
      const r = await call("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", reply_markup });
      return { ok: Boolean(r?.ok), messageId: r?.result?.message_id, error: r?.ok ? undefined : (r?.description || "send failed") };
    },
    async answerCallback(callbackQueryId, text) {
      await call("answerCallbackQuery", { callback_query_id: callbackQueryId, text, show_alert: false });
    },
    async editMessageText(chatId, messageId, text) {
      // Plain text (no parse_mode): the original message text comes back from Telegram entity-stripped,
      // so re-parsing it as HTML/Markdown could fail. Robustness over formatting here.
      await call("editMessageText", { chat_id: chatId, message_id: messageId, text });
    },
    async sendMessage(chatId, text) {
      const r = await call("sendMessage", { chat_id: chatId, text });
      return { ok: Boolean(r?.ok), messageId: r?.result?.message_id, error: r?.ok ? undefined : (r?.description || "send failed") };
    },
    async setWebhook(url, secretToken) {
      const r = await call("setWebhook", { url, secret_token: secretToken, allowed_updates: ["message", "callback_query"] });
      return { ok: Boolean(r?.ok), error: r?.ok ? undefined : (r?.description || "setWebhook failed") };
    },
  };
}
