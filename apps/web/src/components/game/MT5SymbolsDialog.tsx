'use client';

import { useEffect, useMemo, useState } from 'react';
import type { SymbolRow } from '@/lib/game/GameSocketProvider';
import { MAX_WATCHED } from '@/lib/game/symbolSet';
import { cn } from '@/lib/cn';

/**
 * MetaTrader's Symbols dialog, reached with Ctrl+U or from the Market Watch context menu.
 *
 * MetaQuotes describes it as the place where "the full list of symbols provided by the broker" is
 * shown as a tree of groups, and where symbols are added to or removed from Market Watch. The tree
 * is the broker's own grouping — `Forex\Majors`, `Metals` and so on — which is why the engine sends
 * each symbol's group rather than letting the client invent one.
 *
 * Two departures from MetaTrader, both forced and both stated in the dialog itself rather than left
 * for the trader to discover:
 *
 *   - There is a CAP on how many symbols may be shown at once. MetaTrader has no such limit; this
 *     engine holds a bounded number of price chains resident and quotes only the warm ones, so a
 *     longer list would contain rows that never quote. Stopping the trader at the point of asking
 *     is better than a window of silent rows.
 *   - MetaTrader's left pane also carries Custom symbols and a search box. Custom symbols mean
 *     synthesising an instrument from a formula over others, which this platform has no concept of.
 */
