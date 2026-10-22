'use client';

import { useEffect, useRef, useState } from 'react';
import { accountSummary, mobileAccountRows, mtAmount, lotsOfStake } from '@invest254/shared/account';
import { PENDING_LABELS } from '@invest254/shared/pending';
import { useGameSocket, useGameSocketApi } from '@/lib/game/GameSocketProvider';
import { useWallet } from '@/lib/wallet/hooks';
import { useDisplayMoney } from '@/lib/money';
import { useOrderEntry } from '@/lib/game/useOrderEntry';
import { MT5PositionMenu } from '@/components/game/MT5PositionMenu';
import { MT5ClosePosition } from '@/components/game/MT5ClosePosition';
import { MT5ModifyPosition } from '@/components/game/MT5ModifyPosition';
import {
  MT5SwipeRow, SwipeCloseIcon, SwipeEditIcon, SwipePlusIcon, SwipeChartIcon, SwipeDepthIcon,
  type SwipeCommand,
} from '@/components/game/mobile/MT5SwipeRow';
import { ticketLabel, type ActivePosition, type PendingOrderDto } from '@/lib/game/betting';
import { useNavDrawer } from '@/lib/ui/drawer';
import { valueIsStale } from '@/lib/ui/dataPhase';
import { LiveBadge } from '@/components/ui/LiveBadge';
import { cn } from '@/lib/cn';

/**
 * MetaTrader mobile's Trade screen.
 *
 * Top bar carrying the total floating profit in blue, then the account summary block, then a
 * `Positions` section of two-line rows (docs/mt5/04-mobile-app.md section 4). Every label, every
 * ordering and the number format are MetaTrader's own, read off `android/en/trade.png`:
 *
 *     Balance:            9 862.16
 *     Equity:             9 897.11
 *     Margin:             2 165.03
 *     Free margin:        7 732.08
 *     Margin Level (%):     457.14
 *
 * The rows themselves come from `mobileAccountRows` in the shared package, which is unit-tested
 * against that screenshot character for character — including the three things the phone does
 * differently from the desktop strip: no currency code anywhere, the per cent sign in the LABEL
 * rather than the value, and Android's lower-cased "Free margin:".
 *
 * ── The dotted leader ────────────────────────────────────────────────────────────────────────────
 * "Android draws a dotted leader between them; iOS does not." Android's is the build this shell
 * follows, so the leader is here, drawn as a repeating gradient rather than a row of full stops: a
 * literal run of dots cannot be made to end exactly where the value begins at every width.
 *
 * ── Every position, and the orders waiting to become one ─────────────────────────────────────────
 * This screen used to show ONE position and no Orders section, under comments saying "this engine
 * holds one contract at a time" and "this engine has no pending orders at all". Neither is true any
 * more: the socket publishes `positions` (a list, oldest first) and `pendingOrders`, and the desktop
 * Toolbox has rendered both for some time. A trader holding three contracts was shown one, and the
 * account block beneath summed only that one, so Equity and Free margin on the phone disagreed with
 * the same figures on the desktop. Both sections are now the whole list.
 *
 * `Orders` sits under `Positions`, which is MetaTrader's order, and each section is drawn only when
 * it has rows — an empty band headed "Orders" would still be a promise rather than a view.
 */
