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
<body style="margin:0;background:#0a0a0a;color:#e5e7eb;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<div style="max-width:440px;margin:0 auto;padding:32px 20px;">${bodyHtml}</div></body></html>`;
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
    const color = isApprove ? "#22c55e" : "#ef4444";
    const label = isApprove ? "Approve &amp; pay out" : "Reject &amp; return funds";
    html(ctx, 200, page("Confirm withdrawal action", `
      <h1 style="font-size:18px;margin:0 0 6px;">${isApprove ? "Approve this withdrawal?" : "Reject this withdrawal?"}</h1>
      <p style="color:#9ca3af;font-size:14px;margin:0 0 20px;">${isApprove ? "This releases the payout to the requester." : "This returns the held funds to the requester."} Ref ${v.txId.slice(0, 8)}…</p>
      <button id="go" style="width:100%;background:${color};color:#04140a;border:0;font-weight:700;font-size:15px;padding:15px;border-radius:10px;cursor:pointer;">${label}</button>
      <p id="msg" style="text-align:center;color:#9ca3af;font-size:14px;margin-top:18px;"></p>
      <script>
        var b=document.getElementById('go'),m=document.getElementById('msg');
        b.onclick=async function(){
          b.disabled=true;b.textContent='Working…';
          try{
            var r=await fetch(${JSON.stringify(`${BASE}/w/act`)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:${JSON.stringify(token)}})});
            var d=await r.json();
            if(r.ok&&d.ok){b.style.display='none';m.style.color='#22c55e';m.textContent=${JSON.stringify(isApprove ? "✅ Approved — payout dispatched." : "✋ Rejected — funds returned.")};}
            else{m.style.color='#fca5a5';m.textContent=(d&&d.status)||'Already actioned or no longer pending.';b.style.display='none';}
          }catch(e){b.disabled=false;b.textContent=${JSON.stringify(label)};m.textContent='Network error — try again.';}
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
      const r = await deps.payments.approveWithdrawal(v.txId, actor);
      return { body: r.approved ? { ok: true, status: "approved" } : { ok: false, status: "not actionable (already approved/rejected or paid)" } };
    }
    const r = await deps.payments.rejectWithdrawal(v.txId, actor);
    return { body: r.reversed ? { ok: true, status: "rejected" } : { ok: false, status: "not actionable (already approved/rejected)" } };
  });
}

export type { WithdrawalActionKind };
