import { SeededRng, SeedKeystream } from "./prng.js";
import { type GameConfig, CURVE_AMPLITUDE, CURVE_BASE_RATE } from "./config.js";
import type { Tick } from "./types.js";

/**
 * Authoritative shared price curve. Two processes, one per brand family — see CurveProfile.
 *
 * Neither can contain a pointed peak (a C0 cusp): the `wave` profile is a sum of sinusoids passed
 * through tanh, both C-infinity; the `market` profile is a cubic (Catmull-Rom) interpolation of its
 * sampled points, which is continuously differentiable with a bounded second derivative. Both are
 * verified by the same test — refining the sampling step must shrink the second difference
 * quadratically, which a kinked curve cannot do.
 *
 * Determinism: value(t) depends only on (serverSeed, t), so every connected client
 * renders an identical curve and outcomes are reproducible/verifiable.
 */
export interface CurveComponent { freq: number; amp: number; phase: number; }

/**
 * Two price PROCESSES, chosen per brand by chart style:
 *
 *  - `market` — candlestick/bars/area/baseline brands. A seed-derived RANDOM WALK (martingale),
 *    sampled every second and cubic-interpolated. See the WALK section below for why.
 *  - `wave` — line brands (the classic rise/fall "waves"). A band-limited Fourier spectrum: flatter
 *    and irregular at a higher base frequency, so the line crosses the centre line both ways with no
 *    readable cadence while staying smooth. `driftScale` trims the green bias so crossings stay even.
 *
 * Both are deterministic in (serverSeed, t), bounded in (-1,1) by tanh, and C2-smooth (no cusps).
 * The SettlementEngine calibrates tau/gain by sampling whichever process it is given, so
 * win-rate == targetWinRate and RTP == 1-houseEdge hold for EITHER.
 */
export type CurveProfile = "market" | "wave";

/* ── WALK (the `market` process) ───────────────────────────────────────────────────────────────
 *
 * WHY A RANDOM WALK AND NOT A RICHER FOURIER SPECTRUM.
 *
 * The candlestick UI needs believable candles at every MT5 timeframe, which the old market spectrum
 * could not give: its slowest component was a ~167 s period, so it carried no energy beyond ~3
 * minutes and one HOUR spanned 82% of a whole DAY's range (real gold ≈ 15–25%).
 *
 * Widening the spectrum to day-scale periods fixed the look but broke the ECONOMICS: a sum of
 * sinusoids is PREDICTABLE — a sine's recent slope predicts its continuation — so simply "buy when
 * the chart is rising" beat the target rate (measured RTP 0.982 vs 0.950, and >1.0 house-negative on
 * a thin-edge config). Conditioning the threshold on the visible slope only moved the leak (the
 * time-of-day drift survived) and made the gain solve blow up.
 *
 * A random walk fixes both at once, because it is a MARTINGALE: increments are independent, so no
 * strategy based on past prices beats the base rate, and range scales as sqrt(T) — which is exactly
 * the ratio real candles show.
 *
 * WHY THE SQUASH IS NOT tanh HERE. A martingale only stays a martingale under an AFFINE map. The
 * `wave` profile's tanh(s + driftBias) is a CURVED map, so the increment it passes through depends
 * on the LEVEL: tanh' is largest where the argument is nearest 0, i.e. (with driftBias 0.30) at the
 * bottom of the day's range. That is directly exploitable — "only trade when the price is low" was
 * measured at RTP 0.2679 vs 0.2500 (t = 4.4 against a size-matched control). `squash` below is the
 * IDENTITY across the whole operating range, so `value` is an exact affine image of the walk and the
 * leak is gone (worst band |t| = 1.31, i.e. indistinguishable from noise — see curve.exploit.test).
 *
 * Measured on this process (1 s steps, cubic interpolation, single unconditional tau, 12 seeds):
 *   realism     H1/D1 0.255 (ideal .204) | M15/H1 0.507 (.500) | M1/M15 0.249 (.258)
 *               body/range 0.43 (real candles ~0.5)
 *   economics   day RTP 0.2511 ± 0.0025 (target 0.25) | win-rate 0.1255 (target 0.125)
 *               trend-following 0.2502, mean-reverting 0.2504 — neither beats the base rate
 *               4h-bucket win-rate max error 0.0138 (tolerance 0.05)
 *   levels      low/mid/high band RTP vs size-matched control: max |t| 1.31 (no edge)
 *   smoothness  second difference shrinks quadratically — no cusp (see curve.test)
 *   bounds      value ∈ [-0.07, 0.62] over 40 seeds (rate 0.183..0.356), |s|max 0.524 against the
 *               0.9 knee — a 1.7x margin, so the saturating branch is never entered
 *
 * Because the map is affine, WALK_SIGMA is a pure DISPLAY-AMPLITUDE knob: scaling it rescales every
 * move, the calibrator rescales tau/gain inversely, and every dimensionless figure above is
 * unchanged (verified identical at sigma 0.0006 / 0.0008 / 0.0012).
 *
 * Determinism/fairness is strictly BETTER than the Fourier curve's: the increment is a sum of
 * uniforms and the map is arithmetic, so within the operating range value(t) uses no transcendental
 * function at all and is bit-identical on every JS engine. The whole path is a pure function of the
 * committed day seed, so it is recomputable and auditable after reveal.
 */
