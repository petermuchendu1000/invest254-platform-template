'use client';

import { useDigitHistory } from '@/lib/game/useDigitHistory';
import { useDisplayMoney } from '@/lib/money';
import { cn } from '@/lib/cn';
import type { DigitHistoryDto } from '@/lib/api/types';

/** Human label for a digit contract type + its barrier/pick. */
function typeLabel(kind: string, target: number | null): string {
  switch (kind) {
    case 'even': return 'Even';
    case 'odd': return 'Odd';
    case 'over': return `Over ${target ?? ''}`.trim();
    case 'under': return `Under ${target ?? ''}`.trim();
    case 'matches': return `Matches ${target ?? ''}`.trim();
    case 'differs': return `Differs ${target ?? ''}`.trim();
    default: return kind || '—';
  }
}

const fmtTime = (ms: number | null): string =>
  ms ? new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

/**
 * Persisted, reviewable DIGIT trade history (docs/34). Each row is a full receipt: type + barrier,
 * stake, entry spot @ tick, settle spot @ settled-digit @ tick, payout, and P/L. Server-backed
 * (survives sessions/devices), newest-first, with load-more. Purely presentational (brand tokens).
 */
export function DigitHistoryPanel() {
  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage } = useDigitHistory();
  const { fmt } = useDisplayMoney();
  const rows: DigitHistoryDto[] = (data?.pages ?? []).flatMap((p) => p.items);

  return (
    <section className="flex min-h-0 flex-col rounded-2xl border border-border bg-surface-2">
      <div className="flex items-center justify-between px-4 py-3">
        <h3 className="text-sm font-semibold text-fg">Trade history</h3>
        {rows.length > 0 ? <span className="text-xs text-muted">{rows.length} shown</span> : null}
      </div>

      {isLoading ? (
        <p className="px-4 pb-4 text-sm text-muted">Loading your trades…</p>
      ) : isError ? (
        <p className="px-4 pb-4 text-sm text-down">Couldn’t load history. Pull to retry.</p>
      ) : rows.length === 0 ? (
        <p className="px-4 pb-5 text-sm text-muted">No trades yet. Your placed contracts will appear here with entry &amp; settle details.</p>
      ) : (
        <div className="table-wrapper max-h-80 overflow-y-auto">
          <ul className="divide-y divide-border">
            {rows.map((r) => {
              const won = r.result === 'win';
              const settled = r.status === 'settled';
              const pnl = r.pnlCents ?? 0;
              return (
                <li key={r.id} className="flex items-center gap-3 px-4 py-2.5">
                  {/* Type + time */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold text-fg">{typeLabel(r.kind, r.target)}</span>
                      {settled ? (
                        <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-bold uppercase',
                          won ? 'bg-up/15 text-up' : 'bg-down/15 text-down')}>{won ? 'Won' : 'Lost'}</span>
                      ) : (
                        <span className="rounded bg-border px-1.5 py-0.5 text-[10px] font-bold uppercase text-muted">Open</span>
                      )}
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted">
                      Stake {fmt(r.stakeCents)} · {fmtTime(r.settledAt ?? r.openedAt)}
                    </div>
                  </div>

                  {/* Entry → settle spots + ticks + settled digit */}
                  <div className="hidden shrink-0 text-right text-[11px] tabular-nums text-muted sm:block">
                    <div>
                      in <span className="text-fg">{r.entryRate.toFixed(2)}</span>
                      {r.openIndex != null ? <span className="text-muted"> #{r.openIndex}</span> : null}
                    </div>
                    <div>
                      out <span className="text-fg">{r.exitRate != null ? r.exitRate.toFixed(2) : '—'}</span>
                      {r.settleIndex != null ? <span className="text-muted"> #{r.settleIndex}</span> : null}
                    </div>
                  </div>

                  {/* Settled digit chip */}
                  <div className="shrink-0">
                    <span className={cn('flex h-8 w-8 items-center justify-center rounded-full border text-sm font-bold tabular-nums',
                      settled ? (won ? 'border-up/60 text-up' : 'border-down/60 text-down') : 'border-border text-muted')}>
                      {r.settleDigit != null ? r.settleDigit : '·'}
                    </span>
                  </div>

                  {/* P/L */}
                  <div className="w-20 shrink-0 text-right">
                    <div className={cn('text-sm font-bold tabular-nums', !settled ? 'text-muted' : won ? 'text-up' : 'text-down')}>
                      {settled ? `${pnl >= 0 ? '+' : ''}${fmt(pnl)}` : '—'}
                    </div>
                    <div className="text-[10px] text-muted">payout {r.payoutCents != null ? fmt(r.payoutCents) : '—'}</div>
                  </div>
                </li>
              );
            })}
          </ul>
          {hasNextPage ? (
            <div className="p-3">
              <button
                type="button"
                onClick={() => void fetchNextPage()}
                disabled={isFetchingNextPage}
                className="w-full rounded-lg border border-border py-2 text-sm font-semibold text-fg transition hover:border-accent/60 disabled:opacity-50"
              >
                {isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
