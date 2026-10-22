import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * BRANDS ARE GUIDED BY BRAND THEMES — enforced, not just intended.
 *
 * A brand is database data: `sites.color_primary/bg/accent` → the `--pp-*` CSS variables → the
 * semantic Tailwind utilities (`bg-surface`, `text-muted`, `border-border`, `text-accent`, `up`,
 * `down`, `warn`). That is the platform template's core promise — two domains on one deployment
 * render as two different brands with no rebuild. A screen that writes `bg-[#111827]` or
 * `text-gray-400` silently opts out of it: the brand's own colours load into the variables and are
 * then never painted, so every brand on that screen looks identical.
 *
 * That is exactly what happened to the candlestick shell. It was built from a reference mock and
 * carried ~226 literal colours, so a brand whose accent is #65ecca still rendered the mock's
 * #22c55e. This guard is here so it cannot happen again — to that shell or to the next one added
 * to COVERED.
 *
 * THE BROKER TERMINAL IS DELIBERATELY EXCLUDED. MetaTrader's chrome is its own identity, painted
 * from the separate `--mt5-*` tokens; it is a product that is supposed to look like MetaTrader on
 * every brand, so it is not brand-skinned and is not listed below.
 *
 * Equally excluded: the brand theme DEFINITIONS themselves (lib/brand/*), which is where literal
 * colours are supposed to live, and the chart/drawing palettes a trader picks from by hand.
 *
 * To add a surface to the guarantee, add it to COVERED and remove its literals. To keep a single
 * justified literal, put `brand-token-exempt` in a comment on that line and say why.
 */

const ROOT = resolve(import.meta.dirname, '../../..');

/** Surfaces that MUST paint from brand tokens. Grow this list as shells are converted. */
const COVERED: readonly string[] = [
  'src/components/game/candlestick',
  'src/components/candlestick-account',
  'src/components/layout/CandlestickTopBar.tsx',
  'src/components/layout/CandlestickNavSheet.tsx',
  // Lived under `game/candlestick` and so was covered by the directory entry above; it moved out
  // when the wave shell started showing it too, and is listed by name so the move does not quietly
  // drop it out of the guarantee. It is brand-skinned on both shells that render it.
  'src/components/game/ActivityNotice.tsx',
  // The shared loading/empty treatments. They are mounted inside brand-skinned shells, so a literal
  // here would reintroduce an unskinnable surface in the middle of one.
  'src/components/ui/ChartPlaceholder.tsx',
  'src/components/ui/LiveBadge.tsx',
];

/** A literal hex colour, e.g. #0a0f1c / #fff / #22c55e80. */
const HEX = /#[0-9a-fA-F]{3,8}\b/;
/** A literal Tailwind palette utility, e.g. text-gray-400, bg-white, border-red-500. */
const TW = new RegExp(
  String.raw`\b(?:text|bg|border|fill|stroke|ring|from|to|via|divide|outline|shadow|accent|caret|decoration)-` +
  String.raw`(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)` +
  String.raw`(?:-(?:50|[1-9]00|950))?\b`,
);

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'node_modules' && name !== 'dist') yield* files(p);
      continue;
    }
    if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) yield p;
  }
}

function targets(): string[] {
  const out: string[] = [];
  for (const entry of COVERED) {
    const p = join(ROOT, entry);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else out.push(p);
  }
  return out;
}

/** Strip the parts of a line where a colour word is not a painted colour. */
function codeOf(line: string): string {
  const noLineComment = line.replace(/\/\/.*$/, '');
  const trimmed = noLineComment.trim();
  if (trimmed.startsWith('*') || trimmed.startsWith('/*')) return '';
  return noLineComment;
}

test('brand themes: covered shells paint from --pp-* tokens, never literal colours', () => {
  const hits: string[] = [];
  for (const f of targets()) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (line.includes('brand-token-exempt')) return;      // justified, and says why on the line
      const code = codeOf(line);
      if (!code) return;
      if (HEX.test(code) || TW.test(code)) {
        hits.push(`${f.slice(ROOT.length + 1)}:${i + 1}: ${line.trim().slice(0, 120)}`);
      }
    });
  }
  assert.deepEqual(
    hits,
    [],
    `These lines hard-code a colour instead of using a brand token, so the brand's own palette will ` +
    `never reach them:\n${hits.join('\n')}`,
  );
});

test('brand themes: the guard actually looks at files (it cannot silently cover nothing)', () => {
  const found = targets();
  assert.ok(found.length >= 8, `expected the covered shells to contain files, found ${found.length}`);
});

test('brand themes: the broker terminal is deliberately NOT brand-skinned', () => {
  // MetaTrader chrome is its own product identity (--mt5-* tokens) and must stay out of COVERED —
  // if someone adds it, this fails and they have to justify it rather than silently re-skin the
  // broker product on every brand.
  for (const entry of COVERED) {
    assert.ok(!/mt5/i.test(entry), `the broker terminal must not be in COVERED: ${entry}`);
  }
});
