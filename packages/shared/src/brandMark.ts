/**
 * Theme-driven brand MARK (docs/24 §13). ONE vector mark, coloured entirely from the design tokens,
 * used two ways so it is always theme-aware:
 *   1. In-app logo  -> rendered inline with CSS variables (var(--pp-brand/--pp-accent/--pp-accent-fg))
 *      so it recolours INSTANTLY when the theme (or light/dark) changes, and scales to any size.
 *   2. Favicon      -> the SAME mark with the theme's colours BAKED in (a browser chrome resource
 *      can't read page CSS vars), regenerated whenever a theme is applied so the tab icon tracks it.
 *
 * The SHAPE varies per client (hash of the slug -> one of several professional marks) while the
 * COLOURS always come from the theme — so every client is distinct AND every client is theme-aware.
 * Pure vector => crisp at every phone/desktop size (16px favicon to 512px PWA icon).
 */

export interface MarkColors {
  /** gradient start (tile) */ c1: string;
  /** gradient end (tile) */ c2: string;
  /** mark ink (must contrast the tile) */ ink: string;
}

/** Stable small hash of a seed string (slug) -> variant index. */
export function markVariant(seed: string, variants = 4): number {
  let x = 0;
  for (let i = 0; i < seed.length; i++) x = (x * 31 + seed.charCodeAt(i)) >>> 0;
  return x % variants;
}

/** Inner mark geometry (viewBox 0 0 64 64), coloured with `ink` via style so var()/hex both work. */
function markInner(variant: number, ink: string): string {
  const fill = `style="fill:${ink}"`;
  const stroke = `style="fill:none;stroke:${ink}" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"`;
  switch (variant) {
    case 1: // bold upward arrow
      return `<path ${fill} d="M32 15 L48 33 L39 33 L39 49 L25 49 L25 33 L16 33 Z"/>`;
    case 2: // double chevron (ascending)
      return `<g ${stroke}><path d="M19 37 L32 24 L45 37"/><path d="M19 47 L32 34 L45 47"/></g>`;
    case 3: // rising line + arrow tip
      return `<g ${stroke}><polyline points="16,44 27,33 35,39 46,22"/></g>` +
             `<path ${fill} d="M39 20 L49 19 L48 29 Z"/>`;
    default: // ascending bars (0)
      return `<g ${fill}>` +
             `<rect x="16" y="35" width="8" height="12" rx="2.5"/>` +
             `<rect x="28" y="28" width="8" height="19" rx="2.5"/>` +
             `<rect x="40" y="19" width="8" height="28" rx="2.5"/></g>`;
  }
}

/**
 * Full mark SVG string. `idSuffix` keeps the gradient id unique when several marks render on one
 * page (pass React useId() inline; a stable value for a standalone favicon).
 */
export function buildMarkSvg(
  colors: MarkColors,
  opts: { variant?: number; size?: number; idSuffix?: string; rounded?: boolean; fluid?: boolean } = {},
): string {
  const v = opts.variant ?? 0;
  const S = opts.size ?? 64;
  const dim = opts.fluid ? `width="100%" height="100%"` : `width="${S}" height="${S}"`;
  const gid = `ppm-${(opts.idSuffix ?? String(v)).replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const rx = opts.rounded === false ? 0 : 15;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" ${dim} role="img">` +
    `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" style="stop-color:${colors.c1}"/><stop offset="1" style="stop-color:${colors.c2}"/>` +
    `</linearGradient></defs>` +
    `<rect x="2" y="2" width="60" height="60" rx="${rx}" fill="url(#${gid})"/>` +
    markInner(v, colors.ink) +
    `</svg>`
  );
}

/** The colours the mark uses, sourced from a theme's tokens (favicon path — baked hex). */
export function markColorsFromTokens(t: Record<string, string>): MarkColors {
  return { c1: t.brand || '#3861FB', c2: t.accent || t.brandHover || t.brand || '#3861FB', ink: t.accentFg || '#FFFFFF' };
}

/** The colours the mark uses in-app (live, theme-aware) — CSS custom properties. */
export const MARK_COLORS_LIVE: MarkColors = {
  c1: 'var(--pp-brand)', c2: 'var(--pp-accent)', ink: 'var(--pp-accent-fg)',
};

/** base64 (ascii-safe for our SVG) — works in the browser (btoa) and is inlined at apply time. */
function b64(s: string): string {
  if (typeof btoa === 'function') return btoa(s);
  // Node fallback (SSR / scripts)
  return Buffer.from(s, 'utf8').toString('base64');
}

/**
 * A theme-aware favicon as an SVG data URI, generated from a theme's tokens + the client's slug
 * (shape). Store in sites.favicon_url; regenerate on every theme change so the tab icon matches.
 */
export function faviconDataUri(tokens: Record<string, string>, seed: string): string {
  const svg = buildMarkSvg(markColorsFromTokens(tokens), { variant: markVariant(seed), size: 64 });
  return `data:image/svg+xml;base64,${b64(svg)}`;
}
