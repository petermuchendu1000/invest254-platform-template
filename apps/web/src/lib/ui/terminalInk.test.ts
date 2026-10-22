import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The foreground of a MetaTrader screen must move with its background.
 *
 * "Dark or light themes don't work" had a second half that the first fix did not reach. The tokens
 * moved -- `--mt5-surface` goes #0f1720 to #ffffff, and `theme.test.ts` pins that -- but the text on
 * top of them was the literal `text-white`, so choosing the light theme painted white labels on a
 * white screen. Not a dim screen: Settings, Funds and History were blank, and so was the drawer,
 * which is the only route to Settings on a phone. Eighteen labels on the account screen alone
 * measured 1:1 contrast.
 *
 * A token test cannot catch that, because nothing about the tokens is wrong. This reads the markup
 * and asserts the pairing: an element that paints a MetaTrader surface must not also fix its ink to
 * white. `--mt5-text` is the matching token and is the whole fix.
 *
 * White is still right in two places, and both are allowed by the rule rather than by exception:
 * `--mt5-blue` is blue in BOTH themes, so a title bar, a primary button and a badge on it keep
 * white ink; and a literal `bg-white` block (MetaTrader's own volume stepper) is white in both, so
 * its ink is a fixed dark. Neither matches the pattern below.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Every .tsx under components/, which is where the terminal's screens live. */
function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) tsxFiles(p, out);
    else if (name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/**
 * A class list that paints a MetaTrader surface AND fixes the ink to white.
 *
 * Scoped to one `className` string rather than to a whole file, so a component that has a blue bar
 * (white ink, correct) and a surface panel (token ink, correct) is not reported for having both.
 */
const SURFACE = /bg-\[var\(--mt5-(?:surface|raised)\)\]/;

function offenders(): string[] {
  const bad: string[] = [];
  for (const file of tsxFiles(join(SRC, 'components'))) {
    const src = readFileSync(file, 'utf8');
    // Every quoted class list in the file: className="…", cn('…'), and template literals.
    for (const m of src.matchAll(/["'`]([^"'`\n]*\bbg-\[var\(--mt5-(?:surface|raised)\)\][^"'`\n]*)["'`]/g)) {
      const classes = m[1]!;
      if (!SURFACE.test(classes)) continue;
      if (/\btext-white\b/.test(classes)) {
        bad.push(`${file.slice(SRC.length + 1)}: ${classes.slice(0, 110)}`);
      }
    }
  }
  return bad;
}

test('no MetaTrader surface fixes its ink to white', () => {
  const bad = offenders();
  assert.deepEqual(
    bad,
    [],
    `these paint --mt5-surface/--mt5-raised and hard-code white text, so they go white-on-white `
      + `under the light theme. Use text-[var(--mt5-text)]:\n  ${bad.join('\n  ')}`,
  );
});

test('and the token they should use is defined in both themes', () => {
  // The companion half of the rule, so a fix cannot point at a token that only exists in the dark.
  const css = readFileSync(join(SRC, 'app', 'globals.css'), 'utf8');
  for (const sel of [':root', 'html.light']) {
    const rules = [...css.matchAll(new RegExp(`\\n${sel.replace('.', '\\.')} \\{([^}]*)\\}`, 'g'))]
      .map((m) => m[1]!).join('\n');
    assert.match(rules, /--mt5-text:/, `--mt5-text missing from ${sel}`);
  }
});
