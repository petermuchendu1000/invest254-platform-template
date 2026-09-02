/**
 * Telegram bot channel for REAL-MONEY payout moderation (Issue 1).
 *
 * Two record kinds ride this channel, both real money that needs a superadmin decision before cash
 * leaves the platform:
 *   - "withdrawal" : a player's M-Pesa withdrawal (transactions, provider='mpesa') — Approve dispatches
 *                    the Daraja B2C payout, Reject returns the held funds.
 *   - "commission" : a marketer's real-money commission payout (commission_payouts) — Approve records
 *                    approve + mark-paid (the operator sends the M-Pesa manually), Reject rejects it.
 * Demo / "funny money" marketer game→wallet transfers are INSTANT and never ride this channel.
 *
 * UX (bank-grade, deliberately free of emojis/icons):
 *   - Each request is ONE message that shows AWAITING APPROVAL with two inline buttons: Approve, Reject.
 *   - Reject executes immediately.
 *   - Approve requires the superadmin's account password: tapping Approve sends a force-reply prompt;
 *     the superadmin replies with the password; on success the payout executes and the password message
 *     is deleted. The message then updates in place to APPROVED / REJECTED (by whom, when).
 *   - When a forum group + topic threads are configured, a compact record is also posted to the
 *     Approved / Rejected topic so the channel is self-organising.
 *
 * The password prompt carries a human-readable AUTHORIZATION REFERENCE token that lets the webhook
 * recover {kind, original message id, record id} statelessly from the reply — no server-side session.
 *
 * Transport-agnostic surface so tests inject a fake. The concrete client uses the Bot API over HTTPS
 * and is enabled by TELEGRAM_BOT_TOKEN; returns null when unset so the feature stays dormant.
 */
import type { Cents } from "@invest254/shared";

/** callback_data is capped at 64 bytes — 3-byte prefix + uuid(36) = 39 bytes. */
export const CB_W_APPROVE = "wa:";
export const CB_W_REJECT = "wr:";
export const CB_C_APPROVE = "ca:";
export const CB_C_REJECT = "cr:";
/** Legacy aliases (pre-Issue-1 withdrawal-only names) kept so nothing external breaks. */
export const CB_APPROVE = CB_W_APPROVE;
export const CB_REJECT = CB_W_REJECT;

export type PayoutKind = "withdrawal" | "commission";
export type PayoutDecision = "approved" | "rejected";

export interface TelegramSendResult { ok: boolean; error?: string | undefined; messageId?: number | undefined }

/** Everything the alert needs to render a thorough, bank-grade payout record. */
export interface PayoutAlert {
  kind: PayoutKind;
  /** Record id — a withdrawal transaction id or a commission_payouts id. */
  reference: string;
  /** Display handle of the requester (username or marketer name). */
  who: string;
  /** Account type of the requester, e.g. "Player" or "Marketer". */
  userType: string;
  /** Client / brand (site) the request belongs to, e.g. "Invest254". */
  client: string;
  amountCents: Cents;
  /** Destination M-Pesa number (player withdrawal) or the marketer's phone (commission). */
  phone: string;
  requestedAtMs?: number | undefined;
}

export interface TelegramClient {
  /** Send a fresh AWAITING-APPROVAL payout card (optionally into a forum topic thread). */
  sendPayoutAlert(chatId: string, a: PayoutAlert, threadId?: number): Promise<TelegramSendResult>;
  /** Send a force-reply prompt (used to collect the superadmin password on Approve). */
  sendForceReply(chatId: string, text: string): Promise<TelegramSendResult>;
  /** Plain message (optionally into a forum topic thread). */
  sendMessage(chatId: string, text: string, threadId?: number): Promise<TelegramSendResult>;
  answerCallback(callbackQueryId: string, text: string): Promise<void>;
  editMessageText(chatId: string, messageId: number, text: string): Promise<void>;
  deleteMessage(chatId: string, messageId: number): Promise<void>;
  setWebhook(url: string, secretToken: string): Promise<{ ok: boolean; error?: string }>;
}

