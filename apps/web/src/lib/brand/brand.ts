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

import { fontStack } from './fonts.js';

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
  /** Per-brand price chart style (migration 0111): 'line' (default) or 'candlestick'. */
  chartStyle?: "line" | "candlestick";
  /**
   * Display-currency units per 1 KES (KES→currency), resolved live by the API. 1 for KES brands.
   * The money of record is ALWAYS KES cents; this only drives how amounts are RENDERED. When it is
   * missing/0 (e.g. FX unavailable for a non-KES brand) the UI safely falls back to KES formatting.
   */
  fxRateFromKes?: number;
  licenceLine?: string | null;
  supportEmail?: string | null;
  /** Full per-brand design-token palette; maps to every --pp-* token (docs/22). */
  themeTokens?: Record<string, string> | null;
  /**
   * Whether this brand came from the API (true) or is the safety fallback (false) — the API was
   * unreachable, or the host has no ACTIVE brand. The app still renders on a fallback, but callers
   * (layout, monitoring) can surface it instead of silently serving the default brand (GAP 5).
   */
  resolved?: boolean;
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
  chartStyle: "line",
  fxRateFromKes: 1,
  licenceLine: "Operated under licence.",
  supportEmail: null,
  themeTokens: {
    // Two-layer model (docs/22): NEUTRAL near-black chrome + FIXED semantic colours (brand-agnostic,
    // so gain/rising is always green and loss/falling always red), plus the brand's own identity hue
    // for logo/CTAs/accent only. Semantic pair = CoinMarketCap (#16C784 / #EA3943).
    bg: "#0B0E11", surface: "#151A21", surface2: "#1E252E", border: "#2A323D",
    fg: "#EEF2F6", muted: "#8B97A7", brand: "#2CDD6D", brandHover: "#1FBD59",
    accent: "#67E997", accentFg: "#0B0F14", up: "#16C784", down: "#EA3943",
    warn: "#F0B90B", info: "#3B82F6",
    // Typography: heading + body + mono (numbers) faces + heading weight. Applied via --pp-font-*
    // / --pp-heading-weight. Shape: corner radius applied via --pp-radius (rounded-brand).
    fontTitle: "Space Grotesk", fontBody: "Inter", fontMono: "JetBrains Mono",
    headingWeight: "700", radius: "12px",
  },
  resolved: false,
};

/** Resolve the brand for a host by asking the API. Falls back to DEFAULT_BRAND on any error. */
export async function resolveBrand(apiBaseUrl: string, host: string): Promise<Brand> {
  try {
    const res = await fetch(`${apiBaseUrl}/site/brand?host=${encodeURIComponent(host)}`, {
      // Brand rarely changes; let the platform CDN cache it briefly.
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      // A 404 means this host has no ACTIVE brand — a real misconfiguration for a live client
      // domain (DNS points here but the sites row is missing/paused/typo'd). We still render so a
      // transient blip never hard-fails the app, but we surface it loudly (GAP 5): the brand carries
      // resolved:false and we warn with the host, so it shows up in SSR logs / synthetic monitoring
      // instead of silently serving the default brand on someone else's domain.
      console.warn(`[brand] no brand resolved for host "${host}" (HTTP ${res.status}); serving fallback "${DEFAULT_BRAND.slug}"`);
      return { ...DEFAULT_BRAND, resolved: false };
    }
    const b = (await res.json()) as Partial<Brand>;
    return { ...DEFAULT_BRAND, ...b, resolved: true };
  } catch (err) {
    console.warn(`[brand] brand resolution failed for host "${host}" (${(err as Error)?.message ?? "error"}); serving fallback "${DEFAULT_BRAND.slug}"`);
    return { ...DEFAULT_BRAND, resolved: false };
  }
}

/** Map a brand to the CSS custom properties the design system reads.
 *  Always exposes the 3 legacy vars; when a full `themeTokens` palette is present it also emits the
 *  complete --brand-* contract (bg/surface/border/fg/muted/up/down/warn/info/accent-fg/…) so the
 *  whole UI — logo, marquee, live curve, buttons — re-skins per brand, not just the accent. */
export function brandCssVars(b: Brand): Record<string, string> {
  const vars: Record<string, string> = {
    "--brand-primary": b.colorPrimary,
    "--brand-bg": b.colorBg,
    "--brand-accent": b.colorAccent,
  };
  const t = b.themeTokens;
  if (t) {
    const map: Record<string, string> = {
      bg: "--brand-bg", surface: "--brand-surface", surface2: "--brand-surface-2",
      border: "--brand-border", fg: "--brand-fg", muted: "--brand-muted",
      brand: "--brand-primary", brandHover: "--brand-primary-hover",
      accent: "--brand-accent", accentFg: "--brand-accent-fg",
      up: "--brand-up", down: "--brand-down", warn: "--brand-warn", info: "--brand-info",
    };
    for (const [k, cssVar] of Object.entries(map)) {
      const v = t[k];
      if (typeof v === "string" && v) vars[cssVar] = v;
    }
    // Typography tokens map to full font-family stacks (family + generic + system fallback).
    if (typeof t.fontTitle === "string" && t.fontTitle) vars["--brand-font-title"] = fontStack(t.fontTitle);
    if (typeof t.fontBody === "string" && t.fontBody) vars["--brand-font-body"] = fontStack(t.fontBody);
    // Mono face powers money/price displays (tabular). Falls back to the body face in globals.css
    // when a brand sets none, so a brand using proportional numbers just inherits its body font.
    if (typeof t.fontMono === "string" && t.fontMono) vars["--brand-font-mono"] = fontStack(t.fontMono);
    // Heading weight + corner radius are the brand's TYPE-WEIGHT and SHAPE language (a sharp,
    // heavy exchange like Binance vs a soft, medium fintech like Coinbase). Passed through raw.
    if (typeof t.headingWeight === "string" && t.headingWeight) vars["--brand-heading-weight"] = t.headingWeight;
    if (typeof t.radius === "string" && t.radius) vars["--brand-radius"] = t.radius;
  }
  return vars;
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
