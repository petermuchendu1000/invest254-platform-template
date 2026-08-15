import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SITE_THEMES, siteTheme } from './siteThemes.js';
import { BRAND_FONTS } from './fonts.js';

/**
 * The 50-site theme library (docs/22 branding): each client mirrors a distinct real crypto/fintech
 * site so no two clients look alike. These tests guard the contract every consumer relies on
 * (full token set, valid hex, allowed fonts, accessible contrast) and that the looks are distinct.
 */
const HEX = /^#[0-9A-Fa-f]{6}$/;
const TOKEN_KEYS = [
  'bg', 'surface', 'surface2', 'border', 'fg', 'muted',
  'brand', 'brandHover', 'brandText', 'accent', 'accentFg', 'up', 'down', 'warn', 'info',
] as const;

function rgb(h: string): [number, number, number] {
  const s = h.slice(1);
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)) as [number, number, number];
}
function lin(v: number): number { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }
function lum(h: string): number { const [r, g, b] = rgb(h); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); }
function contrast(a: string, b: string): number { const la = lum(a), lb = lum(b); const hi = Math.max(la, lb), lo = Math.min(la, lb); return (hi + 0.05) / (lo + 0.05); }

const fonts = new Set<string>(BRAND_FONTS as readonly string[]);

test('at least 50 site themes, all well-formed and accessible', () => {
  assert.ok(SITE_THEMES.length >= 50, `expected >= 50 themes, got ${SITE_THEMES.length}`);
  const ids = new Set<string>();
  for (const t of SITE_THEMES) {
    assert.ok(!ids.has(t.id), `duplicate theme id: ${t.id}`);
    ids.add(t.id);
    assert.equal(t.id, t.id.toLowerCase(), `${t.id}: id must be lowercase`);
    assert.ok(t.mode === 'dark' || t.mode === 'light', `${t.id}: bad mode ${t.mode}`);
    const tk = t.tokens as unknown as Record<string, string>;
    for (const k of TOKEN_KEYS) assert.match(tk[k]!, HEX, `${t.id}: ${k}=${tk[k]} must be #RRGGBB`);
    // Typography: title + body + mono faces must all be in the curated (loadable) set.
    for (const f of [t.tokens.fontTitle, t.tokens.fontBody, t.tokens.fontMono]) {
      assert.ok(fonts.has(f), `${t.id}: font "${f}" not in BRAND_FONTS`);
    }
    // Shape + type-weight language: a numeric heading weight and a CSS length radius.
    assert.match(t.tokens.headingWeight, /^[1-9]00$/, `${t.id}: headingWeight ${t.tokens.headingWeight} must be 100..900`);
    assert.match(t.tokens.radius, /^(0|\d+px|\d*\.?\d+rem)$/, `${t.id}: radius ${t.tokens.radius} must be a CSS length`);
    // WCAG: body text readable on bg, and accent label readable on accent fill.
    assert.ok(contrast(tk.bg!, tk.fg!) >= 4.5, `${t.id}: fg/bg contrast ${contrast(tk.bg!, tk.fg!).toFixed(2)} < 4.5`);
    assert.ok(contrast(tk.accent!, tk.accentFg!) >= 3, `${t.id}: accentFg/accent ${contrast(tk.accent!, tk.accentFg!).toFixed(2)} < 3`);
    // Semantic invariant: gain reads green-ish, loss red-ish (up greener than red, down redder than green).
    const [ur, ug] = rgb(tk.up!); const [dr, , db2] = rgb(tk.down!);
    assert.ok(ug >= ur, `${t.id}: up must read green (g>=r)`);
    assert.ok(dr >= db2, `${t.id}: down must read red (r>=b)`);
  }
});

test('every client look is visually distinct (unique brand+bg pairing)', () => {
  const seen = new Set<string>();
  for (const t of SITE_THEMES) {
    const key = `${t.tokens.brand}|${t.tokens.bg}`;
    assert.ok(!seen.has(key), `non-distinct look: ${t.label} (${key})`);
    seen.add(key);
  }
});

test('siteTheme() resolves case-insensitively; undefined for unknown', () => {
  assert.equal(siteTheme('coinmarketcap')?.label, 'CoinMarketCap');
  assert.equal(siteTheme('BINANCE')?.id, 'binance');
  assert.equal(siteTheme('  Kraken  '.trim().toLowerCase())?.id, 'kraken');
  assert.equal(siteTheme('does-not-exist'), undefined);
});