// ── Formatting helpers ────────────────────────────────────────────────────────────────────────
const fmtKes = (cents: Cents): string => {
  const kes = cents / 100;
  const s = Number.isInteger(kes)
    ? kes.toLocaleString("en-KE")
    : kes.toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `KES ${s}`;
};

/** Escape for Telegram HTML parse mode (all dynamic, user-controlled fields pass through this). */
const escHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A stable, human-readable UTC timestamp (no locale surprises across servers). */
const fmtWhen = (ms?: number): string => {
  const d = ms ? new Date(ms) : new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
};

const titleFor = (kind: PayoutKind): string =>
  kind === "commission" ? "COMMISSION PAYOUT" : "WITHDRAWAL REQUEST";

/** The "To M-Pesa" / "Marketer M-Pesa" label differs by record kind. */
const destLabelFor = (kind: PayoutKind): string =>
  kind === "commission" ? "Marketer M-Pesa" : "To M-Pesa";

/** Shared labelled body — deliberately plain (no emojis), aligned like a bank advice note. */
function bodyRows(a: PayoutAlert): string {
  return (
    `<b>Amount:</b> ${escHtml(fmtKes(a.amountCents))}\n` +
    `<b>Client:</b> ${escHtml(a.client)}\n` +
    `<b>Requested by:</b> ${escHtml(a.who)} (${escHtml(a.userType)})\n` +
    `<b>${destLabelFor(a.kind)}:</b> ${escHtml(a.phone)}\n` +
    `<b>Requested:</b> ${escHtml(fmtWhen(a.requestedAtMs))}\n` +
    `<b>Reference:</b> <code>${escHtml(a.reference)}</code>`
  );
}

const rule = "────────────────────";

/** The AWAITING-APPROVAL card text (Telegram HTML) — pure and unit-testable. */
export function buildPayoutText(a: PayoutAlert): string {
  return (
    `<b>${titleFor(a.kind)} — AWAITING APPROVAL</b>\n` +
    `${rule}\n` +
    `${bodyRows(a)}\n` +
    `${rule}\n` +
    `Approve requires the superadmin password. Reject returns the funds.`
  );
}

/** Inline keyboard (two buttons) with kind-aware callback data. */
export function buildPayoutKeyboard(a: PayoutAlert): unknown {
  const approve = a.kind === "commission" ? CB_C_APPROVE : CB_W_APPROVE;
  const reject = a.kind === "commission" ? CB_C_REJECT : CB_W_REJECT;
  return {
    inline_keyboard: [[
      { text: "Approve", callback_data: `${approve}${a.reference}` },
      { text: "Reject", callback_data: `${reject}${a.reference}` },
    ]],
  };
}

/** Full alert (text + keyboard). */
export function buildPayoutAlert(a: PayoutAlert): { text: string; reply_markup: unknown } {
  return { text: buildPayoutText(a), reply_markup: buildPayoutKeyboard(a) };
}

/** The in-place text after a decision (no buttons — the card is now a settled record). */
export function buildDecisionText(a: PayoutAlert, decision: PayoutDecision, actor: string, atMs?: number): string {
  const header = decision === "approved" ? "APPROVED" : "REJECTED";
  const line = decision === "approved"
    ? (a.kind === "commission"
        ? `Approved and marked paid by ${escHtml(actor)} on ${escHtml(fmtWhen(atMs))}.`
        : `Approved by ${escHtml(actor)} on ${escHtml(fmtWhen(atMs))}. Payout dispatched.`)
    : `Rejected by ${escHtml(actor)} on ${escHtml(fmtWhen(atMs))}. Funds returned.`;
  return (
    `<b>${titleFor(a.kind)} — ${header}</b>\n` +
    `${rule}\n` +
    `${bodyRows(a)}\n` +
    `${rule}\n` +
    `${line}`
  );
}

