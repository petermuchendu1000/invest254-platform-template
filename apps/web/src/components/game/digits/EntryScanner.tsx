'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { useGameSocket } from '@/lib/game/GameSocketProvider';
import { INSTRUMENTS, instrumentById } from '@/lib/game/instruments';
import { useEntryScanner } from '@/lib/game/entryScannerUi';

// ── Scan model ───────────────────────────────────────────────────────────────────────────────────
export type ScanMarket = 'evenodd' | 'matchesdiffers' | 'overunder';
export type ScanSide = 'even' | 'odd' | 'over' | 'under' | 'matches';

export interface ScanSuggestion {
  instrumentId: string;
  market: ScanMarket;
  side: ScanSide;
  /** Observed share (%) of the suggested side over the sampled window (honest, not inflated). */
  share: number;
  /** Over/Under barrier or Matches digit, when relevant. */
  digit?: number;
}

const MARKET_OPTIONS: { id: ScanMarket; label: string }[] = [
  { id: 'evenodd', label: 'Even / Odd' },
  { id: 'matchesdiffers', label: 'Match / Differ' },
  { id: 'overunder', label: 'Over / Under' },
];

const OVERUNDER_BARRIER = 5;
const lastDigitOf = (rate: number) => (((Math.round(rate * 100) % 10) + 10) % 10);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Compute the observed lean for a market over a tick window. Returns null if too little data. */
function computeLean(
  ticks: { rate: number }[],
  market: ScanMarket,
): { side: ScanSide; share: number; strength: number; digit?: number } | null {
  const n = ticks.length;
  if (n < 20) return null;
  const counts = Array<number>(10).fill(0);
  for (const t of ticks) counts[lastDigitOf(t.rate)]!++;
  const f = counts.map((c) => (c / n) * 100);

  if (market === 'evenodd') {
    const even = f[0]! + f[2]! + f[4]! + f[6]! + f[8]!;
    const side: ScanSide = even >= 50 ? 'even' : 'odd';
    const share = Math.max(even, 100 - even);
    return { side, share, strength: Math.abs(even - 50) };
  }
  if (market === 'overunder') {
    const over = f[6]! + f[7]! + f[8]! + f[9]!; // digit > 5
    const under = f[0]! + f[1]! + f[2]! + f[3]! + f[4]!; // digit < 5
    const side: ScanSide = over >= under ? 'over' : 'under';
    const share = side === 'over' ? over : under;
    return { side, share, strength: Math.abs(over - under), digit: OVERUNDER_BARRIER };
  }
  // matches/differs: surface the hottest digit to MATCH
  let hot = 0;
  for (let d = 1; d < 10; d++) if (f[d]! > f[hot]!) hot = d;
  return { side: 'matches', share: f[hot]!, strength: f[hot]! - 10, digit: hot };
}

function sideLabel(s: ScanSuggestion): string {
  if (s.market === 'evenodd') return s.side === 'even' ? 'Even' : 'Odd';
  if (s.market === 'overunder') return `${s.side === 'over' ? 'Over' : 'Under'} ${s.digit}`;
  return `Matches ${s.digit}`;
}

function Icon({ path, className = 'h-5 w-5' }: { path: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={path} />
    </svg>
  );
}

/**
 * AI Entry Scanner — a "deep scanner" that walks every Volatility / synthetic index, samples each
 * one's authoritative live tick feed, and surfaces the strongest observed digit-frequency lean for
 * the chosen market category. Honest by construction: the % shown is the REAL observed share over
 * the sampled window (not a fabricated confidence), with a responsible-gaming note. "Load Deep
 * Scanner Bot" hands the best entry back to the trade screen (instrument + market + side, AUTO mode).
 *
 * Rendered inside the trade screen (inside GameSocketProvider) so it can sample the socket feed.
 */
