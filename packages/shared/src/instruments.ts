/**
 * Deriv-accurate Volatility Index catalogue (Derived → Synthetic Indices).
 *
 * This is the SINGLE SOURCE OF TRUTH shared by the engine (authoritative price feed +
 * settlement), and mirrored by the web selector. Each index is a synthetic instrument with a
 * CONSTANT volatility level (10%–250%) and a fixed tick cadence: "(1s)" indices emit one tick
 * every second (fast), the plain indices every two seconds (normal). Higher volatility ⇒ larger
 * price swings. These are the real Deriv levels; we do NOT invent extra ones.
 *
 * Dependency-free (no node:crypto) so the browser can import the catalogue for its selector. The
 * authoritative, provably-fair PRICE/DIGIT generation lives in `instrumentfeed.ts` (server-only).
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
  const tag = oneSec ? " (1s)" : "";
  return {
    id: `vol${volPct}${oneSec ? "_1s" : ""}`,
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

export const DEFAULT_INSTRUMENT_ID = "vol10_1s";

const BY_ID = new Map<string, Instrument>(INSTRUMENTS.map((i) => [i.id, i]));

/** Resolve an instrument by id; falls back to the default so an unknown id can never crash a trade. */
export function instrumentById(id: string): Instrument {
  return BY_ID.get(id) ?? INSTRUMENTS[0]!;
}

/** True when the id names a real instrument in the catalogue (used to reject spoofed ids). */
export function isKnownInstrument(id: string): boolean {
  return BY_ID.has(id);
}

/**
 * A stable, per-instrument starting price so each index sits at its own level (like Deriv). No
 * meaning beyond a distinct, deterministic level per index; the live movement comes from the feed.
 */
export function basePrice(inst: Instrument): number {
  const seed = inst.volPct * 7 + (inst.tickMs === 1000 ? 3 : 1) * 131;
  return 1000 + (seed % 9000);
}

/** Decimal places a quote carries (Deriv volatility indices display 2). The last digit is the pip. */
export const PIP_DECIMALS = 2;
