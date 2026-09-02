import { apiFetch } from '@/lib/api/client';

/**
 * Client helper for admin Web Push opt-in (Issue 1). Registers the service worker's push
 * subscription against the browser's push service and mirrors it to the API so the server can send
 * real-time withdrawal-request alerts with Approve/Reject actions.
 *
 * All money actions happen in the authenticated app (the notification opens the admin withdrawals
 * page), so the service worker never holds a bearer token — this module only manages the
 * subscription lifecycle.
 */

export type PushSupport = 'supported' | 'unsupported';

/** Feature-detect: needs SW + Push API + Notification API (absent on iOS Safari < 16.4, etc.). */
export function pushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported';
  const ok = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  return ok ? 'supported' : 'unsupported';
}

/** Current OS/browser permission for notifications. */
export function notificationPermission(): NotificationPermission {
  if (typeof Notification === 'undefined') return 'denied';
  return Notification.permission;
}

/** True when this browser already has an active push subscription. */
export async function isSubscribed(): Promise<boolean> {
  if (pushSupport() !== 'supported') return false;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return false;
  const sub = await reg.pushManager.getSubscription();
  return Boolean(sub);
}

/** VAPID keys arrive base64url; the Push API wants a Uint8Array applicationServerKey. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

async function ready(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration();
  if (existing) return navigator.serviceWorker.ready;
  await navigator.serviceWorker.register('/sw.js');
  return navigator.serviceWorker.ready;
}

export type SubscribeResult =
  | { ok: true }
  | { ok: false; reason: 'unsupported' | 'permission-denied' | 'not-configured' | 'error'; message?: string };

/**
 * Enable withdrawal alerts on this device: request permission, create a push subscription with the
 * server's VAPID key, and register it with the API. Idempotent — re-running refreshes the record.
 */
export async function enableWithdrawalAlerts(token: string): Promise<SubscribeResult> {
  if (pushSupport() !== 'supported') return { ok: false, reason: 'unsupported' };
  try {
    const { key } = await apiFetch<{ key: string | null }>('/admin/push/public-key', { token });
    if (!key) return { ok: false, reason: 'not-configured' };

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return { ok: false, reason: 'permission-denied' };

    const reg = await ready();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        // Cast: the DOM lib types applicationServerKey against ArrayBuffer specifically; our
        // decoded key is a plain Uint8Array which is a valid BufferSource at runtime.
        applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
      });
    }
    const json = sub.toJSON();
    await apiFetch('/admin/push/subscribe', {
      method: 'POST',
      token,
      body: { endpoint: json.endpoint, keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth } },
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

/** Disable alerts on this device: unregister from the API then drop the browser subscription. */
export async function disableWithdrawalAlerts(token: string): Promise<{ ok: boolean }> {
  if (pushSupport() !== 'supported') return { ok: true };
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && (await reg.pushManager.getSubscription());
  if (!sub) return { ok: true };
  try {
    await apiFetch('/admin/push/unsubscribe', { method: 'POST', token, body: { endpoint: sub.endpoint } });
  } catch {
    /* best-effort server cleanup; still drop the local subscription below */
  }
  await sub.unsubscribe();
  return { ok: true };
}