export function MT5MobileTrade({ onNewOrder, onChart }: { onNewOrder: () => void; onChart: () => void }) {
  const money = useDisplayMoney();
  const { data: wallet } = useWallet();
  const { positions, pendingOrders, status, sell, cancelPending, earlyCloseEnabled } = useGameSocket();
  const stale = valueIsStale(status);
  const { getLastTick } = useGameSocketApi();
  const openDrawer = useNavDrawer((s) => s.setOpen);
  // `volDigits` is the ORDER TICKET's own volume digits, so the row states the same lot size the
  // ticket that opened it showed (docs/mt5/09-toolbox.md 300, rows at 313-318). The row printed two
  // places whatever the symbol's step was, so a 0.025-lot position read 0.03 here.
  const { settledSymbol, digits, priceOfRate, volDigits } = useOrderEntry();

  // The floating figures ride the tick stream, which does not re-render React on its own.
  // `useOrderEntry` already drives that re-render on its own 250ms timer, and a second one here
  // only doubled the renders without showing a newer number.

  /**
   * Which row's sheet is open, and WHICH ROW.
   *
   * It was a bare `'menu' | 'close' | 'modify'`, which is all a one-position screen needs. With a
   * list it has to name the position too, or a close form opened from the third row would act on
   * whichever position the screen happened to call "the live one". Keyed on `clientId` because that
   * is the one id every position has from the instant it is optimistically opened; `positionId` is
   * null until the engine answers.
   */
  const [sheet, setSheet] = useState<{ kind: 'menu' | 'close' | 'modify'; clientId: string } | null>(null);
  /**
   * Which rows are expanded. Android: "a single tap expands the row inline; a long press (~1 s)
   * opens the context menu" (04-mobile-app.md 253). A Set, not one id, because MetaTrader's rows
   * expand independently and collapsing one to open another is a rule it does not have.
   */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggleExpanded = (clientId: string) => setExpanded((cur) => {
    const next = new Set(cur);
    if (!next.delete(clientId)) next.add(clientId);
    return next;
  });
  /**
   * MetaTrader's sort button (↑↓) in the Trade top bar (04-mobile-app.md 210).
   *
   * It toggles the direction of the list's own order and nothing else. MetaQuotes publishes no sort
   * KEYS for this screen — the Market Watch's "Sort ▸" submenu is undocumented too (10-market-watch
   * 2.5, "Could not verify" #2) — so a menu of keys here would be invented. The engine sends
   * `positions` oldest first, so the two states are "oldest first" and "newest first", which are
   * real orderings of a real list rather than a guess at MetaTrader's menu.
   */
  const [newestFirst, setNewestFirst] = useState(false);

  /**
   * Every open contract, and the account figures that follow from ALL of them.
   *
   * A settling position still counts: its stake left the balance when it opened and has not come
   * back yet, so dropping it from `openStakeCents` would show the trader margin they cannot spend as
   * free. The screen keeps drawing it, dimmed by its own row, until the engine's settle removes it
   * from the list.
   */
  const openStakeCents = positions.reduce((sum, p) => sum + p.stakeCents, 0);
  const floatingCents = positions.reduce((sum, p) => sum + p.livePnlCents, 0);
  const shown = newestFirst ? [...positions].reverse() : positions;
  const forSheet = sheet === null ? null : positions.find((p) => p.clientId === sheet.clientId) ?? null;
  const summary = accountSummary({
    walletCents: (wallet?.real ?? 0) + (wallet?.bonus ?? 0),
    openStakeCents,
    floatingPnlCents: floatingCents,
  });
  const rows = mobileAccountRows({
    balance: money.toDisplay(summary.balanceCents),
    equity: money.toDisplay(summary.equityCents),
    margin: money.toDisplay(summary.marginCents),
    freeMargin: money.toDisplay(summary.freeMarginCents),
    marginLevelPct: summary.marginLevelPct,
  });

  const px = (rate: number | null | undefined): string => {
    const p = priceOfRate(rate);
    return p === null ? '-' : p.toFixed(digits);
  };

  /**
   * MetaTrader Android's six swipe icons on a position row, in its documented order:
   *
   *   1. Close By   2. Close position   3. Edit position   4. Increase position
   *   5. Open Chart   6. Depth of Market
   *
   * Five of them are here. `Close By` is not, and that is MetaTrader's own behaviour rather than a
   * cut: it shows that icon "hedging accounts only, and only if an opposite position on the same
   * symbol exists", and neither holds here, so MetaTrader would not draw it either.
   *
   * The two that cannot work are DIMMED and say why, not dropped. An icon bar is a map of what the
   * platform does; a short bar teaches the wrong map, and an icon that silently does nothing is
   * worse than one that says it cannot.
   *
   * `Chart` is last of the live ones, which makes it the command MetaTrader's "drag the menu
   * further to the left" fires on its own. That is the right one to land on: it navigates and
   * changes nothing, so a drag that goes further than intended cannot cost money.
   */
  const closeNoteOf = (pos: ActivePosition): string | undefined => (!earlyCloseEnabled
    ? 'This brand settles every contract at expiry.'
    : !pos.sellable
      ? 'This contract settles at expiry and cannot be closed at a loss.'
      : pos.phase !== 'open'
        ? 'This contract is already settling.'
        : undefined);

  /** The six icons, bound to ONE position: with a list, a swipe has to act on the row it opened. */
  const swipeCommandsOf = (pos: ActivePosition): readonly SwipeCommand[] => [
    {
      label: 'Close position',
      icon: SwipeCloseIcon,
      onPick: () => setSheet({ kind: 'close', clientId: pos.clientId }),
      unavailable: closeNoteOf(pos),
    },
    { label: 'Edit position', icon: SwipeEditIcon, onPick: () => setSheet({ kind: 'modify', clientId: pos.clientId }) },
    {
      /**
       * MetaTrader pre-fills a new order from the position it was opened on, and this engine can
       * hold several contracts at once now, so the command WORKS: it opens the ticket, which is
       * already primed with this symbol and the trader's last volume. It used to be dimmed with
       * "this engine holds one contract at a time", which stopped being true when the engine began
       * publishing a list of positions.
       */
      label: 'Increase position',
      icon: SwipePlusIcon,
      onPick: onNewOrder,
    },
    { label: 'Open Chart', icon: SwipeChartIcon, onPick: onChart },
    {
      label: 'Depth of Market',
      icon: SwipeDepthIcon,
      unavailable: 'This engine quotes one price per symbol and keeps no order book, so there is no depth to show.',
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--mt5-surface)] text-[var(--mt5-text)]">
      {/* Android's top bar, all four of its controls (04-mobile-app.md 210):
          `☰` | "Trade" small with the total floating profit beneath it in blue | sort (↑↓) | new
          order. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--mt5-border)] px-3 py-2">
        {/**
          * The hamburger, which was missing and was not a cosmetic absence.
          *
          * It was left out because "the hamburger is on the chart screen's own bar, so it is not
          * repeated here" — but the five-tab bar reaches this screen directly, so a trader who
          * opened the app on Trade had NO route to the drawer at all, and the drawer is where
          * Funds, Settings, Legal and the session action live. MetaTrader draws it on this bar;
          * so does this now.
          */}
        <button
          type="button"
          onClick={() => openDrawer(true)}
          aria-label="Open menu"
          className="-ml-1 grid h-9 w-9 shrink-0 place-items-center rounded text-white"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-5 w-5" aria-hidden>
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
        <div className="min-w-0">
          <div className="text-[11px] leading-none text-[var(--mt5-muted)]">Trade</div>
          <div
            className={cn(
              'pt-1 font-mono text-[18px] font-semibold leading-none tabular-nums',
              floatingCents > 0 ? 'text-[var(--mt5-blue)]' : floatingCents < 0 ? 'text-[var(--mt5-red)]' : 'text-[var(--mt5-blue)]',
            )}
          >
            {/* The ONE figure on this screen that names the currency: "the total floating profit
                beneath it in blue ("34.95 EUR")" (docs/mt5/04-mobile-app.md 211). The position
                rows below it are bare (242-248), and so is the account block (mobileAccountRows). */}
            {mtAmount(money.toDisplay(floatingCents))} {money.currency}
          </div>
        </div>
        {/* One definition of this dot, shared with the three other surfaces that had grown their
            own copy of the same ternary — and it now carries a text equivalent, which a 6px dot
            with a `title` never had on a touch device. */}
        <LiveBadge status={status} showLabel={false} variant="terminal" className="ml-auto" />
        {/* MetaTrader's sort button. Drawn only where there is an order to change: one row has no
            ordering, and a control that cannot do anything is worse than one that is not there. */}
        {positions.length > 1 ? (
          <button
            type="button"
            onClick={() => setNewestFirst((v) => !v)}
            aria-pressed={newestFirst}
            aria-label={newestFirst ? 'Sorted newest first. Sort oldest first.' : 'Sorted oldest first. Sort newest first.'}
            title={newestFirst ? 'Newest first' : 'Oldest first'}
            className="grid h-9 w-9 shrink-0 place-items-center rounded text-[var(--mt5-blue)]"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden>
              <path d="M7 4v16M7 4L4 7M7 4l3 3" />
              <path d="M17 20V4M17 20l-3-3M17 20l3-3" />
            </svg>
          </button>
        ) : null}
        {/* MetaTrader's new-order button: a document with a plus. */}
        <button
          type="button"
          onClick={onNewOrder}
          aria-label="New order"
          className="grid h-9 w-9 shrink-0 place-items-center rounded text-[var(--mt5-blue)]"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden>
            <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" />
            <path d="M14 3v5h5" />
            <path d="M12 11v6M9 14h6" />
          </svg>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <dl className="px-3 py-2">
          {rows.map((r) => (
            <div key={r.label} className="flex items-baseline gap-1 py-[3px]">
              <dt className="shrink-0 text-[12px] text-[var(--mt5-muted)]">{r.label}</dt>
              {/* Android's dotted leader. A repeating radial gradient rather than a run of "."
                  characters: dots typed into the gap cannot be made to stop exactly where the
                  value starts at every screen width, and a leader that overruns reads as broken. */}
              <span
                aria-hidden
                className="min-w-4 flex-1 translate-y-[-3px] self-center"
                style={{
                  height: '1px',
                  backgroundImage: 'radial-gradient(circle, #2b3543 1px, transparent 1px)',
                  backgroundSize: '4px 1px',
                  backgroundRepeat: 'repeat-x',
                }}
              />
              <dd className="shrink-0 font-mono text-[13px] font-semibold tabular-nums">{r.value}</dd>
            </div>
          ))}
        </dl>

        {/* MetaTrader's section header band. */}
        <div className="border-y border-[var(--mt5-border)] bg-[var(--mt5-raised)] px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--mt5-muted)]">
          Positions
        </div>

        {positions.length === 0 ? (
          <p className="px-3 py-6 text-center text-[11px] text-[var(--mt5-muted)]">No open positions.</p>
        ) : (
          shown.map((pos) => (
            /* MetaTrader Android's swipe-left quick commands, over the row's right side. The order
               is its documented one; what each icon does and does not do is argued above. */
            <MT5SwipeRow
              key={pos.clientId}
              label={`${settledSymbol} ${pos.direction}`}
              commands={swipeCommandsOf(pos)}
            >
              <MobilePositionRow
                symbol={settledSymbol}
                direction={pos.direction}
                lots={lotsOfStake(pos.stakeCents, volDigits)}
                from={px(pos.entryRate)}
                /* The tick buffer outlives a disconnect, so this "to" price and the P/L derived
                   from it freeze at their last values. `stale` dims the pair rather than letting a
                   stopped number pass for a live one; the dot in the header says why. */
                to={px(getLastTick()?.rate ?? null)}
                stale={stale}
                profit={money.mt(pos.livePnlCents)}
                profitCents={pos.livePnlCents}
                ticket={ticketLabel(pos)}
                sl={pos.slPrice === null ? null : pos.slPrice.toFixed(digits)}
                tp={pos.tpPrice === null ? null : pos.tpPrice.toFixed(digits)}
                settling={pos.phase === 'settling'}
                expanded={expanded.has(pos.clientId)}
                onToggle={() => toggleExpanded(pos.clientId)}
                onOpenMenu={() => setSheet({ kind: 'menu', clientId: pos.clientId })}
              />
            </MT5SwipeRow>
          ))
        )}

        {/* MetaTrader's second band, under Positions: the orders that have not become positions yet
            (04-mobile-app.md 249-253). Drawn only when there are some, because this engine's
            contracts are market execution by default and a trader who has armed nothing should not
            be shown a heading for it. */}
        {pendingOrders.length > 0 ? (
          <>
            <div className="border-y border-[var(--mt5-border)] bg-[var(--mt5-raised)] px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--mt5-muted)]">
              Orders
            </div>
            {pendingOrders.map((order) => (
              <MobileOrderRow
                key={order.id}
                order={order}
                digits={digits}
                lots={lotsOfStake(order.stakeCents, volDigits)}
                onCancel={() => cancelPending(order.id)}
              />
            ))}
          </>
        ) : null}
      </div>

      {/* MetaTrader's position menu and the two forms it leads to, the same three this terminal's
          desktop Toolbox opens from its own row, and ALL FOUR of its documented Android items:
          Close position, New order, Modify position, Chart. `New order` was absent because the
          engine held one contract at a time; it holds several now, so the item does what MetaTrader
          says it does and opens the ticket, which is already primed with this symbol.

          Every sheet is bound to `forSheet`, the position the row belongs to, looked up afresh from
          the list on each render: the row's live P/L and phase have to keep arriving while its close
          form is open, and a captured copy would freeze at the moment the sheet was opened. */}
      {forSheet && sheet?.kind === 'menu' ? (
        <MT5PositionMenu
          title={`${settledSymbol}, ${forSheet.direction} ${lotsOfStake(forSheet.stakeCents, volDigits)}`}
          subtitle={`#${ticketLabel(forSheet)} at ${px(forSheet.entryRate)}`}
          onDismiss={() => setSheet(null)}
          items={[
            {
              id: 'close',
              label: 'Close position',
              onPick: () => setSheet({ kind: 'close', clientId: forSheet.clientId }),
              disabled: !earlyCloseEnabled || !forSheet.sellable || forSheet.phase !== 'open',
              note: closeNoteOf(forSheet),
            },
            { id: 'neworder', label: 'New order', onPick: () => { setSheet(null); onNewOrder(); } },
            { id: 'modify', label: 'Modify position', onPick: () => setSheet({ kind: 'modify', clientId: forSheet.clientId }) },
            { id: 'chart', label: 'Chart', onPick: () => { setSheet(null); onChart(); } },
          ]}
        />
      ) : null}

      {forSheet && sheet?.kind === 'close' ? (
        <MT5ClosePosition
          pos={forSheet}
          symbol={settledSymbol}
          digits={digits}
          price={priceOfRate(getLastTick()?.rate ?? null)}
          openPrice={forSheet.entryRate === null ? null : priceOfRate(forSheet.entryRate)}
          busy={forSheet.phase === 'settling'}
          onDismiss={() => setSheet(null)}
          /* The position's OWN id. `sell()` with no argument closes whichever one the provider
             considers active, which with a list is the newest rather than the one on screen. */
          onConfirm={() => { sell(forSheet.positionId ?? undefined); setSheet(null); }}
        />
      ) : null}

      {forSheet && sheet?.kind === 'modify' ? (
        <MT5ModifyPosition
          pos={forSheet}
          symbol={settledSymbol}
          digits={digits}
          openPrice={forSheet.entryRate === null ? null : priceOfRate(forSheet.entryRate)}
          canTakeProfit={earlyCloseEnabled}
          onDismiss={() => setSheet(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * One position, in MetaTrader's phone layout: two lines left, the profit right.
 *
 *     GBPUSD, buy 1.00                 46.91
 *     1.26622 → 1.26673
 *
 * Android's exact punctuation — a comma after the symbol, volume to two decimals — and its colour
 * rule: the side word is blue for a buy and red for a sell, and the profit is BLUE when positive,
 * not green. MT5 mobile uses blue for gains throughout, which is the single most recognisable thing
 * about its colour scheme and the easiest to get wrong.
 *
 * ── The two gestures, which are not the same gesture ─────────────────────────────────────────────
 * Android, verbatim: "a single tap expands the row inline; a long press (~1 s) opens the context
 * menu" (04-mobile-app.md 253). This row had the tap opening the menu and no expansion at all,
 * under a comment saying there was nothing to expand "because this contract has no swap, no comment
 * and no stop level". It has a ticket and it has both stop levels now, which is most of what
 * MetaTrader's own expanded card prints:
 *
 *     EURUSD  buy 1.00                            13.00
 *     1.12762 → 1.12775
 *     S / L:   1.12562        Swap:        0.00
 *     T / P:   1.12962                #52763705
 *
 * So the tap expands, and the long press opens the menu. The menu is still reachable without the
 * timing: a swipe-left on the row carries the same commands as icons, which is MetaTrader's other
 * documented route to them, and the expanded card ends in a button to it — a gesture a trader has
 * to hold for a second should never be the ONLY way to reach a close form.
 *
 * `Swap` is not printed. MetaTrader's figure is an overnight financing charge, and this engine has
 * none: a row of `0.00` would be a real-looking number for a cost that does not exist.
 */
function MobilePositionRow({
  symbol, direction, lots, from, to, profit, profitCents, ticket, sl, tp, settling, stale = false, expanded, onToggle, onOpenMenu,
}: {
  symbol: string;
  direction: string;
  lots: string;
  from: string;
  to: string;
  profit: string;
  profitCents: number;
  ticket: string;
  sl: string | null;
  tp: string | null;
  /** Already closing: the row stays, dimmed, until the engine's settle takes it off the list. */
  settling: boolean;
  /** The feed is down, so `to` and the profit are the last values seen rather than current ones. */
  stale?: boolean;
  expanded: boolean;
  onToggle: () => void;
  onOpenMenu: () => void;
}) {
  const buy = direction === 'buy';
  /**
   * The long press, measured by a timer rather than by a library.
   *
   * Cancelled by a move as well as by the release: this row sits inside a swipe container and in a
   * scrolling list, so a drag that begins on the row is a swipe or a scroll and must not also count
   * as a press. `fired` is what stops the release from then being treated as the tap.
   */
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const cancel = () => { if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; } };
  const start = () => {
    fired.current = false;
    cancel();
    timer.current = setTimeout(() => { fired.current = true; timer.current = null; onOpenMenu(); }, 1000);
  };
  useEffect(() => cancel, []);

  return (
    <div className={cn('border-b border-[var(--mt5-border)]', settling ? 'opacity-60' : '')}>
      <button
        type="button"
        onClick={() => { if (!fired.current) onToggle(); }}
        onPointerDown={start}
        onPointerUp={cancel}
        onPointerLeave={cancel}
        onPointerCancel={cancel}
        onPointerMove={cancel}
        onContextMenu={(e) => { e.preventDefault(); cancel(); onOpenMenu(); }}
        aria-expanded={expanded}
        aria-label={`${symbol} ${direction} ${lots}, ${expanded ? 'collapse' : 'expand'} details`}
        className="flex w-full items-start justify-between gap-3 px-3 py-2.5 text-left transition active:bg-[var(--mt5-raised)]"
      >
        <div className="min-w-0">
          <div className="text-[13px] font-bold text-white">
            {symbol},{' '}
            <span className={cn('font-semibold', buy ? 'text-[var(--mt5-blue)]' : 'text-[var(--mt5-red)]')}>{direction} {lots}</span>
          </div>
          <div className={cn('pt-0.5 font-mono text-[12px] text-[var(--mt5-muted)] tabular-nums', stale && 'opacity-50')}>
            {from} → {to}
          </div>
        </div>
        <div
          className={cn(
            'shrink-0 font-mono text-[13px] font-bold tabular-nums',
            profitCents > 0 ? 'text-[var(--mt5-blue)]' : profitCents < 0 ? 'text-[var(--mt5-red)]' : 'text-white',
            stale && 'opacity-50',
          )}
        >
          {profit}
        </div>
      </button>

      {expanded ? (
        /* MetaTrader's expanded card: the two levels on the left, the ticket bottom-right (Android
           puts it there; iOS puts it at the top). A level that is not set reads "not set" rather
           than being omitted, so the card says the same thing whichever levels this position has. */
        <div className="px-3 pb-2.5 font-mono text-[11px] tabular-nums">
          <div className="flex items-baseline gap-2">
            <span className="w-12 shrink-0 text-[var(--mt5-muted)]">S / L:</span>
            <span className={sl === null ? 'text-[var(--mt5-muted)]' : 'text-white'}>{sl ?? 'not set'}</span>
          </div>
          <div className="flex items-baseline gap-2 pt-0.5">
            <span className="w-12 shrink-0 text-[var(--mt5-muted)]">T / P:</span>
            <span className={tp === null ? 'text-[var(--mt5-muted)]' : 'text-white'}>{tp ?? 'not set'}</span>
            <span className="ml-auto text-[var(--mt5-muted)]">#{ticket}</span>
          </div>
          {/* The commands, without the one-second hold. A long press is MetaTrader's gesture and it
              is implemented above; it is not an acceptable only route to a close form. */}
          <button
            type="button"
            onClick={onOpenMenu}
            className="mt-2 text-[11px] font-semibold text-[var(--mt5-blue-link)]"
          >
            Commands
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * An order waiting on its level, in the phone's own two-line shape.
 *
 * MetaTrader Android: `GBPUSD, buy limit` / `1.00 / 0.00 at 1.26235` · right: `placed` in grey
 * (04-mobile-app.md 251). The `x / y` is requested volume over filled volume, which is always
 * `0.00` while the order is still waiting, and the trigger price follows "at".
 *
 * The delete control is this app's, and it has to be: MetaTrader reaches `Delete order` through the
 * order's context menu, and a phone row whose only gesture led to a menu with one live item would be
 * a menu for the sake of the shape. Nothing has been staked while an order waits, so deleting one
 * settles nothing.
 */
function MobileOrderRow({
  order, digits, lots, onCancel,
}: {
  order: PendingOrderDto;
  digits: number;
  lots: string;
  onCancel: () => void;
}) {
  const buy = order.kind === 'buyLimit' || order.kind === 'buyStop';
  return (
    <div data-pending-order={order.id} className="flex items-start justify-between gap-3 border-b border-[var(--mt5-border)] px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-[13px] font-bold text-white">
          {order.symbol},{' '}
          <span className={cn('font-semibold', buy ? 'text-[var(--mt5-blue)]' : 'text-[var(--mt5-red)]')}>
            {PENDING_LABELS[order.kind].toLowerCase()}
          </span>
        </div>
        <div className="pt-0.5 font-mono text-[12px] text-[var(--mt5-muted)] tabular-nums">
          {lots} / 0 at {order.triggerPrice.toFixed(digits)}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-[11px] text-[var(--mt5-muted)]">placed</span>
        <button
          type="button"
          onClick={onCancel}
          aria-label={`Delete ${PENDING_LABELS[order.kind].toLowerCase()} order`}
          title="Delete this order. Nothing has been staked, so there is nothing to settle."
          className="rounded-sm border border-[var(--mt5-border)] px-1.5 text-[13px] leading-5 text-[var(--mt5-muted)] transition active:border-[var(--mt5-red)] active:text-[var(--mt5-red)]"
        >
          ×
        </button>
      </div>
    </div>
  );
}
