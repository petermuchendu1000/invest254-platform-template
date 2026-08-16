'use client';

import * as React from 'react';

export type Point = { label: string; value: number };

/** Compact KES from integer cents: 12 345 600 → "KES 123K". */
export function kesCompact(cents: number): string {
  const kes = cents / 100;
  const abs = Math.abs(kes);
  const sign = kes < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}KES ${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${sign}KES ${(abs / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`;
  return `${sign}KES ${abs.toFixed(0)}`;
}

const VB_W = 300;
const VB_H = 96;
const PAD = 4;

/** Build (x,y) screen coords for a series, mapping value range (incl. 0 baseline) to the plot box. */
function project(points: Point[]) {
  const n = points.length;
  const values = points.map((p) => p.value);
  let min = Math.min(0, ...values);
  let max = Math.max(0, ...values);
  if (min === max) max = min + 1; // avoid divide-by-zero on flat/empty series
  const span = max - min;
  const x = (i: number) => (n <= 1 ? VB_W / 2 : PAD + (i / (n - 1)) * (VB_W - 2 * PAD));
  const y = (v: number) => VB_H - PAD - ((v - min) / span) * (VB_H - 2 * PAD);
  return { x, y, min, max, zeroY: y(0) };
}

/**
 * Filled line/area chart with a zero baseline and an emphasised latest point.
 * Colour is driven entirely by theme/brand tokens (currentColor), so it adapts to light/dark and to
 * each brand automatically. One series, one question — use it for a single trend over time.
 */
export function AreaChart({ points, tone = 'accent', className = 'h-24 w-full' }: { points: Point[]; tone?: Tone; className?: string }) {
  if (points.length === 0) return <div className={className} />;
  const { x, y, zeroY } = project(points);
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(2)} ${y(p.value).toFixed(2)}`).join(' ');
  const area = `${line} L ${x(points.length - 1).toFixed(2)} ${zeroY.toFixed(2)} L ${x(0).toFixed(2)} ${zeroY.toFixed(2)} Z`;
  const lastX = x(points.length - 1), lastY = y(points[points.length - 1]!.value);
  return (
    <svg viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="none" className={`${className} ${TEXT[tone]}`} role="img">
      {/* zero baseline for reference (data-ink: the only gridline we keep) */}
      <line x1={PAD} x2={VB_W - PAD} y1={zeroY} y2={zeroY} className="stroke-border" strokeWidth={0.5} strokeDasharray="2 2" />
      <path d={area} fill="currentColor" fillOpacity={0.12} stroke="none" />
      <path d={line} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={lastX} cy={lastY} r={2.4} fill="currentColor" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Two-series grouped bars (e.g. deposits vs withdrawals) sharing one scale. */
export function GroupedBars({ a, b }: { a: { label: string; points: Point[]; tone: 'up' | 'down' | 'accent' }; b: { label: string; points: Point[]; tone: 'up' | 'down' | 'accent' } }) {
  const n = Math.max(a.points.length, b.points.length);
  if (n === 0) return <div className="h-24 w-full" />;
  const max = Math.max(1, ...a.points.map((p) => p.value), ...b.points.map((p) => p.value));
  const slot = (VB_W - 2 * PAD) / n;
  const bw = Math.min(slot * 0.38, 10);
  const fillOf = (t: string) => (t === 'up' ? 'fill-up' : t === 'down' ? 'fill-down' : 'fill-accent');
  const barY = (v: number) => VB_H - PAD - (v / max) * (VB_H - 2 * PAD);
  return (
    <svg viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="none" className="h-24 w-full" role="img">
      {Array.from({ length: n }).map((_, i) => {
        const cx = PAD + slot * (i + 0.5);
        const av = a.points[i]?.value ?? 0;
        const bv = b.points[i]?.value ?? 0;
        return (
          <g key={i}>
            <rect x={cx - bw - 0.5} y={barY(av)} width={bw} height={Math.max(0, VB_H - PAD - barY(av))} className={fillOf(a.tone)} rx={0.5} />
            <rect x={cx + 0.5} y={barY(bv)} width={bw} height={Math.max(0, VB_H - PAD - barY(bv))} className={fillOf(b.tone)} rx={0.5} />
          </g>
        );
      })}
    </svg>
  );
}

/** Card frame for a chart: title, latest/summary readout, legend, and the plot. */
export function ChartCard({
  title,
  readout,
  legend,
  children,
}: {
  title: string;
  readout?: string;
  legend?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs uppercase tracking-wide text-muted">{title}</span>
        {readout ? <span className="text-sm font-semibold tabular-nums">{readout}</span> : null}
      </div>
      {children}
      {legend ? <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">{legend}</div> : null}
    </div>
  );
}

export function LegendDot({ tone, label }: { tone: 'up' | 'down' | 'accent'; label: string }) {
  const bg = tone === 'up' ? 'bg-up' : tone === 'down' ? 'bg-down' : 'bg-accent';
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${bg}`} />
      {label}
    </span>
  );
}

// ── Richer primitives for the owner dashboard (mobile-first) ──────────────────────────────────

type Tone = 'up' | 'down' | 'accent';
const STROKE = { up: 'stroke-up', down: 'stroke-down', accent: 'stroke-accent' } as const;
const FILL_SOFT = { up: 'fill-up/15', down: 'fill-down/15', accent: 'fill-accent/15' } as const;
// Colour an SVG via currentColor + a text token, so fills/strokes/dots share one theme-aware source.
const TEXT: Record<Tone, string> = { up: 'text-up', down: 'text-down', accent: 'text-accent' };

/** Tiny inline trend line for a KPI card. No axes — just the shape of the last N points. */
export function Sparkline({ points, tone = 'accent', className = 'h-8 w-full' }: { points: Point[]; tone?: Tone; className?: string }) {
  if (points.length === 0) return <div className={className} />;
  const w = 120, h = 32, pad = 2;
  const vals = points.map((p) => p.value);
  let min = Math.min(...vals), max = Math.max(...vals);
  if (min === max) max = min + 1;
  const x = (i: number) => (points.length <= 1 ? w / 2 : pad + (i / (points.length - 1)) * (w - 2 * pad));
  const y = (v: number) => h - pad - ((v - min) / (max - min)) * (h - 2 * pad);
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');
  const area = `${line} L ${x(points.length - 1).toFixed(1)} ${h - pad} L ${x(0).toFixed(1)} ${h - pad} Z`;
  const lastX = x(points.length - 1), lastY = y(points[points.length - 1]!.value);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={className} role="img" aria-hidden>
      <path d={area} className={FILL_SOFT[tone]} stroke="none" />
      <path d={line} className={STROKE[tone]} fill="none" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lastX} cy={lastY} r={1.8} className={tone === 'up' ? 'fill-up' : tone === 'down' ? 'fill-down' : 'fill-accent'} />
    </svg>
  );
}

/** KPI card: big value + a delta chip vs the previous period + a sparkline of the series. */
export function KpiCard({
  label,
  value,
  series,
  tone = 'accent',
  deltaPct,
}: {
  label: string;
  value: string;
  series: Point[];
  tone?: Tone;
  deltaPct?: number | null;
}) {
  const up = (deltaPct ?? 0) >= 0;
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs uppercase tracking-wide text-muted">{label}</span>
        {deltaPct !== undefined && deltaPct !== null && Number.isFinite(deltaPct) ? (
          <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${up ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>
            {up ? '▲' : '▼'} {Math.abs(deltaPct).toFixed(0)}%
          </span>
        ) : null}
      </div>
      <span className="text-xl font-bold tabular-nums text-fg sm:text-2xl">{value}</span>
      <Sparkline points={series} tone={tone} />
    </div>
  );
}

/** Donut split of labelled segments with a center total. Mobile-first (scales with container). */
export function Donut({
  segments,
  centerLabel,
  centerValue,
  size = 132,
}: {
  segments: { label: string; value: number; tone: Tone }[];
  centerLabel?: string;
  centerValue?: string;
  size?: number;
}) {
  const total = segments.reduce((s, x) => s + Math.max(0, x.value), 0);
  const r = 52, c = 60, circ = 2 * Math.PI * r;
  const strokeOf = (t: Tone) => (t === 'up' ? 'stroke-up' : t === 'down' ? 'stroke-down' : 'stroke-accent');
  let offset = 0;
  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 120 120" width={size} height={size} className="shrink-0 -rotate-90" role="img">
        <circle cx={c} cy={c} r={r} className="fill-none stroke-surface-2" strokeWidth={14} />
        {total > 0 &&
          segments.map((seg, i) => {
            const frac = Math.max(0, seg.value) / total;
            const dash = frac * circ;
            const el = (
              <circle
                key={i}
                cx={c}
                cy={c}
                r={r}
                className={`fill-none ${strokeOf(seg.tone)}`}
                strokeWidth={14}
                strokeDasharray={`${dash} ${circ - dash}`}
                strokeDashoffset={-offset}
                strokeLinecap="butt"
              />
            );
            offset += dash;
            return el;
          })}
      </svg>
      <div className="flex flex-col gap-1">
        {centerValue ? (
          <div className="mb-1">
            <div className="text-lg font-bold tabular-nums text-fg">{centerValue}</div>
            {centerLabel ? <div className="text-[11px] uppercase tracking-wide text-muted">{centerLabel}</div> : null}
          </div>
        ) : null}
        {segments.map((seg, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span className={`h-2.5 w-2.5 rounded-full ${seg.tone === 'up' ? 'bg-up' : seg.tone === 'down' ? 'bg-down' : 'bg-accent'}`} />
            <span className="text-muted">{seg.label}</span>
            <span className="ml-auto font-medium tabular-nums text-fg">{total > 0 ? `${((Math.max(0, seg.value) / total) * 100).toFixed(0)}%` : '—'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
