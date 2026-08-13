/**
 * Curated brand-theme presets for the /platform palette editor.
 *
 * DESIGN CONTRACT: a brand theme is ONE seed hue. `deriveMinimalPalette(seed, mode)`
 * (see ./derivePalette) expands that single hue into the whole token set — background,
 * surfaces, border, text, brand, accent and the mono gain/loss graph colours. So a preset
 * only needs to carry its seed; picking one in the editor sets the seed and the full palette
 * re-derives live. This keeps every client on the "max 2–3 colours, one hue" principle.
 *
 * The seeds are public brand hues (a colour is not ownable), chosen to be iconic and spaced
 * around the hue wheel so distinct clients stay visually distinguishable — not a raw dump of
 * look-alike blues. `source` is attribution only; it has no runtime effect. The full 105-brand
 * research set lives in docs/brand-hues-reference.json (reference data, not imported).
 */

import type { BrandFont } from './fonts.js';

/** Hue-family bucket used to group presets in the editor menu. */
export type BrandPresetGroup = 'Warm' | 'Green' | 'Teal' | 'Blue' | 'Violet' | 'Pink' | 'Mono';

export interface BrandPreset {
  /** Menu label, e.g. "Coinbase Blue". */
  label: string;
  /** Seed hex — the single hue the entire theme derives from (uppercase, #RRGGBB). */
  seed: string;
  /** Hue-family bucket for <optgroup> grouping. */
  group: BrandPresetGroup;
  /** Approximate hue in degrees (0–359); presets are spaced apart on this axis. */
  hue: number;
  /** Heading typeface (free Google family; closest match to the source brand's real face). */
  fontTitle: BrandFont;
  /** Body typeface (free Google family). */
  fontBody: BrandFont;
  /** Public brand the hue is drawn from (attribution only — no runtime effect). */
  source: string;
}

/** Curated, hue-spaced preset menu. Ordered by group, then hue. */
export const BRAND_PRESETS: readonly BrandPreset[] = [
  { label: 'Ledger Orange', seed: '#FF5300', group: 'Warm', hue: 20, fontTitle: 'Space Mono', fontBody: 'Inter', source: 'Ledger' },
  { label: 'Bitcoin Orange', seed: '#FF9500', group: 'Warm', hue: 35, fontTitle: 'Titillium Web', fontBody: 'Titillium Web', source: 'Bitcoin' },
  { label: 'Binance Gold', seed: '#F0B90A', group: 'Warm', hue: 46, fontTitle: 'Poppins', fontBody: 'Inter', source: 'Binance' },
  { label: 'Avalanche Red', seed: '#FF394A', group: 'Warm', hue: 355, fontTitle: 'Onest', fontBody: 'Inter', source: 'Avalanche' },
  { label: 'NVIDIA Lime', seed: '#76B900', group: 'Green', hue: 82, fontTitle: 'Rajdhani', fontBody: 'Inter', source: 'NVIDIA' },
  { label: 'Trezor Green', seed: '#89DB7F', group: 'Green', hue: 113, fontTitle: 'Manrope', fontBody: 'Manrope', source: 'Trezor' },
  { label: 'Spotify Green', seed: '#1ED760', group: 'Green', hue: 141, fontTitle: 'Montserrat', fontBody: 'Inter', source: 'Spotify' },
  { label: 'Solana Spring', seed: '#00FFA3', group: 'Green', hue: 158, fontTitle: 'Space Grotesk', fontBody: 'Inter', source: 'Solana' },
  { label: 'Algorand Teal', seed: '#00BEA5', group: 'Teal', hue: 172, fontTitle: 'IBM Plex Sans', fontBody: 'IBM Plex Sans', source: 'Algorand' },
  { label: 'Gemini Cyan', seed: '#26DDF9', group: 'Teal', hue: 188, fontTitle: 'Fraunces', fontBody: 'Inter', source: 'Gemini' },
  { label: 'XRP Azure', seed: '#008CFF', group: 'Blue', hue: 207, fontTitle: 'DM Sans', fontBody: 'DM Sans', source: 'Ripple' },
  { label: 'Coinbase Blue', seed: '#0052FF', group: 'Blue', hue: 221, fontTitle: 'Sora', fontBody: 'Inter', source: 'Coinbase' },
  { label: 'Stripe Indigo', seed: '#635BFF', group: 'Blue', hue: 243, fontTitle: 'Hanken Grotesk', fontBody: 'Inter', source: 'Stripe' },
  { label: 'Ethereum Violet', seed: '#6C24E0', group: 'Violet', hue: 263, fontTitle: 'Inter', fontBody: 'Inter', source: 'Ethereum' },
  { label: 'Uniswap Magenta', seed: '#FF007A', group: 'Pink', hue: 331, fontTitle: 'Lora', fontBody: 'Inter', source: 'Uniswap' },
  { label: 'Graphite Mono', seed: '#8A8F98', group: 'Mono', hue: 215, fontTitle: 'JetBrains Mono', fontBody: 'Inter', source: 'Graphite' },
];

/** Group headings in display order (only groups that have ≥ 1 preset are rendered). */
export const BRAND_PRESET_GROUPS: readonly BrandPresetGroup[] = [
  'Warm', 'Green', 'Teal', 'Blue', 'Violet', 'Pink', 'Mono',
];

/** Presets bucketed by group, in `BRAND_PRESET_GROUPS` order, each list sorted by hue. */
export function groupedPresets(): Array<{ group: BrandPresetGroup; presets: BrandPreset[] }> {
  return BRAND_PRESET_GROUPS
    .map((group) => ({
      group,
      presets: BRAND_PRESETS.filter((p) => p.group === group).sort((a, b) => a.hue - b.hue),
    }))
    .filter((g) => g.presets.length > 0);
}

/** Find a preset by its seed hex (case-insensitive). Returns undefined if none matches. */
export function presetForSeed(seed: string): BrandPreset | undefined {
  const s = seed.trim().toLowerCase();
  return BRAND_PRESETS.find((p) => p.seed.toLowerCase() === s);
}
