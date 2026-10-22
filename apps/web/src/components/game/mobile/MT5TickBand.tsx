'use client';

import { useEffect, useRef, useState } from 'react';
import type { Tick } from '@/lib/game/types';

/**
 * MetaTrader's tick chart, as the phone order ticket draws it.
 *
 * The screen it copies (`android/en/open_market.png`) is not a candle chart in miniature. It is a
 * PRICE band with three horizontal lines and a tag on each: the ask above, the last between, the bid
 * below, with the tick trace running through them. On a quiet market the trace is nearly flat and
 * the three tagged lines are most of what is on screen, which is exactly what the reference shows.
 *
 * Drawn on a PRICE scale rather than the curve's own unitless value, which is the whole reason this
 * exists instead of reusing `CurveCanvas`. That canvas plots the raw curve value, so a horizontal
 * line at a price could only be placed by inventing a mapping; here the ticks are converted with the
 * same `priceOfRate` every other surface uses, so a line at the bid really is at the bid.
 *
 * SVG rather than canvas because the three tags are text that has to stay crisp and selectable-ish
 * at phone density, and because there are only ever a couple of hundred points to draw.
 */
export function MT5TickBand({
  getTicks, priceOfRate, digits, bid, ask, last, windowMs = 60_000,
}: {
  getTicks: () => readonly Tick[];
  /** The same conversion the ticket's own quote uses, so the band and the quote cannot disagree. */
  priceOfRate: (rate: number | null | undefined) => number | null;
  digits: number;
  /** MetaTrader's two sides. Null on a brand that quotes one price; then only `last` is drawn. */
  bid: number | null;
  ask: number | null;
  last: number | null;
  windowMs?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  // The tick buffer is mutated in place by the socket provider and never re-renders React on its
  // own, so the band is redrawn on a timer, as every other live surface on this shell is.
  const [, force] = useState(0);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const id = setInterval(() => force((n) => (n + 1) % 1_000_000), 250);
    return () => { ro.disconnect(); clearInterval(id); };
  }, []);

  const { w, h } = size;
  const now = Date.now();
  const from = now - windowMs;
  const pts: Array<{ t: number; p: number }> = [];
  for (const t of getTicks()) {
    if (t.t < from) continue;
    // A tick the client invented is not a quote and never reaches a price surface. See
    // `Tick.synthetic`: one of these priced through the real anchor is a number the server never
    // sent, which is what put a candle tens of points off the market.
    if (t.synthetic === true) continue;
    const p = priceOfRate(t.rate);
    if (p !== null && Number.isFinite(p)) pts.push({ t: t.t, p });
  }

  /** The scale spans the ticks AND both tagged lines, so no tag is ever drawn off the band. */
  const prices = pts.map((x) => x.p);
  for (const v of [bid, ask, last]) if (v !== null && Number.isFinite(v)) prices.push(v);
  const lo = prices.length ? Math.min(...prices) : 0;
  const hi = prices.length ? Math.max(...prices) : 1;
  // A dead-flat market would collapse the scale to a line; a floor of one point keeps the band
  // readable and the three tags apart.
  const point = 1 / 10 ** digits;
  const padRaw = (hi - lo) * 0.25;
  const pad = Math.max(padRaw, point * 2);
  const top = hi + pad;
  const bottom = lo - pad;
  const span = top - bottom || 1;
  /** Room on the right for the price tags, which MetaTrader hangs off the edge of the band. */
  const TAG_W = 58;
  const plotW = Math.max(0, w - TAG_W);
  const yOf = (p: number) => ((top - p) / span) * h;
  const xOf = (t: number) => ((t - from) / windowMs) * plotW;

  const path = pts.length
    ? pts.map((x, i) => `${i === 0 ? 'M' : 'L'}${xOf(x.t).toFixed(1)},${yOf(x.p).toFixed(1)}`).join(' ')
    : '';

  const lines: Array<{ p: number; colour: string; dashed: boolean; tag: boolean }> = [];
  if (ask !== null && Number.isFinite(ask)) lines.push({ p: ask, colour: '#3183ff', dashed: false, tag: true });
  if (last !== null && Number.isFinite(last)) lines.push({ p: last, colour: '#8fa2b8', dashed: true, tag: false });
  if (bid !== null && Number.isFinite(bid)) lines.push({ p: bid, colour: '#f23645', dashed: false, tag: true });

  /** Nothing has quoted and no tick survived the window — the band has literally nothing to draw. */
  const empty = pts.length === 0 && lines.length === 0;

  /**
   * Absolutely filled rather than `h-full`.
   *
   * Its holder is a flex item sized by `flex-1` and a `min-h`, so its computed height is `auto` and
   * a percentage height on the child resolves against nothing: the band measured 390x0 and drew
   * nothing at all. Pinning to the holder's box sidesteps the percentage entirely.
   */
  return (
    <div ref={box} className="absolute inset-0">
      {w > 0 && h > 0 ? (
        <svg width={w} height={h} className="block" aria-label="Tick chart" role="img">
          {lines.map((l) => {
            const y = yOf(l.p);
            return (
              <g key={`${l.colour}-${l.p}`}>
                <line
                  x1={0} x2={plotW} y1={y} y2={y}
                  stroke={l.colour} strokeWidth={1}
                  {...(l.dashed ? { strokeDasharray: '3 3' } : {})}
                />
                {l.tag ? (
                  <>
                    <rect x={plotW} y={y - 8} width={TAG_W} height={16} fill={l.colour} rx={1} />
                    <text
                      x={plotW + TAG_W / 2} y={y + 4}
                      textAnchor="middle" fontSize={10} fill="#ffffff"
                      fontFamily="ui-monospace, SFMono-Regular, monospace"
                    >
                      {l.p.toFixed(digits)}
                    </text>
                  </>
                ) : (
                  // The last price carries a plain label with no plate, which is how the reference
                  // distinguishes it from the two tradable sides.
                  <text
                    x={plotW + TAG_W / 2} y={y + 4}
                    textAnchor="middle" fontSize={10} fill={l.colour}
                    fontFamily="ui-monospace, SFMono-Regular, monospace"
                  >
                    {l.p.toFixed(digits)}
                  </text>
                )}
              </g>
            );
          })}
          {path ? <path d={path} fill="none" stroke="#c9d6e4" strokeWidth={1.2} /> : null}
        </svg>
      ) : null}
      {/*
        Nothing to draw: no tick survived the window and no side has quoted, so `lines` is empty and
        `path` is ''. That used to render an empty `<svg>` — a blank band in the middle of the order
        ticket, with no hint that it was waiting rather than broken. Its desktop sibling
        (`MT5TicksChart`) has always said so; this is the same sentence.
      */}
      {empty ? (
        <p
          className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 px-4 text-center text-[11px] leading-snug text-[var(--mt5-muted)]"
          role="status"
          aria-live="polite"
        >
          Waiting for ticks. The band fills as the server quotes.
        </p>
      ) : null}
    </div>
  );
}
