/**
 * Per-brand web typography.
 *
 * A brand carries a title + body + mono font family (see ./siteThemes and the `theme_tokens`
 * jsonb). The app loads them from Google Fonts and exposes them as `--pp-font-title` /
 * `--pp-font-body` / `--pp-font-mono`, so a client's type is as brand-specific as its colour:
 * headings take the title face, prose the body face, and money/price displays the mono face
 * (with tabular-nums). We keep to a CURATED, self-serve (free, embeddable) Google Fonts set so
 * every brand's type is legal to ship and loads from one stylesheet. Where a brand's real face is
 * a proprietary custom font, the closest free family is used (documented in docs/23).
 */

/** Curated font families offered to brands (all free + Google-hosted). */
export const BRAND_FONTS = [
  // Sans — brand + body faces (closest free matches to each source site's real UI font).
  'Inter', 'DM Sans', 'Manrope', 'Poppins', 'Montserrat', 'Sora', 'Space Grotesk', 'Onest',
  'Hanken Grotesk', 'IBM Plex Sans', 'Rajdhani', 'Titillium Web', 'Work Sans', 'Archivo',
  'Chivo', 'Barlow', 'Red Hat Display', 'Figtree', 'Plus Jakarta Sans', 'Outfit', 'Exo 2',
  'Rubik', 'Roboto',
  // Serif — editorial brands (Gemini, some fintech).
  'Fraunces', 'Lora',
  // Mono — number/price displays on trading brands (tabular).
  'Space Mono', 'JetBrains Mono', 'IBM Plex Mono', 'Roboto Mono',
] as const;
export type BrandFont = (typeof BRAND_FONTS)[number];

const SERIF = new Set<string>(['Fraunces', 'Lora']);
const MONO = new Set<string>(['Space Mono', 'JetBrains Mono', 'IBM Plex Mono', 'Roboto Mono']);

const SANS_FALLBACK = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const SERIF_FALLBACK = 'ui-serif, Georgia, "Times New Roman", serif';
const MONO_FALLBACK = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/** A CSS font-family stack for `family`, with the right generic fallback + a system safety net. */
export function fontStack(family: string): string {
  const generic = MONO.has(family) ? MONO_FALLBACK : SERIF.has(family) ? SERIF_FALLBACK : SANS_FALLBACK;
  return `"${family}", ${generic}`;
}

/**
 * Per-family weights that actually exist on Google Fonts. Requesting a weight a family does NOT
 * publish makes the CSS2 endpoint return HTTP 400 for the WHOLE stylesheet (a real gotcha — e.g.
 * Space Mono only ships 400/700, Titillium Web skips 500). So we intersect the UI's desired
 * weights with each family's real axis instead of blindly asking for 400;500;600;700;800.
 * Families absent here fall back to the safe universal pair {400,700}.
 */
const FAMILY_WEIGHTS: Record<string, number[]> = {
  Inter: [400, 500, 600, 700, 800], 'DM Sans': [400, 500, 700], Manrope: [400, 500, 600, 700, 800],
  Poppins: [400, 500, 600, 700, 800], Montserrat: [400, 500, 600, 700, 800], Sora: [400, 500, 600, 700, 800],
  'Space Grotesk': [400, 500, 600, 700], Onest: [400, 500, 600, 700, 800], 'Hanken Grotesk': [400, 500, 600, 700, 800],
  'IBM Plex Sans': [400, 500, 600, 700], Rajdhani: [400, 500, 600, 700], 'Titillium Web': [400, 600, 700],
  'Work Sans': [400, 500, 600, 700, 800], Archivo: [400, 500, 600, 700, 800], Chivo: [400, 500, 600, 700, 800],
  Barlow: [400, 500, 600, 700, 800], 'Red Hat Display': [400, 500, 600, 700, 800], Figtree: [400, 500, 600, 700, 800],
  'Plus Jakarta Sans': [400, 500, 600, 700, 800], Outfit: [400, 500, 600, 700, 800], 'Exo 2': [400, 500, 600, 700, 800],
  Rubik: [400, 500, 600, 700, 800], Roboto: [400, 500, 700],
  Fraunces: [400, 500, 600, 700, 800], Lora: [400, 500, 600, 700],
  'Space Mono': [400, 700], 'JetBrains Mono': [400, 500, 600, 700, 800], 'IBM Plex Mono': [400, 500, 600, 700],
  'Roboto Mono': [400, 500, 600, 700],
};

/** The weights the UI renders (body 400/500, semibold 600, bold 700, heavy headings 800). */
const DESIRED_WEIGHTS = [400, 500, 600, 700, 800];

/** The real, requestable weight list for a family: desired ∩ published, always incl. 400+700. */
function weightsFor(family: string): number[] {
  const have = FAMILY_WEIGHTS[family] ?? [400, 700];
  const set = new Set(DESIRED_WEIGHTS.filter((w) => have.includes(w)));
  set.add(400);
  if (have.includes(700)) set.add(700);
  return Array.from(set).sort((a, b) => a - b);
}

/**
 * Build a Google Fonts CSS2 stylesheet URL for the given families (deduped, order preserved).
 * Requests only the weights each family actually publishes (see weightsFor) so the stylesheet
 * never 400s on a single unsupported weight. Empty -> ''.
 */
export function googleFontsHref(families: string[]): string {
  const uniq = Array.from(new Set(families.filter((f) => typeof f === 'string' && f.length > 0)));
  if (uniq.length === 0) return '';
  const specs = uniq.map(
    (f) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@${weightsFor(f).join(';')}`,
  );
  return `https://fonts.googleapis.com/css2?${specs.join('&')}&display=swap`;
}
