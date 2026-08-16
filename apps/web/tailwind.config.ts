import type { Config } from 'tailwindcss';

/**
 * Theme tokens are hex CSS variables (`--pp-*`), which are ALSO overridden per-brand at runtime with
 * hex values from the API. Tailwind v3's `/opacity` modifier can only split rgb-channel colors, so
 * `bg-up/15`, `fill-accent/10`, `border-down/30` etc. silently produced NOTHING for these tokens —
 * every token-tinted fill, chip and soft background across the app was invisible. `color-mix()` works
 * with hex, rgb and CSS vars alike, so this helper makes the opacity modifier work everywhere while
 * leaving solid usages (`bg-up`) untouched. Theme- and brand-aware by construction.
 */
function withAlpha(cssVar: string): string {
  // Tailwind resolves colour VALUES that are functions at runtime; the config's TS type only allows
  // strings, so we cast. The function returns the plain var when no opacity modifier is used, and a
  // color-mix() when one is (`bg-up/15`), keeping everything theme- and brand-aware.
  const fn = ({ opacityValue }: { opacityValue?: string }) =>
    opacityValue === undefined
      ? `var(${cssVar})`
      : `color-mix(in srgb, var(${cssVar}) calc(${opacityValue} * 100%), transparent)`;
  return fn as unknown as string;
}

const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Extra-small breakpoint so secondary header stats can hide on the
      // narrowest phones (e.g. 320px) while staying visible from 360px up.
      screens: {
        xs: '360px',
      },
      colors: {
        bg: withAlpha('--pp-bg'),
        surface: withAlpha('--pp-surface'),
        'surface-2': withAlpha('--pp-surface-2'),
        border: withAlpha('--pp-border'),
        fg: withAlpha('--pp-fg'),
        muted: withAlpha('--pp-muted'),
        up: withAlpha('--pp-up'),
        down: withAlpha('--pp-down'),
        accent: withAlpha('--pp-accent'),
        'accent-fg': withAlpha('--pp-accent-fg'),
        brand: {
          DEFAULT: withAlpha('--pp-brand'),
          50: withAlpha('--pp-brand-50'), 100: withAlpha('--pp-brand-100'), 200: withAlpha('--pp-brand-200'),
          300: withAlpha('--pp-brand-300'), 400: withAlpha('--pp-brand-400'), 500: withAlpha('--pp-brand-500'),
          600: withAlpha('--pp-brand-600'), 700: withAlpha('--pp-brand-700'), 800: withAlpha('--pp-brand-800'),
          900: withAlpha('--pp-brand-900'), 950: withAlpha('--pp-brand-950'),
        },
        warn: withAlpha('--pp-warn'),
        info: withAlpha('--pp-info'),
      },
      // Per-brand type: `font-title` (headings), `font-body` (prose), `font-mono` (money/prices).
      // All resolve to the resolved brand's faces via the --pp-font-* custom properties.
      fontFamily: {
        title: 'var(--pp-font-title)',
        body: 'var(--pp-font-body)',
        mono: 'var(--pp-font-mono)',
      },
      // `rounded-brand` = the brand's corner radius (sharp exchange vs soft fintech). Legacy
      // xl/2xl kept for any component not yet migrated.
      borderRadius: { xl: '0.875rem', '2xl': '1.25rem', brand: 'var(--pp-radius)' },
      boxShadow: { glow: '0 0 24px -6px var(--pp-accent)' },
      maxWidth: { app: '80rem' },
    },
  },
  plugins: [],
};

export default config;