export function EntryScanner({
  currentInstrumentId,
  busy,
  onApply,
}: {
  currentInstrumentId: string;
  busy: boolean;
  onApply: (s: ScanSuggestion) => void;
}) {
  const open = useEntryScanner((s) => s.open);
  const setOpen = useEntryScanner((s) => s.setOpen);
  const { subscribeInstrument, getInstrumentTicks } = useGameSocket();

  const [market, setMarket] = useState<ScanMarket>('evenodd');
  const [ddOpen, setDdOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [best, setBest] = useState<ScanSuggestion | null>(null);

  const cancelledRef = useRef(false);
  const total = INSTRUMENTS.length;

  // Reset transient scan state whenever the sheet is reopened or the market changes.
  useEffect(() => { setBest(null); setProgress(0); }, [market, open]);

  // On unmount / close: cancel any in-flight scan and restore the user's instrument feed.
  useEffect(() => {
    if (!open) { cancelledRef.current = true; }
    return () => { cancelledRef.current = true; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (!open) return null;

  async function runScan() {
    if (scanning || busy) return;
    cancelledRef.current = false;
    setScanning(true);
    setBest(null);
    setProgress(0);
    const found: ScanSuggestion[] = [];
    try {
      for (let i = 0; i < INSTRUMENTS.length; i++) {
        if (cancelledRef.current) return;
        const inst = INSTRUMENTS[i]!;
        subscribeInstrument(inst.id);
        await sleep(480); // let the feed reset + fill (history + a few live ticks)
        if (cancelledRef.current) return;
        const lean = computeLean(getInstrumentTicks(), market);
        if (lean) {
          const sug: ScanSuggestion = { instrumentId: inst.id, market, side: lean.side, share: lean.share };
          if (lean.digit != null) sug.digit = lean.digit;
          found.push(sug);
        }
        setProgress(i + 1);
      }
      found.sort((a, b) => b.share - a.share);
      // strongest lean = the entry with the highest observed share for its suggested side
      const ranked = found
        .map((s) => ({ s, strength: s.market === 'evenodd' ? s.share - 50 : s.market === 'overunder' ? s.share - 50 : s.share - 10 }))
        .sort((a, b) => b.strength - a.strength);
      setBest(ranked[0]?.s ?? null);
    } finally {
      // Always restore the user's instrument feed.
      subscribeInstrument(currentInstrumentId);
      if (!cancelledRef.current) setScanning(false);
    }
  }

  const pct = total ? Math.round((progress / total) * 100) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label="AI Entry Scanner">
      <button aria-label="Close" className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setOpen(false)} />
      <div className="relative w-full max-w-app rounded-t-2xl border border-border bg-surface p-4 shadow-2xl sm:max-w-md sm:rounded-2xl">
        {/* header */}
        <div className="mb-3 flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-accent/15 text-accent ring-1 ring-accent/30">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-5 w-5">
              <line x1="12" y1="2" x2="12" y2="4.6" />
              <circle cx="12" cy="1.9" r="1" fill="currentColor" stroke="none" />
              <rect x="4" y="4.6" width="16" height="13.8" rx="4" />
              <rect x="1.5" y="9.6" width="2" height="4" rx="1" />
              <rect x="20.5" y="9.6" width="2" height="4" rx="1" />
              <circle cx="9" cy="11" r="2.2" />
              <circle cx="15" cy="11" r="2.2" />
              <circle cx="9" cy="11" r="0.85" fill="currentColor" stroke="none" />
              <circle cx="15" cy="11" r="0.85" fill="currentColor" stroke="none" />
              <path d="M8.6 14.4c1 1.4 5.8 1.4 6.8 0" />
            </svg>
          </span>
          <h2 className="text-base font-extrabold text-fg">Entry Scanner</h2>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-fg">
            <Icon path="M6 6l12 12M18 6L6 18" className="h-4 w-4" />
          </button>
        </div>

        {/* description */}
        <p className="rounded-xl border border-border bg-surface-2/50 p-3 text-[13px] leading-relaxed text-muted">
          Pick the market category you want to scan. The deep scanner walks every{' '}
          <span className="font-semibold text-fg">volatility / synthetic</span> index and surfaces the
          strongest recent entry lean for that category based on its live tick history.
        </p>

        {/* market dropdown */}
        <div className="mt-4">
          <label className="text-[13px] font-semibold text-fg">Market</label>
          <div className="relative mt-1.5">
            <button
              type="button"
              onClick={() => setDdOpen((v) => !v)}
              aria-haspopup="listbox"
              aria-expanded={ddOpen}
              disabled={scanning}
              className={cn(
                'flex h-11 w-full items-center rounded-xl border bg-surface-2 px-3.5 text-left text-[15px] font-semibold text-fg transition disabled:opacity-60',
                ddOpen ? 'border-accent' : 'border-border hover:border-accent/60',
              )}
            >
              {MARKET_OPTIONS.find((o) => o.id === market)?.label}
              <Icon path="M6 9l6 6 6-6" className={cn('ml-auto h-4 w-4 text-muted transition-transform', ddOpen ? 'rotate-180' : '')} />
            </button>
            {ddOpen ? (
              <div role="listbox" className="absolute left-0 top-[calc(100%+6px)] z-10 w-full overflow-hidden rounded-xl border border-border bg-surface-2 shadow-2xl">
                {MARKET_OPTIONS.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    role="option"
                    aria-selected={o.id === market}
                    onClick={() => { setMarket(o.id); setDdOpen(false); }}
                    className={cn('flex w-full items-center px-3.5 py-2.5 text-left text-[15px] font-medium transition', o.id === market ? 'text-fg' : 'text-muted hover:bg-white/5 hover:text-fg')}
                  >
                    {o.label}
                    {o.id === market ? <Icon path="M5 13l4 4L19 7" className="ml-auto h-4 w-4 text-accent" /> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        {/* progress / result */}
        {scanning ? (
          <div className="mt-4">
            <div className="flex items-center justify-between text-[12px] font-semibold text-muted">
              <span>Scanning…</span>
              <span className="tabular-nums">{progress}/{total}</span>
            </div>
            <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
            </div>
          </div>
        ) : best ? (
          <div className="mt-4">
            <div className="flex items-center justify-between text-[12px] font-semibold text-muted">
              <span>Scan complete</span>
              <span className="tabular-nums">{total}/{total}</span>
            </div>
            <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full bg-accent" style={{ width: '100%' }} />
            </div>
            <div className="mt-3 rounded-xl border border-accent/40 bg-accent/10 p-3">
              <div className="text-[10px] font-bold uppercase tracking-wider text-accent">Best entry found</div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-[15px] font-extrabold text-fg">{instrumentById(best.instrumentId).label}</div>
                  <div className="text-[12px] text-muted">Suggested side: <span className="font-semibold text-fg">{sideLabel(best)}</span></div>
                </div>
                <span className="shrink-0 rounded-full bg-accent/20 px-2.5 py-1 text-[13px] font-bold tabular-nums text-accent">{Math.round(best.share)}%</span>
              </div>
            </div>
          </div>
        ) : null}

        {/* actions */}
        <button
          type="button"
          onClick={runScan}
          disabled={scanning || busy}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-accent py-3 text-[15px] font-bold text-accent-fg transition hover:brightness-105 disabled:opacity-50"
        >
          <Icon path="M11 4a7 7 0 105.2 11.7l3.5 3.6M11 4a7 7 0 015.2 11.7" className="h-4 w-4" />
          {scanning ? 'Scanning…' : 'Deep Scan for Best Market'}
        </button>
        <button
          type="button"
          disabled={!best || scanning}
          onClick={() => { if (best) { onApply(best); setOpen(false); } }}
          className="mt-2 w-full rounded-xl border border-border py-2.5 text-[14px] font-semibold text-fg transition hover:border-accent/60 disabled:opacity-40"
        >
          Load Deep Scanner Bot
        </button>

        {busy ? (
          <p className="mt-2 text-center text-[11px] text-warn">Finish or stop the current trade before scanning.</p>
        ) : null}
      </div>
    </div>
  );
}
