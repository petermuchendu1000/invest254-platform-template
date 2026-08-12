/**
 * Brand resolution + theming (multi-tenant front-end).
 *
 * Many domains point at ONE web deployment. On each request/load the app resolves the
 * current host → brand and renders that brand's identity. Branding is DATA (served by the
 * API from the `sites` row), never hard-coded, so a new skin is a DB row + a domain — no
 * rebuild. Colours are applied as CSS custom properties so the whole UI re-skins instantly.
 *
 * Resolution order:
 *   1. `GET {API}/site/brand?host=<host>` — the authoritative per-site brand (public route).
 *   2. `NEXT_PUBLIC_DEFAULT_SITE_SLUG` fallback (single-brand / local dev).
 *   3. Hard-coded DEFAULT_BRAND (last resort so the app always renders).
 */

export interface Brand {
  siteId: string;
  slug: string;
  name: string;
  wordmarkText?: string | null;
  logoUrl?: string | null;
  faviconUrl?: string | null;
  colorPrimary: string;
  colorBg: string;
  colorAccent: string;
  theme: "dark" | "light" | "auto";
  currency: string;
  locale: string;
  licenceLine?: string | null;
  supportEmail?: string | null;
}

/** Last-resort brand so the UI always renders (used only if the API is unreachable). */
export const DEFAULT_BRAND: Brand = {
  siteId: "00000000-0000-0000-0000-000000000001",
  slug: "invest254",
  name: "Invest254",
  wordmarkText: "invest254.com",
  logoUrl: null,
  faviconUrl: null,
  colorPrimary: "#22c55e",
  colorBg: "#0a0a0a",
  colorAccent: "#06b6d4",
  theme: "dark",
  currency: "KES",
  locale: "en-KE",
  licenceLine: "Operated under licence.",
  supportEmail: null,
};

/** Resolve the brand for a host by asking the API. Falls back to DEFAULT_BRAND on any error. */
export async function resolveBrand(apiBaseUrl: string, host: string): Promise<Brand> {
  try {
    const res = await fetch(`${apiBaseUrl}/site/brand?host=${encodeURIComponent(host)}`, {
      // Brand rarely changes; let the platform CDN cache it briefly.
      headers: { accept: "application/json" },
    });
    if (!res.ok) return DEFAULT_BRAND;
    const b = (await res.json()) as Partial<Brand>;
    return { ...DEFAULT_BRAND, ...b } as Brand;
  } catch {
    return DEFAULT_BRAND;
  }
}

/** Map a brand to the CSS custom properties the design system reads. */
export function brandCssVars(b: Brand): Record<string, string> {
  return {
    "--brand-primary": b.colorPrimary,
    "--brand-bg": b.colorBg,
    "--brand-accent": b.colorAccent,
  };
}

/**
 * Inline style object for the app root so colours apply before hydration (no flash).
 * Returned as a plain string map (assignable to React's `style` prop) to keep this module
 * framework-agnostic; spread it directly: `<div style={brandRootStyle(brand)}>`.
 */
export function brandRootStyle(b: Brand): Record<string, string> {
  return brandCssVars(b);
}

/**
 * Append the brand to a WebSocket base URL as `?site=<siteId>`. The multiplexed engine binds a
 * socket to its brand at connect from `?site=` (slug|domain|id) or Host, BEFORE any token, so the
 * public tick stream starts on the right brand and the post-auth JWT `site` claim must then match.
 * Preserves any existing query string. Empty siteId → base unchanged.
 */
export function wsUrlForSite(wsBase: string, siteId: string | null | undefined): string {
  if (!siteId) return wsBase;
  const sep = wsBase.includes("?") ? "&" : "?";
  return `${wsBase}${sep}site=${encodeURIComponent(siteId)}`;
}

/** The user-facing wordmark: an explicit brand wordmark, else the brand name. */
export function brandWordmark(b: Brand): string {
  return (b.wordmarkText && b.wordmarkText.trim()) || b.name;
}
