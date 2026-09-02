import webpush from "web-push";
import type { WebPushTransport, PushSubscriptionRow, PushSendResult } from "@invest254/engine";

/**
 * Concrete Web Push (VAPID) transport backing PushService (Issue 1). Kept in apps/api so the
 * `web-push` dependency never leaks into the transport-agnostic @invest254/engine barrel.
 *
 * Configured from env (set as Fly/CF secrets in production; generate a pair with
 * `npx web-push generate-vapid-keys`):
 *   VAPID_PUBLIC_KEY   base64url public key (also served to the client to create subscriptions)
 *   VAPID_PRIVATE_KEY  base64url private key (secret)
 *   VAPID_SUBJECT      contact URI, e.g. "mailto:ops@invest254.com" (default used if unset)
 *
 * Returns null when keys are absent so the server leaves push unwired (routes stay absent, no
 * withdrawal fan-out) instead of crashing — push is an additive, optional capability.
 */
export function makeWebPushTransport(): WebPushTransport | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return null;
  const subject = process.env.VAPID_SUBJECT?.trim() || "mailto:ops@invest254.com";
  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
  } catch (e) {
    console.warn("[api] web-push VAPID config invalid; push disabled:", (e as Error).message);
    return null;
  }

  return {
    publicKey: () => publicKey,
    async send(sub: PushSubscriptionRow, payload: string): Promise<PushSendResult> {
      try {
        const res = await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          { TTL: 600 }, // deliver within 10 min or drop — a stale withdrawal alert is noise
        );
        return { ok: true, statusCode: res.statusCode };
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        // 404 (unknown) / 410 (gone) => the browser dropped this subscription; signal a prune.
        const gone = status === 404 || status === 410;
        return { ok: false, statusCode: status, gone, error: (err as Error).message };
      }
    },
  };
}
