'use client';

import { useState } from 'react';
import { MT5Price } from '@/components/game/MT5Price';
import { useOrderEntry } from '@/lib/game/useOrderEntry';
import { refusalReason } from '@/lib/game/orderResult';
import { quoteTone, QUOTE_TONE_COLOUR } from '@/lib/game/quoteTone';
import { useGameSocket } from '@/lib/game/GameSocketProvider';
import { cn } from '@/lib/cn';

/**
 * MetaTrader's Market Watch **Trading** tab: One Click Trading.
 *
 * Read off `en/market_watch_trading_x2.png` at 3.5x (docs/mt5/10-market-watch.md 9.1). It is a grid
 * of panels, one per symbol in the Symbols tab, and each panel is:
 *
 *     ┌ EURUSD                                 05:00:28 ┐
 *     │ [ SELL ] [▾] [   0.10   ] [▴] [ BUY ]           │
 *     │ ┌──────────────┬──────────────┐                 │
 *     │ │  1.13 59 ²   │  1.13 59 ²   │                 │
 *     │ └──────────────┴──────────────┘                 │
 *     │   LOW    │  Spread: 0   │   HIGH                │
 *     │ 1.13541  │ Swap: -1.00/-0.70 │ 1.13747         │
 *     └─────────────────────────────────────────────────┘
 *
 * Symbol bold left, last quote time right; the two big blocks are the Bid under SELL and the Ask
 * under BUY, in MetaTrader's own price typography; the footer is `LOW | middle | HIGH` over the
 * three values.
 *
 * Three things this panel takes from MetaQuotes' own prose rather than guessing:
 *
 *   The MIDDLE of the footer is the LAST price, not a spread and a swap. Verbatim: "If the price
 *   of the last executed deal is available for a symbol, it is displayed instead of spread and
 *   swap." This platform's symbols are Last-mode (their Specification says so) and carry no
 *   overnight financing at all, so MetaTrader's own alternative is the one that applies.
 *
 *   The two halves are NOT one colour. "`NZDCAD` renders its SELL half blue and its BUY half red
 *   in one panel. Each half takes the tick colour of its own side's price" (10-market-watch.md
 *   1107-1110), which corrects an earlier note in this repo's own docs.
 *
 *   A click TRADES. Verbatim: "once the 'Sell' or 'Buy' button is pressed, the corresponding
 *   request… is immediately sent to the server without any additional confirmation." So there is
 *   no confirm step here, which is the whole point of the tab; the result lands in the Journal and
 *   the Trade tab as any order's does.
 *
 * The symbol set is deliberately not its own: "The set of symbols for quick trading is taken from
 * the list on the 'Symbols' tab."
 */
/** What a panel needs off a Market Watch quote, which is a subset of the socket's `SymbolQuote`. */
export interface OneClickQuote {
  price: number | null;
  up: boolean | null;
  changedAt: number | null;
  t: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  instrument: { scale: number; digits: number };
}

