/**
 * Per-brand web typography.
 *
 * A brand carries a title + body font family (see ./presets and the `theme_tokens` jsonb). The
 * app loads them from Google Fonts and exposes them as `--pp-font-title` / `--pp-font-body`, so a
 * client's type is as brand-specific as its colour. We keep to a CURATED, self-serve (free,
 * embeddable) Google Fonts set so every brand's type is legal to ship and loads from one
 * stylesheet. Where a brand's real face is a proprietary custom font, the closest free family is
 * used (documented in docs/23).
 */

/** Curated font families offered to brands (all free + Google-hosted). */
export const BRAND_FONTS = [
  'Inter', 'DM Sans', 'Manrope', 'Poppins', 'Montserrat', 'Sora', 'Space Grotesk', 'Onest',
  'Hanken Grotesk', 'IBM Plex Sans', 'Rajdhani', 'Titillium Web', 'Fraunces', 'Lora',
  'Space Mono', 'JetBrains Mono',
] as const;
export type BrandFont = (typeof BRAND_FONTS)[number];

const SERIF = new Set<string>(['Fraunces', 'Lora']);
const MONO = new Set<string>(['Space Mono', 'JetBrains Mono']);

const SANS_FALLBACK = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const SERIF_FALLBACK = 'ui-serif, Georgia, "Times New Roman", serif';
const MONO_FALLBACK = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/** A CSS font-family stack for `family`, with the right generic fallback + a system safety net. */
export function fontStack(family: string): string {
  const generic = MONO.has(family) ? MONO_FALLBACK : SERIF.has(family) ? SERIF_FALLBACK : SANS_FALLBACK;
  return `"${family}", ${generic}`;
}

/**
 * Build a Google Fonts CSS2 stylesheet URL for the given families (deduped, order preserved).
 * Requests the weights the UI uses; Google serves only those that exist per family. Empty -> ''.
 */
export function googleFontsHref(families: string[]): string {
  const uniq = Array.from(new Set(families.filter((f) => typeof f === 'string' && f.length > 0)));
  if (uniq.length === 0) return '';
  const specs = uniq.map(
    (f) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@400;500;600;700`,
  );
  return `https://fonts.googleapis.com/css2?${specs.join('&')}&display=swap`;
}
