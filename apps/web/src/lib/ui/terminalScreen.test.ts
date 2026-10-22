import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTerminalRoute, isTerminalScreen, isBrokerTerminalBrand, presentsAsTradingProduct, TERMINAL_ROUTES } from './terminalScreen.js';

/**
 * Which routes wear MetaTrader's chrome.
 *
 * This was an exact-match Set of four paths, so `/history` was a terminal screen and
 * `/history/digits` was not, and every other page a trader can reach rendered in the generic house
 * style whatever brand it belonged to — the affiliate screen put the terminal's blue bar on top of
 * an invest254 reading column with the gaming footer underneath.
 */

test('a terminal route covers its children, which is what the Set could not do', () => {
  assert.equal(isTerminalRoute('/history'), true);
  assert.equal(isTerminalRoute('/history/digits'), true);
  assert.equal(isTerminalRoute('/legal'), true);
  assert.equal(isTerminalRoute('/legal#risk'), false, 'a fragment is not part of a pathname');
  assert.equal(isTerminalRoute('/r/ABC123'), true, 'a referral landing is a first impression of the brand');
});

test('a prefix matches a SEGMENT, never a word that merely starts the same way', () => {
  // `/accounts-payable` is not `/account`. Matching on `startsWith` alone would sweep it in.
  assert.equal(isTerminalRoute('/account'), true);
  assert.equal(isTerminalRoute('/account/security'), true);
  assert.equal(isTerminalRoute('/accounts-payable'), false);
  assert.equal(isTerminalRoute('/walletx'), false);
  assert.equal(isTerminalRoute('/historian'), false);
});

test('the operator consoles are never terminal screens', () => {
  // They are staff tools with their own sidebar shells and are not reached from the terminal.
  for (const p of ['/admin', '/admin/users', '/admin/users/42', '/platform', '/platform/billing', '/console']) {
    assert.equal(isTerminalRoute(p), false, p);
  }
});

test('the trade surface itself is not in the list: it is the shell, not a screen off it', () => {
  assert.equal(isTerminalRoute('/'), false);
});

test('nothing, and nothing-shaped, is refused rather than throwing', () => {
  assert.equal(isTerminalRoute(null), false);
  assert.equal(isTerminalRoute(undefined), false);
  assert.equal(isTerminalRoute(''), false);
});

test('every listed prefix is an absolute path with no trailing slash', () => {
  // A trailing slash would make the segment test below it never fire.
  for (const p of TERMINAL_ROUTES) {
    assert.match(p, /^\/[a-z0-9-]*$/, p);
  }
});

test('the brand half is unchanged: a candlestick brand, and never a Basic skin', () => {
  assert.equal(isTerminalScreen(true, false), true);
  assert.equal(isTerminalScreen(true, true), false, 'MetaTrader chrome is the opposite of what Basic is for');
  assert.equal(isTerminalScreen(false, false), false);
});

test('isBrokerTerminalBrand: named outright, or reached by a TradingView chart as it always was', () => {
  // The name selects the terminal whatever the chart is — that is the point of giving it one.
  assert.equal(isBrokerTerminalBrand('broker', false), true);
  assert.equal(isBrokerTerminalBrand('broker', true), true);

  // The route every candlestick brand live today arrives by: no trade_ui set, a TradingView chart.
  assert.equal(isBrokerTerminalBrand(undefined, true), true);
  assert.equal(isBrokerTerminalBrand(null, true), true);
  assert.equal(isBrokerTerminalBrand('classic', true), true);

  // A line brand is not a terminal, however it is asked.
  assert.equal(isBrokerTerminalBrand('classic', false), false);
  assert.equal(isBrokerTerminalBrand(undefined, false), false);

  // The two screens that are emphatically NOT the terminal keep their own layout even on a
  // candlestick chart — which is exactly the case the new screen runs in, and the regression that
  // would otherwise hand it MetaTrader's chrome.
  assert.equal(isBrokerTerminalBrand('candlestick', true), false);
  assert.equal(isBrokerTerminalBrand('digits', true), false);
});

