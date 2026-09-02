import type { Cents } from "@invest254/shared";

/**
 * Transactional email for admin withdrawal alerts (Issue 1). Provider-agnostic: PushService-style
 * interface so the sender can be swapped/faked in tests. The concrete sender uses Resend's HTTP API
 * (simplest DX, generous free tier); set RESEND_API_KEY + EMAIL_FROM to enable. Returns null when
 * unconfigured so the server leaves email dormant (additive, never crashes).
 */
export interface EmailMessage { to: string[]; subject: string; html: string; text: string }
export interface EmailSendResult { ok: boolean; id?: string | undefined; error?: string | undefined }
export interface EmailSender { send(msg: EmailMessage): Promise<EmailSendResult> }

export function makeResendSender(): (EmailSender & { from: string }) | null {
  const key = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim();
  if (!key || !from) return null;
  return {
    from,
    async send(msg: EmailMessage): Promise<EmailSendResult> {
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text }),
        });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const data = (await res.json().catch(() => ({}))) as { id?: string };
        return { ok: true, id: data.id };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

const fmtKes = (cents: Cents): string => {
  const kes = cents / 100;
  const s = Number.isInteger(kes) ? kes.toLocaleString("en-KE") : kes.toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `KES ${s}`;
};
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** Build the withdrawal-request alert email. `approveUrl`/`rejectUrl` open the API confirm pages. */
export function buildWithdrawalEmail(o: {
  who: string; amountCents: Cents; phone: string; txId: string; approveUrl: string; rejectUrl: string;
}): { subject: string; html: string; text: string } {
  const amount = fmtKes(o.amountCents);
  const subject = `Withdrawal request: ${amount} — ${o.who}`;
  const text =
    `${o.who} requested a withdrawal of ${amount} to ${o.phone}.\n\n` +
    `Approve: ${o.approveUrl}\nReject:  ${o.rejectUrl}\n\n` +
    `Transaction ${o.txId}. Links expire in 72h. Approving pays out; rejecting returns the funds.`;
  const html = `<!doctype html><html><body style="margin:0;background:#0a0a0a;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:480px;margin:0 auto;padding:24px;color:#e5e7eb;">
    <h1 style="font-size:18px;margin:0 0 4px;">New withdrawal request</h1>
    <p style="color:#9ca3af;font-size:13px;margin:0 0 16px;">Action needed — approve to pay out, or reject to return the funds.</p>
    <div style="background:#111827;border:1px solid #1f2937;border-radius:12px;padding:16px;margin-bottom:20px;">
      <div style="font-size:26px;font-weight:700;color:#fff;">${esc(amount)}</div>
      <div style="color:#9ca3af;font-size:13px;margin-top:6px;">Requested by <b style="color:#e5e7eb;">${esc(o.who)}</b></div>
      <div style="color:#9ca3af;font-size:13px;">To M-Pesa <b style="color:#e5e7eb;">${esc(o.phone)}</b></div>
    </div>
    <a href="${esc(o.approveUrl)}" style="display:block;text-align:center;background:#22c55e;color:#04140a;text-decoration:none;font-weight:700;padding:14px;border-radius:10px;margin-bottom:10px;">✅ Approve &amp; pay out</a>
    <a href="${esc(o.rejectUrl)}" style="display:block;text-align:center;background:#1f2937;color:#fca5a5;text-decoration:none;font-weight:700;padding:14px;border-radius:10px;">✋ Reject &amp; return funds</a>
    <p style="color:#6b7280;font-size:11px;margin-top:18px;">Each button opens a confirmation page — you tap once more to confirm. Links expire in 72 hours. No login required. Ref ${esc(o.txId)}.</p>
  </div></body></html>`;
  return { subject, html, text };
}