/** A compact one-line record for a status topic (Approved / Rejected tabs). */
export function buildTopicRecord(a: PayoutAlert, decision: PayoutDecision, actor: string, atMs?: number): string {
  const verb = decision === "approved" ? "APPROVED" : "REJECTED";
  const what = a.kind === "commission" ? "Commission" : "Withdrawal";
  return (
    `<b>${what} ${verb}</b> — ${escHtml(fmtKes(a.amountCents))}\n` +
    `${escHtml(a.who)} (${escHtml(a.userType)}) · ${escHtml(a.client)} · ${escHtml(a.phone)}\n` +
    `By ${escHtml(actor)} on ${escHtml(fmtWhen(atMs))} · Ref <code>${escHtml(a.reference)}</code>`
  );
}

// ── Approval (password) prompt: a stateless authorization reference token ─────────────────────
const TOKEN_PFX: Record<PayoutKind, string> = { withdrawal: "WA", commission: "CA" };
const TOKEN_KIND: Record<string, PayoutKind> = { WA: "withdrawal", CA: "commission" };
/** Matches `WA-<origMsgId>-<uuid>` / `CA-<origMsgId>-<uuid>`. */
const TOKEN_RE = /\b(WA|CA)-(\d{1,15})-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b/;

/** Build the force-reply prompt shown when Approve is tapped (carries the recovery token). */
export function buildApprovalPrompt(a: PayoutAlert, origMsgId: number): string {
  const token = `${TOKEN_PFX[a.kind]}-${origMsgId}-${a.reference}`;
  const what = a.kind === "commission" ? "commission payout" : "withdrawal";
  return (
    `<b>Authorization required</b>\n` +
    `Reply to this message with the superadmin password to approve the ${what} of ` +
    `<b>${escHtml(fmtKes(a.amountCents))}</b> for ${escHtml(a.who)} (${escHtml(a.client)}).\n` +
    `Authorization reference: <code>${token}</code>`
  );
}

/** Recover {kind, origMsgId, reference} from a force-reply prompt's text, or null. */
export function parseApprovalToken(promptText: string): { kind: PayoutKind; origMsgId: number; reference: string } | null {
  const m = TOKEN_RE.exec(promptText ?? "");
  if (!m) return null;
  const kind = TOKEN_KIND[m[1]!];
  const origMsgId = Number(m[2]);
  if (!kind || !Number.isInteger(origMsgId)) return null;
  return { kind, origMsgId, reference: m[3]! };
}

/** Parse a button callback into {kind, action, id}, or null if unrecognised. */
export function parseCallback(data: string): { kind: PayoutKind; action: "approve" | "reject"; id: string } | null {
  if (data.startsWith(CB_W_APPROVE)) return { kind: "withdrawal", action: "approve", id: data.slice(CB_W_APPROVE.length) };
  if (data.startsWith(CB_W_REJECT)) return { kind: "withdrawal", action: "reject", id: data.slice(CB_W_REJECT.length) };
  if (data.startsWith(CB_C_APPROVE)) return { kind: "commission", action: "approve", id: data.slice(CB_C_APPROVE.length) };
  if (data.startsWith(CB_C_REJECT)) return { kind: "commission", action: "reject", id: data.slice(CB_C_REJECT.length) };
  return null;
}

// ── Concrete Bot API client ───────────────────────────────────────────────────────────────────
/** A settled decision, for the `/history` view (read live from the DB — always accurate). */
export interface PayoutDecisionRecord {
  kind: PayoutKind;
  reference: string;
  who: string;
  userType: string;
  client: string;
  amountCents: Cents;
  decision: PayoutDecision;
  actor: string;
  atMs?: number | undefined;
}

/** Header shown before the live pending queue (`/pending`). */
export function buildQueueHeader(count: number): string {
  if (count === 0) return "<b>PENDING APPROVALS</b>\nYou're all caught up — no real-money requests are waiting.";
  return `<b>PENDING APPROVALS — ${count} waiting</b>\n${rule}\nEach card below is live. Approve requires the superadmin password; Reject returns the funds.`;
}