export function MT5OneClickTrading({ symbols, quoteOf, digitsOf, settledSymbol }: {
  symbols: readonly string[];
  quoteOf: (symbol: string) => OneClickQuote | null;
  digitsOf: (symbol: string) => number;
  /** The one symbol this brand accepts an order on. Every other panel says so instead of trading. */
  settledSymbol: string | null;
}) {
  const entry = useOrderEntry();
  const { spread } = useGameSocket();
  /** The last refusal, by symbol, so a rejected click says why on the panel that was clicked. */
  const [refused, setRefused] = useState<{ symbol: string; text: string } | null>(null);

  if (symbols.length === 0) {
    return (
      <div className="px-3 py-4 text-center text-[11px] leading-snug text-[var(--mt5-muted)]">
        No symbols shown. One Click Trading uses the Symbols tab&apos;s own list.
      </div>
    );
  }

  return (
    <div data-trading-tab="" className="space-y-2 p-2">
      {symbols.map((symbol) => (
        <OneClickPanel
          key={symbol}
          symbol={symbol}
          digits={digitsOf(symbol)}
          quote={quoteOf(symbol)}
          spread={spread}
          entry={entry}
          tradable={symbol === settledSymbol && symbol === entry.symbol && !entry.connecting}
          /**
           * The two reasons a panel cannot trade, and they are different: a symbol this brand does
           * not settle never can, and the settled symbol cannot while the chart is on another one,
           * because the ticket follows the chart. The second comes with a way out.
           */
          blocked={
            symbol !== settledSymbol
              ? `This brand settles ${settledSymbol ?? 'one symbol'} only, so an order cannot be placed on ${symbol}.`
              : entry.symbol !== symbol
                ? `The chart is on ${entry.symbol}. Orders follow the chart, as MetaTrader's do.`
                : entry.connecting ? 'Connecting to the trade server.' : null
          }
          onChartSettled={symbol === settledSymbol && entry.symbol !== symbol ? entry.chartSettled : null}
          refusal={refused?.symbol === symbol ? refused.text : null}
          onTrade={(dir) => {
            const r = entry.place(dir);
            if (r === 'sent' || r === 'deposit') { setRefused(null); return; }
            const { title, detail } = refusalReason(r);
            setRefused({ symbol, text: `${title}. ${detail}` });
          }}
        />
      ))}
    </div>
  );
}

