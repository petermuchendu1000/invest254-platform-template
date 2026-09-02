import { Router, ApiError, rateLimit, type Ctx } from "./http.js";
import type { ApiDeps } from "./app.js";
import { verifyWithdrawalAction, type WithdrawalActionKind } from "./withdrawalactionlink.js";

/**
 * Public, login-free withdrawal moderation from an email magic link (Issue 1).
 *   GET  /api/v1/w/act?token=…   -> a confirm PAGE (never mutates; safe against email/scanner prefetch)
 *   POST /api/v1/w/act           -> { token } verifies + performs the approve/reject
 * The HMAC-signed token (scoped to one tx + action + expiry) is the authorization, so no session is
 * needed. Approve/reject are idempotent (only act on a 'pending' row), so a replayed link is safe.
 */
const BASE = "/api/v1";

function page(title: string, bodyHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;background:#f3f4f6;color:#111827;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<div style="max-width:460px;margin:0 auto;padding:32px 18px;">
  <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;padding:26px 24px;box-shadow:0 1px 2px rgba(0,0,0,0.05);">${bodyHtml}</div>
  <p style="text-align:center;color:#9ca3af;font-size:11px;margin-top:16px;letter-spacing:.04em;">SECURE PAYOUT AUTHORIZATION</p>
</div></body></html>`;
}

function html(ctx: Ctx, status: number, body: string): void {
  ctx.res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  ctx.res.end(body);
}

export function registerWithdrawalActionRoutes(router: Router, deps: ApiDeps): void {
  const secret = deps.actionSecret;
  if (!secret) return; // signing secret absent -> feature dormant
  const limit = rateLimit({ name: "withdrawal-action", limit: 30, windowMs: 60_000, by: "ip" });

  // Confirm page (no mutation).
  router.get(`${BASE}/w/act`, limit, async (ctx: Ctx) => {
    const token = ctx.query.get("token") ?? "";
    const v = token ? verifyWithdrawalAction(token, secret) : null;
    if (!v) {
      html(ctx, 400, page("Link expired", `<h1 style="font-size:18px;">This link is invalid or has expired</h1>
        <p style="color:#9ca3af;font-size:14px;">Open the admin dashboard to action this withdrawal manually.</p>`));
      return;
    }
    const isApprove = v.action === "approve";
    const color = isApprove ? "#166534" : "#991b1b";
    const label = isApprove ? "Approve payout" : "Reject and return funds";
    const pwField = isApprove
      ? `<label for="pw" style="display:block;font-size:13px;color:#374151;margin:0 0 6px;">Superadmin password</label>
         <input id="pw" type="password" autocomplete="off" style="width:100%;box-sizing:border-box;border:1px solid #d1d5db;border-radius:9px;padding:12px;font-size:15px;margin-bottom:14px;" placeholder="Enter password to authorize">`
      : "";
    html(ctx, 200, page("Confirm payout action", `
      <div style="font-size:12px;letter-spacing:.06em;color:#6b7280;margin:0 0 4px;">${isApprove ? "WITHDRAWAL APPROVAL" : "WITHDRAWAL REJECTION"}</div>
      <h1 style="font-size:19px;margin:0 0 8px;color:#111827;">${isApprove ? "Approve this withdrawal?" : "Reject this withdrawal?"}</h1>
      <p style="color:#6b7280;font-size:14px;margin:0 0 20px;">${isApprove ? "This releases the payout to the requester." : "This returns the held funds to the requester."} Reference ${v.txId.slice(0, 8)}&hellip;</p>
      ${pwField}
      <button id="go" style="width:100%;background:${color};color:#ffffff;border:0;font-weight:600;font-size:15px;padding:14px;border-radius:9px;cursor:pointer;">${label}</button>
      <p id="msg" style="text-align:center;color:#6b7280;font-size:14px;margin-top:16px;"></p>
      <script>
        var b=document.getElementById('go'),m=document.getElementById('msg'),pw=document.getElementById('pw');
        b.onclick=async function(){
          if(pw&&!pw.value){m.style.color='#b91c1c';m.textContent='Enter the superadmin password.';return;}
          b.disabled=true;b.textContent='Working\\u2026';
          try{
            var payload={token:${JSON.stringify(token)}};if(pw){payload.password=pw.value;}
            var r=await fetch(${JSON.stringify(`${BASE}/w/act`)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
            var d=await r.json();
            if(r.ok&&d.ok){b.style.display='none';if(pw)pw.style.display='none';m.style.color='#166534';m.textContent=${JSON.stringify(isApprove ? "Approved. Payout dispatched." : "Rejected. Funds returned.")};}
            else{m.style.color='#b91c1c';m.textContent=(d&&d.status)||'Already actioned or no longer pending.';b.disabled=false;b.textContent=${JSON.stringify(label)};}
          }catch(e){b.disabled=false;b.textContent=${JSON.stringify(label)};m.textContent='Network error \\u2014 try again.';}
        };
      </script>`));
  });

  // Perform the action.
  router.post(`${BASE}/w/act`, limit, async (ctx: Ctx) => {
    const body = ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : {};
    const token = typeof body.token === "string" ? body.token : "";
    const v = token ? verifyWithdrawalAction(token, secret) : null;
    if (!v) throw new ApiError("INVALID_TOKEN", "invalid or expired link", 400);
    const actor = deps.withdrawalActionActor ? await deps.withdrawalActionActor() : null;
    if (!actor) throw new ApiError("NO_ACTOR", "no admin actor configured for email actions", 503);
    if (v.action === "approve") {
      // Superadmin password gate (Issue 1): approving releases the payout, so it requires the password.
      const password = typeof body.password === "string" ? body.password : "";
      if (deps.verifyApprovalPassword && !(await deps.verifyApprovalPassword(password))) {
        return { status: 403, body: { ok: false, status: "incorrect superadmin password" } };
      }
      const r = await deps.payments.approveWithdrawal(v.txId, actor);
      return { body: r.approved ? { ok: true, status: "approved" } : { ok: false, status: "not actionable (already approved/rejected or paid)" } };
    }
    const r = await deps.payments.rejectWithdrawal(v.txId, actor);
    return { body: r.reversed ? { ok: true, status: "rejected" } : { ok: false, status: "not actionable (already approved/rejected)" } };
  });
}

export type { WithdrawalActionKind };
