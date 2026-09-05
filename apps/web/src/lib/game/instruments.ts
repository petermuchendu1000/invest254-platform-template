/**
 * Deriv-accurate Volatility Index catalogue (Derived → Synthetic Indices).
 *
 * Each index is a synthetic instrument with a CONSTANT volatility level (10%–250%) and a fixed tick
 * cadence: "(1s)" indices emit one tick every second (fast action), the plain indices every two
 * seconds (normal). Higher volatility ⇒ larger price swings. These are the real Deriv levels; we do
 * NOT invent extra ones. The price stream is generated client-side per instrument (see useInstrument).
 */
export interface Instrument {
  id: string;
  /** Full name as Deriv lists it, e.g. "Volatility 75 (1s) Index". */
  label: string;
  /** Compact header label, e.g. "Vol 75 (1s)". */
  short: string;
  /** Constant volatility level in percent (10, 25, 50, 75, 100, 150, 250). */
  volPct: number;
  /** Tick cadence in ms: 1000 for "(1s)" (fast), 2000 for normal. */
  tickMs: number;
}

function mk(volPct: number, oneSec: boolean): Instrument {
  const tag = oneSec ? ' (1s)' : '';
  return {
    id: `vol${volPct}${oneSec ? '_1s' : ''}`,
    label: `Volatility ${volPct}${tag} Index`,
    short: `Vol ${volPct}${tag}`,
    volPct,
    tickMs: oneSec ? 1000 : 2000,
  };
}

/**
 * Ordered exactly like Deriv's picker: each level's (1s) fast variant first, then its 2s variant.
 * 150 and 250 exist only as (1s) on Deriv.
 */
export const INSTRUMENTS: Instrument[] = [
  mk(10, true), mk(10, false),
  mk(25, true), mk(25, false),
  mk(50, true), mk(50, false),
  mk(75, true), mk(75, false),
  mk(100, true), mk(100, false),
  mk(150, true),
  mk(250, true),
];

export const DEFAULT_INSTRUMENT_ID = 'vol10_1s';

export function instrumentById(id: string): Instrument {
  return INSTRUMENTS.find((i) => i.id === id) ?? INSTRUMENTS[0]!;
}

/**
 * Per-tick log-return sigma for an instrument. Calibrated so a Vol 10 (1s) index shows ~0.25%
 * peak-to-peak over a one-minute window (matching Deriv's on-screen magnitude), scaling linearly
 * with the volatility level and with √dt for the slower 2s cadence.
 */
export function sigmaStep(volPct: number, tickMs: number): number {
  return 0.000016 * volPct * Math.sqrt(tickMs / 1000);
}

/** A stable, per-instrument starting price so each index sits at its own level (like Deriv). */
export function basePrice(inst: Instrument): number {
  // Deterministic spread across a realistic band; no meaning beyond a distinct level per index.
  const seed = inst.volPct * 7 + (inst.tickMs === 1000 ? 3 : 1) * 131;
  return 1000 + (seed % 9000);
}
