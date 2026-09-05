/* Invest254 service worker — offline shell + safe runtime caching.
 * Strategy:
 *   - Precache a minimal offline shell.
 *   - Navigations: network-first, fall back to the cached offline shell when the
 *     network is unavailable (the live game/wallet always need fresh data, so we
 *     never serve a stale page when online).
 *   - Same-origin static assets (icons, manifest): stale-while-revalidate.
 *   - API and WebSocket traffic is never intercepted — money/game state must hit
 *     the network directly.
 */
const VERSION = 'pp-v3';
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;
const OFFLINE_URL = '/offline';
const PRECACHE = [OFFLINE_URL, '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

function isStaticAsset(url) {
  return (
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.webmanifest' ||
    url.pathname === '/favicon.png' ||
    url.pathname.startsWith('/_next/static/')
  );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // never touch API/WS/CDN cross-origin

  // App navigations: network-first with offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(SHELL_CACHE);
        return (await cache.match(OFFLINE_URL)) || Response.error();
      }),
    );
    return;
  }

  // Static assets: stale-while-revalidate.
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.open(ASSET_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const network = fetch(request)
          .then((res) => {
            if (res && res.status === 200) cache.put(request, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || network;
      }),
    );
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
 * Web Push — real-time admin withdrawal alerts (Issue 1).
 * The API sends a push whenever a player requests a withdrawal. We render an OS/browser
 * notification with inline "Approve" / "Reject" action buttons. Clicking the body (or an
 * action) opens/focuses the authenticated admin withdrawals page at the exact request —
 * the money action is executed there by the logged-in session, so no bearer token is ever
 * stored in the service worker. The page reads `?do=approve|reject` and acts on the tx.
 * ─────────────────────────────────────────────────────────────────────────── */
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (_) { payload = {}; }
  const title = payload.title || 'Invest254';
  const actions = Array.isArray(payload.actions) ? payload.actions.slice(0, 2) : [];
  const options = {
    body: payload.body || '',
    tag: payload.txId ? `withdrawal-${payload.txId}` : undefined,
    renotify: true,
    requireInteraction: true, // stay on screen until the admin acts (a payout decision matters)
    data: payload,
    actions,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  let target = data.url || '/admin/withdrawals';
  if (event.action === 'approve' || event.action === 'reject') {
    target += (target.indexOf('?') >= 0 ? '&' : '?') + 'do=' + event.action;
  }
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of wins) {
      // Reuse an already-open admin tab: focus it and navigate to the exact request.
      if (c.url && c.url.indexOf('/admin') >= 0 && 'focus' in c) {
        await c.focus();
        if ('navigate' in c) { try { await c.navigate(target); } catch (_) {} }
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});

// A browser may rotate the push subscription; drop the stale local one so the app re-subscribes
// (and re-registers with the API) the next time an admin opens the alerts settings.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(self.registration.pushManager.getSubscription().then((s) => s && s.unsubscribe()).catch(() => {}));
});
