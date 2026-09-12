/**
 * Pure digit-contract payout math, shared by the trade console's Stake <-> Payout toggle.
 *
 * The engine is the authoritative source of the ACTUAL settlement amount; these helpers only drive
 * the client's display and the Stake<->Payout conversion, mirroring the engine's fixed-odds default
 *   return = stake x factor / winProb        (factor 0.95 => 5% house edge)
 * and its exact inverse
 *   stake  = payout x winProb / factor
 * so a target payout resolves to the stake that (per the display model) returns it. Both are total
 * (round-half-up) and total by construction: non-positive / non-finite inputs yield 0 rather than
 * throwing, so a transient winProb=0 (e.g. an Over 9 barrier) can never crash the console.
 */

function finite(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

/** Gross return (cents) for a stake, at the given win probability and payout factor. */
export function payoutForStake(stakeCents: number, winProb: number, factor: number): number {
  const s = finite(stakeCents);
  if (s <= 0 || winProb <= 0 || factor <= 0) return 0;
  return Math.round((s * factor) / winProb);
}

/** Stake (cents) required to return a target gross payout, the exact inverse of payoutForStake. */
export function stakeForPayout(payoutCents: number, winProb: number, factor: number): number {
  const p = finite(payoutCents);
  if (p <= 0 || winProb <= 0 || factor <= 0) return 0;
  return Math.round((p * winProb) / factor);
}
