/**
 * AUTO trading — one decision per idle tick (BUGLOG #84). Pure: the trade screen feeds it the run's
 * state and gets back "place this stake" or "stop, and why".
 *
 * Every figure is KES cents. P&L is measured from the run's own start, so a second run after a target
 * or stop-loss starts from zero instead of stopping at once (the old bug: the session P&L never reset).
 */
export interface AutoRun { startPnlCents: number; trades: number; lossStreak: number }
export interface AutoConfig {
  baseCents: number;          // the stake entered
  multiplier: number;         // martingale factor after each loss (1 = flat)
  targetCents: number;        // stop when the run is up this much (0 = none)
  stopLossCents: number;      // stop when the run is down this much (0 = none)
  minCents: number;           // brand minimum stake
  maxCents?: number | undefined; // brand maximum stake
  balanceCents: number;       // spendable balance now
}
export type AutoStop = 'target' | 'stoploss' | 'funds' | 'stake';
export type AutoDecision = { kind: 'place'; stakeCents: number } | { kind: 'stop'; reason: AutoStop };

export const startRun = (pnlCents: number): AutoRun => ({ startPnlCents: pnlCents, trades: 0, lossStreak: 0 });
export const runPnl = (run: AutoRun, pnlCents: number) => pnlCents - run.startPnlCents;

export function nextAuto(run: AutoRun, pnlCents: number, c: AutoConfig): AutoDecision {
  const p = runPnl(run, pnlCents);
  if (c.targetCents > 0 && p >= c.targetCents) return { kind: 'stop', reason: 'target' };
  if (c.stopLossCents > 0 && p <= -c.stopLossCents) return { kind: 'stop', reason: 'stoploss' };
  if (!Number.isFinite(c.baseCents) || c.baseCents < c.minCents) return { kind: 'stop', reason: 'stake' };
  const mult = Number.isFinite(c.multiplier) && c.multiplier >= 1 ? c.multiplier : 1;
  // capped exponent: the stake is bounded by max/balance anyway, and this keeps it finite
  let next = Math.round(c.baseCents * Math.pow(mult, Math.min(run.lossStreak, 60)));
  if (!Number.isFinite(next)) next = Number.MAX_SAFE_INTEGER;
  if (c.maxCents !== undefined && next > c.maxCents) next = c.maxCents;
  if (next > c.balanceCents) next = c.balanceCents;                  // all-in on the last step, never more
  if (next < c.minCents) return { kind: 'stop', reason: 'funds' };
  return { kind: 'place', stakeCents: Math.floor(next) };
}

/** After a settle: count it and update the loss streak. */
export function afterSettle(run: AutoRun, won: boolean): AutoRun {
  return { ...run, trades: run.trades + 1, lossStreak: won ? 0 : run.lossStreak + 1 };
}
