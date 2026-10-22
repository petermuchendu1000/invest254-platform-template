/**
 * The broker's own article library.
 *
 * MetaTrader's Articles tab reads MQL5.com's library, which is MetaQuotes' own service and not
 * something a broker has. What a broker DOES have, and publishes, is market analysis and trader
 * education, so that is what this tab carries: written for this platform, about the instruments it
 * quotes and the mechanics it actually implements.
 *
 * Every figure quoted in these is one the reader can verify ON this terminal: the spread the ticket
 * shows, the margin the account strip prints, the stop the engine really holds. Nothing here
 * describes a feature that is not built, which is the whole reason the content lives beside the
 * code rather than in a CMS someone else fills.
 */

export type ArticleCategory = 'Education' | 'Market analysis' | 'Platform' | 'Risk';

export interface Article {
  id: string;
  name: string;
  category: ArticleCategory;
  /** Publication date, epoch ms, UTC. Fixed so the list never reorders between reads. */
  atMs: number;
  /** A one-line standfirst, which is what the grid shows under the name on a narrow pane. */
  summary: string;
  /** The body, as paragraphs. Plain text: this is a terminal pane, not a web page. */
  body: readonly string[];
}

const d = (y: number, m: number, day: number): number => Date.UTC(y, m - 1, day, 9, 0, 0);

/**
 * Newest first, which is the order a library lists and the order the grid keeps.
 *
 * Dates are fixed rather than relative so the shelf is stable: an article does not quietly become
 * "today's" on every reload, and two traders comparing notes see the same list.
 */
