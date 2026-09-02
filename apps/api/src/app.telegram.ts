import { Router, ApiError, type Ctx } from "./http.js";
import type { ApiDeps } from "./app.js";
import {
  parseCallback, parseApprovalToken, buildApprovalPrompt, buildDecisionText, buildTopicRecord,
  buildQueueHeader, buildHistoryText, buildHelpText,
  type TelegramClient, type PayoutKind, type PayoutAlert, type PayoutDecision, type PayoutDecisionRecord,
} from "./telegram.js";

/**
 * Telegram webhook (Issue 1): receives Bot API updates and moderates REAL-MONEY payouts.
 *
 * Security model:
 *   1) Authenticity — Telegram echoes our secret in `X-Telegram-Bot-Api-Secret-Token` (set via
 *      setWebhook). Requests without the exact secret are rejected.
 *   2) Authorization — an action only proceeds if the acting Telegram USER id is allowlisted
 *      (TELEGRAM_CHAT_IDS), so a stranger who finds the bot cannot touch payouts.
 *   3) Approval — Approve additionally requires the SUPERADMIN PASSWORD: tapping Approve does NOT
 *      execute; it sends a force-reply prompt, the superadmin replies with the password, we verify it
 *      (scrypt) and only then execute. The password message is deleted immediately afterwards.
 *      Reject executes on tap (it only returns funds — no money leaves the platform).
 *
 * Approve/Reject are idempotent (they only act on a still-pending record), so a double-tap is
 * harmless. The webhook always returns 200 so Telegram never enters a retry storm.
 */
const BASE = "/api/v1";

export interface TelegramCommissionOps {
  approve(id: string, actor: string): Promise<{ approved: boolean }>;
  reject(id: string, actor: string): Promise<{ rejected: boolean }>;
}

export interface TelegramUpdateDeps {
  telegram: TelegramClient;
  /** Allowlisted Telegram USER/chat ids permitted to act on payouts. */
  telegramChatIds: string[];
  payments: Pick<ApiDeps["payments"], "approveWithdrawal" | "rejectWithdrawal">;
  /** Real-money marketer commission ops (approve = approve+mark-paid). Optional/dormant if unset. */
  commission?: TelegramCommissionOps | undefined;
  /** Rebuild the enriched payout card from the DB (for in-place status edits + topic records). */
  describe: (kind: PayoutKind, id: string) => Promise<PayoutAlert | null>;
  /** Live queue of real-money requests awaiting approval (DB truth) — powers /pending. */
  listPending?: (() => Promise<PayoutAlert[]>) | undefined;
  /** Recent settled decisions (DB truth) — powers /history. */
  listRecent?: ((limit: number) => Promise<PayoutDecisionRecord[]>) | undefined;
  /** Verify a supplied password against an active superadmin credential (scrypt, constant-time). */
  verifyApprovalPassword: (password: string) => Promise<boolean>;
  /** The admin uuid recorded as approver/rejecter (approved_by FK). */
  resolveActor: () => Promise<string | null>;
  /** Human display name of the acting superadmin (for "Approved by …"). */
  resolveActorName: () => Promise<string>;
  /** Optional forum group + status topic threads (Approved / Rejected) for self-organising records. */
  forumChatId?: string | undefined;
  topics?: { approved?: number | undefined; rejected?: number | undefined } | undefined;
}

async function executeApprove(kind: PayoutKind, id: string, actor: string, deps: TelegramUpdateDeps): Promise<boolean> {
  if (kind === "withdrawal") return (await deps.payments.approveWithdrawal(id, actor)).approved;
  if (!deps.commission) return false;
  return (await deps.commission.approve(id, actor)).approved;
}

async function executeReject(kind: PayoutKind, id: string, actor: string, deps: TelegramUpdateDeps): Promise<boolean> {
  if (kind === "withdrawal") return (await deps.payments.rejectWithdrawal(id, actor)).reversed;
  if (!deps.commission) return false;
  return (await deps.commission.reject(id, actor)).rejected;
}

