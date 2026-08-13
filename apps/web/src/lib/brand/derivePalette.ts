/**
 * Minimal-palette derivation (client mirror of the Python colour engine). ONE brand hue → a full
 * brand-tinted neutral ramp + graph gain/loss, all from lightness/chroma of that single hue. Used
 * by the /platform palette editor to preview + persist a brand's theme from just a seed colour.
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

/** Derive the full minimal token set from a seed colour + theme mode. */
export function deriveMinimalPalette(seedHex: string, mode: 'dark' | 'light' = 'dark'): ThemeTokens {
  const [H] = hexToHsl(seedHex);
  if (mode === 'dark') {
    const brand = hsl(H, 0.72, 0.52), accent = hsl(H, 0.75, 0.66);
    return {
      bg: hsl(H, 0.16, 0.055), surface: hsl(H, 0.15, 0.10), surface2: hsl(H, 0.14, 0.15),
      border: hsl(H, 0.12, 0.24), muted: hsl(H, 0.10, 0.62), fg: hsl(H, 0.06, 0.95),
      brand, brandHover: hsl(H, 0.72, 0.43), brandText: brand,
      accent, accentFg: readableInk(accent),
      up: brand, down: hsl(H, 0.10, 0.60), warn: hsl(40, 0.92, 0.56), info: hsl(212, 0.80, 0.62),
    };
  }
  const brand = hsl(H, 0.68, 0.42), accent = hsl(H, 0.70, 0.34);
  return {
    bg: hsl(H, 0.30, 0.975), surface: '#ffffff', surface2: hsl(H, 0.22, 0.945),
    border: hsl(H, 0.20, 0.86), muted: hsl(H, 0.16, 0.40), fg: hsl(H, 0.30, 0.14),
    brand, brandHover: hsl(H, 0.68, 0.34), brandText: brand,
    accent, accentFg: readableInk(accent),
    up: brand, down: hsl(H, 0.10, 0.52), warn: hsl(38, 0.95, 0.40), info: hsl(212, 0.82, 0.44),
  };
}
