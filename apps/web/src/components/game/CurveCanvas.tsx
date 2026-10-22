 'use client';

import { useEffect, useRef, useState } from 'react';
import { CURVE_AMPLITUDE, CURVE_BASE_RATE } from '@invest254/shared/config';
import type { Tick, ConnStatus } from '@/lib/game/types';
import { ChartPlaceholder } from '@/components/ui/ChartPlaceholder';
import { dataPhaseOf, phaseIsBlocking } from '@/lib/ui/dataPhase';

interface Colors {
  up: string;
  down: string;
  border: string;
  muted: string;
  axis: string;
  accent: string;
  secondary: string;
}

function readColors(): Colors {
  const cs = getComputedStyle(document.documentElement);
  const g = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    up: g('--pp-up', '#16C784'),
    down: g('--pp-down', '#EA3943'),
    border: g('--pp-border', '#2A323D'),
    muted: g('--pp-muted', '#8B97A7'),
    axis: g('--pp-muted', '#8B97A7'),
    accent: g('--pp-accent', '#00D395'),
    // MARKETER "below the divider" tone: an explicit per-brand token (--pp-secondary) when set, else a
    // neutral slate-indigo. Deliberately NOT signal red, so the divider stays legible without the
    // trading green/red colour tell. (--pp-info is avoided: some brands set it equal to the accent.)
    secondary: g('--pp-secondary', '#8A93C2'),
  };
}

function hexA(hex: string, a: number): string {
  const h = hex.replace('#', '').trim();
  if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(h)) return hex;
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

type Pt = [number, number];

// Catmull-Rom control-point tension. Smaller = tighter/sharper peaks (was 1/6).
const SMOOTH = 0.085;

function smoothPath(ctx: CanvasRenderingContext2D, p: Pt[]): void {
  const first = p[0];
  if (!first) return;
  ctx.moveTo(first[0], first[1]);
  for (let i = 0; i < p.length - 1; i++) {
    const p1 = p[i];
    const p2 = p[i + 1];
    if (!p1 || !p2) continue;
    const p0 = p[i - 1] ?? p1;
    const p3 = p[i + 2] ?? p2;
    const cp1x = p1[0] + (p2[0] - p0[0]) * SMOOTH;
    const cp1y = p1[1] + (p2[1] - p0[1]) * SMOOTH;
    const cp2x = p2[0] - (p3[0] - p1[0]) * SMOOTH;
    const cp2y = p2[1] - (p3[1] - p1[1]) * SMOOTH;
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2[0], p2[1]);
  }
}

// Signed display value ∈ (-1, 1): the curve's tanh signal recovered from `rate`.
const toValue = (rate: number) => (rate - CURVE_BASE_RATE) / CURVE_AMPLITUDE;
// Tight symmetric vertical scale so waves fill the canvas (taller); ±1 spikes clip a touch.
const Y_MAX = 0.9;
// y-axis calibration lines/labels at 0.2 intervals.
const AXIS_TICKS = [-0.8, -0.6, -0.4, -0.2, 0, 0.2, 0.4, 0.6, 0.8];

/** MARKETER anticipation beat: the live round's elapsed progress (0→1) and the latest settled
 *  outcome, so the board can show a "round is about to resolve" meter + payoff — all driven by the
 *  REAL contract timer and REAL settlement (never faked). Both are optional; players never pass them. */
export interface MarketerBeat {
  /** Active contract: elapsed fraction (0 at open → 1 at expiry), or null when nothing is live. */
  getProgress: () => number | null;
  /** Monotonic id of the last settled outcome + whether it won; null until the first settle. */
  resolve: { id: number; won: boolean } | null;
}