function OneClickPanel({
  symbol, digits, quote, spread, entry, tradable, blocked, onChartSettled, refusal, onTrade,
}: {
  symbol: string;
  digits: number;
  quote: OneClickQuote | null;
  spread: { buy: number; sell: number } | null;
  entry: ReturnType<typeof useOrderEntry>;
  tradable: boolean;
  blocked: string | null;
  onChartSettled: (() => void) | null;
  refusal: string | null;
  onTrade: (dir: 'buy' | 'sell') => void;
}) {
  const price = quote?.price ?? null;
  const scale = quote?.instrument.scale ?? null;
  /**
   * The two sides, by the spread the engine already charges. Identical arithmetic to the order
   * ticket's (see `useOrderEntry.bidAsk`), so a panel and the ticket cannot quote differently:
   * a price is `base + scale * value` and the cost is in curve-value units, so the offset in price
   * terms is `cost * scale`.
   */
  const sides = price !== null && spread !== null && scale !== null
    ? { bid: price - spread.sell * scale, ask: price + spread.buy * scale }
    : null;

  /**
   * MetaTrader's tick colour, per HALF rather than per panel: blue up, red down, the theme
   * foreground once the price has not moved for fifteen seconds. Both sides move together here
   * because both are derived from one quote, which is what a one-price feed with a fixed spread
   * means; `quoteTone` still owns the fifteen-second rule.
   */
  const tone = quoteTone({ up: quote?.up ?? null, changedAt: quote?.changedAt ?? null, now: Date.now() });
  const colour = tone === null ? '#ffffff' : QUOTE_TONE_COLOUR[tone];

  const t = quote?.t ?? null;
  const hhmmss = t === null ? '' : new Date(t).toLocaleTimeString('en-GB', { hour12: false });

  return (
    <div data-one-click={symbol} className="rounded-sm border border-[var(--mt5-border)] bg-[#1b232d]">
      <div className="flex items-baseline gap-2 border-b border-[var(--mt5-border)] px-2 py-1">
        <span className="text-[12px] font-semibold text-white">{symbol}</span>
        <span className="ml-auto font-mono text-[10px] text-[var(--mt5-muted)]">{hhmmss}</span>
      </div>

      {/* MetaTrader's button strip: SELL, the volume between its two steppers, BUY. */}
      <div className="flex items-stretch gap-1 px-2 pt-2">
        <button
          type="button"
          disabled={!tradable}
          onClick={() => onTrade('sell')}
          className={cn(
            'flex-1 rounded-sm py-1 text-[11px] font-semibold tracking-wide transition',
            tradable ? 'bg-[var(--mt5-red)]/85 text-white hover:bg-[var(--mt5-red)]' : 'bg-[var(--mt5-border)] text-[var(--mt5-muted)]',
          )}
        >
          SELL
        </button>
        <div className="flex items-stretch overflow-hidden rounded-sm border border-[var(--mt5-border)]">
          <Stepper label="▾" onClick={() => entry.bump(-entry.volStep)} disabled={!tradable || entry.lots <= entry.minLots} />
          <span className="grid w-[4.5rem] place-items-center bg-[#151b23] font-mono text-[11px] tabular-nums text-white">
            {entry.lots.toFixed(entry.volDigits)}
          </span>
          <Stepper label="▴" onClick={() => entry.bump(entry.volStep)} disabled={!tradable || entry.lots >= entry.maxLots} />
        </div>
        <button
          type="button"
          disabled={!tradable}
          onClick={() => onTrade('buy')}
          className={cn(
            'flex-1 rounded-sm py-1 text-[11px] font-semibold tracking-wide transition',
            tradable ? 'bg-[var(--mt5-blue)]/85 text-white hover:bg-[var(--mt5-blue)]' : 'bg-[var(--mt5-border)] text-[var(--mt5-muted)]',
          )}
        >
          BUY
        </button>
      </div>

      {/* The two big price blocks: the Bid you sell at, the Ask you buy at. */}
      <div className="mt-1.5 grid grid-cols-2 gap-1 px-2">
        <PriceBlock value={sides?.bid ?? null} digits={digits} colour={colour} />
        <PriceBlock value={sides?.ask ?? null} digits={digits} colour={colour} />
      </div>

      {/* MetaTrader's footer, two lines. The middle is the LAST price rather than a spread and a
          swap, which is its own documented alternative for a symbol that has one. */}
      <div className="mt-1.5 grid grid-cols-3 border-t border-[var(--mt5-border)] px-2 py-1 text-center">
        {([
          ['LOW', quote?.dayLow ?? null],
          ['Last', price],
          ['HIGH', quote?.dayHigh ?? null],
        ] as const).map(([label, value]) => (
          <div key={label}>
            {/* LOW and HIGH are MetaTrader's own capitals; the middle cell is not one of them (its
                own middle reads `Spread: 0` / `Swap: …`), so `Last` keeps its case. */}
            <div className={cn('text-[9px] tracking-wide text-[var(--mt5-muted)]', label !== 'Last' && 'uppercase')}>{label}</div>
            <div className="font-mono text-[10.5px] tabular-nums text-[#c8d2de]">
              {value === null ? '-' : value.toFixed(digits)}
            </div>
          </div>
        ))}
      </div>

      {blocked === null ? null : (
        <p className="border-t border-[var(--mt5-border)] px-2 py-1 text-[10px] leading-snug text-[var(--mt5-muted)]">
          {blocked}
          {onChartSettled === null ? null : (
            <button type="button" onClick={onChartSettled} className="ml-1 text-[var(--mt5-blue)] underline">
              Chart {symbol}
            </button>
          )}
        </p>
      )}
      {refusal === null ? null : (
        <p className="border-t border-[var(--mt5-border)] px-2 py-1 text-[10px] leading-snug text-[var(--mt5-red)]">{refusal}</p>
      )}
    </div>
  );
}

function Stepper({ label, onClick, disabled }: { label: string; onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label === '▴' ? 'Increase volume' : 'Decrease volume'}
      className="w-6 bg-[var(--mt5-raised)] text-[10px] text-[#c8d2de] transition hover:bg-[var(--mt5-border)] disabled:text-[#4a5666]"
    >
      {label}
    </button>
  );
}

/** One half of the panel, in MetaTrader's price typography and its own tick colour. */
function PriceBlock({ value, digits, colour }: { value: number | null; digits: number; colour: string }) {
  return (
    <div className="rounded-sm bg-[#151b23] py-1.5 text-center">
      <MT5Price value={value} digits={digits} className="text-[18px] font-semibold" style={{ color: colour }} />
    </div>
  );
}
