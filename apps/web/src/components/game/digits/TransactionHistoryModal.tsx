'use client';

import { useEffect, useMemo } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/cn';
import { api } from '@/lib/api/endpoints';
import { useSession } from '@/lib/auth/session';
import { useDigitSession } from '@/lib/game/digitSession';
import { useAmountText } from '@/lib/game/useAmountText';
import { instrumentById } from '@/lib/game/instruments';
import { DIcon } from '@/components/game/digits/icons';
import type { DigitHistoryDto, LedgerEntryDto } from '@/lib/api/types';

const stamp = (ms: number) =>
  new Date(ms).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', '');

function kindText(d: DigitHistoryDto): string {
  const t = d.target ?? '';
  return ({ even: 'even', odd: 'odd', over: `over ${t}`, under: `under ${t}`, matches: `matches ${t}`, differs: `differs ${t}` } as Record<string, string>)[d.kind] ?? d.kind;
}

/** Title + subtitle for one ledger line, enriched with the digit contract it belongs to (if any). */
function describe(e: LedgerEntryDto, contract: DigitHistoryDto | undefined): { title: string; sub: string } {
  const bonus = e.balanceKind === 'bonus' ? ' · bonus' : '';
  if (e.type === 'adjustment' && e.balanceKind === 'demo') return { title: 'Demo balance refreshed', sub: 'play money' };
  switch (e.type) {
    case 'stake':
      return { title: 'Trade Stake', sub: contract ? `${kindText(contract)} · ${instrumentById(contract.instrumentId ?? '').short}` : `trade${bonus}` };
    case 'payout':
      return { title: 'Trade Win', sub: contract ? `${kindText(contract)} · result ${contract.settleDigit ?? '—'}` : `trade${bonus}` };
    case 'deposit': return { title: 'Deposit', sub: 'M-Pesa' };
    case 'withdrawal': return { title: 'Withdrawal', sub: 'M-Pesa' };
    case 'withdrawal_reversal': return { title: 'Withdrawal refunded', sub: 'returned to your balance' };
    case 'bonus': return { title: 'Bonus', sub: 'bonus balance' };
    case 'adjustment': return { title: 'Balance adjustment', sub: 'by support' };
    default: return { title: e.type.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()), sub: bonus.replace(' · ', '') };
  }
}

/**
 * Transaction history (digits broker mock): one list of deposits, withdrawals, bonuses and every
 * trade stake and win, newest first, straight from the wallet ledger (the money of record). Trade
 * lines are labelled from the matching saved digit contract ("odd · result 7").
 */
export function TransactionHistoryModal() {
  const open = useDigitSession((s) => s.historyOpen);
  const setOpen = useDigitSession((s) => s.setHistoryOpen);
  const token = useSession((s) => s.token);
  const amt = useAmountText();

  const ledger = useInfiniteQuery({
    queryKey: ['wallet-ledger', 'history-modal'],
    enabled: open && !!token,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.ledger(token as string, { cursor: pageParam ?? null, limit: 40 }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const contracts = useQuery({
    queryKey: ['digit-history', 'lookup'],
    enabled: open && !!token,
    queryFn: () => api.digitHistory(token as string, { limit: 100 }),
  });
  const byId = useMemo(() => new Map((contracts.data?.items ?? []).map((c) => [c.id, c])), [contracts.data]);
  const rows = (ledger.data?.pages ?? []).flatMap((p) => p.items);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-3 sm:p-6" role="dialog" aria-modal="true" aria-label="Transaction history">
      <button aria-label="Close" className="absolute inset-0 bg-black/70 backdrop-blur-md" onClick={() => setOpen(false)} />
      <div className="relative flex max-h-[88vh] w-full max-w-[510px] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl">
        <header className="flex items-center gap-3 border-b border-border bg-gradient-to-r from-accent/10 to-transparent px-5 py-4">
          <span className="grid h-9 w-9 place-items-center rounded-xl border border-accent/40 bg-accent/10 text-accent"><DIcon name="clock" className="h-5 w-5" /></span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-semibold text-fg">Transaction History</h2>
            <p className="text-[11px] text-muted">Deposits, withdrawals &amp; trade activity</p>
          </div>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:text-fg">
            <DIcon name="close" className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-2">
          {!token ? (
            <p className="px-4 py-8 text-center text-sm text-muted">Sign in to see your transactions.</p>
          ) : ledger.isLoading ? (
            <p className="px-4 py-8 text-center text-sm text-muted">Loading…</p>
          ) : ledger.isError ? (
            <p className="px-4 py-8 text-center text-sm text-down">Couldn’t load your transactions.</p>
          ) : rows.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted">No transactions yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((e) => {
                const credit = e.amountCents >= 0;
                const { title, sub } = describe(e, e.refId ? byId.get(e.refId) : undefined);
                return (
                  <li key={e.id} className="flex items-center gap-3 px-3 py-3">
                    <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-xl border',
                      credit ? 'border-up/50 bg-up/10 text-up' : 'border-warn/50 bg-warn/10 text-warn')}>
                      <DIcon name={credit ? 'trend' : 'arrowDownRight'} className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-semibold text-fg">{title}</div>
                      <div className="truncate text-[11px] text-muted">{sub}{e.balanceKind === 'demo' ? <span className="ml-1.5 rounded bg-warn/15 px-1 text-[9px] font-bold text-warn">DEMO</span> : null}</div>
                    </div>
                    <div className="text-right">
                      <div className={cn('font-mono text-[13px] font-bold tabular-nums', credit ? 'text-up' : 'text-warn')}>
                        {credit ? '+' : '-'}{amt.prefix}{amt.num(e.amountCents)}
                      </div>
                      <div className="text-[10px] tabular-nums text-muted">{stamp(e.ts)}</div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {ledger.hasNextPage ? (
            <div className="p-3">
              <button type="button" onClick={() => void ledger.fetchNextPage()} disabled={ledger.isFetchingNextPage}
                className="w-full rounded-lg border border-border py-2 text-sm font-semibold text-fg transition hover:border-accent/60 disabled:opacity-50">
                {ledger.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
