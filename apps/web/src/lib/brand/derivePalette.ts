/**
 * Minimal-palette derivation (client mirror of the colour engine). Two-layer model (docs/22):
 * the NEUTRAL chrome (near-black bg + layered surfaces) and the SEMANTIC colours (green gain /
 * red loss / amber warn / blue info) are FIXED per mode and brand-independent; only the brand
 * IDENTITY (brand/brandHover/accent) derives from the single seed hue. Used by the /platform
 * palette editor to preview + persist a brand's theme from just a seed colour.
 */
export type ThemeTokens = Record<string, string>;

function hexToHsl(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let s = 0, hue = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) hue = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
  }
  return [hue, s, l];
}
function hsl(hue: number, s: number, l: number): string {
  hue = ((hue % 360) + 360) % 360; s = Math.max(0, Math.min(1, s)); l = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((hue / 60) % 2) - 1)), m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}
function relLum(hex: string): number {
  const h = hex.replace('#', '');
  const lin = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(parseInt(h.slice(0, 2), 16)) + 0.7152 * lin(parseInt(h.slice(2, 4), 16)) + 0.0722 * lin(parseInt(h.slice(4, 6), 16));
}
/** WCAG contrast ratio between two luminances (1..21). */
function contrastOf(a: number, b: number): number {
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}
/** Pick the ink (near-black or white) with the HIGHER contrast on `bg`. A luminance threshold
 *  mis-picks for mid-tone fills, so always maximise; guarantees >= ~4.3:1 for any hue. */
function readableInk(bg: string): string {
  const l = relLum(bg);
  return contrastOf(l, relLum('#0b0f14')) >= contrastOf(l, relLum('#ffffff')) ? '#0b0f14' : '#ffffff';
}

/** Derive the full minimal token set from a seed colour + theme mode.
 *
 * TWO-LAYER MODEL (docs/22 branding): a money product must read universally, so the SEMANTIC layer
 * (up=green gain/rising, down=red loss/falling, warn=amber, info=blue) and the NEUTRAL layer
 * (near-black background + layered surfaces, à la Binance/Coinbase/TradingView) are FIXED per mode —
 * they never bend to the brand. Only the IDENTITY layer (brand/brandHover/accent) derives from the
 * single seed hue, so a brand skins its logo/CTAs/links without ever making a falling price look
 * "neutral". Colours from CoinMarketCap's palette (up #16C784 / down #EA3943). */
const SEMANTIC = {
  dark:  { up: '#16C784', down: '#EA3943', warn: '#F0B90B', info: '#3B82F6' },
  light: { up: '#0F9D63', down: '#CF2E3B', warn: '#B45309', info: '#2563EB' },
} as const;
const NEUTRAL = {
  dark:  { bg: '#0B0E11', surface: '#151A21', surface2: '#1E252E', border: '#2A323D', muted: '#8B97A7', fg: '#EEF2F6' },
  light: { bg: '#F7F9FB', surface: '#FFFFFF', surface2: '#EEF2F6', border: '#DCE3EB', muted: '#5B6673', fg: '#0B0E11' },
} as const;

export function deriveMinimalPalette(seedHex: string, mode: 'dark' | 'light' = 'dark'): ThemeTokens {
  const [H] = hexToHsl(seedHex);
  const brand      = mode === 'dark' ? hsl(H, 0.72, 0.55) : hsl(H, 0.62, 0.42);
  const brandHover = mode === 'dark' ? hsl(H, 0.72, 0.46) : hsl(H, 0.62, 0.34);
  const accent     = mode === 'dark' ? hsl(H, 0.78, 0.66) : hsl(H, 0.66, 0.50);
  return {
    ...NEUTRAL[mode],
    brand, brandHover, brandText: brand,
    accent, accentFg: readableInk(accent),
    ...SEMANTIC[mode],
  };
}