const WALK_STEP_S = 1;
/**
 * Per-second increment scale. Sets how far the price travels in a day — NOT the economics (see
 * above). At 0.0008 a day spans up to ≈ 0.105 in displayed rate and a 10 s round moves ≈ 4.4e-4,
 * which is why CandleChart prices at 6 decimals rather than 4: a martingale's per-round move is
 * inevitably ~1% of its daily range (sqrt(10/86400)), so the chart needs the ticks to show it.
 */
const WALK_SIGMA = 0.0008;
/**
 * Half-width of the seeded STARTING level, drawn once per (site, day).
 *
 * Without it every brand's walk begins at exactly 0, so two brands sharing a master seed track each
 * other for the first minutes of each day (they separate only as sqrt(t): ~0.013 apart after 10
 * minutes) and every price snaps back to the same level at UTC midnight. A constant offset fixes
 * both and costs nothing: it shifts the level, never an increment, so the martingale and the
 * calibration are untouched. Sized to stay well inside WALK_KNEE once a day's excursion (~0.45 at
 * this sigma) is added on top.
 */
const WALK_START_SPREAD = 0.2;
/** A full UTC day plus a margin so a round opened near midnight is not flattened by the clamp. */
const WALK_POINTS = 86_400 + 900 + 2;
/**
 * Where `squash` stops being the identity. The walk's largest excursion over a day was 0.56 across
 * 12 seeds, so the curved branch is ~1.6x beyond anything the process reaches and exists only to
 * guarantee the (-1,1) bound for a pathological seed or a very large configured `volatility`.
 */
const WALK_KNEE = 0.9;

/**
 * Bounding map for the `market` process: the identity on [-WALK_KNEE, WALK_KNEE], saturating
 * smoothly to ±1 outside it. The branches meet with equal first AND second derivatives (slope 1,
 * curvature 0 on both sides), so the join introduces no kink and no curvature step.
 *
 * Being exactly linear where the process actually lives is the whole point: it keeps the displayed
 * curve an affine image of a martingale, so volatility cannot depend on the price level.
 */
function squash(x: number): number {
  const a = x < 0 ? -x : x;
  if (a <= WALK_KNEE) return x;
  const r = 1 - WALK_KNEE;
  const s = WALK_KNEE + r * Math.tanh((a - WALK_KNEE) / r);
  return x < 0 ? -s : s;
}

interface ProfileParams {
  K: number; baseFreq: number; ratio: number; ampExp: number;
  freqJitter: readonly [number, number]; ampJitter: readonly [number, number]; driftScale: number;
}

