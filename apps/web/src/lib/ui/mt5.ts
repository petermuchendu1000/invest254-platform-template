/**
 * MetaTrader 5's dark theme, sampled from the product itself.
 *
 * These are not approximations. Each value was read out of a MetaTrader 5 screenshot pixel by
 * pixel — the figure after each entry is how many pixels of that exact colour the sample contained,
 * which is why the surface and the raised tones are the two dominant ones.
 *
 * Previously this terminal used TradingView's Supercharts palette, which is close enough to look
 * deliberate and wrong enough to not be MetaTrader: #131722 against #0f1720, #2962ff against
 * #3183ff. Those near-misses are what stop a copy from reading as the real thing.
 *
 * MetaTrader's dark theme carries only TWO text levels — white for values, a blue-grey for labels —
 * so there is no third "body" tone here. Anything that needs to sit between them uses opacity on
 * the muted tone rather than a fourth colour that MetaTrader does not have.
 */
export const MT5 = {
  /** Panel and page surface. The sidebar and the content pane share it, separated only by a rule. (246,210 px) */
  surface: '#0f1720',
  /** Raised: title strips, footers, the selected row, an active tab. (43,620 px) */
  raised: '#202933',
  /** Primary blue — the window title bar, the active control, the buy side. (30,223 px) */
  blue: '#3183ff',
  /** Lighter blue, used for links and secondary accents. (1,502 px) */
  blueLink: '#4597ff',
  /** Confirmation green, used on the primary call to action. (7,157 px) */
  green: '#41be56',
  /** Pressed/darker green. (500 px) */
  greenDeep: '#2e9d41',
  /** Rules and control borders. (1,172 px) */
  border: '#2b3543',
  /** Labels and secondary text. (1,242 px) */
  muted: '#8fa2b8',
  /** Values and headings. (4,882 px) */
  text: '#ffffff',
  /**
   * Sell side and losses. MetaTrader pairs this with `blue`, not with a green — the green/red of a
   * casino UI is the single clearest tell that a screen is not MetaTrader.
   */
  red: '#f23645',
} as const;
