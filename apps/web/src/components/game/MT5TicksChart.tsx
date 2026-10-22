'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * MetaTrader's Market Watch **Ticks** tab.
 *
 * Rendered off `en/tick_chart_x2.png` (docs/mt5/10-market-watch.md 9.2): the symbol name top-left,
 * a BLUE step line for the Bid (lower) and a RED step line for the Ask (upper), a price scale down
 * the right edge, a time axis along the bottom whose FIRST label is the full date and the rest
 * times, and two filled last-price tags on the right edge, red for the Ask and blue for the Bid.
 * No columns, no toolbar, no tabs of its own.
 *
 * Step lines rather than sloped ones, because that is what a tick series is: the price is the last
 * quoted price until the next quote arrives, and drawing a slope between two ticks claims prices in
 * between that were never quoted. It is the same honesty rule as `Tick.synthetic`, one level down.
 *
 * MetaTrader keeps "up to 2000 last ticks for each symbol" and clears a symbol's chart when it
 * leaves Market Watch, and the socket provider's ring does both. The points it holds are the
 * quotes the ENGINE sent for this symbol, already mapped through the day's anchor, so this chart
 * and the row above it cannot disagree about the price.
 *
 * SVG, like the phone ticket's band, because the scale labels and the two tags are text that has to
 * stay crisp and there are at most a couple of thousand points.
 */
export function MT5TicksChart({ symbol, getTicks, digits, spread, scale }: {
  symbol: string;
  /** This symbol's recent quotes, newest last, as prices. See `getSymbolTicks`. */
  getTicks: () => readonly { t: number; price: number }[];
  digits: number;
  /** The brand's spread, in curve-value units. Null on a brand that publishes none. */
  spread: { buy: number; sell: number } | null;
  /** The symbol's price scale, which turns a spread in curve units into one in price terms. */
  scale: number | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  // The tick buffer is mutated in place by the socket provider and never re-renders React on its
  // own, so this redraws on a timer as every other live surface on this shell does.
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
  /** Right edge for the price scale, bottom edge for the time axis. MetaTrader's own layout. */
  const padR = 52;
  const padB = 16;
  const padT = 14;
  const plotW = Math.max(0, w - padR);
  const plotH = Math.max(0, h - padB - padT);

  const offBid = spread !== null && scale !== null ? spread.sell * scale : 0;
  const offAsk = spread !== null && scale !== null ? spread.buy * scale : 0;

  const pts: Array<{ t: number; bid: number; ask: number }> = [];
  for (const tk of getTicks()) {
    if (!Number.isFinite(tk.price)) continue;
    pts.push({ t: tk.t, bid: tk.price - offBid, ask: tk.price + offAsk });
  }

  const empty = pts.length < 2 || plotW <= 0 || plotH <= 0;

  const t0 = empty ? 0 : pts[0]!.t;
  const t1 = empty ? 1 : pts[pts.length - 1]!.t;
  const span = Math.max(1, t1 - t0);
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of pts) { if (p.bid < lo) lo = p.bid; if (p.ask > hi) hi = p.ask; }
  // A flat market would give a zero-height scale and divide by nothing; a hair of padding either
  // side keeps the two lines inside the plot and a tick apart.
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo < 1e-9) { lo = (lo || 0) - 1; hi = (hi || 0) + 1; }
  const pad = (hi - lo) * 0.12;
  lo -= pad;
  hi += pad;

  const x = (t: number): number => ((t - t0) / span) * plotW;
  const y = (p: number): number => padT + (1 - (p - lo) / (hi - lo)) * plotH;

  /** A STEP path: hold the last price, then jump. That is what a tick series is. */
  const stepPath = (pick: (p: { bid: number; ask: number }) => number): string => {
    let d = '';
    let prevY = 0;
    pts.forEach((p, i) => {
      const px = x(p.t);
      const py = y(pick(p));
      if (i === 0) { d += `M${px.toFixed(1)} ${py.toFixed(1)}`; } else { d += `H${px.toFixed(1)}V${py.toFixed(1)}`; }
      prevY = py;
    });
    // Hold the last quote out to the live edge, which is where the tags sit.
    if (pts.length > 0) d += `H${plotW.toFixed(1)}`;
    void prevY;
    return d;
  };

  const last = pts[pts.length - 1] ?? null;

  /** Four gridline prices, which is what the right-edge scale carries. */
  const ticksY = empty ? [] : [0, 1, 2, 3, 4].map((i) => lo + ((hi - lo) * i) / 4);
  /**
   * The time axis: MetaTrader's first label is the FULL DATE and the rest are times. Four labels
   * fit a docked Market Watch; more would overlap at this width.
   */
  const ticksX = empty ? [] : [0, 1, 2, 3].map((i) => t0 + (span * i) / 3);
  const hhmm = (ms: number): string =>
    new Date(ms).toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit' });
  const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '.');

  return (
    <div ref={box} data-ticks-chart={symbol} className="relative h-full min-h-[180px] w-full">
      <span className="pointer-events-none absolute left-2 top-1 z-10 text-[11px] font-semibold text-white">
        {symbol}
      </span>
      {empty ? (
        <p className="absolute inset-x-0 top-1/2 -translate-y-1/2 px-4 text-center text-[11px] leading-snug text-[var(--mt5-muted)]">
          Waiting for ticks on {symbol}. The chart fills as the server quotes, and is cleared when
          the symbol is removed from Market Watch.
        </p>
      ) : (
        <svg width={w} height={h} className="absolute inset-0" role="img" aria-label={`${symbol} tick chart`}>
          {ticksY.map((p, i) => (
            <g key={i}>
              <line x1={0} x2={plotW} y1={y(p)} y2={y(p)} stroke="#2b3543" strokeWidth={1} />
              <text x={plotW + 4} y={y(p) + 3} fill="#8fa2b8" fontSize={9} fontFamily="monospace">
                {p.toFixed(digits)}
              </text>
            </g>
          ))}
          {ticksX.map((t, i) => (
            <text
              key={i}
              x={Math.min(x(t) + 2, plotW - 4)}
              y={h - 4}
              fill="#8fa2b8"
              fontSize={9}
              fontFamily="monospace"
              textAnchor={i === 0 ? 'start' : 'middle'}
            >
              {i === 0 ? ymd(t) : hhmm(t)}
            </text>
          ))}

          {/* Ask above in red, Bid below in blue, which is MetaTrader's own pairing. */}
          <path d={stepPath((p) => p.ask)} fill="none" stroke="#f23645" strokeWidth={1.25} />
          <path d={stepPath((p) => p.bid)} fill="none" stroke="#3183ff" strokeWidth={1.25} />

          {last === null ? null : (
            <>
              <PriceTag x={plotW} y={y(last.ask)} text={last.ask.toFixed(digits)} fill="#f23645" />
              <PriceTag x={plotW} y={y(last.bid)} text={last.bid.toFixed(digits)} fill="#3183ff" />
            </>
          )}
        </svg>
      )}
    </div>
  );
}

/** A filled last-price tag on the right edge, as MetaTrader draws one per side. */
function PriceTag({ x, y, text, fill }: { x: number; y: number; text: string; fill: string }) {
  return (
    <g>
      <rect x={x + 1} y={y - 6} width={48} height={12} rx={1.5} fill={fill} />
      <text x={x + 4} y={y + 3} fill="#ffffff" fontSize={9} fontFamily="monospace">{text}</text>
    </g>
  );
}