/** The `/history` view — recent decisions grouped Approved / Rejected (read live from the DB). */
export function buildHistoryText(records: PayoutDecisionRecord[]): string {
  if (records.length === 0) return "<b>RECENT DECISIONS</b>\nNo approvals or rejections recorded yet.";
  const line = (r: PayoutDecisionRecord): string => {
    const what = r.kind === "commission" ? "Commission" : "Withdrawal";
    return `• ${escHtml(fmtKes(r.amountCents))} — ${escHtml(r.who)} (${escHtml(r.userType)}, ${escHtml(r.client)})\n` +
      `   ${what} · by ${escHtml(r.actor)} · ${escHtml(fmtWhen(r.atMs))}`;
  };
  const approved = records.filter((r) => r.decision === "approved");
  const rejected = records.filter((r) => r.decision === "rejected");
  const parts: string[] = ["<b>RECENT DECISIONS</b>", rule];
  parts.push(`<b>Approved (${approved.length})</b>`);
  parts.push(approved.length ? approved.map(line).join("\n") : "  —");
  parts.push(rule);
  parts.push(`<b>Rejected (${rejected.length})</b>`);
  parts.push(rejected.length ? rejected.map(line).join("\n") : "  —");
  return parts.join("\n");
}

/** The `/help` / `/start` text — what the operator can do and whether this chat is authorized. */
export function buildHelpText(authorized: boolean, chatId: unknown): string {
  return (
    `<b>Invest254 — payout approvals</b>\n${rule}\n` +
    `<b>/pending</b> — the live queue of real-money requests awaiting approval (with Approve/Reject).\n` +
    `<b>/history</b> — recent approved &amp; rejected decisions (who and when).\n` +
    `<b>/help</b> — this message.\n${rule}\n` +
    `Approve requires the superadmin password; Reject is immediate.\n` +
    `Your chat ID is <code>${escHtml(String(chatId))}</code>. ` +
    (authorized ? "This chat is authorized." : "\u26a0 This chat is NOT authorized — send this ID to your platform admin.")
  );
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
  const withThread = (chatId: string, extra: Record<string, unknown>, threadId?: number): Record<string, unknown> =>
    threadId != null ? { chat_id: chatId, message_thread_id: threadId, ...extra } : { chat_id: chatId, ...extra };
  return {
    async sendPayoutAlert(chatId, a, threadId) {
      const { text, reply_markup } = buildPayoutAlert(a);
      const r = await call("sendMessage", withThread(chatId, { text, parse_mode: "HTML", reply_markup }, threadId));
      return { ok: Boolean(r?.ok), messageId: r?.result?.message_id, error: r?.ok ? undefined : (r?.description || "send failed") };
    },
    async sendForceReply(chatId, text) {
      const r = await call("sendMessage", {
        chat_id: chatId, text, parse_mode: "HTML",
        reply_markup: { force_reply: true, input_field_placeholder: "Superadmin password", selective: false },
      });
      return { ok: Boolean(r?.ok), messageId: r?.result?.message_id, error: r?.ok ? undefined : (r?.description || "send failed") };
    },
    async sendMessage(chatId, text, threadId) {
      const r = await call("sendMessage", withThread(chatId, { text, parse_mode: "HTML" }, threadId));
      return { ok: Boolean(r?.ok), messageId: r?.result?.message_id, error: r?.ok ? undefined : (r?.description || "send failed") };
    },
    async answerCallback(callbackQueryId, text) {
      await call("answerCallbackQuery", { callback_query_id: callbackQueryId, text, show_alert: false });
    },
    async editMessageText(chatId, messageId, text) {
      // Re-render with HTML (we rebuild the full body ourselves, so the entities are always valid).
      await call("editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML" });
    },
    async deleteMessage(chatId, messageId) {
      await call("deleteMessage", { chat_id: chatId, message_id: messageId });
    },
    async setWebhook(url, secretToken) {
      const r = await call("setWebhook", { url, secret_token: secretToken, allowed_updates: ["message", "callback_query"] });
      return { ok: Boolean(r?.ok), error: r?.ok ? undefined : (r?.description || "setWebhook failed") };
    },
  };
}