/** Fourier parameters for the `wave` process (the `market` process is the walk above). */
const WAVE_PARAMS: ProfileParams = {
  // Higher, flatter band (~0.022 Hz up to ~2.3 Hz; 1/f^0.5) with wider jitter ⇒ irregular, no trend
  // dominance. driftScale 0.18 keeps only a slight green lean so crossings stay roughly even.
  K: 14, baseFreq: 0.022, ratio: 1.4, ampExp: 0.5, freqJitter: [0.7, 1.35], ampJitter: [0.65, 1.4], driftScale: 0.18,
};

/**
 * The seed domain a symbol's curve is drawn from.
 *
 * The default symbol keeps the bare `"curve"` domain so that every day already generated, and every
 * position already settled against it, reconstructs unchanged. A named symbol gets its own.
 */
export const DEFAULT_CURVE_SYMBOL = "XAUUSD";

export function curveDomain(symbol?: string): string {
  return symbol === undefined || symbol === DEFAULT_CURVE_SYMBOL ? "curve" : `curve:${symbol}`;
}

export class CurveGenerator {
  /** Fourier components — populated for the `wave` profile only (empty for `market`). */
  readonly components: CurveComponent[];
  private readonly ampNorm: number;
  private readonly driftScale: number;
  /** Seeded random-walk samples at WALK_STEP_S — the `market` process (null for `wave`). */
  private readonly walk: Float64Array | null;

  /**
   * `symbol` gives each tradable instrument its OWN curve from the same day seed.
   *
   * It is a domain separator on the seed, exactly as the digits shell already separates its
   * instruments with `inst:${id}` (see instrumentfeed.ts). Two symbols on one day therefore move
   * independently rather than being affine transforms of one series, which is what a second symbol
   * drawn from the same curve would have been.
   *
   * XAUUSD and any caller that passes nothing keep the bare `"curve"` domain they have always used,
   * so every historical day and every settled position reconstructs bit-for-bit as before. That
   * backwards compatibility is the reason the default is a literal rather than a formatted string.
   *
   * This does NOT change how a win, a loss or a payout is decided. In pool mode the curve is
   * cosmetic by design (see game.ts). In the statistical path the curve does decide, through
   * `signedMove` against `tau` — and a per-symbol curve is the same stochastic process with a
   * different seed, so the calibration that pins targetWinRate and RTP is unaffected. That claim is
   * tested across many symbol seeds in settle.calibration.test.ts rather than asserted here.
   */
  constructor(
    serverSeed: string,
    private readonly cfg: GameConfig,
    readonly profile: CurveProfile = "market",
    readonly symbol?: string,
  ) {
    const domain = curveDomain(symbol);
    if (profile === "market") {
      // Martingale: independent increments ⇒ no past-price strategy beats the base rate.
      // A day needs ~260k draws, so this uses the bulk keystream rather than the per-draw HMAC: same
      // uniforms, same unpredictability, ~170x faster — which is what makes reconstructing a year of
      // history for the candle chart practical (0.3s instead of 59s). See SeedKeystream.
      const rng = new SeedKeystream(serverSeed, domain, 1 + 3 * WALK_POINTS);
      const w = new Float64Array(WALK_POINTS);
      w[0] = rng.range(-WALK_START_SPREAD, WALK_START_SPREAD);
      for (let i = 1; i < WALK_POINTS; i++) {
        // Irwin–Hall(3), standardised: three uniforms have mean 1.5 and variance 3/12, so
        // 2*(sum) - 3 has mean 0 and sd 1. Chosen over Box–Muller (SeededRng.normal) because it is
        // pure arithmetic: no log/cos, so the path is bit-identical on every engine and a player can
        // recompute it exactly from the revealed seed. Each step is capped at 3 sd, which is
        // immaterial at the round scale — a 10 s move is the sum of ten of them.
        const g = 2 * (rng.next() + rng.next() + rng.next()) - 3;
        w[i] = w[i - 1]! + WALK_SIGMA * g;
      }
      this.walk = w;
      this.components = [];
      this.ampNorm = 1;
      this.driftScale = 1;
      return;
    }
    // `wave` draws only a few dozen values, so the per-draw HMAC stream costs nothing here and the
    // line brands' approved look stays byte-for-byte identical.
    const rng = new SeededRng(serverSeed, domain);
    // `wave`: a dense, non-harmonic spectrum of pink-noise sinusoids. Each component's frequency is
    // jittered off the geometric ladder with an independent seed-derived phase, so no single period
    // dominates and the pattern never visibly repeats; the band stays well under ~2.5 Hz so the sum
    // is clearly C2-smooth (no cusps — see curve.test).
    const p = WAVE_PARAMS;
    this.walk = null;
    this.driftScale = p.driftScale;
    const comps: CurveComponent[] = [];
    let ampSum = 0;
    for (let k = 0; k < p.K; k++) {
      const freq = p.baseFreq * p.ratio ** k * rng.range(p.freqJitter[0], p.freqJitter[1]);
      const amp = (1 / freq ** p.ampExp) * rng.range(p.ampJitter[0], p.ampJitter[1]);
      ampSum += amp;
      comps.push({ freq, amp, phase: rng.range(0, 2 * Math.PI) });
    }
    this.components = comps;
    this.ampNorm = ampSum; // normalise so the pre-tanh sum is ~O(1)
  }