/** Edit the original card in place + (if configured) post a compact record into the status topic. */
async function finalizeDecision(
  deps: TelegramUpdateDeps, chatId: unknown, origMsgId: number | undefined,
  kind: PayoutKind, id: string, decision: PayoutDecision,
): Promise<void> {
  const a = await deps.describe(kind, id).catch(() => null);
  if (!a) return;
  const actorName = await deps.resolveActorName().catch(() => "superadmin");
  const now = Date.now();
  if (chatId != null && origMsgId != null) {
    await deps.telegram.editMessageText(String(chatId), origMsgId, buildDecisionText(a, decision, actorName, now)).catch(() => {});
  }
  if (deps.forumChatId && deps.topics) {
    const thread = decision === "approved" ? deps.topics.approved : deps.topics.rejected;
    if (thread != null) {
      await deps.telegram.sendMessage(deps.forumChatId, buildTopicRecord(a, decision, actorName, now), thread).catch(() => {});
    }
  }
}

/** Pure handler (no HTTP) so every scenario is unit-testable. Never throws. */
export async function processTelegramUpdate(update: any, deps: TelegramUpdateDeps): Promise<{ handled: string }> {
  const authorized = (id: unknown): boolean => id != null && deps.telegramChatIds.includes(String(id));
  try {
    // ── Inline button taps ──────────────────────────────────────────────────────────────────
    const cb = update?.callback_query;
    if (cb) {
      const chatId = cb.message?.chat?.id;
      if (!authorized(chatId) && !authorized(cb.from?.id)) {
        await deps.telegram.answerCallback(cb.id, "Not authorized for this action.");
        return { handled: "callback_unauthorized" };
      }
      const parsed = parseCallback(String(cb.data ?? ""));
      if (!parsed) { await deps.telegram.answerCallback(cb.id, "Unknown action."); return { handled: "callback_bad_data" }; }

      // Approve → require the superadmin password: open a force-reply prompt, do NOT execute yet.
      if (parsed.action === "approve") {
        const origMsgId = cb.message?.message_id;
        if (origMsgId == null) { await deps.telegram.answerCallback(cb.id, "Cannot start approval here."); return { handled: "callback_no_msg" }; }
        const a = await deps.describe(parsed.kind, parsed.id).catch(() => null);
        if (!a) { await deps.telegram.answerCallback(cb.id, "Record not found or already actioned."); return { handled: "callback_notfound" }; }
        await deps.telegram.sendForceReply(String(chatId ?? cb.from?.id), buildApprovalPrompt(a, origMsgId));
        await deps.telegram.answerCallback(cb.id, "Reply with the superadmin password to approve.");
        return { handled: `callback_${parsed.kind}_approve_prompt` };
      }

      // Reject → immediate (returns funds, no money leaves the platform).
      const actor = await deps.resolveActor();
      if (!actor) { await deps.telegram.answerCallback(cb.id, "No admin actor configured."); return { handled: "callback_no_actor" }; }
      const rejected = await executeReject(parsed.kind, parsed.id, actor, deps);
      await deps.telegram.answerCallback(cb.id, rejected ? "Rejected — funds returned." : "Already actioned or no longer pending.");
      if (rejected) await finalizeDecision(deps, chatId, cb.message?.message_id, parsed.kind, parsed.id, "rejected");
      return { handled: rejected ? `callback_${parsed.kind}_reject_done` : "callback_noop" };
    }

    // ── Messages ────────────────────────────────────────────────────────────────────────────
    const msg = update?.message;
    if (msg && typeof msg.text === "string") {
      const chatId = msg.chat?.id;
      const reply = msg.reply_to_message;
      const tok = reply && typeof reply.text === "string" ? parseApprovalToken(reply.text) : null;

      // A reply carrying the password for an approval prompt.
      if (tok) {
        if (!authorized(chatId) && !authorized(msg.from?.id)) {
          // Unauthorized reply — delete it (may contain a password) and ignore.
          if (chatId != null && msg.message_id != null) await deps.telegram.deleteMessage(String(chatId), msg.message_id).catch(() => {});
          return { handled: "reply_unauthorized" };
        }
        const delPw = async (): Promise<void> => {
          if (chatId != null && msg.message_id != null) await deps.telegram.deleteMessage(String(chatId), msg.message_id).catch(() => {});
        };
        const ok = await deps.verifyApprovalPassword(msg.text);
        if (!ok) {
          await delPw();
          await deps.telegram.sendMessage(String(chatId), "Incorrect password. Tap Approve again to retry.");
          return { handled: "reply_bad_password" };
        }
        const actor = await deps.resolveActor();
        if (!actor) { await delPw(); await deps.telegram.sendMessage(String(chatId), "No admin actor configured."); return { handled: "reply_no_actor" }; }
        const approved = await executeApprove(tok.kind, tok.reference, actor, deps);
        await delPw();
        if (reply.message_id != null && chatId != null) await deps.telegram.deleteMessage(String(chatId), reply.message_id).catch(() => {});
        if (approved) {
          await finalizeDecision(deps, chatId, tok.origMsgId, tok.kind, tok.reference, "approved");
          return { handled: `reply_${tok.kind}_approve_done` };
        }
        await deps.telegram.sendMessage(String(chatId), "Already actioned or no longer pending.");
        return { handled: "reply_noop" };
      }

      // Bot commands — the authoritative, always-accurate view (reads the DB, immune to stale cards).
      const text = msg.text.trim();
      if (text.startsWith("/")) {
        const cmd = text.split(/\s+/)[0]!.toLowerCase().replace(/@[\w_]+$/, "");
        const ok = authorized(chatId) || authorized(msg.from?.id);
        if (cmd === "/pending" || cmd === "/queue") {
          if (!ok) { await deps.telegram.sendMessage(String(chatId), "Not authorized."); return { handled: "cmd_unauthorized" }; }
          const items = deps.listPending ? await deps.listPending().catch(() => []) : [];
          await deps.telegram.sendMessage(String(chatId), buildQueueHeader(items.length));
          for (const a of items.slice(0, 12)) await deps.telegram.sendPayoutAlert(String(chatId), a);
          if (items.length > 12) await deps.telegram.sendMessage(String(chatId), `…and ${items.length - 12} more — action the above first.`);
          return { handled: "cmd_pending" };
        }
        if (cmd === "/history" || cmd === "/recent") {
          if (!ok) { await deps.telegram.sendMessage(String(chatId), "Not authorized."); return { handled: "cmd_unauthorized" }; }
          const recs = deps.listRecent ? await deps.listRecent(10).catch(() => []) : [];
          await deps.telegram.sendMessage(String(chatId), buildHistoryText(recs));
          return { handled: "cmd_history" };
        }
        // /help, /start, or anything unrecognised -> help + authorization status.
        await deps.telegram.sendMessage(String(chatId), buildHelpText(ok, chatId));
        return { handled: "cmd_help" };
      }

      // Plain message → echo the chat id + authorization status (onboarding helper).
      if (chatId != null) {
        const ok = authorized(chatId) || authorized(msg.from?.id);
        await deps.telegram.sendMessage(String(chatId),
          `Your Telegram chat ID is ${chatId}.\n` +
          (ok ? "This chat is authorized — you'll receive payout alerts here."
              : "Not yet authorized. Send this ID to your platform admin to enable alerts."));
        return { handled: "message" };
      }
    }
    return { handled: "ignored" };
  } catch {
    return { handled: "error" };
  }
}

