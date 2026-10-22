import { headers, cookies } from 'next/headers';
import { resolveBrand, DEFAULT_BRAND, type Brand } from './brand.js';
import { isAdminHost } from './adminHost.js';
import { env } from '@/lib/env';

/**
 * The brand for the current REQUEST, server-side.
 *
 * It lived inside the root layout, which is where it is needed most and the only place that could
 * reach it. A second server surface then needed it (the legal page's `<title>`, which follows the
 * brand's register) and copying four functions to get at it would have been two resolutions that
 * could disagree. It is here so every server component asks the same question the same way.
 */

/** The incoming host (proxy-aware) — drives which brand this request renders. */
export function requestHost(): string {
  const h = headers();
  return (h.get('x-forwarded-host') ?? h.get('host') ?? '').split(',')[0]!.trim();
}

/**
 * #10 geo-currency: the visitor's ISO country from the CDN edge (Cloudflare `cf-ipcountry`, with a
 * Vercel fallback for preview deploys). Sentinels like 'XX'/'T1' are left as-is — the API ignores an
 * unmapped country and keeps the brand currency. Empty string when the header is absent (local dev).
 */
export function requestCountry(): string {
  const h = headers();
  return (h.get('cf-ipcountry') ?? h.get('x-vercel-ip-country') ?? '').trim();
}

/**
 * #10: the user's chosen display currency, read from the `pp-currency` cookie so it survives into SSR
 * (the bearer token lives only in localStorage, invisible to the server). The switcher sets this
 * cookie, and a signed-in user's saved server preference is synced into it after login.
 */
export function preferredCurrency(): string {
  return cookies().get('pp-currency')?.value?.trim() ?? '';
}

/**
 * Resolve the brand for the current request (host → API `sites` row, cached briefly upstream).
 *
 * THE OPERATOR HOST SHORT-CIRCUITS, and this is a fix rather than an optimisation.
 *
 * The root layout asks for a brand on every request, for every route — including `/console`,
 * `/admin` and `/platform`, which have no brand and never will. On the admin domain the API
 * answers `SITE_NOT_FOUND` by design (verified against production: `GET /site/brand?host=
 * triocodes.com` → 404), so every one of those requests spent a cross-continent round trip to be
 * told nothing, logged a warning about an unresolved host that is not a misconfiguration, and fell
 * back to DEFAULT_BRAND anyway. And because a FALLBACK is deliberately cached for seconds rather
 * than minutes (so a blip cannot pin the wrong brand on a client's domain), the console re-paid
 * that round trip almost every time.
 *
 * Measured on production before this: triocodes.com/console answered in 1.14–1.35s, SLOWER than a
 * real brand's trade screen at 0.75–0.86s — the operator console was the slowest page in the
 * product because it kept asking who it was.
 *
 * DEFAULT_BRAND is returned directly. That is what the console rendered with before, so nothing it
 * draws changes; what changes is that it stops asking.
 */
export async function currentBrand(): Promise<Brand> {
  if (isAdminHost(requestHost())) return DEFAULT_BRAND;
  return resolveBrand(env.apiBaseUrl, requestHost(), { country: requestCountry(), currency: preferredCurrency() });
}
