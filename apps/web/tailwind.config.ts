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
        brand: 'var(--pp-brand)',
        warn: 'var(--pp-warn)',
        info: 'var(--pp-info)',
      },
      borderRadius: { xl: '0.875rem', '2xl': '1.25rem' },
      boxShadow: { glow: '0 0 24px -6px var(--pp-accent)' },
      maxWidth: { app: '80rem' },
    },
  },
  plugins: [],
};

export default config;