/** Assemble the webhook deps from ApiDeps, with safe fallbacks so partial wiring degrades gracefully. */
export function buildTelegramUpdateDeps(deps: ApiDeps): TelegramUpdateDeps {
  return {
    telegram: deps.telegram!,
    telegramChatIds: deps.telegramChatIds ?? [],
    payments: deps.payments,
    commission: deps.commissionTelegramOps,
    describe: deps.describePayout ?? (async () => null),
    listPending: deps.listPendingPayouts,
    listRecent: deps.listRecentPayoutDecisions,
    verifyApprovalPassword: deps.verifyApprovalPassword ?? (async () => false),
    resolveActor: deps.withdrawalActionActor ?? (async () => null),
    resolveActorName: deps.resolveActorName ?? (async () => "superadmin"),
    forumChatId: deps.telegramForumChatId,
    topics: deps.telegramTopics,
  };
}

export function registerTelegramRoutes(router: Router, deps: ApiDeps): void {
  if (!deps.telegram) return; // bot not configured -> route dormant
  const tgDeps = buildTelegramUpdateDeps(deps);
  router.post(`${BASE}/telegram/webhook`, async (ctx: Ctx) => {
    const got = ctx.req.headers["x-telegram-bot-api-secret-token"];
    if (!deps.telegramWebhookSecret || got !== deps.telegramWebhookSecret) {
      throw new ApiError("FORBIDDEN", "bad webhook secret", 403);
    }
    await processTelegramUpdate(ctx.body, tgDeps);
    return { body: { ok: true } }; // always 200 so Telegram doesn't retry
  });
}
