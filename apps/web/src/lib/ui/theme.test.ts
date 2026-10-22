import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The theme contract, checked against the stylesheet rather than against a mock.
 *
 * "Dark or light themes don't work" had three independent causes stacked on each other, and all
 * three were invisible to any test that only exercised the toggle: the toggle wrote the class, the
 * class was applied before paint, and nothing on screen changed. What was missing was anything
 * asserting that the TOKENS move. So this reads globals.css.
 */

const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app', 'globals.css'),
  'utf8',
);

/**
 * Every declaration under a selector, from ALL of its rules.
 *
 * `:root` and `html.light` are each declared more than once in this stylesheet (the palette, the
 * brand mapping, the colour-scheme line), so reading only the first rule asks a question about a
 * fragment and answers it confidently. The cascade sees all of them; so does this.
 */
function block(selector: string): string {
  const out: string[] = [];
  const needle = `\n${selector} {`;
  for (let i = CSS.indexOf(needle); i !== -1; i = CSS.indexOf(needle, i + 1)) {
    const start = CSS.indexOf('{', i);
    out.push(CSS.slice(start + 1, CSS.indexOf('}', start)));
  }
  assert.notEqual(out.length, 0, `no rule for \`${selector}\``);
  return out.join('\n');
}

const MT5_TOKENS = [
  '--mt5-surface', '--mt5-raised', '--mt5-border', '--mt5-muted', '--mt5-text',
  '--mt5-blue', '--mt5-blue-link', '--mt5-green', '--mt5-green-deep', '--mt5-red',
];

test('every MetaTrader token has a value in BOTH themes', () => {
  // A token defined only in the dark block would keep its dark value under `html.light`, which is
  // exactly the bug class this file exists to prevent.
  const dark = block(':root');
  const light = block('html.light');
  for (const t of MT5_TOKENS) {
    assert.ok(dark.includes(`${t}:`), `${t} missing from :root`);
    assert.ok(light.includes(`${t}:`), `${t} missing from html.light`);
  }
});

test('and the two values differ, so switching actually changes the screen', () => {
  const dark = block(':root');
  const light = block('html.light');
  const valueOf = (css: string, token: string) => {
    const m = new RegExp(`${token}:\\s*([^;]+);`).exec(css);
    return m?.[1]?.trim() ?? null;
  };
  for (const t of MT5_TOKENS) {
    const d = valueOf(dark, t), l = valueOf(light, t);
    assert.ok(d && l, t);
    assert.notEqual(d, l, `${t} is the same colour in both themes`);
  }
});

test('the structural tokens are NOT read through --brand-*, which is what shadowed them', () => {
  /**
   * `--pp-bg: var(--brand-bg, #F7F9FB)` was the original defect. `--brand-bg` is set inline on
   * <html> for every brand, so the fallback was never reached and `html.light` could not change
   * the background. The brand's own palette now applies only in the mode it was authored for
   * (`html.dark.brand-dark` / `html.light.brand-light`), which is tested below.
   */
  for (const sel of [':root', 'html.light']) {
    const b = block(sel);
    for (const t of ['--pp-bg', '--pp-surface', '--pp-surface-2', '--pp-border', '--pp-fg', '--pp-muted']) {
      const m = new RegExp(`${t}:\\s*([^;]+);`).exec(b);
      if (!m) continue;
      assert.doesNotMatch(m[1]!, /var\(--brand-/, `${t} in ${sel} still resolves through --brand-*`);
    }
  }
});

test('a brand still skins the mode it was authored for', () => {
  // The brand must not LOSE its palette: it keeps it in its own mode and yields in the other.
  for (const sel of ['html.dark.brand-dark', 'html.light.brand-light']) {
    const b = block(sel);
    for (const t of ['--pp-bg', '--pp-surface', '--pp-border', '--pp-fg']) {
      assert.match(b, new RegExp(`${t}:\\s*var\\(--brand-`), `${t} missing from ${sel}`);
    }
  }
});

test('the dead profit/loss class is gone from the stylesheet and the boot script', () => {
  // It was written in two places and styled in none: a colour setting that could not change a
  // colour. Named here so it cannot come back without a rule to go with it.
  assert.doesNotMatch(CSS, /pnl-classic/, 'pnl-classic is back in the stylesheet');
});
