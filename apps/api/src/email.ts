import type { Cents } from "@invest254/shared";
import type { PayoutAlert } from "./telegram.js";

/**
 * Transactional email for real-money payout alerts (Issue 1). Provider-agnostic: a small interface so
 * the sender can be swapped/faked in tests. The concrete sender uses Resend's HTTP API; set
 * RESEND_API_KEY + EMAIL_FROM to enable. Returns null when unconfigured so email stays dormant.
 *
 * The template is deliberately bank-grade: a clean, light, emoji-free advice note with a labelled
 * detail table (amount, client, requester + type, destination, time, reference). Withdrawal alerts
 * carry one-tap Approve / Reject links (the Approve confirm page is password-gated); commission alerts
 * are informational (moderated in the dashboard or Telegram).
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
const fmtWhen = (ms?: number): string => {
  const d = ms ? new Date(ms) : new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
};

const detailRow = (label: string, value: string): string =>
  `<tr>
     <td style="padding:9px 0;color:#6b7280;font-size:13px;border-bottom:1px solid #f1f5f9;">${esc(label)}</td>
     <td style="padding:9px 0;color:#111827;font-size:13px;text-align:right;border-bottom:1px solid #f1f5f9;font-weight:600;">${esc(value)}</td>
   </tr>`;

/**
 * Build the payout-request alert email for a withdrawal or a commission payout.
 * When `links` is supplied (withdrawal), the email includes Approve / Reject buttons.
 */
export function buildPayoutEmail(
  a: PayoutAlert,
  links?: { approveUrl: string; rejectUrl: string } | undefined,
): { subject: string; html: string; text: string } {
  const amount = fmtKes(a.amountCents);
  const isCommission = a.kind === "commission";
  const kindLabel = isCommission ? "Commission payout" : "Withdrawal request";
  const destLabel = isCommission ? "Marketer M-Pesa" : "To M-Pesa";
  const subject = `${kindLabel}: ${amount} — ${a.who} (${a.client})`;

  const textLines = [
    `${kindLabel} — awaiting approval`,
    ``,
    `Amount:        ${amount}`,
    `Client:        ${a.client}`,
    `Requested by:  ${a.who} (${a.userType})`,
    `${destLabel}:  ${a.phone}`,
    `Requested:     ${fmtWhen(a.requestedAtMs)}`,
    `Reference:     ${a.reference}`,
  ];
  if (links) {
    textLines.push(``, `Approve: ${links.approveUrl}`, `Reject:  ${links.rejectUrl}`,
      ``, `Approving requires the superadmin password. Links expire in 72h.`);
  } else {
    textLines.push(``, `Review and action this payout in the admin dashboard or the Telegram channel.`);
  }
  const text = textLines.join("\n");

  const actions = links
    ? `<tr><td style="padding-top:8px;">
         <a href="${esc(links.approveUrl)}" style="display:block;text-align:center;background:#166534;color:#ffffff;text-decoration:none;font-weight:600;padding:13px;border-radius:9px;margin-bottom:10px;">Approve payout</a>
         <a href="${esc(links.rejectUrl)}" style="display:block;text-align:center;background:#ffffff;color:#991b1b;border:1px solid #e5e7eb;text-decoration:none;font-weight:600;padding:13px;border-radius:9px;">Reject and return funds</a>
         <p style="color:#6b7280;font-size:11px;margin:14px 0 0;">Approving opens a secure page that requires the superadmin password. Links expire in 72 hours. No login required.</p>
       </td></tr>`
    : `<tr><td style="padding-top:6px;">
         <p style="color:#374151;font-size:13px;margin:0;">Review and action this payout in the admin dashboard or the Telegram approval channel. Approval requires the superadmin password.</p>
       </td></tr>`;

  const html = `<!doctype html><html><body style="margin:0;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:24px 16px;">
    <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;">
      <div style="padding:18px 24px;border-bottom:1px solid #eef2f7;">
        <div style="font-size:12px;letter-spacing:.06em;color:#6b7280;">${esc(kindLabel.toUpperCase())} — AWAITING APPROVAL</div>
        <div style="font-size:26px;font-weight:700;color:#111827;margin-top:4px;">${esc(amount)}</div>
      </div>
      <div style="padding:8px 24px 4px;">
        <table role="presentation" width="100%" style="border-collapse:collapse;">
          ${detailRow("Client", a.client)}
          ${detailRow("Requested by", `${a.who} (${a.userType})`)}
          ${detailRow(destLabel, a.phone)}
          ${detailRow("Requested", fmtWhen(a.requestedAtMs))}
          ${detailRow("Reference", a.reference)}
        </table>
      </div>
      <div style="padding:12px 24px 22px;">
        <table role="presentation" width="100%" style="border-collapse:collapse;">${actions}</table>
      </div>
    </div>
    <p style="text-align:center;color:#9ca3af;font-size:11px;margin-top:14px;letter-spacing:.04em;">SECURE PAYOUT AUTHORIZATION</p>
  </div></body></html>`;

  return { subject, html, text };
}
