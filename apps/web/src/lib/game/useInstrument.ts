'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { type Instrument, sigmaStep, basePrice } from '@/lib/game/instruments';

export interface InstrumentTick {
  /** epoch ms */
  t: number;
  /** price/quote */
  rate: number;
  /** change vs previous tick */
  delta: number;
}

/** Standard-normal sample (sum-of-uniforms approximation; mean 0, std 1). */
function gaussian(): number {
  return ((Math.random() + Math.random() + Math.random() + Math.random() + Math.random() + Math.random()) - 3) / Math.sqrt(0.5);
}

const SEED_TICKS = 240;
const MAX_TICKS = 2000;

/**
 * Client-side price engine for a single Volatility Index. Generates a geometric-Brownian tick
 * stream whose step size is set by the instrument's volatility level and cadence, seeded with
 * history so the chart is full immediately. Reseeds whenever the instrument changes. Exposes the
 * same `getTicks()/getLastTick()` shape the chart + digit logic consume, and a `resetKey` that
 * bumps on each reseed so the chart can re-render its data.
 *
 * This is intentionally decoupled from the shared GameSocket feed: Deriv streams each instrument
 * independently, and the digits surface is preview-stage, so driving it from a per-instrument
 * client engine is both more faithful and zero-risk to the classic game.
 */
export function useInstrument(inst: Instrument): {
  getTicks: () => InstrumentTick[];
  getLastTick: () => InstrumentTick | null;
  resetKey: string;
} {
  const bufRef = useRef<InstrumentTick[]>([]);
  const resetKeyRef = useRef<string>('');
  // Bumped after each reseed so consumers (the chart) re-render and re-read the fresh buffer.
  const [, forceReseed] = useState(0);

  useEffect(() => {
    const sigma = sigmaStep(inst.volPct, inst.tickMs);
    const base = basePrice(inst);
    const now = Date.now();

    // Seed history ending "now" so the curve is already full on load.
    const seed: InstrumentTick[] = [];
    let p = base;
    let prev = base;
    for (let i = SEED_TICKS; i > 0; i--) {
      p = p * Math.exp(sigma * gaussian());
      p += (base - p) * 0.0005; // gentle anchor so long sessions don't drift off-screen
      seed.push({ t: now - i * inst.tickMs, rate: p, delta: p - prev });
      prev = p;
    }
    bufRef.current = seed;
    resetKeyRef.current = `${inst.id}:${now}`;
    forceReseed((n) => n + 1);

    const id = window.setInterval(() => {
      const buf = bufRef.current;
      const last = buf.length ? buf[buf.length - 1]!.rate : base;
      let next = last * Math.exp(sigma * gaussian());
      next += (base - next) * 0.0005;
      buf.push({ t: Date.now(), rate: next, delta: next - last });
      if (buf.length > MAX_TICKS) buf.splice(0, buf.length - MAX_TICKS);
    }, inst.tickMs);

    return () => window.clearInterval(id);
  }, [inst.id, inst.volPct, inst.tickMs]);

  const getTicks = useCallback(() => bufRef.current, []);
  const getLastTick = useCallback(() => (bufRef.current.length ? bufRef.current[bufRef.current.length - 1]! : null), []);

  return { getTicks, getLastTick, resetKey: resetKeyRef.current };
}
