// Pure, with no `@/` imports: `node --test` (which the deploy's verify step runs) cannot resolve the
// web alias, so a helper the suite tests has to live where it can be loaded without the bundler.
// chartSymbol re-exports it, so every caller keeps importing it from there.

/**
 * The symbol the chart is on when it is NOT the one this brand settles, or null when it is.
 *
 * This exists because "the chart is on another instrument" was being inferred from `symbol !== null`
 * alone, and that is a different claim. The stored value can legitimately BE the brand's own symbol:
 * every writer compares against a `defaultSymbol` it has to discover asynchronously, and before that
 * answer arrives the comparison is against `null` and the brand's own name gets stored. The trader
 * then saw `Trade disabled for XAUUSD.` with a button offering to `Chart XAUUSD` — a refusal to
 * trade the instrument they were already looking at, which no click could clear because clicking it
 * stored the same thing again. It survived a reload, too, because the value is persisted.
 *
 * Normalising HERE rather than at each of the three writers is the point: a writer can be wrong
 * about the default symbol, and a reader asking this question can never be. `settled` is null only
 * before the brand's own symbol is known at all, in which case nothing can be said to differ from
 * it and the honest answer is "not on another instrument".
 */
export const chartOverride = (stored: string | null, settled: string | null): string | null =>
  stored === null || settled === null || stored === settled ? null : stored;
