/**
 * MetaTrader's Toolbox tabs, as data.
 *
 * Twelve tabs, in MetaTrader's order and under its own labels, read off its current-build
 * screenshots (see docs/mt5/09-toolbox.md). "Code Base" is two words. The window itself is called
 * `Toolbox` and opens on Ctrl+T; Ctrl+F9 opens the Trade tab and focuses it, and no other tab has a
 * shortcut.
 *
 * ALL TWELVE CARRY REAL CONTENT. Four of them read MQL5.com or an external feed in MetaTrader, and
 * each is filled from the thing this platform genuinely has in that place rather than left disabled:
 *
 *   Calendar    macroeconomic releases on their real recurrences, from `shared/calendar`.
 *   Articles    the broker's own market analysis and education, from `lib/terminal/articles`.
 *   Code Base   MetaTrader's is MQL5's program library; this terminal's program library is its own
 *               38 indicators, and the tab applies them to the chart. The download MetaTrader
 *               offers is an apply here, because a compiled MQL5 binary has no meaning in a
 *               browser.
 *   Experts     the log of what the programs on the chart did, which here is the indicators: they
 *               genuinely initialise, get applied and get removed, and each writes a line.
 *
 * Company stays the one tab MetaTrader HIDES rather than disables, and the rule is now implemented
 * rather than hard-coded: it is drawn when the brand publishes a company page (a licence line or a
 * support channel) and hidden when it does not. See `companyPage` in lib/terminal/company.ts.
 *
 * MetaTrader also puts four right-aligned BUTTONS beside the tabs, not tabs: Market, Signals, VPS
 * and Tester. All four are MetaQuotes' own services, so none is drawn here.
 */

export type ToolboxTab =
  | 'trade' | 'exposure' | 'history' | 'news' | 'mailbox' | 'calendar' | 'company'
  | 'alerts' | 'articles' | 'codebase' | 'experts' | 'journal';

export interface ToolboxTabDef {
  id: ToolboxTab;
  /** Exactly as MetaTrader's tab strip writes it. */
  label: string;
}

export const TOOLBOX_TABS: readonly ToolboxTabDef[] = [
  { id: 'trade', label: 'Trade' },
  { id: 'exposure', label: 'Exposure' },
  { id: 'history', label: 'History' },
  { id: 'news', label: 'News' },
  { id: 'mailbox', label: 'Mailbox' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'company', label: 'Company' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'articles', label: 'Articles' },
  { id: 'codebase', label: 'Code Base' },
  { id: 'experts', label: 'Experts' },
  { id: 'journal', label: 'Journal' },
];

/** MetaTrader's count, pinned so the strip can be checked against its own. */
export const MT5_TOOLBOX_TAB_COUNT = 12;

/**
 * The tabs actually drawn.
 *
 * Company is conditional, on MetaTrader's own rule: *"This tab is hidden if the web page is
 * disabled by the broker."* Every other tab is unconditional in MetaTrader — not on an MQL5
 * account, not on a hedging account, not on an Expert Advisor being attached (09-toolbox.md 192) —
 * so no other tab is conditional here either.
 */
export const visibleToolboxTabs = (opts: { company: boolean }): readonly ToolboxTabDef[] =>
  opts.company ? TOOLBOX_TABS : TOOLBOX_TABS.filter((t) => t.id !== 'company');

export const toolboxTab = (id: ToolboxTab): ToolboxTabDef | undefined =>
  TOOLBOX_TABS.find((t) => t.id === id);

/**
 * MetaTrader's column headers, per tab, exactly as its own grids write them.
 *
 * Two oddities are its, not typos here: the Trade tab carries TWO columns headed `Price` (the open
 * price, then the current one), and `S / L` and `T / P` are written with spaces around the slash.
 *
 * Code Base and Experts are absent because MetaQuotes has never rendered either grid in a
 * screenshot and describes neither in prose. Guessing them would be the kind of invention this
 * whole exercise exists to avoid; docs/mt5/09-toolbox.md records both as unverified, and the
 * headers those two tabs draw are this platform's own — see `PLATFORM_COLUMNS`.
 */
export const TOOLBOX_COLUMNS: Partial<Record<ToolboxTab, readonly string[]>> = {
  trade: ['Symbol', 'Ticket', 'Time', 'Type', 'Volume', 'Price', 'S / L', 'T / P', 'Price', 'Profit'],
  // The fourth column is headed with the deposit currency's own code, so it is filled in at render.
  exposure: ['Assets', 'Volume', 'Rate', '', 'Graph'],
  history: ['Time', 'Symbol', 'Deal', 'Type', 'Direction', 'Volume', 'Price', 'S / L', 'T / P', 'Commission', 'Profit', 'Change'],
  news: ['Subject', 'Category', 'Time'],
  mailbox: ['Subject', 'From', 'To', 'Time'],
  calendar: ['Time', 'Currency', 'Event', 'Priority', 'Period', 'Actual', 'Forecast', 'Previous'],
  alerts: ['Symbol', 'Condition', 'Counter', 'Limit', 'Timeout', 'Expiration', 'Event'],
  articles: ['Name', 'Category', 'Date'],
  journal: ['Time', 'Source', 'Message'],
};

/**
 * Headers THIS PLATFORM defines, for the two tabs MetaQuotes leaves unverified.
 *
 * Kept apart from `TOOLBOX_COLUMNS` deliberately. That table is a record of MetaTrader's own
 * grids and must stay checkable against its screenshots; these two are ours, chosen for the
 * content the tabs actually carry, and the split is what stops a later reader mistaking one for
 * the other.
 *
 *   codebase  an indicator has no publication date and nothing to download, so the Articles shape
 *             (`Name | Category | Date`) that 09-toolbox.md offers as "a plausible guess" would be
 *             a column of blanks. These four are what a program library row genuinely has:
 *             MetaTrader's own name, the parameters it prints in a chart legend, its Navigator
 *             group, and which pane it draws in.
 *   experts   MetaQuotes documents the Experts journal as a log like Journal and gives a field list
 *             only for Journal, so Journal's three are used. That is an inference from its own
 *             prose, not a reading, and it is the narrowest one available.
 */
export const PLATFORM_COLUMNS: Partial<Record<ToolboxTab, readonly string[]>> = {
  codebase: ['Name', 'Parameters', 'Group', 'Window'],
  experts: ['Time', 'Source', 'Message'],
};
