import type { CSSProperties } from 'react';

/**
 * MetaTrader's palette as the CSS variables globals.css defines, NOT as the literals in lib/ui/mt5.
 *
 * The difference is the whole point. `V.surface` is the string `#0f1720`, so setting it here
 * pinned every surface that uses these tokens to the dark theme: flipping to light re-pointed
 * `--mt5-surface`, and these inline styles — which outrank every stylesheet rule — went on
 * painting the old colour underneath. Referring to the variable instead makes the inline style
 * follow the theme rather than defeat it.
 *
 * lib/ui/mt5 stays the authority for CANVAS colours, where a `var()` cannot be used.
 */
const V = {
  surface: 'var(--mt5-surface)',
  raised: 'var(--mt5-raised)',
  border: 'var(--mt5-border)',
  muted: 'var(--mt5-muted)',
  text: 'var(--mt5-text)',
  blue: 'var(--mt5-blue)',
  blueLink: 'var(--mt5-blue-link)',
  green: 'var(--mt5-green)',
  red: 'var(--mt5-red)',
} as const;

/**
 * The app's theme tokens, re-pointed at MetaTrader's palette.
 *
 * Every surface in this app paints from `--pp-*` custom properties (see globals.css and the Tailwind
 * config, where `bg-surface`, `text-muted`, `bg-accent` and the rest all resolve through them). Set
 * these on a container and everything inside it renders in MetaTrader's colours — without editing the
 * components themselves.
 *
 * That matters most for the money surfaces. The deposit and withdrawal forms are ~1,100 lines of
 * payment logic across four components: STK push, Pay Bill claim, hosted checkout, withdrawal
 * limits, throttles, polling. Restyling them by hand would mean a thousand lines of diff through
 * code that moves real money, for a change that is entirely cosmetic. Re-pointing the tokens gets
 * the same screen with the payment path untouched.
 *
 * `up`/`down` keep MetaTrader's own pairing. Only ACCENT differs between the two sets below.
 */
const SHARED = {
  '--pp-bg': V.surface,
  '--pp-surface': V.surface,
  '--pp-surface-2': V.raised,
  '--pp-border': V.border,
  '--pp-fg': V.text,
  '--pp-muted': V.muted,
  '--pp-up': V.green,
  '--pp-down': V.red,
  '--pp-accent-fg': V.text,
  '--pp-info': V.blue,
  // The brand hue skins links and soft chips; on a MetaTrader surface those read blue.
  '--pp-brand': V.blueLink,
  /**
   * MetaTrader is SQUARE. Its fields, buttons and panels have a 2px corner at most — nothing on it
   * is a pill. The brand radius is 0.875rem, which is what made the sign-in fields and the Deposit
   * button read as a consumer app sitting inside a terminal. `Input` and `Button` both corner
   * themselves from this token, so one line squares every control on these surfaces without
   * touching either component.
   */
  '--pp-radius': '2px',
} as const;

/**
 * The default set. Accent is MetaTrader's BLUE, which is its identity colour: the title bar, the
 * active control, the buy side, and your own voice in a chat thread.
 */
export const MT5_TOKENS: CSSProperties = { ...SHARED, '--pp-accent': V.blue } as CSSProperties;

/**
 * For a surface whose primary action CONFIRMS something — a deposit, a withdrawal. MetaTrader puts
 * green on a confirming action and keeps blue for chrome, so a green Deposit button is right where a
 * green chat bubble would not be.
 */
export const MT5_CONFIRM_TOKENS: CSSProperties = { ...SHARED, '--pp-accent': V.green } as CSSProperties;