/**
 * ANTI-DRIFT DEVICE. This test exists for one reason: `seededSocialProofAllowed` (packages/shared/
 * src/chart.ts) restates `isBrokerTerminalBrand`'s expression, because the shared package cannot
 * import a web module and the server has to make the same screen decision this file makes. Two
 * copies of a rule drift, and the failure mode is silent — seeded social proof appearing on a
 * MetaTrader screen, which is exactly what the product rule forbids. So every one of the 4 x 5 = 20
 * legal (trade_ui, chart_style) pairs is checked against the terminal rule as it is written HERE.
 *
 * If this fails, do not "fix" the expectation: the two definitions have diverged, and the shared
 * predicate is the one that has to follow this file.
 */
test('seededSocialProofAllowed agrees with isBrokerTerminalBrand on all 20 brand combinations', async () => {
  const { seededSocialProofAllowed, chartStyleOf, tradingViewTypeOf, CHART_STYLES, TRADE_UIS } =
    await import('@invest254/shared/chart');

  assert.equal(TRADE_UIS.length * CHART_STYLES.length, 20, 'the matrix is 4 trade_ui x 5 chart_style');

  let allowed = 0;
  for (const tradeUi of TRADE_UIS) {
    for (const chartStyle of CHART_STYLES) {
      // Exactly how both call sites compute it — TradeSurface.tsx and AppShell.tsx.
      const chartIsTradingView = tradingViewTypeOf(chartStyleOf(chartStyle)) !== null;
      const expected = !isBrokerTerminalBrand(tradeUi, chartIsTradingView) && tradeUi !== 'digits';
      assert.equal(seededSocialProofAllowed(tradeUi, chartStyle), expected, `${tradeUi}/${chartStyle}`);
      if (expected) allowed++;
    }
  }
  // Not vacuous: the matrix really does split, and it splits 6/14 (candlestick x 5, classic+line).
  assert.equal(allowed, 6);
});

/**
 * THE LIVE BRAND MATRIX, pinned.
 *
 * Thirteen call sites decided "is this a terminal?" from `chart_style` alone. Because a TradingView
 * chart type is non-null for BOTH `candlestick` and `area`, that swept up two brands that are not
 * brokers at all: cpfmarket (the single-screen candlestick shell) and mpesapap (digits). They got
 * MetaTrader's History and Settings screens, its drawer in place of the bottom nav, and its toasts.
 * These cases are the regression test for that.
 */
const CHART_IS_TRADINGVIEW = { line: false, candlestick: true, area: true } as const;

test('live brand matrix: only a real broker brand wears MetaTrader chrome', () => {
  const chrome = (tradeUi: string, chart: keyof typeof CHART_IS_TRADINGVIEW) =>
    isBrokerTerminalBrand(tradeUi, CHART_IS_TRADINGVIEW[chart]);

  // The 16 classic/line brands — never were terminals, still are not.
  assert.equal(chrome('classic', 'line'), false);
  // muchwins: classic shell on a TradingView chart. It IS reached by the legacy chart route, and
  // that is deliberate and unchanged — dropping it would silently move a live brand.
  assert.equal(chrome('classic', 'candlestick'), true);
  // cpfmarket: the candlestick shell is NOT MetaTrader. This is the bug this matrix exists for.
  assert.equal(chrome('candlestick', 'candlestick'), false);
  // mpesapap: digits is a game, not a broker — and `area` is a TradingView type, which is how it
  // was being swept in.
  assert.equal(chrome('digits', 'area'), false);
  // A brand named a broker outright is one however it charts.
  assert.equal(chrome('broker', 'line'), true);
});

test('register is a DIFFERENT question from chrome: candlestick speaks trading, digits does not', () => {
  const voice = (tradeUi: string, chart: keyof typeof CHART_IS_TRADINGVIEW) =>
    presentsAsTradingProduct(tradeUi, CHART_IS_TRADINGVIEW[chart]);

  // The candlestick shell must not wear MetaTrader's chrome, but its own copy says TOP TRADERS and
  // "How to trade" — calling its users players would contradict the screen they are standing on.
  assert.equal(voice('candlestick', 'candlestick'), true);
  assert.equal(isBrokerTerminalBrand('candlestick', true), false);   // chrome: no. voice: yes.

  // Digits and classic are prediction games: players, not traders.
  assert.equal(voice('digits', 'area'), false);
  assert.equal(voice('classic', 'line'), false);
  // A broker is a trading product on both counts.
  assert.equal(voice('broker', 'line'), true);
});
