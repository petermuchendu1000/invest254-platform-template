'use client';

import { useState } from 'react';
import { cn } from '@/lib/cn';
import { useDigitSession, sessionStats, type ClosedContract } from '@/lib/game/digitSession';
import { useDigitHistory } from '@/lib/game/useDigitHistory';
import { useAmountText } from '@/lib/game/useAmountText';
import { DIcon } from '@/components/game/digits/icons';
import type { DigitHistoryDto } from '@/lib/api/types';

type Tab = 'open' | 'closed' | 'history';

const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dayClock = (ms: number) => new Date(ms).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function kindLabel(kind: string, target: number | null): string {
  const t = target ?? '';
  switch (kind) {
    case 'even': return 'Even';
    case 'odd': return 'Odd';
    case 'over': return `Over ${t}`.trim();
    case 'under': return `Under ${t}`.trim();
    case 'matches': return `Matches ${t}`.trim();
    case 'differs': return `Differs ${t}`.trim();
    default: return kind || '—';
  }
}

/**
 * Positions (digits broker mock): Open / Closed / History tabs with the session summary pinned at
 * the bottom. Desktop shows it as the left rail; phones open it as a sheet from the bottom nav.
 *  - Open: the contract in play ("settling…").
 *  - Closed: contracts settled in this session.
 *  - History: the player's saved contracts from the server (every session, every device).
 */
export function PositionsPanel({ onClose, className }: { onClose?: () => void; className?: string }) {
  const [tab, setTab] = useState<Tab>('open');
  const open = useDigitSession((s) => s.open);
  const closed = useDigitSession((s) => s.closed);
  const stats = sessionStats(closed);
  const amt = useAmountText();
  const openCount = open ? 1 : 0;

  return (
    <section className={cn('flex min-h-0 flex-col', className)} aria-label="Positions">
      <div className="flex items-stretch border-b border-border">
        {([
          ['open', 'Open', openCount],
          ['closed', 'Closed', closed.length],
          ['history', 'History', null],
        ] as const).map(([id, label, n]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              'relative flex flex-col items-center justify-center px-3 py-2.5 text-[13px] font-semibold leading-tight transition',
              tab === id ? 'text-fg' : 'text-muted hover:text-fg',
            )}
          >
            <span>{label}</span>
            {n != null ? <span className="tabular-nums">({n})</span> : null}
            {tab === id ? <span aria-hidden className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-accent" /> : null}
          </button>
        ))}
        {onClose ? (
          <button type="button" onClick={onClose} aria-label="Close positions" className="ml-auto grid w-10 place-items-center text-muted transition hover:text-fg">
            <DIcon name="close" className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'open' ? (
          open ? (
            <ul>
              <li className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
                <div>
                  <div className="font-mono text-[13px] font-bold uppercase text-fg">{open.label}</div>
                  <div className="font-mono text-[11px] text-muted">{clock(open.openedAtMs)}</div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-[13px] font-bold tabular-nums text-fg">{amt.prefix}{amt.num(open.stakeCents)}</div>
                  <div className="text-[11px] font-medium text-accent">settling…</div>
                </div>
              </li>
            </ul>
          ) : (
            <Empty title="No open positions" body="Your active trades will appear here" />
          )
        ) : tab === 'closed' ? (
          closed.length ? (
            <ul>{closed.map((c) => <ClosedRow key={c.id} c={c} />)}</ul>
          ) : (
            <Empty title="No closed positions" body="Trades you settle this session will appear here" />
          )
        ) : (
          <HistoryList />
        )}
      </div>

      <footer className="mt-auto flex flex-col gap-1.5 border-t border-border px-4 py-3 text-[12px]">
        <div className="flex items-center justify-between">
          <span className="text-muted">Session</span>
          <span className="text-muted tabular-nums">{stats.trades} trades ({stats.wins}W / {stats.losses}L)</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted">Session P/L:</span>
          <span className={cn('font-mono text-[13px] font-bold tabular-nums', stats.pnlCents > 0 ? 'text-up' : stats.pnlCents < 0 ? 'text-down' : 'text-up')}>{amt.signed(stats.pnlCents)}</span>
        </div>
        <div className="text-[11px] text-muted">{openCount} open position{openCount === 1 ? '' : 's'}</div>
      </footer>
    </section>
  );
}

