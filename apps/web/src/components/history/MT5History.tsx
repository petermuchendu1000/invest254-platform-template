'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { XAUUSD } from '@invest254/shared/candles';
import { lotsOfStake } from '@invest254/shared/account';
import { useVolumeDigits } from '@/lib/game/volumeDigits';
import { usePositions } from '@/lib/positions/hooks';
import { useTransactions } from '@/lib/wallet/hooks';
import { useSession } from '@/lib/auth/session';
import { useDisplayMoney } from '@/lib/money';
import { PositionDetailModal } from '@/components/positions/PositionDetailModal';
import {
  PERIODS, SORTS, dealRows, moneySummary, orderRows, ordersSummary,
  periodRange, periodSubtitle, positionRows, priceText, sortRows, stamp,
  type DealRow, type HistoryTab, type OrderRow, type PeriodKey, type PositionRow, type Range,
  type SortKey,
} from '@/lib/history/mt5history';
import type { PositionDto, TransactionDto } from '@/lib/api/types';
import { MT5TitleBar, MT5Summary, MT5SummaryLine, MT5Entry, MT5Amount, MT5Empty } from '@/components/mt5/kit';
import { cn } from '@/lib/cn';

/**
 * MetaTrader 5's History screen.
 *
 * Built against the product's own screens (metatrader5.com/en/mobile-trading/android/help/history),
 * element by element: the blue header carrying the screen name over the symbol filter, the three
 * tabs underlined in the title bar itself, the dotted-leader summary with its figures in blue, and
 * two-line entries whose side and result carry MetaTrader's blue/red pairing. The period and sort
 * menus are the ones behind its two header icons, and both really filter and really sort.
 *
 * What each tab means — and why we genuinely have all three — is documented in lib/history/mt5history.
 * Scoped to candlestick (terminal) brands; every other shell keeps the standard History tabs.
 */

const SYMBOL = XAUUSD.symbol;

/**
 * A price as this symbol quotes it, or "at market" when the trade carries none.
 *
 * The engine stamps the executed price on every trade (migration 0180), so these screens print the
 * number the player actually saw. Only a trade older than that column falls back — see
 * EXECUTION_PRICE in lib/history/mt5history.
 */
const px = (price: number | null) => priceText(price, XAUUSD.digits);

/** Enough pages to cover the longest preset without hammering the API on a large account. */
const MAX_AUTO_PAGES = 20;

const TAB_LABELS: Record<HistoryTab, string> = { positions: 'Positions', orders: 'Orders', deals: 'Deals' };

