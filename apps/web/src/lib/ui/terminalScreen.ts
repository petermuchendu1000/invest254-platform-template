/**
 * Whether this request gets a MetaTrader screen off the trade surface.
 *
 * Two places have to agree: the screen itself, and the shell, which has to drop the centred reading
 * column and the marketing footer for it (a MetaTrader screen fills the window and ends at the
 * toolbar). Keeping the rule in one place is what stops them drifting apart — a terminal screen
 * inside a centred container with a footer under it is neither one thing nor the other.
 *
 * A BASIC-skin screen never qualifies: MetaTrader chrome is the opposite of what Basic is for. That
 * used to exclude every marketer, since a marketer was pinned to Basic; marketers now get the player
 * interface, so the only screen this turns away is a player who chose the simplified view.
 *
 * The parameter keeps its name because it is still what `useMarketerSkin()` returns — see the policy
 * note in lib/marketer/isMarketer.
 */
export const isTerminalScreen = (terminalBrand: boolean, isMarketer: boolean): boolean =>
  terminalBrand && !isMarketer;

/**
 * Routes that render a full-bleed MetaTrader screen outside the trade surface.
 *
 * `/dashboard` is the marketer's own page, and it belongs here for the same reason the rest do: it
 * is reached from inside the terminal, so arriving at a centred reading column with a marketing
 * footer under it would be the moment the illusion of one app breaks.
 *
 * It is a PREFIX list, and that is the fix for most of what was wrong. As an exact-match set it
 * covered five paths: `/history` was a terminal screen and `/history/digits` was not, and every
 * other page a trader can reach — the affiliate screen, the legal pages, a referral landing, the
 * offline and not-found screens — rendered in the generic house style whatever brand they belonged
 * to. The worst of them put the terminal's blue bar on top of an invest254 reading column with the
 * gaming footer underneath, which is three different products in one scroll.
 */
export const TERMINAL_ROUTES: readonly string[] = [
  '/history', '/account', '/wallet', '/dashboard', '/affiliate', '/legal', '/r', '/offline',
];

/**
 * The operator consoles are NOT terminal screens and never should be.
 *
 * They are staff tools with their own sidebar shells, they are not reached from inside the
 * terminal, and a prefix list that swept them in would restyle seventeen admin pages as a trading
 * platform. Listed explicitly so the prefix rule above can stay simple.
 */
const NEVER_TERMINAL: readonly string[] = ['/admin', '/platform', '/console'];

const underPrefix = (pathname: string, prefix: string): boolean =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

export const isTerminalRoute = (pathname: string | null | undefined): boolean => {
  if (pathname === null || pathname === undefined) return false;
  if (NEVER_TERMINAL.some((p) => underPrefix(pathname, p))) return false;
  return TERMINAL_ROUTES.some((p) => underPrefix(pathname, p));
};

/**
 * The title the SHELL must draw for a terminal route, or null when the page draws its own.
 *
 * Four screens build their own `MT5TitleBar` because they put things in it — History has its tabs
 * and its symbol filter, Funds has the account mode in its subtitle. Everything else was a bare
 * page with no bar at all: no title, no way back, and its heading flush against the window edge,
 * because the terminal shell deliberately has no gutters (the chart lives in it). Naming them here
 * gives each one MetaTrader's bar without touching the page.
 */
const OWN_TITLE_BAR: readonly string[] = ['/history', '/account', '/wallet', '/dashboard'];

const SHELL_TITLES: ReadonlyArray<readonly [prefix: string, title: string]> = [
  ['/affiliate', 'Invite friends'],
  ['/legal', 'Legal'],
  ['/r', 'Invitation'],
  ['/offline', 'Offline'],
];

export function terminalScreenTitle(pathname: string | null | undefined): string | null {
  if (!isTerminalRoute(pathname)) return null;
  const path = pathname as string;
  // `/history/digits` is under a prefix whose own page draws a bar, but it is a different page and
  // draws none. The exact-match test is what tells the parent from the child.
  if (OWN_TITLE_BAR.includes(path)) return null;
  const hit = SHELL_TITLES.find(([prefix]) => underPrefix(path, prefix));
  if (hit) return hit[1];
  // A child of a screen that titles itself: `/history/digits`. Title it after its parent.
  const parent = OWN_TITLE_BAR.find((p) => underPrefix(path, p));
  return parent === undefined ? null : parent.slice(1).replace(/^./, (c) => c.toUpperCase());
}

/**
 * Does this brand wear the BROKER terminal (MetaTrader chrome, Market Watch, order ticket)?
 *
 * Two independent routes reach it, and both have to be read the same way in the two places that
 * decide — the screen (`TradeSurface`) and the shell around it (`AppShell`):
 *
 *  - `trade_ui = 'broker'` names it outright (migration 0189);
 *  - a TradingView `chart_style` selects it too, which is the ONLY way it could be reached before
 *    0189 gave it a name. Every candlestick brand live today arrives this way, so dropping that
 *    route would silently move them to another screen.
 *
 * Pure, and takes the chart answer already computed rather than the raw style, so it can be tested
 * without a brand, a provider or the charting library. `trade_ui = 'candlestick'` is NOT this: that
 * is the single-screen layout, which has no MetaTrader chrome at all.
 */
export const isBrokerTerminalBrand = (
  tradeUi: string | null | undefined,
  chartIsTradingView: boolean,
): boolean => tradeUi === 'broker' || (tradeUi !== 'candlestick' && tradeUi !== 'digits' && chartIsTradingView);

/**
 * Does this brand PRESENT AS A TRADING PRODUCT, in the only sense the COPY cares about?
 *
 * This is a different question from `isBrokerTerminalBrand`, and conflating the two is what the
 * register note in lib/ui/register.ts could not anticipate: it was written when there were two
 * shells, so it said "the MetaTrader terminal is a broker, classic or digits is a game". The
 * candlestick shell is a third case. It is NOT MetaTrader — it must not wear the terminal's chrome
 * or screens — but it is unmistakably a trading product: its own header says TOP TRADERS, its panel
 * is the Trading Panel, and its help sheet is "How to trade". Calling its users "players" and their
 * activity "play" in the footer, the legal pages and a referral landing would contradict the screen
 * they are standing on.
 *
 * So: broker OR candlestick -> 'trading'; classic OR digits -> 'gaming'. Chrome is decided by
 * `isBrokerTerminalBrand`; vocabulary is decided here.
 */
export const presentsAsTradingProduct = (
  tradeUi: string | null | undefined,
  chartIsTradingView: boolean,
): boolean => tradeUi === 'candlestick' || isBrokerTerminalBrand(tradeUi, chartIsTradingView);
