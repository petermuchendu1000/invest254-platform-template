import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOLBOX_TABS, TOOLBOX_COLUMNS, PLATFORM_COLUMNS, MT5_TOOLBOX_TAB_COUNT, toolboxTab,
  visibleToolboxTabs,
} from './toolboxTabs.js';

/**
 * MetaTrader's Toolbox, pinned BY LABEL, because a count of twelve passes just as happily with the
 * wrong twelve. Source: docs/mt5/09-toolbox.md, read off its current-build screenshots.
 */

test("the Toolbox carries MetaTrader's twelve tabs, in its order and under its labels", () => {
  assert.equal(TOOLBOX_TABS.length, MT5_TOOLBOX_TAB_COUNT);
  assert.deepEqual(TOOLBOX_TABS.map((t) => t.label), [
    'Trade', 'Exposure', 'History', 'News', 'Mailbox', 'Calendar', 'Company',
    'Alerts', 'Articles', 'Code Base', 'Experts', 'Journal',
  ]);
  // "Code Base" is two words in the tab strip. MQL5.com's own search sub-tab writes it as one,
  // which is MetaQuotes disagreeing with itself rather than a slip here.
  assert.equal(toolboxTab('codebase')?.label, 'Code Base');
});

test('Company is drawn only when the brand publishes a company page, as MetaTrader hides it', () => {
  // "This tab is hidden if the web page is disabled by the broker." The brand's own data decides;
  // see `companyPage` in lib/terminal/company.ts for what counts as published.
  const with_ = visibleToolboxTabs({ company: true });
  assert.equal(with_.length, 12);
  assert.ok(with_.some((t) => t.id === 'company'));

  const without = visibleToolboxTabs({ company: false });
  assert.equal(without.length, 11);
  assert.ok(!without.some((t) => t.id === 'company'));
  // Hiding Company does not disturb the order of the rest.
  assert.deepEqual(
    without.map((t) => t.id),
    TOOLBOX_TABS.filter((t) => t.id !== 'company').map((t) => t.id),
  );
});

test('every tab carries real content: none is disabled with an excuse', () => {
  // The four that read MQL5.com or an external feed in MetaTrader are each filled from what this
  // platform genuinely has in that place: a generated economic calendar, the broker's own article
  // library, the terminal's 38-indicator program library, and the log those indicators write.
  for (const t of TOOLBOX_TABS) {
    assert.ok(!('unavailable' in t), `${t.label} carries no "cannot fill this" reason`);
  }
  // And the only conditional tab is Company, so nothing else can quietly become hidden.
  for (const t of TOOLBOX_TABS) assert.ok(!('hidden' in t), `${t.label} is not hard-hidden`);
});

test("the Trade grid is MetaTrader's ten columns, including its two headed Price", () => {
  assert.deepEqual(TOOLBOX_COLUMNS.trade, [
    'Symbol', 'Ticket', 'Time', 'Type', 'Volume', 'Price', 'S / L', 'T / P', 'Price', 'Profit',
  ]);
  // Two columns genuinely share the heading "Price": the open price, then the current one.
  assert.equal(TOOLBOX_COLUMNS.trade!.filter((c) => c === 'Price').length, 2);
  // MetaTrader spaces the slashes in S / L and T / P.
  assert.ok(TOOLBOX_COLUMNS.trade!.includes('S / L'));
  assert.ok(TOOLBOX_COLUMNS.trade!.includes('T / P'));
});

test("History's grid is MetaTrader's twelve deal columns", () => {
  assert.deepEqual(TOOLBOX_COLUMNS.history, [
    'Time', 'Symbol', 'Deal', 'Type', 'Direction', 'Volume', 'Price', 'S / L', 'T / P',
    'Commission', 'Profit', 'Change',
  ]);
});

test('Exposure has a column headed with the deposit currency, filled in at render', () => {
  // MetaTrader writes the account's own currency code there, literally "USD" on its screenshot.
  assert.deepEqual(TOOLBOX_COLUMNS.exposure, ['Assets', 'Volume', 'Rate', '', 'Graph']);
  assert.equal(TOOLBOX_COLUMNS.exposure![3], '');
});

test("Articles is MetaTrader's own three columns", () => {
  // Read off en/articles.png, the only published image of the tab.
  assert.deepEqual(TOOLBOX_COLUMNS.articles, ['Name', 'Category', 'Date']);
});

test("Code Base and Experts do not guess at MetaTrader's headers", () => {
  // MetaQuotes has never rendered either grid, so neither appears in the table of ITS columns.
  assert.equal(TOOLBOX_COLUMNS.codebase, undefined);
  assert.equal(TOOLBOX_COLUMNS.experts, undefined);
  // What they draw is this platform's own, declared separately so the two can never be confused.
  assert.deepEqual(PLATFORM_COLUMNS.codebase, ['Name', 'Parameters', 'Group', 'Window']);
  // The Experts journal is documented as a log like Journal, and Journal's fields ARE published.
  assert.deepEqual(PLATFORM_COLUMNS.experts, TOOLBOX_COLUMNS.journal);
  // Nothing else is ours: every other tab's headers are MetaTrader's.
  assert.deepEqual(Object.keys(PLATFORM_COLUMNS).sort(), ['codebase', 'experts']);
});
