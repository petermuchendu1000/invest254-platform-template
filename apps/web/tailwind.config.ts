import type { Config } from 'tailwindcss';

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
        bg: 'var(--pp-bg)',
        surface: 'var(--pp-surface)',
        'surface-2': 'var(--pp-surface-2)',
        border: 'var(--pp-border)',
        fg: 'var(--pp-fg)',
        muted: 'var(--pp-muted)',
        up: 'var(--pp-up)',
        down: 'var(--pp-down)',
        accent: 'var(--pp-accent)',
        'accent-fg': 'var(--pp-accent-fg)',
        brand: {
          DEFAULT: 'var(--pp-brand)',
          50: 'var(--pp-brand-50)', 100: 'var(--pp-brand-100)', 200: 'var(--pp-brand-200)',
          300: 'var(--pp-brand-300)', 400: 'var(--pp-brand-400)', 500: 'var(--pp-brand-500)',
          600: 'var(--pp-brand-600)', 700: 'var(--pp-brand-700)', 800: 'var(--pp-brand-800)',
          900: 'var(--pp-brand-900)', 950: 'var(--pp-brand-950)',
        },
        warn: 'var(--pp-warn)',
        info: 'var(--pp-info)',
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