function ClosedRow({ c }: { c: ClosedContract }) {
  const amt = useAmountText();
  return (
    <li className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
      <div className="flex items-start gap-2.5">
        <span className={cn('mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border font-mono text-[11px] font-bold', c.won ? 'border-up/60 text-up' : 'border-down/60 text-down')}>{c.digit}</span>
        <div>
          <div className="flex items-center gap-1.5 font-mono text-[13px] font-bold uppercase text-fg">{c.label}{c.demo ? <DemoTag /> : null}</div>
          <div className="font-mono text-[11px] text-muted">{clock(c.settledAtMs)}</div>
        </div>
      </div>
      <div className="text-right">
        <div className="font-mono text-[13px] font-bold tabular-nums text-fg">{amt.prefix}{amt.num(c.stakeCents)}</div>
        <div className={cn('font-mono text-[11px] font-semibold tabular-nums', c.won ? 'text-up' : 'text-down')}>{amt.signed(c.pnlCents)}</div>
      </div>
    </li>
  );
}

function HistoryList() {
  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage } = useDigitHistory();
  const amt = useAmountText();
  const rows: DigitHistoryDto[] = (data?.pages ?? []).flatMap((p) => p.items);
  if (isLoading) return <p className="px-4 py-4 text-sm text-muted">Loading your trades…</p>;
  if (isError) return <p className="px-4 py-4 text-sm text-down">Couldn’t load your trades.</p>;
  if (!rows.length) return <Empty title="No trades yet" body="Every contract you place is saved here" />;
  return (
    <>
      <ul>
        {rows.map((r) => {
          const settled = r.status === 'settled';
          const won = r.result === 'win';
          const pnl = r.pnlCents ?? 0;
          return (
            <li key={r.id} className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
              <div className="flex items-start gap-2.5">
                <span className={cn('mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border font-mono text-[11px] font-bold',
                  !settled ? 'border-border text-muted' : won ? 'border-up/60 text-up' : 'border-down/60 text-down')}>{r.settleDigit ?? '·'}</span>
                <div>
                  <div className="flex items-center gap-1.5 font-mono text-[13px] font-bold uppercase text-fg">{kindLabel(r.kind, r.target)}{r.demo ? <DemoTag /> : null}</div>
                  <div className="font-mono text-[11px] text-muted">{dayClock(r.settledAt ?? r.openedAt)}</div>
                </div>
              </div>
              <div className="text-right">
                <div className="font-mono text-[13px] font-bold tabular-nums text-fg">{amt.prefix}{amt.num(r.stakeCents)}</div>
                <div className={cn('font-mono text-[11px] font-semibold tabular-nums', !settled ? 'text-muted' : won ? 'text-up' : 'text-down')}>
                  {settled ? amt.signed(pnl) : 'open'}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {hasNextPage ? (
        <div className="p-3">
          <button type="button" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}
            className="w-full rounded-lg border border-border py-2 text-sm font-semibold text-fg transition hover:border-accent/60 disabled:opacity-50">
            {isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      ) : null}
    </>
  );
}

function DemoTag() {
  return <span className="rounded bg-warn/15 px-1 py-px font-sans text-[9px] font-bold text-warn">DEMO</span>;
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <span className="mb-2 grid h-16 w-16 place-items-center rounded-full border border-border bg-surface-2 text-muted">
        <DIcon name="target" className="h-7 w-7" />
      </span>
      <p className="text-[15px] font-semibold text-fg">{title}</p>
      <p className="text-[13px] text-muted">{body}</p>
    </div>
  );
}