export function MT5SymbolsDialog({ catalogue, watched, onApply, onDismiss }: {
  catalogue: readonly SymbolRow[];
  watched: readonly string[];
  onApply: (symbols: readonly string[]) => void;
  onDismiss: () => void;
}) {
  const [picked, setPicked] = useState<readonly string[]>(watched);
  const [query, setQuery] = useState('');
  /** Groups start collapsed except the ones the trader already has symbols from. */
  const [open, setOpen] = useState<readonly string[]>(() => {
    const has = new Set(catalogue.filter((s) => watched.includes(s.symbol)).map((s) => s.group));
    return [...has];
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  const groups = useMemo(() => {
    const q = query.trim().toUpperCase();
    const rows = q === ''
      ? catalogue
      : catalogue.filter((s) => s.symbol.includes(q) || s.description.toUpperCase().includes(q));
    const by = new Map<string, SymbolRow[]>();
    for (const r of rows) (by.get(r.group) ?? by.set(r.group, []).get(r.group)!).push(r);
    return [...by.entries()];
  }, [catalogue, query]);

  const full = picked.length >= MAX_WATCHED;
  const toggle = (symbol: string) => setPicked((prev) =>
    prev.includes(symbol) ? prev.filter((s) => s !== symbol) : prev.length >= MAX_WATCHED ? prev : [...prev, symbol]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Symbols"
      className="fixed inset-0 z-[86] flex flex-col bg-[var(--mt5-surface)] text-[var(--mt5-text)] sm:items-center sm:justify-center sm:bg-black/60 sm:p-4"
    >
      <div className="flex min-h-0 w-full flex-1 flex-col bg-[var(--mt5-surface)] sm:h-[78vh] sm:max-w-[460px] sm:flex-none sm:rounded-sm sm:border sm:border-[var(--mt5-border)]">
        <div className="flex items-center gap-2 border-b border-[var(--mt5-border)] px-3 py-2.5">
          {/* MetaTrader's own icon for this window: "Title: `Symbols`, with the yellow `$` badge
              icon" (docs/mt5/10-market-watch.md 999), the same badge its context-menu entry carries
              (442) and the same one the tree's group nodes wear. It was a blue `S`, which is a
              letter from the window's title rather than MetaTrader's mark. */}
          <span aria-hidden className="grid h-4 w-4 shrink-0 place-items-center rounded-[2px] bg-[#f0b90b] text-[11px] font-black leading-none text-[#1a1a1a]">$</span>
          <span className="flex-1 truncate text-[15px] font-semibold leading-tight">Symbols</span>
          <button type="button" onClick={onDismiss} aria-label="Close" className="shrink-0 px-1 text-[18px] leading-none text-[var(--mt5-muted)] transition hover:text-white">×</button>
        </div>

        <div className="shrink-0 border-b border-[var(--mt5-border)] px-3 py-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find symbol"
            aria-label="Find symbol"
            className="h-7 w-full rounded-sm border border-[var(--mt5-border)] bg-[var(--mt5-raised)] px-2 text-[11px] text-[var(--mt5-text)] outline-none placeholder:text-[#4a5666] focus:border-[var(--mt5-blue)]"
          />
          <p className={cn('mt-1.5 text-[10px] leading-snug', full ? 'text-[#f0b90b]' : 'text-[var(--mt5-muted)]')}>
            {picked.length} of {MAX_WATCHED} shown.
            {full ? ' That is the most this feed quotes at once; hide one to add another.' : ''}
          </p>
        </div>

        {/*
          MetaTrader's three columns, verbatim and in order: `Symbol | Description | Expiration`
          (docs/mt5/10-market-watch.md 1028). Two were drawn here and the list carried no headings at
          all, so there was nothing to say which cell was which.

          Every cell under `Expiration` is EMPTY, and that is MetaTrader's own rendering rather than a
          gap: its screenshot shows blank Expiration cells for EURUSD, GBPUSD and USDCHF, because a
          spot instrument has no expiry date. Nothing in this catalogue is a dated contract, so the
          column is present and empty throughout — which is also why there is no "Show expired
          contracts" checkbox beside the search box.
        */}
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--mt5-border)] bg-[var(--mt5-raised)] px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--mt5-muted)]">
          <span aria-hidden className="w-3 shrink-0" />
          <span className="w-20 shrink-0">Symbol</span>
          <span className="min-w-0 flex-1">Description</span>
          <span className="w-16 shrink-0 text-right">Expiration</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {groups.length === 0 ? (
            <p className="px-3 py-4 text-center text-[11px] text-[var(--mt5-muted)]">No symbol matches that.</p>
          ) : groups.map(([group, rows]) => {
            const expanded = open.includes(group) || query.trim() !== '';
            return (
              <div key={group}>
                <button
                  type="button"
                  onClick={() => setOpen((p) => (p.includes(group) ? p.filter((g) => g !== group) : [...p, group]))}
                  aria-expanded={expanded}
                  className="flex w-full items-center gap-2 border-b border-[var(--mt5-border)]/60 bg-[var(--mt5-raised)] px-3 py-1.5 text-left text-[11px] font-semibold text-[var(--mt5-text)]"
                >
                  <span aria-hidden className="w-3 text-[var(--mt5-muted)]">{expanded ? '−' : '+'}</span>
                  {/* MetaTrader prints the tree path with a backslash; the leaf is what reads as a heading. */}
                  <span className="flex-1 truncate">{group.replace('\\', ' › ')}</span>
                  <span className="w-16 shrink-0 text-right font-mono text-[10px] text-[var(--mt5-muted)]">{rows.length}</span>
                </button>
                {expanded ? rows.map((r) => {
                  const on = picked.includes(r.symbol);
                  return (
                    <label
                      key={r.symbol}
                      className={cn(
                        'flex cursor-pointer items-center gap-2 border-b border-[var(--mt5-border)]/40 px-3 py-1.5 text-[11px] transition hover:bg-[var(--mt5-raised)]',
                        !on && full ? 'opacity-50' : '',
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={!on && full}
                        onChange={() => toggle(r.symbol)}
                        className="h-3 w-3 shrink-0 accent-[var(--mt5-blue)]"
                      />
                      <span className="w-20 shrink-0 font-semibold text-white">{r.symbol}</span>
                      <span className="min-w-0 flex-1 truncate text-[var(--mt5-muted)]">{r.description}</span>
                      <span className="w-16 shrink-0 text-right text-[var(--mt5-muted)]" />
                    </label>
                  );
                }) : null}
              </div>
            );
          })}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-[var(--mt5-border)] px-3 py-2.5">
          <button
            type="button"
            onClick={() => setPicked([])}
            className="h-8 rounded-sm border border-[var(--mt5-border)] px-3 text-[11px] font-semibold text-[var(--mt5-muted)] transition hover:text-white"
          >
            Hide all
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onDismiss}
            className="h-8 rounded-sm border border-[var(--mt5-border)] px-3 text-[11px] font-semibold text-[var(--mt5-muted)] transition hover:text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => { onApply(picked); onDismiss(); }}
            className="h-8 rounded-sm bg-[var(--mt5-blue)] px-5 text-[11px] font-semibold text-white transition hover:brightness-110"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