export const ARTICLES: readonly Article[] = [
  {
    id: 'spread-and-cost',
    name: 'What the spread costs you, and when it stops mattering',
    category: 'Education',
    atMs: d(2026, 10, 2),
    summary: 'The gap between Bid and Ask is the only fee on a position. Here is how to size it.',
    body: [
      'Every position on this platform opens against the Ask if it is a buy and the Bid if it is a sell, and closes against the other one. The difference between those two prices is the spread, and on a market-execution account it is the whole cost of the trade: there is no commission line, no overnight financing and no withdrawal fee on the position itself.',
      'The order ticket prints both sides, so the cost is visible before you commit. Subtract the Bid from the Ask and you have, in the symbol’s own points, exactly how far the market has to move in your favour before the position is worth what you paid for it. Below that distance the position is behind, however the chart looks.',
      'This is why the spread matters enormously to a trader holding a position for ninety seconds and barely at all to one holding it for a day. A gold spread of sixty points is most of a one-minute move and a rounding error against a session-long one. The cost is fixed; what changes is how much of your expected move it eats.',
      'The practical consequence: match the horizon to the cost. If you cannot name a move several times larger than the spread, the trade is paying a toll it cannot recover. Widening the stop does not fix this, because the stop is not what you are paying.',
    ],
  },
  {
    id: 'margin-and-free-margin',
    name: 'Reading the account strip: Balance, Equity, Margin, Free Margin',
    category: 'Platform',
    atMs: d(2026, 9, 28),
    summary: 'Four numbers under the chart, and why only two of them move while a trade is open.',
    body: [
      'Balance is settled money. It changes when a position closes, when you deposit and when you withdraw, and at no other time. Opening a position does not reduce it, which surprises people who expect the stake to disappear; the money is committed, not spent.',
      'Equity is Balance plus the profit or loss of everything currently open. It is the number that moves tick by tick, and it is what you would have if every position closed right now. When nothing is open, Equity and Balance are the same figure.',
      'Margin is the part of your money that your open positions are holding. Free Margin is what is left, which is what you can still open new positions against. Margin Level is Equity divided by Margin as a percentage, and it is the single number that tells you how close you are to being unable to trade.',
      'Watch Equity against Balance to see how you are doing, and Free Margin to see what you can still do. A rising Equity with a shrinking Free Margin means you are winning but running out of room, which is the position most traders are in just before they over-commit.',
    ],
  },
  {
    id: 'stops-that-fire',
    name: 'Your stop lives on the server, not in your browser',
    category: 'Risk',
    atMs: d(2026, 9, 24),
    summary: 'Where a protective level is held decides whether it protects you at all.',
    body: [
      'A Stop Loss or Take Profit set on this platform is sent to the engine and held there. It is checked on every tick, by the server, whether or not your tab is open, your phone is awake or your connection is up.',
      'That distinction is not academic. A stop that lives in the page is a stop that disarms itself when the page closes, and the moment it matters most is exactly the moment you are not watching. If you set a level and then close the terminal, the level is still armed.',
      'A stop here closes the position at what it is worth AT THE PRICE IT FIRES, not at a pre-decided outcome. That means a stop can return part of your stake rather than all-or-nothing, and it means the level you choose is the loss you are accepting, in money, before you commit.',
      'The levels survive a restart of the platform itself. They are stored with the position, so a deployment in the middle of your trade does not quietly leave it unprotected.',
    ],
  },
  {
    id: 'calendar-discipline',
    name: 'Trading around the economic calendar',
    category: 'Market analysis',
    atMs: d(2026, 9, 19),
    summary: 'Scheduled releases are the one kind of volatility you can see coming.',
    body: [
      'The Calendar tab lists macroeconomic releases with the time they publish, the currency they affect and their importance. The three-level marker is the one thing to read first: a rate decision and a payrolls print move a market, and a sentiment survey usually does not.',
      'The number that matters is not the reading itself but the reading against the forecast. A calendar highlights the gap for exactly this reason: an unemployment rate of 4.1% is neutral if 4.1% was expected and a shock if 3.6% was. Markets price the forecast in advance and trade the difference.',
      'The practical discipline is simple and most traders ignore it. Know what is due in the next hour before you open a position, because a stop placed twenty points away means nothing against a release that moves a market two hundred. Either size for it or stand aside until it has printed.',
      'Times in the Calendar are the broker’s server time, UTC, which is the same clock the Trade and History grids use. That is deliberate: one clock across the terminal means a release and a fill can be lined up without arithmetic.',
    ],
  },
  {
    id: 'gold-character',
    name: 'XAUUSD: what makes gold behave differently',
    category: 'Market analysis',
    atMs: d(2026, 9, 15),
    summary: 'A larger point value, a wider spread, and a different reaction to the same news.',
    body: [
      'Gold is quoted to two decimal places, so one point is one cent of the metal. That sounds small and is not: the instrument routinely travels several dollars in a session, which is hundreds of points, so a stop measured in the tens of points on a currency pair is nothing like the same risk on gold.',
      'The spread is correspondingly wider than a major currency pair’s. Check it on the ticket before sizing, because the same volume is a very different exposure.',
      'Gold reacts to real interest rates and to risk sentiment, which means it reads the same releases as the dollar but often in the opposite direction. A strong US print that lifts the dollar frequently presses gold, and the two moves arrive within the same second.',
      'The practical consequence is that gold rewards a wider stop and a smaller volume rather than the reverse. Traders who carry their currency-pair position sizing onto gold are usually taking several times the risk they think they are.',
    ],
  },
  {
    id: 'market-execution',
    name: 'Market execution: what you are agreeing to',
    category: 'Education',
    atMs: d(2026, 9, 10),
    summary: 'You are asking for a fill, not naming a price.',
    body: [
      'Under market execution an order is a request to trade at whatever the market is when it reaches the engine. The price on the ticket when you press the button is the price then, not a price you are promised.',
      'This is why the ticket says so plainly rather than hiding it. In a quiet market the fill and the quote are the same to the point; in a fast one they are not, and that difference is yours either way.',
      'The fill policy is Fill or Kill: the order is executed in full or not at all. It is never partly filled with the remainder left working, so you never end up holding half a position you did not plan.',
      'A rejection comes back in the order window with the reason on it. That is the whole reason the result appears there rather than as a notification that can be missed: an order you believe went through and did not is the most expensive misunderstanding in trading.',
    ],
  },
  {
    id: 'position-sizing',
    name: 'Sizing a position from the stop, not from the balance',
    category: 'Risk',
    atMs: d(2026, 9, 4),
    summary: 'Decide what you are willing to lose first; the volume follows from it.',
    body: [
      'Most traders choose a volume and then decide where the stop goes. That is backwards, and it is the reason position sizes drift upward over a losing run.',
      'Work the other way. Decide the money you are prepared to lose on this trade. Decide where the price proves you wrong, which is a question about the chart and not about your account. The distance between the entry and that level, divided into your money, is your volume. It is arithmetic, not judgement, and it is the one part of a trade you fully control.',
      'The consequence is that a tight stop permits a larger position and a wide stop demands a smaller one, so the risk you take is the same either way. A trader doing this cannot accidentally take five times their usual risk because a setup looked good.',
      'The volume stepper on the ticket moves in the symbol’s own steps and the ticket prints the money the volume represents, so the arithmetic is in front of you before you commit.',
    ],
  },
  {
    id: 'reading-the-ticket',
    name: 'Every field on the order ticket, and what it changes',
    category: 'Platform',
    atMs: d(2026, 8, 30),
    summary: 'Six controls, and only two of them affect your risk.',
    body: [
      'Volume is how much. It moves in the symbol’s own step, is bounded by the symbol’s own minimum and maximum, and the ticket prints the money it represents underneath so the number is never abstract.',
      'Stop Loss and Take Profit are the levels the engine will close you at. They can be set before the order or modified afterwards, and either way the engine holds them. These are the two fields that change your risk; everything else changes only your convenience.',
      'Bid and Ask are the two sides. A sell is filled at the Bid and a buy at the Ask, which is why the two prices sit over the two buttons that take them.',
      'Fill policy states how the order may be executed, and under market execution there is one answer: in full, or not at all. The hint under the buttons says what market execution means, because it is the one thing on the ticket that is a commitment rather than a setting.',
    ],
  },
  {
    id: 'closing-early',
    name: 'Closing early: what the price you see is worth',
    category: 'Education',
    atMs: d(2026, 8, 24),
    summary: 'A position closed before its horizon settles at what it is worth right then.',
    body: [
      'A position on this platform can be closed by hand at any time, and it settles at the value the engine computes for the price at that instant. There is no penalty for closing early and no bonus for holding on; the value is continuous.',
      'That is what makes a Stop Loss meaningful. If closing early paid a fixed outcome decided when you opened, a stop could only ever be all or nothing, and a level on the chart would be decoration. Because the payout follows the price, a stop placed halfway to your loss limit really does cost you about half.',
      'The Trade grid shows every open position with its live profit and a close control on its own row. The Close form states the volume, the price and the side before you confirm, which is the last point at which the trade is still yours to change your mind about.',
      'The number on the row is the engine’s own figure, the one it will settle on, not a client-side estimate. What you see is what closing would pay.',
    ],
  },
  {
    id: 'session-rhythm',
    name: 'The trading day has a shape',
    category: 'Market analysis',
    atMs: d(2026, 8, 18),
    summary: 'Liquidity is not constant, and neither is the behaviour of a price.',
    body: [
      'The hours around the London and New York overlap carry the most activity in the currency and metals markets, and the hours after the New York close carry the least. The same instrument behaves differently in each.',
      'In active hours a price trends and retraces in recognisable swings, and a breakout tends to follow through. In quiet hours the same chart produces small ranges that look like setups and resolve into nothing, which is where a trader with a tight stop is most reliably stopped out for no reason.',
      'Scheduled releases concentrate this further: the minutes around a major print carry a day’s worth of movement, and the minutes before it are often unnaturally still.',
      'The practical reading is that the clock belongs in the decision. A strategy that works at 14:00 UTC is not the same strategy at 03:00, and the chart alone will not tell you which one you are looking at.',
    ],
  },
];

/** Newest first, which is how a library lists and what the grid draws. */
export const articlesNewestFirst = (): readonly Article[] =>
  [...ARTICLES].sort((a, b) => b.atMs - a.atMs);

/** Every category present, for the tab's filter. */
export const ARTICLE_CATEGORIES: readonly ArticleCategory[] =
  [...new Set(ARTICLES.map((a) => a.category))].sort() as ArticleCategory[];