export function MT5History({ embedded = false }: {
  /** Rendered inside the phone shell's History tab rather than on the /history route. */
  embedded?: boolean;
}) {
  const token = useSession((s) => s.token);
  const money = useDisplayMoney();
  /**
   * Volume prints to the SYMBOL's volume digits, the same ones the order ticket offers.
   *
   * docs/mt5/09-toolbox.md 300 and the rows at 313-318: one rule for the ticket and the grids. These
   * rows read `0.03` while the ticket that placed them read `0.025`, so the lot size appeared to
   * change between the ticket and the row it produced.
   */
  const volumeDigits = useVolumeDigits(SYMBOL);
  const lots = useCallback((stakeCents: number) => lotsOfStake(stakeCents, volumeDigits), [volumeDigits]);
  /**
   * Money on this screen is BARE: no currency code anywhere.
   *
   * docs/mt5/09-toolbox.md 429 keeps the code after the Balance value alone and prints "all other
   * figures bare"; 729 is stricter for the History summary strip, which carries no code at all,
   * "not even after Balance". Every figure here went through the wallet formatter and read
   * `KES 225`, which is neither.
   */
  const amount = money.mt;

  const [tab, setTab] = useState<HistoryTab>('positions');
  const [period, setPeriod] = useState<PeriodKey>('month');
  const [custom, setCustom] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const [menu, setMenu] = useState<'period' | 'sort' | null>(null);
  // Close time, descending: the newest settled record first, which is the view MetaTrader opens on.
  const [sort, setSort] = useState<SortKey>('closetime');
  const [ascending, setAscending] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  // The range is recomputed per render from a clock read, which is correct for "Today" when the page
  // is left open across midnight.
  const range: Range = useMemo(
    () => periodRange(period, Date.now(), {
      ...(custom.from ? { fromMs: new Date(`${custom.from}T00:00:00`).getTime() } : {}),
      ...(custom.to ? { toMs: new Date(`${custom.to}T00:00:00`).getTime() + 86_400_000 } : {}),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [period, custom.from, custom.to],
  );

  const positionsQ = usePositions('all');
  const transactionsQ = useTransactions();

  const positions: PositionDto[] = useMemo(
    () => (positionsQ.data?.pages ?? []).flatMap((p) => p.items),
    [positionsQ.data],
  );
  const transactions: TransactionDto[] = useMemo(
    () => (transactionsQ.data?.pages ?? []).flatMap((p) => p.items),
    [transactionsQ.data],
  );

  // Both feeds are newest-first and cursor-paged. A period filter that only ever saw the first page
  // would quietly under-report "Last 3 months", so keep pulling until the oldest record loaded is
  // older than the window — then stop, because everything beyond it is outside the period anyway.
  useAutoPage(positionsQ, positions.at(-1)?.openedAt, range.fromMs);
  useAutoPage(transactionsQ, transactions.at(-1)?.ts, range.fromMs);

  const orders = useMemo(
    () => orderRows(positions, range, SYMBOL, lots),
    [positions, range, lots],
  );
  const deals = useMemo(
    () => dealRows(positions, transactions, range, SYMBOL, lots),
    [positions, transactions, range, lots],
  );
  const closed = useMemo(
    () => positionRows(positions, transactions, range, SYMBOL, lots),
    [positions, transactions, range, lots],
  );

  const money3 = moneySummary(tab === 'deals' ? deals : closed);
  const counts = ordersSummary(orders);
  const loading = positionsQ.isLoading || transactionsQ.isLoading;

  // Sorted per tab rather than over a union, so each row type keeps its own shape all the way to
  // the entry that renders it.
  const sortedOrders = sortRows(orders, sort, ascending);
  const sortedDeals = sortRows(deals, sort, ascending);
  const sortedClosed = sortRows(closed, sort, ascending);
  const shown = tab === 'orders' ? sortedOrders.length : tab === 'deals' ? sortedDeals.length : sortedClosed.length;

  return (
    <div className="flex min-h-full flex-1 flex-col bg-[var(--mt5-surface)] text-[var(--mt5-text)]">
      {/* MetaTrader keeps the screen name, the symbol filter and the tabs all inside the one blue
          band. One instrument is quoted, so "All symbols" is a statement of fact rather than a picker
          that would open on a list of one. */}
      <MT5TitleBar
        embedded={embedded}
        {...(embedded ? {} : { back: true as const })}
        title="History"
        subtitle="All symbols"
        actions={<>
            <IconButton
              label="Sort"
              active={menu === 'sort'}
              onClick={() => setMenu((m) => (m === 'sort' ? null : 'sort'))}
            >
              <path d="M7 4v16M7 20l-3-3M7 4l3 3M17 20V4M17 4l3 3M17 20l-3-3" />
            </IconButton>
            <IconButton
              label="Period"
              active={menu === 'period'}
              onClick={() => setMenu((m) => (m === 'period' ? null : 'period'))}
            >
              <path d="M4 6h16v14H4zM4 10h16M8 3v4M16 3v4" />
            </IconButton>

            {menu ? (
              <>
                <button
                  type="button"
                  aria-label="Close menu"
                  onClick={() => setMenu(null)}
                  className="fixed inset-0 z-30 cursor-default"
                />
                <div className="absolute right-0 top-full z-40 mt-1 w-60 overflow-hidden rounded border border-[var(--mt5-border)] bg-[var(--mt5-raised)] shadow-2xl">
                  {menu === 'period' ? (
                    <PeriodMenu
                      period={period}
                      custom={custom}
                      onPeriod={(k) => { setPeriod(k); if (k !== 'custom') setMenu(null); }}
                      onCustom={setCustom}
                    />
                  ) : (
                    <SortMenu
                      sort={sort}
                      ascending={ascending}
                      onPick={(k) => {
                        // Tapping the current key flips the arrow, as MetaTrader's menu does.
                        if (k === sort) setAscending((v) => !v); else { setSort(k); setAscending(false); }
                        setMenu(null);
                      }}
                    />
                  )}
                </div>
              </>
            ) : null}
        </>}
      >
        <div className="flex">
          {(['positions', 'orders', 'deals'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              aria-pressed={tab === t}
              className={cn(
                'flex-1 border-b-2 px-2 pb-2 pt-1.5 text-center text-[12px] font-medium uppercase tracking-wider transition',
                tab === t ? 'border-white text-white' : 'border-transparent text-white/70',
              )}
            >
              {/* Capitalised in the markup and uppercased in CSS: MetaTrader's look, without
                  handing a screen reader three shouted words. */}
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>
      </MT5TitleBar>

      <MT5Summary>
        {tab === 'orders' ? (
          <>
            <MT5SummaryLine label="Filled" value={String(counts.filled)} />
            <MT5SummaryLine label="Canceled" value={String(counts.canceled)} />
            <MT5SummaryLine label="Total" value={String(counts.total)} />
          </>
        ) : (
          <>
            {/* Swap and Commission are the two lines MetaTrader drops when they are zero, and here
                they are structurally zero — nothing is held overnight and nothing is charged per
                trade. See moneySummary. */}
            <MT5SummaryLine label="Profit" value={amount(money3.profitCents)} />
            <MT5SummaryLine label="Deposit" value={amount(money3.depositCents)} />
            <MT5SummaryLine label="Balance" value={amount(money3.balanceCents)} />
          </>
        )}
      </MT5Summary>

      <div className="flex-1 shrink-0">
        {!token ? (
          <MT5Empty>Sign in to see your trading history.</MT5Empty>
        ) : loading ? (
          <MT5Empty>Loading history…</MT5Empty>
        ) : positionsQ.isError || transactionsQ.isError ? (
          <MT5Empty>History is unavailable right now.</MT5Empty>
        ) : shown === 0 ? (
          <MT5Empty>No {TAB_LABELS[tab].toLowerCase()} for {periodSubtitle(range)}.</MT5Empty>
        ) : (
          // MetaTrader shows history as two-line entries on a phone and as a wide table once the
          // window has room — the same split the Toolbox uses. Both are rendered from the same rows.
          <>
            <div className="lg:hidden">
              {tab === 'orders'
                ? sortedOrders.map((r) => <OrderEntry key={r.id} row={r} onOpen={() => setSelected(r.id)} />)
                : tab === 'deals'
                  ? sortedDeals.map((r) => <DealEntry key={r.id} row={r} fmt={money.fmt} />)
                  : sortedClosed.map((r) => (
                    <PositionEntry key={r.id} row={r} fmt={money.fmt} onOpen={() => setSelected(r.id)} />
                  ))}
            </div>
            <div className="hidden lg:block">
              {tab === 'orders' ? (
                <Table head={['Time', 'Order', 'Symbol', 'Type', 'Volume', 'Price', 'State']}>
                  {sortedOrders.map((r) => (
                    <Row key={r.id} onOpen={() => setSelected(r.id)}>
                      <Td>{stamp(r.atMs)}</Td>
                      <Td>{r.ticket}</Td>
                      <Td className="text-left">{r.symbol}</Td>
                      <Td className={sideClass(r.side)}>{r.side}</Td>
                      <Td>{r.lots} / {r.filledLots}</Td>
                      <Td>{r.state === 'CANCELED' ? '-' : px(r.price)}</Td>
                      <Td className="text-[var(--mt5-muted)]">{r.state}</Td>
                    </Row>
                  ))}
                </Table>
              ) : tab === 'deals' ? (
                <Table head={['Time', 'Deal', 'Symbol', 'Type', 'Direction', 'Volume', 'Price', 'Profit']}>
                  {sortedDeals.map((r) => (
                    <Row key={r.id}>
                      <Td>{stamp(r.atMs)}</Td>
                      <Td>{r.ticket}</Td>
                      <Td className="text-left">{r.symbol}</Td>
                      <Td className={r.side ? sideClass(r.side) : ''}>{r.side ?? r.label}</Td>
                      <Td>{r.entry ?? '-'}</Td>
                      <Td>{r.lots ?? '-'}</Td>
                      <Td>{r.lots === null ? '-' : px(r.price)}</Td>
                      <Td><MT5Amount cents={r.amountCents} fmt={amount} /></Td>
                    </Row>
                  ))}
                </Table>
              ) : (
                // MetaTrader's positions table prints the round trip's two prices side by side —
                // what it opened at and what it closed at — which is the whole point of the tab.
                <Table head={['Time', 'Position', 'Symbol', 'Type', 'Volume', 'Price', 'Close price', 'Profit']}>
                  {sortedClosed.map((r) => (
                    <Row key={r.id} onOpen={r.kind === 'trade' ? () => setSelected(r.id) : undefined}>
                      <Td>{stamp(r.atMs)}</Td>
                      <Td>{r.ticket}</Td>
                      <Td className="text-left">{r.symbol}</Td>
                      <Td className={r.side ? sideClass(r.side) : ''}>{r.side ?? r.label}</Td>
                      <Td>{r.lots ?? '-'}</Td>
                      <Td>{r.lots === null ? '-' : px(r.entryPrice)}</Td>
                      <Td>{r.lots === null ? '-' : px(r.exitPrice)}</Td>
                      <Td><MT5Amount cents={r.amountCents} fmt={amount} /></Td>
                    </Row>
                  ))}
                </Table>
              )}
            </div>
          </>
        )}
      </div>

      <PositionDetailModal id={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

/** Pull older pages until the loaded tail reaches past the start of the period, then stop. */
function useAutoPage(
  q: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown; data?: { pages: unknown[] } | undefined },
  oldestMs: number | undefined,
  fromMs: number,
): void {
  const pages = q.data?.pages.length ?? 0;
  const needMore = q.hasNextPage && !q.isFetchingNextPage && pages < MAX_AUTO_PAGES
    && (oldestMs === undefined || oldestMs >= fromMs);
  useEffect(() => {
    if (needMore) void q.fetchNextPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needMore]);
}

// ───────────────────────────────── entries ─────────────────────────────────


const sideClass = (side: string | null) => (side === 'buy' ? 'text-[var(--mt5-blue)]' : 'text-[var(--mt5-red)]');

function OrderEntry({ row, onOpen }: { row: OrderRow; onOpen: () => void }) {
  return (
    <MT5Entry
      title={<>{row.symbol}, <span className={sideClass(row.side)}>{row.side}</span></>}
      time={stamp(row.atMs)}
      detail={`${row.lots} / ${row.filledLots} ${row.state === 'CANCELED' ? '' : px(row.price)}`.trim()}
      result={<span className="text-[var(--mt5-muted)]">{row.state}</span>}
      onOpen={onOpen}
    />
  );
}

function DealEntry({ row, fmt }: { row: DealRow; fmt: (cents: number) => string }) {
  if (row.kind === 'balance') {
    return (
      <MT5Entry
        title={row.symbol}
        time={stamp(row.atMs)}
        detail={row.label}
        result={<MT5Amount cents={row.amountCents} fmt={fmt} />}
      />
    );
  }
  return (
    <MT5Entry
      title={<>{row.symbol}, <span className={sideClass(row.side)}>{row.side}, {row.entry}</span></>}
      time={stamp(row.atMs)}
      detail={`${row.lots} ${px(row.price)}`}
      result={row.amountCents === null ? null : <MT5Amount cents={row.amountCents} fmt={fmt} />}
    />
  );
}

function PositionEntry({ row, fmt, onOpen }: { row: PositionRow; fmt: (cents: number) => string; onOpen: () => void }) {
  if (row.kind === 'balance') {
    return (
      <MT5Entry title={row.symbol} time={stamp(row.atMs)} detail={row.label} result={<MT5Amount cents={row.amountCents} fmt={fmt} />} />
    );
  }
  return (
    <MT5Entry
      title={<>{row.symbol}, <span className={sideClass(row.side)}>{row.side} {row.lots}</span></>}
      time={stamp(row.atMs)}
      detail={`${px(row.entryPrice)} \u2192 ${px(row.exitPrice)}`}
      result={<MT5Amount cents={row.amountCents} fmt={fmt} />}
      onOpen={onOpen}
    />
  );
}

/**
 * MetaTrader's wide-window history table: one line per record, grey headings, no rules between
 * columns — only the thin row rule the entry list uses.
 *
 * `Symbol` is the one left-aligned column and everything else is right-aligned, HEADER INCLUDED:
 * docs/mt5/09-toolbox.md 266-268 reads that off the position grid ("`Symbol` is left-aligned …
 * every column from `Ticket` rightwards is right-aligned, including its header"), and the figure
 * columns here are the same figures. Every column was left-aligned, which breaks the one thing a
 * column of numbers is for — reading the decimal points down the page.
 */
function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <table className="w-full border-collapse text-right font-mono text-[12px] tabular-nums">
      <thead>
        <tr className="border-b border-[var(--mt5-border)] text-[var(--mt5-muted)]">
          {head.map((h) => (
            <th key={h} className={cn('whitespace-nowrap px-3 py-1.5 font-normal', h === 'Symbol' && 'text-left')}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

function Row({ children, onOpen }: { children: React.ReactNode; onOpen?: (() => void) | undefined }) {
  return (
    <tr
      {...(onOpen ? { onClick: onOpen, className: 'cursor-pointer border-b border-[var(--mt5-border)] hover:bg-[var(--mt5-raised)]' } : { className: 'border-b border-[var(--mt5-border)]' })}
    >
      {children}
    </tr>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={cn('whitespace-nowrap px-3 py-1.5', className)}>{children}</td>;
}


// ───────────────────────────────── chrome ─────────────────────────────────


function IconButton({
  label, active, onClick, children,
}: { label: string; active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={active}
      onClick={onClick}
      className={cn('rounded p-1.5 text-white transition', active && 'bg-white/20')}
    >
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  );
}

function PeriodMenu({
  period, custom, onPeriod, onCustom,
}: {
  period: PeriodKey;
  custom: { from: string; to: string };
  onPeriod: (k: PeriodKey) => void;
  onCustom: (c: { from: string; to: string }) => void;
}) {
  return (
    <div className="py-1">
      {PERIODS.map((p) => (
        <button
          key={p.key}
          type="button"
          onClick={() => onPeriod(p.key)}
          className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-[var(--mt5-border)]"
        >
          {/* MetaTrader marks each period with a calendar glyph; the two that are not a plain span
              carry what distinguishes them inside the frame. */}
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden className="shrink-0 text-[var(--mt5-muted)]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <rect x="3.5" y="5.5" width="17" height="15" rx="1.5" />
            <path d="M3.5 10h17M8 3v4M16 3v4" />
            {p.key === 'quarter' ? <text x="12" y="18" textAnchor="middle" fontSize="7" stroke="none" fill="currentColor">3</text> : null}
            {p.key === 'custom' ? <path d="M9 15h6" /> : null}
          </svg>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] text-[var(--mt5-text)]">{p.label}</span>
            {p.key !== 'custom' ? (
              <span className="block truncate font-mono text-[11px] text-[var(--mt5-muted)]">
                {periodSubtitle(periodRange(p.key, Date.now()))}
              </span>
            ) : null}
          </span>
          {period === p.key ? <span className="shrink-0 text-[var(--mt5-blue-link)]" aria-hidden>✓</span> : null}
        </button>
      ))}
      {period === 'custom' ? (
        <div className="flex flex-col gap-1.5 border-t border-[var(--mt5-border)] px-3 py-2">
          <label className="flex items-center gap-2 text-[11px] text-[var(--mt5-muted)]">
            From
            <input
              type="date"
              value={custom.from}
              onChange={(e) => onCustom({ ...custom, from: e.target.value })}
              className="flex-1 rounded border border-[var(--mt5-border)] bg-[var(--mt5-surface)] px-1.5 py-1 text-[12px] text-[var(--mt5-text)] outline-none focus:border-[var(--mt5-blue)]"
            />
          </label>
          <label className="flex items-center gap-2 text-[11px] text-[var(--mt5-muted)]">
            To
            <input
              type="date"
              value={custom.to}
              onChange={(e) => onCustom({ ...custom, to: e.target.value })}
              className="flex-1 rounded border border-[var(--mt5-border)] bg-[var(--mt5-surface)] px-1.5 py-1 text-[12px] text-[var(--mt5-text)] outline-none focus:border-[var(--mt5-blue)]"
            />
          </label>
        </div>
      ) : null}
    </div>
  );
}

function SortMenu({
  sort, ascending, onPick,
}: { sort: SortKey; ascending: boolean; onPick: (k: SortKey) => void }) {
  return (
    <div className="py-1">
      {SORTS.map((s) => (
        <button
          key={s.key}
          type="button"
          onClick={() => onPick(s.key)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-[var(--mt5-text)] hover:bg-[var(--mt5-border)]"
        >
          <span className="flex-1">{s.label}</span>
          {sort === s.key ? (
            <span className="shrink-0 text-[var(--mt5-blue-link)]" aria-hidden>{ascending ? '↑' : '↓'}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

