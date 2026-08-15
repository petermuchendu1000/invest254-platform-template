
'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';

/**
 * Decorative market ticker (FE — design replica). Symbols and values are
 * client-side simulated (random walk) to dress the trade screen like a live
 * exchange. NOT real market data and NOT the game outcome — the authoritative
 * curve is the value above.
 */
interface Asset {
  sym: string;
  price: number;
  pct: number;
}

const SEED: Asset[] = [
  { sym: 'MATIC', price: 0.71, pct: -0.02 },
  { sym: 'ATOM', price: 1.01, pct: 0.61 },
  { sym: 'UNI', price: 7.42, pct: 1.23 },
  { sym: 'BTC', price: 64210, pct: 0.42 },
  { sym: 'ETH', price: 3180, pct: -0.31 },
  { sym: 'SOL', price: 148.3, pct: 2.1 },
  { sym: 'XRP', price: 0.52, pct: -0.12 },
  { sym: 'DOGE', price: 0.13, pct: 3.4 },
  { sym: 'ADA', price: 0.45, pct: 0.08 },
];

function fmtPrice(p: number): string {
  if (p >= 1000) return `$${Math.round(p).toLocaleString('en-US')}`;
  if (p >= 1) return `$${p.toFixed(2)}`;
  return `$${p.toFixed(3)}`;
}

function Pill({ a }: { a: Asset }) {
  const up = a.pct >= 0;
  return (
    <div className="flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-xs">
      <span className="font-semibold text-fg">{a.sym}</span>
      <span className="font-mono tabular-nums text-muted">{fmtPrice(a.price)}</span>
      <span className={cn('font-mono tabular-nums', up ? 'text-up' : 'text-down')}>
        {up ? '+' : ''}
        {a.pct.toFixed(2)}%
      </span>
    </div>
  );
}

export function TickerStrip() {
  const [assets, setAssets] = useState<Asset[]>(SEED);

  useEffect(() => {
    const id = setInterval(() => {
      setAssets((cur) =>
        cur.map((a) => {
          const drift = (Math.random() - 0.5) * 0.006; // ±0.3%
          const price = Math.max(0.0001, a.price * (1 + drift));
          const pct = Math.max(-9.9, Math.min(9.9, a.pct + (Math.random() - 0.5) * 0.35));
          return { ...a, price, pct };
        }),
      );
    }, 1500);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex items-stretch overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex shrink-0 items-center gap-1.5 border-r border-border bg-down/10 px-3 text-xs font-semibold text-down">
        <span className="h-1.5 w-1.5 rounded-full bg-down" />
        LIVE
      </div>
      <div className="relative flex-1 overflow-hidden">
        {/* Fade the marquee edges so partial pills never crowd the LIVE badge. */}
        <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-4 bg-gradient-to-r from-surface to-transparent" />
        <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-4 bg-gradient-to-l from-surface to-transparent" />
        <div className="flex w-max animate-marquee" aria-hidden>
          {[...assets, ...assets].map((a, i) => (
            <Pill key={`${a.sym}-${i}`} a={a} />
          ))}
        </div>
      </div>
    </div>
  );
}
