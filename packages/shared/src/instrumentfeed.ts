import { createHmac } from "node:crypto";
import { SeededRng } from "./prng.js";
import { type Instrument, basePrice, PIP_DECIMALS } from "./instruments.js";

/**
 * Authoritative, provably-fair per-instrument price/digit feed for the Deriv-style digits game.
 *
 * DESIGN (zero-assumption, provably fair):
 *  - The engine extends the existing daily-seed model to PER-INSTRUMENT curves. Everything a tick
 *    carries is a PURE function of (daySeed, instrumentId, tickIndex), so — once the day's seed is
 *    revealed — anyone can recompute every quote and every settled digit and verify fairness.
 *  - The last displayed digit (the pip a player bets on) is drawn DIRECTLY from
 *    HMAC-SHA256(daySeed, "dg:<instrument>:<index>"), which is EXACTLY uniform over 0..9. This
 *    guarantees the theoretical probabilities hold precisely (even/odd = 0.5, each digit = 0.1,
 *    over/under exact) independent of the chart's shape, so the house edge equals the payout factor
 *    with no distributional drift. The visible quote is built so its last pip equals this digit,
 *    hence "the chart digit == the settlement digit".
 *  - The whole-and-tenths part of the quote is a smooth, band-limited walk (like the classic curve)
 *    scaled by the instrument's volatility level, purely for a realistic chart. It carries no money
 *    meaning; only the last pip does.
 *
 * Because the seed stays server-side until the UTC day closes (commit-then-reveal), clients cannot
 * precompute future digits — they render ticks streamed by the engine, exactly like the classic
 * curve. Deterministic recomputation makes crash recovery of open digit contracts trivial: settle
 * against `digitAt(daySeed, instrument, settleIndex)` at any later time, idempotently.
 */
export interface InstrumentTickData {
  /** Integer tick index since day start (1 index = 1 instrument tick of `tickMs`). */
  index: number;
  /** Displayed quote at `PIP_DECIMALS` precision; its last pip equals `digit`. */
  quote: number;
  /** The authoritative last digit (0..9), uniform and provably fair. */
  digit: number;
}

const PIP_SCALE = 10 ** PIP_DECIMALS; // 100 for 2dp

/**
 * Provably-fair uniform last digit (0..9) for a given instrument tick.
 * Exactly uniform: 6 HMAC bytes → [0, 2^48) → scaled to [0, 10) → floored.
 */
export function digitAt(daySeed: string, instrumentId: string, index: number): number {
  if (!daySeed) throw new Error("daySeed is required");
  const d = createHmac("sha256", daySeed).update(`dg:${instrumentId}:${index}`).digest();
  let v = 0;
  for (let i = 0; i < 6; i++) v = v * 256 + d[i]!;
  const digit = Math.floor((v / 2 ** 48) * 10);
  return digit < 0 ? 0 : digit > 9 ? 9 : digit; // guard the (measure-zero) endpoint
}

interface Comp { freq: number; amp: number; phase: number; }

export class InstrumentFeed {
  private readonly comps: Comp[];
  private readonly ampNorm: number;
  private readonly base: number;
  private readonly vol: number;

  constructor(private readonly daySeed: string, readonly instrument: Instrument, K = 5) {
    if (!daySeed) throw new Error("daySeed is required");
    const rng = new SeededRng(daySeed, `inst:${instrument.id}`);
    const baseFreq = 0.05; // ~20 index-units per swell
    const ratio = 1.8;
    const comps: Comp[] = [];
    let ampSum = 0;
    for (let k = 0; k < K; k++) {
      const freq = baseFreq * ratio ** k;
      const amp = (1 / freq ** 0.9) * rng.range(0.85, 1.15);
      ampSum += amp;
      comps.push({ freq, amp, phase: rng.range(0, 2 * Math.PI) });
    }
    this.comps = comps;
    this.ampNorm = ampSum;
    this.base = basePrice(instrument);
    this.vol = instrument.volPct / 100; // 0.10 .. 2.50
  }

  /** Smooth signal in (-1, 1) for the chart shape (no money meaning). */
  private value(index: number): number {
    let s = 0;
    for (const c of this.comps) s += c.amp * Math.sin(2 * Math.PI * c.freq * index + c.phase);
    return Math.tanh((s / this.ampNorm) * this.vol);
  }

  /** Authoritative tick at an integer index. Pure ⇒ recomputable & verifiable from the seed. */
  tickAt(index: number): InstrumentTickData {
    const digit = digitAt(this.daySeed, this.instrument.id, index);
    // Whole-and-tenths from the smooth walk (±~2%·vol around base); last pip carries the fair digit.
    const raw = this.base * (1 + 0.02 * this.value(index));
    const tenths = Math.round(raw * 10) / 10;         // one decimal place
    const quote = Math.round(tenths * PIP_SCALE) / PIP_SCALE + digit / PIP_SCALE;
    return { index, quote: Math.round(quote * PIP_SCALE) / PIP_SCALE, digit };
  }

  /** Current integer tick index for a wall-clock instant relative to the UTC day start. */
  indexAt(nowMs: number, dayStartMs: number): number {
    return Math.max(0, Math.floor((nowMs - dayStartMs) / this.instrument.tickMs));
  }

  /** Epoch ms at which a given tick index occurs (for stream timing). */
  timeOfIndex(index: number, dayStartMs: number): number {
    return dayStartMs + index * this.instrument.tickMs;
  }
}
