import { Router, ApiError, type Ctx } from "./http.js";
import type { ApiDeps } from "./app.js";
import { parseCallback, type TelegramClient } from "./telegram.js";

/**
 * Telegram webhook (Issue 1): receives updates from the Bot API and performs Approve/Reject when an
 * admin taps an inline button. Security:
 *   1) Authenticity — Telegram echoes our secret in the `X-Telegram-Bot-Api-Secret-Token` header
 *      (set via setWebhook). Requests without the exact secret are rejected.
 *   2) Authorization — a callback only acts if its chat/user id is in the allowlist (TELEGRAM_CHAT_IDS),
 *      so a stranger who finds the bot cannot approve payouts.
 * Approve/reject are idempotent (only act on a 'pending' row), so a double-tap is harmless. The
 * webhook always returns 200 so Telegram never enters a retry storm.
 */
const BASE = "/api/v1";

export interface TelegramUpdateDeps {
  telegram: TelegramClient;
  telegramChatIds: string[];
  payments: Pick<ApiDeps["payments"], "approveWithdrawal" | "rejectWithdrawal">;
  withdrawalActionActor?: (() => Promise<string | null>) | undefined;
}

/** Pure handler (no HTTP) so every scenario is unit-testable. Never throws. */
export async function processTelegramUpdate(update: any, deps: TelegramUpdateDeps): Promise<{ handled: string }> {
  const authorized = (id: unknown): boolean => id != null && deps.telegramChatIds.includes(String(id));
  try {
    const cb = update?.callback_query;
    if (cb) {
      const chatId = cb.message?.chat?.id;
      if (!authorized(chatId) && !authorized(cb.from?.id)) {
        await deps.telegram.answerCallback(cb.id, "⛔ Not authorized for this action.");
        return { handled: "callback_unauthorized" };
      }
      const parsed = parseCallback(String(cb.data ?? ""));
      if (!parsed) { await deps.telegram.answerCallback(cb.id, "Unknown action."); return { handled: "callback_bad_data" }; }
      const actor = deps.withdrawalActionActor ? await deps.withdrawalActionActor() : null;
      if (!actor) { await deps.telegram.answerCallback(cb.id, "No admin actor configured."); return { handled: "callback_no_actor" }; }

      let resultText: string; let done: boolean;
      if (parsed.action === "approve") {
        const r = await deps.payments.approveWithdrawal(parsed.txId, actor);
        done = r.approved; resultText = r.approved ? "✅ Approved — payout dispatched." : "Already actioned or no longer pending.";
      } else {
        const r = await deps.payments.rejectWithdrawal(parsed.txId, actor);
        done = r.reversed; resultText = r.reversed ? "✋ Rejected — funds returned." : "Already actioned or no longer pending.";
      }
      await deps.telegram.answerCallback(cb.id, resultText);
      if (chatId != null && cb.message?.message_id != null) {
        const orig = typeof cb.message.text === "string" ? cb.message.text : "Withdrawal";
        await deps.telegram.editMessageText(String(chatId), cb.message.message_id, `${orig}\n\n${resultText}`);
      }
      return { handled: done ? `callback_${parsed.action}_done` : "callback_noop" };
    }

    const msg = update?.message;
    if (msg && typeof msg.text === "string") {
      const chatId = msg.chat?.id;
      if (chatId != null) {
        const ok = authorized(chatId);
        await deps.telegram.sendMessage(String(chatId),
          `Your Telegram chat ID is ${chatId}.\n` +
          (ok ? "✅ This chat is authorized — you'll receive withdrawal alerts here." :
                "⚠️ Not yet authorized. Send this ID to your platform admin to enable alerts."));
        return { handled: "message" };
      }
    }
    return { handled: "ignored" };
  } catch {
    return { handled: "error" };
  }
}

export function registerTelegramRoutes(router: Router, deps: ApiDeps): void {
  if (!deps.telegram) return; // bot not configured -> route dormant
  router.post(`${BASE}/telegram/webhook`, async (ctx: Ctx) => {
    const got = ctx.req.headers["x-telegram-bot-api-secret-token"];
    if (!deps.telegramWebhookSecret || got !== deps.telegramWebhookSecret) {
      throw new ApiError("FORBIDDEN", "bad webhook secret", 403);
    }
    await processTelegramUpdate(ctx.body, {
      telegram: deps.telegram!,
      telegramChatIds: deps.telegramChatIds ?? [],
      payments: deps.payments,
      withdrawalActionActor: deps.withdrawalActionActor,
    });
    return { body: { ok: true } }; // always 200 so Telegram doesn't retry
  });
}