export function CurveCanvas({
  getTicks,
  getLastTick,
  windowMs,
  marketer = false,
  numbers = true,
  beat,
  status = 'open',
}: {
  getTicks: () => Tick[];
  getLastTick: () => Tick | null;
  windowMs: number;
  /** MARKETER: render a neutral single-colour wave — no price axis/grid/labels and no red/green
   *  up-down split — so the motion reads as a game visual, not a trading chart (TikTok Phase 2). */
  marketer?: boolean;
  /**
   * Draw the y-axis NUMBERS and their calibration grid.
   *
   * They are the curve's own unitless value, between about -1 and +1, which is the right axis for
   * the line-brand chart this canvas was written for. It is the wrong one beside a price: the phone
   * order ticket draws this canvas as MetaTrader's tick chart directly under a quote reading
   * 3081.42, and an axis running 0.8 to -0.8 next to it reads as a second, contradictory price.
   *
   * With it off the grid and the labels go and the wave keeps its shape, its red/green split and
   * its zero line, which is what a small tick chart is for: the direction of the last minute, not a
   * scale to read off.
   */
  numbers?: boolean;
  /** MARKETER: live round progress + settlement, for the anticipation beat (perimeter charge meter
   *  + live-point pulse + payoff burst). Ignored unless `marketer` is set. */
  beat?: MarketerBeat;
  /**
   * The socket's state, used ONLY to word the empty view.
   *
   * The canvas painted its own "Waiting for live ticks…" at 12px, unthemed, and invisible to a
   * screen reader (the canvas carries a static `aria-label`). Worse, it could not tell a first
   * connection from a dropped one, because the connection state never reached here. Optional, so
   * the phone order ticket can keep mounting this without one.
   */
  status?: ConnStatus;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /**
   * Is the canvas drawing anything RIGHT NOW (does the window hold at least two points)?
   *
   * Live rather than latched, unlike the chart components: those keep their last picture across a
   * drop, so they must not re-blank. This canvas does not — `drawEmpty` clears it the moment the
   * window empties, so a wave whose feed stops ticking for a whole window really is a blank box,
   * and that is exactly when the words are needed. The canvas painted them itself before; this is
   * the same condition, now in the DOM.
   *
   * Written from the render loop, which runs every frame, so the ref guards the one `setState` to
   * the two genuine transitions.
   */
  const [curveEmpty, setCurveEmpty] = useState(true);
  const emptyRef = useRef(true);
  const markEmpty = (next: boolean) => {
    if (emptyRef.current === next) return;
    emptyRef.current = next;
    setCurveEmpty(next);
  };
  const windowRef = useRef(windowMs);
  windowRef.current = windowMs;
  const marketerRef = useRef(marketer);
  marketerRef.current = marketer;
  const numbersRef = useRef(numbers);
  numbersRef.current = numbers;
  const beatRef = useRef(beat);
  beatRef.current = beat;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let cssW = 0;
    let cssH = 0;
    let dpr = 1;
    let colors = readColors();
    let seenT = 0;
    let seenPerf = 0;

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      cssW = r.width;
      cssH = r.height;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(cssW * dpr));
      canvas.height = Math.max(1, Math.round(cssH * dpr));
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const mo = new MutationObserver(() => {
      colors = readColors();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const PAD_Y = 12;
    // gutter so the curve never paints over the y-axis labels; marketers have no axis, so no gutter.
    const PAD_LEFT = marketer || !numbers ? 8 : 30;
    // MARKETER: a right gutter leaving a clear GAP between the wave tip (+ its live-point beacon) and
    // the board edge — the wave never runs into the edge. Players keep the full-bleed right edge.
    const PAD_RIGHT = marketer ? 28 : 0;

    // Vertical geometry for the fixed ±Y_MAX scale; 0 sits dead-centre.
    const geom = () => {
      const usableH = Math.max(1, cssH - 2 * PAD_Y);
      const Y = (v: number) => {
        const c = Math.max(-Y_MAX, Math.min(Y_MAX, v));
        return PAD_Y + usableH * ((Y_MAX - c) / (2 * Y_MAX));
      };
      return { Y, y0: PAD_Y + usableH * 0.5 };
    };

    // MARKETER: a single centre DIVIDER — the reference line the wave rises above (accent) or dips
    // below (neutral). No numeric labels, no calibration grid: a game guide line, not a price axis.
    const drawDivider = (Y: (v: number) => number) => {
      const y = Y(0);
      ctx.save();
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = hexA(colors.muted, 0.45);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PAD_LEFT, y);
      ctx.lineTo(cssW, y);
      ctx.stroke();
      ctx.restore();
    };

    // MARKETER: ALTITUDE ZONE TINT behind the wave — a soft vertical wash, accent glow toward the top,
    // neutral toward the bottom, clear at the divider. Height reads from colour intensity, so there are
    // no numbers or gridlines for a classifier to parse as a price axis — it reads as an arcade background.
    const drawZones = (y0: number) => {
      const g = ctx.createLinearGradient(0, PAD_Y, 0, cssH - PAD_Y);
      g.addColorStop(0, hexA(colors.accent, 0.12));
      g.addColorStop(Math.max(0, (y0 - PAD_Y) / Math.max(1, cssH - 2 * PAD_Y) - 0.02), hexA(colors.accent, 0));
      g.addColorStop(Math.min(1, (y0 - PAD_Y) / Math.max(1, cssH - 2 * PAD_Y) + 0.02), hexA(colors.secondary, 0));
      g.addColorStop(1, hexA(colors.secondary, 0.12));
      ctx.fillStyle = g;
      ctx.fillRect(PAD_LEFT, PAD_Y, cssW - PAD_LEFT, cssH - 2 * PAD_Y);
    };

    // y-axis calibration grid (0.2 steps) + labels; the 0-axis is emphasised.
    const drawAxis = (Y: (v: number) => number) => {
      ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (const v of AXIS_TICKS) {
        const y = Y(v);
        const zero = v === 0;
        // Without the numbers only the zero line is drawn: it is what tells an up minute from a
        // down one, and the 0.2 grid without labels against it would be decoration.
        if (!numbersRef.current && !zero) continue;
        ctx.strokeStyle = hexA(colors.axis, zero ? 0.5 : 0.13);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(PAD_LEFT, y);
        ctx.lineTo(cssW, y);
        ctx.stroke();
        if (!numbersRef.current) continue;
        ctx.fillStyle = hexA(colors.muted, zero ? 0.95 : 0.55);
        ctx.fillText(v.toFixed(1), PAD_LEFT - 5, y);
      }
    };

    // ── MARKETER anticipation beat ────────────────────────────────────────────────────────────────
    // Tracks the last settled outcome so a new settlement plays a short payoff burst once.
    let lastResolveId: number | null = null;
    let burstStart = 0;
    let burstWon = false;

    // LIVE-POINT PULSE — a beacon at the live edge that grows/brightens as resolve nears, so the
    // eye is parked exactly where the reveal happens. Side-coloured (accent up / neutral down).
    const drawPulse = (x: number, y: number, p: number, sideC: string) => {
      const rings = p < 0.4 ? 1 : p < 0.72 ? 2 : 3;
      const breathe = reduce ? 0 : 0.5 + 0.5 * Math.sin(performance.now() / 180);
      for (let k = rings - 1; k >= 0; k--) {
        const r = 5 + k * 6 * (0.5 + p) + breathe * 2 * p;
        const a = Math.max(0, (0.32 + 0.5 * p) * (1 - k * 0.28));
        ctx.save();
        ctx.strokeStyle = hexA(sideC, a);
        ctx.lineWidth = 1.8;
        ctx.shadowColor = sideC;
        ctx.shadowBlur = reduce ? 0 : 8 * p;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    };

    // Payoff burst at the live point on a real settlement — win = brighter/bigger accent, loss = a
    // softer neutral pulse (honest: a loss never flashes like a win; no red/green either way).
    const drawBurst = (x: number, y: number, t: number, won: boolean) => {
      const C = won ? colors.accent : colors.secondary;
      const ease = 1 - (1 - t) * (1 - t);
      const r = 6 + ease * (won ? 40 : 26);
      const swell = ctx.createRadialGradient(x, y, 2, x, y, Math.max(40, r * 1.7));
      swell.addColorStop(0, hexA(C, (won ? 0.24 : 0.16) * (1 - t)));
      swell.addColorStop(1, hexA(C, 0));
      ctx.save();
      ctx.fillStyle = swell;
      ctx.fillRect(0, 0, cssW, cssH);
      ctx.restore();
      ctx.save();
      ctx.strokeStyle = hexA(C, (won ? 0.7 : 0.5) * (1 - t));
      ctx.lineWidth = 3 * (1 - t) + 1;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      if (t < 0.5) {
        ctx.save();
        ctx.fillStyle = C;
        ctx.shadowColor = C;
        ctx.shadowBlur = reduce ? 0 : 18 * (1 - t * 2);
        ctx.beginPath();
        ctx.arc(x, y, 6 * (1 - t * 0.5), 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    };

    // Draw the whole beat for marketers: a pulse at the live point that intensifies as the round nears
    // resolve, and a one-shot burst when a settlement arrives. `ly` is the live-dot y; `sideC` its colour.
    // (No edge frame/meter — the right side stays a clean gap; the pulse alone carries the countdown.)
    const drawBeat = (lx: number, ly: number, sideC: string) => {
      const b = beatRef.current;
      if (!b) return;
      const p = b.getProgress();
      if (p != null) {
        drawPulse(lx, ly, Math.min(1, Math.max(0, p)), sideC);
      }
      const rs = b.resolve;
      if (rs && rs.id !== lastResolveId) {
        lastResolveId = rs.id;
        burstStart = performance.now();
        burstWon = rs.won;
      }
      if (burstStart) {
        const dt = performance.now() - burstStart;
        const DUR = 800;
        if (dt <= DUR && !reduce) drawBurst(lx, ly, dt / DUR, burstWon);
        else if (dt <= 220 && reduce) drawBurst(lx, ly, dt / 220, burstWon); // single static-ish frame
        else burstStart = 0;
      }
    };

    const drawEmpty = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      const { Y, y0 } = geom();
      if (marketerRef.current) { drawZones(y0); drawDivider(Y); } else drawAxis(Y);   // MARKETER: tint + divider
      /* The wording used to be painted HERE, in 12px canvas text: unthemed, unreadable by a screen
         reader, and unable to tell a first connect from a drop because the status never reached
         this file. It is now a DOM overlay below, so it inherits the brand's type and colours and
         announces itself. The axis/zones above still draw, so the frame is not empty either. */
    };

    const render = () => {
      const w = windowRef.current;
      const last = getLastTick();
      if (last && last.t !== seenT) {
        seenT = last.t;
        seenPerf = performance.now();
      }
      const rightEdge = last ? last.t + (reduce ? 0 : performance.now() - seenPerf) : Date.now();
      const start = rightEdge - w;

      const all = getTicks();
      let pts: Tick[] = [];
      for (let i = 0; i < all.length; i++) {
        const t = all[i]!;
        if (t.t >= start) pts.push(t);
      }
      if (pts.length < 2) {
        markEmpty(true);
        drawEmpty();
        return;
      }
      markEmpty(false);
      // decimate for very dense windows
      if (pts.length > 800) {
        const step = Math.ceil(pts.length / 800);
        const ds: Tick[] = [];
        for (let i = 0; i < pts.length; i += step) ds.push(pts[i]!);
        const tail = pts[pts.length - 1]!;
        if (ds[ds.length - 1] !== tail) ds.push(tail);
        pts = ds;
      }

      const { Y, y0 } = geom();
      const plotRight = cssW - PAD_RIGHT; // wave's right extent (marketer gutter; = cssW for players)
      const X = (t: number) => PAD_LEFT + ((t - start) / w) * (plotRight - PAD_LEFT);
      // MARKETER: two-tone around the centre divider — brand accent above, a contrasting neutral below.
      // Keeps the "above vs below" legibility a viewer needs, without the trading green/red colour pair.
      const mk = marketerRef.current;
      const upC = mk ? colors.accent : colors.up;
      const dnC = mk ? colors.secondary : colors.down;

      const last2 = pts[pts.length - 1]!;
      const coords: Pt[] = pts.map((p) => [X(p.t), Y(toValue(p.rate))]);
      coords.push([plotRight, Y(toValue(last2.rate))]); // hold the line to the live tip (inside the marketer gutter)

      const firstX = coords[0]![0];
      const lastX = coords[coords.length - 1]![0];

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      // Behind the curve: the calibration grid for players; for marketers, the altitude zone tint then
      // the centre divider (the "y-axis" job done by colour + a game meter, not a numbered scale).
      if (mk) { drawZones(y0); drawDivider(Y); } else drawAxis(Y);

      // Closed area between the curve and the 0-axis (filled twice, clipped per side).
      const buildArea = () => {
        ctx.beginPath();
        smoothPath(ctx, coords);
        ctx.lineTo(lastX, y0);
        ctx.lineTo(firstX, y0);
        ctx.closePath();
      };

      // ── Above 0 → green (clip to the region above the axis) ──
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, cssW, y0);
      ctx.clip();
      buildArea();
      const gUp = ctx.createLinearGradient(0, PAD_Y, 0, y0);
      gUp.addColorStop(0, hexA(upC, 0.34));
      gUp.addColorStop(1, hexA(upC, 0));
      ctx.fillStyle = gUp;
      ctx.fill();
      ctx.beginPath();
      smoothPath(ctx, coords);
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = upC;
      ctx.shadowColor = upC;
      ctx.shadowBlur = 12;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.restore();

      // ── Below 0 → red (clip to the region below the axis) ──
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, y0, cssW, Math.max(1, cssH - y0));
      ctx.clip();
      buildArea();
      const gDn = ctx.createLinearGradient(0, y0, 0, cssH - PAD_Y);
      gDn.addColorStop(0, hexA(dnC, 0));
      gDn.addColorStop(1, hexA(dnC, 0.34));
      ctx.fillStyle = gDn;
      ctx.fill();
      ctx.beginPath();
      smoothPath(ctx, coords);
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = dnC;
      ctx.shadowColor = dnC;
      ctx.shadowBlur = 12;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.restore();

      // 0-axis + labels on top of the fill (MARKETER: just the divider, redrawn so the wave doesn't bury it).
      if (mk) drawDivider(Y); else drawAxis(Y);

      // Live dot, coloured by the current side (accent above the divider, neutral below for marketers).
      const lastV = toValue(last2.rate);
      const ly = Y(lastV);
      const sideC = lastV >= 0 ? upC : dnC;
      // MARKETER: the live dot sits AT the wave tip (inside the right gutter), so the pulse/burst
      // beacon reads as emanating from the end of the wave and isn't clipped by the board edge.
      const dotX = mk ? plotRight : cssW - 2;
      ctx.beginPath();
      ctx.arc(dotX, ly, 3, 0, Math.PI * 2);
      ctx.fillStyle = sideC;
      ctx.fill();

      // MARKETER: the anticipation beat sits on top of the wave (charge meter + live-point pulse + burst).
      if (mk) drawBeat(dotX, ly, sideC);
    };

    let raf = 0;
    let interval: ReturnType<typeof setInterval> | null = null;
    if (reduce) {
      interval = setInterval(render, 250);
      render();
    } else {
      const loop = () => {
        render();
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    }

    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (interval) clearInterval(interval);
      ro.disconnect();
      mo.disconnect();
    };
  }, [getTicks, getLastTick]);

  const phase = dataPhaseOf(status, !curveEmpty);
  return (
    <div className="relative h-full w-full">
      <canvas ref={canvasRef} className="h-full w-full" aria-label={marketer ? 'Live game motion' : 'Live price curve'} role="img" />
      {phaseIsBlocking(phase) ? (
        <ChartPlaceholder
          phase={phase}
          /* MARKETER: never the words "market data" and never the candle skeleton — the whole
             neutralised wave exists so this surface does not read as a trading chart. */
          subject={marketer ? 'the round' : 'live ticks'}
          showSkeleton={!marketer}
        />
      ) : null}
    </div>
  );
}