  /**
   * Catmull-Rom interpolation of the walk: a cubic through the sampled points. It keeps the second
   * difference shrinking quadratically (the no-cusp proof — see curve.test), so the rendered line is
   * smooth, while the 1-second samples retain exact random-walk statistics. Interpolation is a fixed
   * linear combination of four neighbouring samples, so it does not disturb the martingale at the
   * scales settlement reads (round durations are seconds, not fractions of one).
   */
  private walkAt(t: number): number {
    const w = this.walk!;
    const x = Math.max(0, Math.min(w.length - 2, t / WALK_STEP_S));
    const i = Math.floor(x), f = x - i;
    const p0 = w[Math.max(0, i - 1)]!, p1 = w[i]!, p2 = w[i + 1]!, p3 = w[Math.min(w.length - 1, i + 2)]!;
    const a = 0.5 * (-p0 + 3 * p1 - 3 * p2 + p3);
    const b = 0.5 * (2 * p0 - 5 * p1 + 4 * p2 - p3);
    const c = 0.5 * (-p0 + p2);
    return ((a * f + b) * f + c) * f + p1;
  }

  /** Smooth signal in (-1, 1). t is seconds. */
  value(t: number): number {
    if (this.walk) {
      // AFFINE by construction: the bias is a constant shift and the scale a constant factor, so
      // every increment is passed through identically whatever the price level — the martingale
      // survives the map. `squash` is the identity here (the walk never reaches the knee), so this
      // is exactly `bias + scale * walk`; see the WALK notes on why a curved map leaks.
      const b = Math.max(-0.9, Math.min(0.9, this.cfg.driftBias));
      return b + (1 - Math.abs(b)) * squash(this.walkAt(t) * this.cfg.volatility);
    }
    let s = 0;
    for (const c of this.components) s += c.amp * Math.sin(2 * Math.PI * c.freq * t + c.phase);
    s /= this.ampNorm;
    // Green dominance: a positive additive OFFSET before the smooth squash. It shifts the level, not
    // the increments, so it cannot be traded against (differences — what settlement reads — are
    // untouched). Trimmed on the wave profile so its crossings stay even.
    const biased = s * this.cfg.volatility + this.cfg.driftBias * this.driftScale;
    return Math.tanh(biased);
  }

  /** Displayed rate, centred at `base`. */
  rate(t: number, base = CURVE_BASE_RATE): number {
    return base + CURVE_AMPLITUDE * this.value(t);
  }

  /** Build a tick at epoch ms relative to the day-start epoch ms. */
  tick(nowMs: number, dayStartMs: number, prevRate?: number): Tick {
    const t = (nowMs - dayStartMs) / 1000;
    const rate = this.rate(t);
    return { t: nowMs, rate, delta: prevRate === undefined ? 0 : rate - prevRate };
  }
}
