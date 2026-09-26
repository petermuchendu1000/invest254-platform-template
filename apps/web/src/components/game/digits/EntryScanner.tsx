'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { Sheet } from '@/components/ui/Sheet';
import { Segmented } from '@/components/ui/Segmented';
import { useGameSocketApi } from '@/lib/game/GameSocketProvider';
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
  /** Percentage points above that side's expected share (even/odd 50, over 5 40, under 5 50, a digit 10). */
  edge: number;
  /** Over/Under barrier or Matches digit, when relevant. */
  digit?: number;
}

const MARKET_OPTIONS: { id: ScanMarket; label: string }[] = [
  { id: 'evenodd', label: 'Even/Odd' },
  { id: 'matchesdiffers', label: 'Match/Differ' },
  { id: 'overunder', label: 'Over/Under' },
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
    return { side, share, strength: share - 50 };
  }
  if (market === 'overunder') {
    // Over 5 wins on 6–9 (40% expected), Under 5 on 0–4 (50%). Compare each to ITS OWN expectation
    // (BUGLOG #96: raw shares always favoured Under, and ~50% was shown as if it were a lean).
    const over = f[6]! + f[7]! + f[8]! + f[9]!;
    const under = f[0]! + f[1]! + f[2]! + f[3]! + f[4]!;
    const dOver = over - 40, dUnder = under - 50;
    const side: ScanSide = dOver >= dUnder ? 'over' : 'under';
    return { side, share: side === 'over' ? over : under, strength: Math.max(dOver, dUnder), digit: OVERUNDER_BARRIER };
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
  const { subscribeInstrument, getInstrumentTicks } = useGameSocketApi();

  const [market, setMarket] = useState<ScanMarket>('evenodd');
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
          const sug: ScanSuggestion = { instrumentId: inst.id, market, side: lean.side, share: lean.share, edge: lean.strength };
          if (lean.digit != null) sug.digit = lean.digit;
          found.push(sug);
        }
        setProgress(i + 1);
      }
      // strongest lean = the biggest gap between observed and expected share for its side
      found.sort((a, b) => b.edge - a.edge);
      setBest(found[0] ?? null);
    } finally {
      // Always restore the user's instrument feed, and always end the scan: closing the sheet mid-scan
      // used to leave it "Scanning…" with both buttons disabled for good (BUGLOG #84).
      subscribeInstrument(currentInstrumentId);
      setScanning(false);
    }
  }

  const pct = total ? Math.round((progress / total) * 100) : 0;

  const robot = (
    <span className="grid h-8 w-8 place-items-center rounded-full bg-accent/15 text-accent ring-1 ring-accent/30">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-[18px] w-[18px]">
        <rect x="4" y="4.6" width="16" height="13.8" rx="4" />
        <circle cx="9" cy="11" r="2.2" />
        <circle cx="15" cy="11" r="2.2" />
        <path d="M8.6 14.4c1 1.4 5.8 1.4 6.8 0" />
      </svg>
    </span>
  );

  return (
    // Sheet + segmented control (BUGLOG #120): the market list was a dropdown inside a bottom sheet
    // that ran off the bottom of the screen on phones, with nothing to scroll.
    <Sheet open={open} onClose={() => setOpen(false)} title="Entry Scanner" label="AI Entry Scanner" icon={robot}
      footer={
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={runScan}
            disabled={scanning || busy}
            className={cn('flex items-center justify-center gap-2 rounded-xl py-3 text-[15px] font-bold transition disabled:opacity-40',
              best ? 'border border-border text-fg hover:border-accent/60' : 'col-span-2 bg-accent text-accent-fg hover:brightness-105')}
          >
            <Icon path="M11 4a7 7 0 105.2 11.7l3.5 3.6M11 4a7 7 0 015.2 11.7" className="h-4 w-4" />
            {scanning ? `${pct}%` : busy ? 'Auto running' : best ? 'Rescan' : 'Scan'}
          </button>
          {best ? (
            <button
              type="button"
              disabled={scanning}
              onClick={() => { onApply(best); setOpen(false); }}
              className="flex items-center justify-center gap-2 rounded-xl bg-accent py-3 text-[15px] font-bold text-accent-fg transition hover:brightness-105 disabled:opacity-40"
            >
              <Icon path="M7 5l12 7-12 7V5z" className="h-4 w-4" />Run
            </button>
          ) : null}
        </div>
      }>
      <Segmented label="Market" value={market} onChange={setMarket} options={MARKET_OPTIONS} disabled={scanning} className="mt-1" />
        {/* progress / result */}
        {scanning ? (
          <div className="mt-4">
            <div className="flex items-center justify-between text-[12px] font-semibold text-muted">
              <span>{instrumentById(INSTRUMENTS[Math.min(progress, total - 1)]!.id).short}</span>
              <span className="tabular-nums">{progress}/{total}</span>
            </div>
            <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
            </div>
          </div>
        ) : best ? (
          <div className="mt-4">
            <div className="flex items-center justify-between text-[12px] font-semibold text-muted">
              <span>Best</span>
              <span className="tabular-nums">{total}/{total}</span>
            </div>
            <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full bg-accent" style={{ width: '100%' }} />
            </div>
            <div className="mt-3 rounded-xl border border-accent/40 bg-accent/10 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-[15px] font-extrabold text-fg">{instrumentById(best.instrumentId).label}</div>
                  <div className="text-[13px] font-semibold text-fg">{sideLabel(best)}</div>
                </div>
                <span className="shrink-0 text-right">
                  <span className="block rounded-full bg-accent/20 px-2.5 py-1 text-[13px] font-bold tabular-nums text-accent">{Math.round(best.share)}%</span>
                  <span className="mt-0.5 block text-[11px] font-semibold tabular-nums text-muted" title="Points above the expected share">{best.edge >= 0 ? '+' : ''}{best.edge.toFixed(1)}</span>
                </span>
              </div>
            </div>
          </div>
        ) : null}

    </Sheet>
  );
}
