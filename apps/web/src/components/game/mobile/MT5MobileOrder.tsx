'use client';

import { useState } from 'react';
import { symbolDef } from '@invest254/shared/symbols';
import { useDisplayMoney } from '@/lib/money';
import { useOrderEntry, durationLabel } from '@/lib/game/useOrderEntry';
import { useOrderResult } from '@/lib/game/useOrderResult';
import { MT5OrderResult } from '@/components/game/mobile/MT5OrderResult';
import { useGameSocketApi } from '@/lib/game/GameSocketProvider';
import { MT5TickBand } from '@/components/game/mobile/MT5TickBand';
import { useLevelsStore, useRestoreLevels } from '@/lib/game/levelsStore';
import { levelPrice } from '@/lib/game/levelWatch';
import { volumeSteps, volClampReason } from '@/lib/game/volumeSteps';
import { MT5Price } from '@/components/game/MT5Price';
import { cn } from '@/lib/cn';

/**
 * MetaTrader's PHONE order ticket, which is not its desktop dialog in a full-screen frame.
 *
 * This screen used to be exactly that: the docked desktop ticket, card border and all, pushed over
 * the shell. MetaTrader's phone ticket is a different screen, and its field order is its own
 * (docs/mt5/04-mobile-app.md section 5a, read off `android/en/open_market.png`):
 *
 *    1  back  |  SYMBOL bold + description subtitle
 *    2  the order type, full width, centred, with a triangle at the right edge
 *    3  a SEVEN-cell volume stepper: -0.5 -0.1 -0.01 [value] +0.01 +0.1 +0.5, tap the value to type
 *    4  `- SL +` under a RED underline and `- TP +` under a GREEN one, SIDE BY SIDE on one row
 *    5  `Fill policy:` ..... `Fill or Kill`
 *    6  Bid and Ask, large, side by side, in MetaTrader's big-figure typography
 *    7  a tick chart
 *    8  a warning line
 *    9  the buttons, at the very bottom: TEXT ONLY, two lines each, `SELL` / `by market` in red
 *       and `BUY` / `by market` in blue, with a thin divider between them
 *
 * Nine is the one most easily got wrong, and this screen had it wrong: two filled rectangles with
 * "Sell by Market" on them is iOS's treatment of this screen, not Android's, and Android is the
 * build the rest of this phone shell follows. Android's buttons carry no fill at all.
 *
 * ── Where this instrument differs, and why ───────────────────────────────────────────────────────
 *
 *   BID AND ASK are real here, and this screen shows both. They were not always: a contract used to
 *   open and settle on the same seeded number with no spread for two prices to sit either side of,
 *   and this screen printed one and said so. The terminal's edge then moved INTO the spread, and
 *   `cost` in the continuous payout is now exactly that: the move a trader has to make before the
 *   position is worth its stake. The engine publishes it per side and the two quotes follow from it,
 *   so a buy at the ask and a sell at the bid is the truth about the trade rather than decoration.
 *   A line brand publishes none and still shows its single price.
 *
 *   The order type cannot be changed. MetaTrader's row is a selector over Market Execution and four
 *   pending types; every contract here is market execution, so the row is present, shows what it
 *   is, and says why it will not open.
 *
 *   The tick chart is drawn, and on a price scale with both sides tagged on it, which is what the
 *   reference shows. The Specification dialog's Ticks tab says there is no tick HISTORY to chart and
 *   that is still true: history is served as bars from M1 up. The live buffer is a different thing,
 *   the engine streams it, and it is what MetaTrader draws here.
 *
 *   An EXPIRY row, which MetaTrader has no equivalent of: its positions run until closed, these
 *   settle on a timer the trader picks. It is the single most important fact about the trade, so it
 *   is stated rather than hidden to keep the screen looking more like the original.
 */
export function MT5MobileOrder({ onBack, onAdvanced }: {
  onBack: () => void;
  /** MetaTrader's top-right button: "switches to the extended/advanced dialog". */
  onAdvanced: () => void;
}) {
  const money = useDisplayMoney();
  const { getTicks, getLastTick } = useGameSocketApi();
  const {
    ready, symbol, settledSymbol, digits, price, bidAsk, tradeDisabled, connecting,
    lots, minLots, maxLots, volDigits, volStep, bump, setLots, volNote, stakeCents, overBalance, signedIn,
    durationS, setDurationS, durations, place, continuous, chartSettled,
    priceOfRate,
  } = useOrderEntry();

  /**
   * The SAME levels the advanced dialog and the chart use.
   *
   * This ticket held a money target and the dialog held price levels, so the phone's own two order
   * screens disagreed: set a target here and the dialog still said "not set", and nothing this
   * screen set was ever drawn on the chart.
   */
  const levels = useLevelsStore((s) => s.levels);
  const setLevels = useLevelsStore((s) => s.set);
  const levelRef = useLevelsStore((s) => s.ref);
  useRestoreLevels();
  const anchor = levelRef ?? price;
  const slPrice = levelPrice(levels, anchor, 'sl', digits);
  const tpPrice = levelPrice(levels, anchor, 'tp', digits);
  /** One point at a time, which is what MetaTrader's own stepper on these rows moves by. */
  const bumpTp = (dir: 1 | -1) => {
    if (anchor === null) return;
    const cur = levels.tpPoints;
    setLevels({ ...levels, tpPoints: cur === null ? dir * 100 : cur + dir }, price);
  };
  const bumpSl = (dir: 1 | -1) => {
    if (anchor === null) return;
    const cur = levels.slPoints;
    /**
     * The first press seeds the stop on the side of the button that was pressed.
     *
     * This read `-dir * 100`, which inverted the FIRST press only: "Lower" seeded the stop 100
     * points ABOVE the market and "Raise" seeded it below, while every press after that moved it
     * the way its label said. Internally inconsistent, which is what makes it a bug rather than a
     * convention, and on a tall portrait chart the inverted seed landed off the top of the visible
     * scale, so the level was not drawn at all and looked like a control that did nothing.
     *
     * There is no direction to infer a natural side from: a MetaTrader new-order screen carries
     * SL and TP before the trader has chosen Buy or Sell. So the button's own direction is the only
     * honest answer, and it is what Take Profit beside it has always done.
     */
    setLevels({ ...levels, slPoints: cur === null ? dir * 100 : cur + dir }, price);
  };


  /** "tap the centre value to type on the keyboard" — MetaTrader's own affordance for the volume. */
  const [typing, setTyping] = useState<string | null>(null);
  /**
   * What became of the figure that was typed, when it was not taken as written.
   *
   * MetaTrader's volume field validates keystrokes and reports; it does not quietly swap the
   * number. The phone ticket snapped silently, so typing 1 against a 0.058 ceiling put 0.058 back
   * and read as a field that ignored the keyboard.
   */
  const [volClamp, setVolClamp] = useState<string | null>(null);
  const commit = () => {
    if (typing === null) return;
    const n = Number(typing);
    setTyping(null);
    if (!Number.isFinite(n) || n <= 0) {
      setVolClamp(`"${typing}" is not a volume, so ${lots.toFixed(volDigits)} lots is kept.`);
      return;
    }
    const applied = setLots(n);
    setVolClamp(volClampReason(n, applied, { minLots, maxLots, volStep, volDigits }));
  };
  const volMessage = volClamp ?? volNote;
  const description = symbolDef(symbol)?.description ?? '';
  const steps = volumeSteps(lots, { min: minLots, max: maxLots, step: volStep });
  const refused = tradeDisabled || connecting;
  /**
   * MetaTrader's execution result, which belongs IN THIS WINDOW: "either confirmation of a
   * successful trade or a rejection with the reason specified". The form stays underneath it.
   */
  const { result, report, clear } = useOrderResult({ symbol: settledSymbol, digits, lots, volDigits, priceOf: priceOfRate });
  const send = (dir: 'buy' | 'sell') => report(dir, place(dir));

  if (!ready) return <div className="h-full animate-pulse bg-[var(--mt5-surface)]" />;

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-[var(--mt5-surface)] text-[var(--mt5-text)]">
      {/* 1. Header: back, then the symbol in bold over its description. */}
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--mt5-border)] px-1 py-2">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="grid h-9 w-9 shrink-0 place-items-center rounded text-[var(--mt5-blue)]"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden>
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </button>
        <div className="min-w-0">
          <div className="truncate text-[15px] font-bold leading-tight text-white">{symbol}</div>
          {description === '' ? null : (
            <div className="truncate text-[11px] leading-tight text-[var(--mt5-muted)]">{description}</div>
          )}
        </div>
        {/* MetaTrader's top-right button on this screen, which "switches to the extended/advanced
            dialog" — the sheet with the order-type strip, the volume slider and the SL/TP chips. */}
        <button
          type="button"
          onClick={onAdvanced}
          aria-label="Advanced dialog"
          className="ml-auto grid h-9 w-9 shrink-0 place-items-center rounded text-[var(--mt5-blue)]"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-5 w-5" aria-hidden>
            <path d="M4 7h10M18 7h2M4 12h4M12 12h8M4 17h12M20 17h0" />
            <circle cx="16" cy="7" r="2" />
            <circle cx="10" cy="12" r="2" />
            <circle cx="18" cy="17" r="2" />
          </svg>
        </button>
      </div>

      {/* `min-h-full flex-col` inside the scroller is what lets the tick chart take the slack, the
          way MetaTrader's fills the middle of this screen: on a tall phone the fields do not reach
          the buttons, and the band grows into the gap rather than leaving it black. On a short one
          the band keeps its floor and the screen scrolls. */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
       {/* `[&>*]:shrink-0` so every fixed row keeps its height and the box GROWS past the scroller
           instead of squeezing them. With auto-basis children and negative free space, a flex column
           shrinks its rows rather than overflowing, which clips without producing any scroll at all:
           the content is simply shorter and some of it is gone. The one row meant to flex is the
           tick band below, which opts back in with `grow`. */}
       <div className="flex min-h-full flex-col [&>*]:shrink-0">
        {/* 2. The order type, centred across the width, with MetaTrader's triangle at the edge. */}
        <button
          type="button"
          disabled
          title="Every contract on this platform is market execution. MetaTrader's other four order types are pending orders, and this engine has none."
          className="relative flex w-full items-center border-b border-[var(--mt5-border)] px-3 py-3 text-[14px] text-white disabled:cursor-not-allowed"
        >
          <span className="flex-1 text-center">Market Execution</span>
          {/* MetaTrader's affordance on this row is a small triangle tucked into the BOTTOM-RIGHT
              CORNER of the cell, not a dropdown caret on the baseline. Drawn as a corner wedge so it
              reads the same way at phone density. */}
          <span
            aria-hidden
            className="absolute bottom-0 right-0"
            style={{
              width: 0, height: 0,
              borderLeft: '7px solid transparent',
              borderBottom: '7px solid #5b6b7d',
            }}
          />
        </button>

        {/* 3. The seven-cell stepper. The three sizes scale with the volume, as MetaTrader's do; the
               rule and the two screenshots it reproduces are in lib/game/volumeSteps. */}
        <div className="flex items-stretch border-b border-[var(--mt5-border)]">
          {steps.filter((s) => s.delta < 0).map((s) => (
            <StepCell key={s.label} step={s} onPick={() => { setVolClamp(null); bump(s.delta); }} bound={`Minimum volume ${minLots.toFixed(volDigits)} lots.${volNote === null ? '' : ` ${volNote}`}`} />
          ))}
          {/* The centre cell is NEVER disabled: MetaTrader's volume is a type-in and a brand whose
              minimum equals its maximum sits every stepper cell on its bound at once. */}
          {typing === null ? (
            <button
              type="button"
              onClick={() => setTyping(lots.toFixed(volDigits))}
              title={`Volume in lots. Type a value between ${minLots.toFixed(volDigits)} and ${maxLots.toFixed(volDigits)}.`}
              aria-label={`Volume ${lots.toFixed(volDigits)} lots`}
              className="flex-[1.4] px-1 py-3 text-center font-mono text-[17px] font-bold text-white tabular-nums"
            >
              {lots.toFixed(volDigits)}
            </button>
          ) : (
            <input
              autoFocus
              inputMode="decimal"
              value={typing}
              onChange={(e) => setTyping(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setTyping(null); }}
              aria-label="Volume"
              className="w-0 flex-[1.4] bg-transparent px-1 py-3 text-center font-mono text-[17px] font-bold text-white outline-none tabular-nums"
            />
          )}
          {steps.filter((s) => s.delta > 0).map((s) => (
            <StepCell key={s.label} step={s} onPick={() => { setVolClamp(null); bump(s.delta); }} bound={`Maximum volume ${maxLots.toFixed(volDigits)} lots.${volNote === null ? '' : ` ${volNote}`}`} />
          ))}
        </div>
        {/* Both bounds, always: they are the symbol's own limits intersected with the brand's,
            which is the pair MetaTrader's contract specification states. */}
        <div className="flex items-baseline gap-2 px-3 py-1.5 text-[11px] text-[var(--mt5-muted)]">
          <span>= {money.fmt(stakeCents)}</span>
          <span className="ml-auto">
            min {minLots.toFixed(volDigits)} / max {maxLots.toFixed(volDigits)}
          </span>
        </div>
        {volMessage === null ? null : (
          <p data-volume-note="" className="px-3 pb-1.5 text-[11px] leading-snug text-[#f0b90b]">{volMessage}</p>
        )}

        {/*
          SL and TP, side by side on ONE row, each under its own underline: red for the stop and
          green for the target, the way `android/en/open_market.png` draws them. They sit ABOVE the
          prices here, which is the order of the reference screen; this file's own notes had them
          below, from the field list in docs/mt5/04-mobile-app.md section 5a, and the screenshot is
          the newer evidence.

          Unset, the cell shows the greyed label `SL` / `TP` rather than a value, exactly as the
          reference does.
        */}
        <div className="flex items-stretch border-b border-[var(--mt5-border)]">
          <LevelHalf
            label="SL"
            // MetaTrader's measured Android value for this underline, #EF853A (04-mobile-app.md
            // 571). It is ORANGE, not the terminal's sell red: on mobile MetaTrader reserves
            // orange for the stop and for closing a position, and uses red for a loss. The red
            // here read as "this is the sell side", which is a different claim.
            underline="#EF853A"
            value={anchor === null ? 'waiting' : slPrice === null ? null : slPrice.toFixed(digits)}
            onDown={() => bumpSl(-1)}
            onUp={() => bumpSl(1)}
            disabled={anchor === null}
          />
          <span aria-hidden className="w-px shrink-0 bg-[var(--mt5-border)]" />
          <LevelHalf
            label="TP"
            // #54BE66 (04-mobile-app.md 572), the classic ticket's own green. #0EB52E, which was
            // here, is the ADVANCED dialog's TP chip (570) — a different control on a different
            // screen.
            underline="#54BE66"
            value={!continuous ? 'n/a' : anchor === null ? 'waiting' : tpPrice === null ? null : tpPrice.toFixed(digits)}
            onDown={() => bumpTp(-1)}
            onUp={() => bumpTp(1)}
            disabled={!continuous || anchor === null}
            title={continuous ? undefined : 'This brand settles every contract at expiry, so a target cannot close one early.'}
          />
        </div>

        {/*
          Fill policy, which MetaTrader writes with a colon and right-aligns the value of.

          `Fill or Kill` and not the `Return` the reference screenshot shows, because this row states
          a SYMBOL property, not a piece of MetaTrader's chrome: its Specification dialog lists
          `Filling` as one of `Fill or Kill`, `Immediate or Cancel`, `Book or Cancel`, `Return`, and
          what a screenshot shows is whatever that broker configured for that symbol. This engine
          fills an order whole at the next tick or rejects it, and never leaves a remainder working,
          so Fill or Kill is what it does. `Return` would promise partial fills that cannot happen.
          docs/mt5/01-order-and-close-dialogs.md 60 records the same value for EURUSD market
          execution.
        */}
        <Leader label="Fill policy:" value="Fill or Kill" />

        {/*
          MetaTrader's BID and ASK, large and side by side, in its own typography: the lead digits
          small, the pip figure big, the fractional pip raised.

          Two prices at last, and they are real. `cost` in the continuous payout IS the spread, the
          move a trader has to make before the position is worth its stake, and the engine now
          publishes it per side; `bidAsk` turns it into the two prices a broker quotes. This screen
          used to print one number with a note that there was no spread for two to sit either side
          of, which was true under the step economy and stopped being true when the terminal's edge
          moved into the spread.

          A brand that publishes none still shows the single centred price it always did.
        */}
        {bidAsk === null ? (
          <div className="flex items-end justify-center border-b border-[var(--mt5-border)] py-3">
            <MT5Price value={price} digits={digits} className="text-[24px] font-semibold text-[var(--mt5-blue)]" />
          </div>
        ) : (
          <div className="flex items-end justify-around border-b border-[var(--mt5-border)] py-3">
            {/* Bid on the left under SELL, ask on the right under BUY: a sell is filled at the bid
                and a buy at the ask, so each side sits over the button that takes it. */}
            <MT5Price value={bidAsk.bid} digits={digits} className="text-[24px] font-semibold text-[var(--mt5-blue)]" />
            <MT5Price value={bidAsk.ask} digits={digits} className="text-[24px] font-semibold text-[var(--mt5-blue)]" />
          </div>
        )}

        {/*
          MetaTrader's tick chart, which on this screen is a PRICE band with the two sides tagged on
          it: the ask line above, the last between as a dashed rule, the bid below, and the tick
          trace running through them. That is what `android/en/open_market.png` draws, and it is why
          this is `MT5TickBand` rather than the classic shell's `CurveCanvas`: that canvas plots the
          curve's own unitless value, so a line at the bid could only be placed by inventing a
          mapping between the two scales.

          Only while the ticket is on the symbol this brand settles. The tick buffer carries that
          symbol alone, so on any other one this band would draw a second instrument's price under
          the first one's name.
        */}
        {tradeDisabled ? null : (
          <div className="relative min-h-28 flex-1 grow border-b border-[var(--mt5-border)]">
            <MT5TickBand
              getTicks={getTicks}
              priceOfRate={priceOfRate}
              digits={digits}
              bid={bidAsk?.bid ?? null}
              ask={bidAsk?.ask ?? null}
              last={price}
            />
          </div>
        )}

        {/*
          Expiry, and ONLY on a brand that still has one.

          MetaTrader has no expiry on a position, and docs/mt5/20-real-sl-tp.md settled that the row
          goes: "A position now ends at its stop, its target, a manual close, or the brand's
          horizon." The desktop ticket dropped it then and this one did not, so the phone, which
          13-phone-shell.md calls the primary shell, kept offering a control the engine ignores:
          `GameServer.openPosition` takes the BRAND's horizon whenever it has a price axis and
          discards whatever duration the client sent. A line brand has no axis, still commits its
          outcome at open and still runs to the duration asked for, so there the row is real.
        */}
        {continuous ? null : (
        <div className="flex items-center gap-2 px-3 py-2">
          <span className="shrink-0 text-[12px] text-[var(--mt5-muted)]">Expiry</span>
          <div className="flex flex-1 gap-1">
            {durations.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDurationS(d)}
                aria-pressed={durationS === d}
                className={cn(
                  'h-9 flex-1 rounded text-[12px] font-semibold transition',
                  durationS === d ? 'bg-[var(--mt5-blue)] text-white' : 'bg-[var(--mt5-raised)] text-[var(--mt5-muted)]',
                )}
              >
                {durationLabel(d)}
              </button>
            ))}
          </div>
        </div>
        )}

        {/*
          MetaTrader's Market Execution hint, verbatim as far as it is true here.

          The reference reads: "With Market Execution the price depends on the market situation. The
          order price will be quoted by a dealer." The first sentence is exactly this contract: the
          order goes at whatever the market is when it fills, and no price is promised. The second is
          not, because there is no dealer in the loop; this engine fills at its next tick. Copying it
          would be the same class of error as quoting a price the server never sent, so the mechanism
          is named instead of a counterparty that does not exist.
        */}
        <p className="px-3 pb-3 pt-2 text-[10px] leading-snug text-[var(--mt5-muted)]">
          With Market Execution the price depends on the market situation. The order fills at the
          engine&apos;s next tick, which may differ from the price shown.
        </p>

        {tradeDisabled ? (
          <p data-trade-disabled="" className="px-3 pb-3 text-center text-[11px] leading-snug text-[#f0b90b]">
            Trade disabled for {symbol}.{' '}
            <button type="button" onClick={() => { chartSettled(); onBack(); }} className="underline underline-offset-2">
              Chart {settledSymbol}
            </button>{' '}
            to place an order.
          </p>
        ) : null}
        {connecting ? <p className="px-3 pb-3 text-center text-[11px] text-[var(--mt5-muted)]">Connecting…</p> : null}
        {overBalance && signedIn ? (
          <p className="px-3 pb-3 text-center text-[11px] text-[#f0b90b]">Not enough free margin: tap a side to top up.</p>
        ) : null}
       </div>
      </div>

      {/* 9. The buttons, pinned to the bottom. Text only, two lines each, with a thin divider:
             Android draws no fill behind either of them. */}
      <div className="flex shrink-0 items-stretch border-t border-[var(--mt5-border)] pb-[env(safe-area-inset-bottom)]">
        <SideButton
          top="SELL"
          colour="#D00000"
          disabled={refused}
          onPick={() => send('sell')}
          title={tradeDisabled ? `Trade disabled for ${symbol}.` : undefined}
        />
        <span aria-hidden className="w-px shrink-0 bg-[var(--mt5-border)]" />
        <SideButton
          top="BUY"
          colour="#0064F2"
          disabled={refused}
          onPick={() => send('buy')}
          title={tradeDisabled ? `Trade disabled for ${symbol}.` : undefined}
        />
      </div>

      {/* MetaTrader's result, over the form it was sent from. */}
      {result === null ? null : <MT5OrderResult result={result} onDismiss={clear} />}
    </div>
  );
}

/**
 * One cell of the seven. Disabled rather than dropped where it would leave the brand's range, and
 * it carries WHICH bound stopped it: MetaTrader states a symbol's volume limits rather than
 * offering a cell that does nothing and says nothing.
 */
function StepCell({ step, onPick, bound }: { step: { label: string; delta: number; enabled: boolean }; onPick: () => void; bound: string }) {
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={!step.enabled}
      title={step.enabled ? undefined : bound}
      aria-label={`${step.delta < 0 ? 'Decrease' : 'Increase'} volume by ${Math.abs(step.delta)}`}
      className="min-w-0 flex-1 px-0.5 py-3 text-center font-mono text-[12px] font-semibold text-[var(--mt5-blue)] tabular-nums transition active:bg-[var(--mt5-raised)] disabled:text-[var(--mt5-muted)] disabled:opacity-40"
    >
      {step.label}
    </button>
  );
}

/**
 * One HALF of MetaTrader's `−  SL  +` / `−  TP  +` row.
 *
 * The reference screen puts both on one line, split down the middle, each sitting on its own
 * coloured rule: red under the stop, green under the target. That underline is the whole visual
 * identity of the pair, and it is how a trader tells them apart without reading the two letters.
 *
 * Unset, the cell shows the greyed LABEL and no number, which is what the reference draws: `SL` and
 * `TP` in placeholder grey between the two steppers. A value replaces it once one is set.
 */
function LevelHalf({ label, underline, value, onDown, onUp, disabled, title }: {
  label: string;
  underline: string;
  /** The level as a price, or null when there is none to show and the label stands in. */
  value: string | null;
  onDown: () => void;
  onUp: () => void;
  disabled: boolean;
  title?: string | undefined;
}) {
  const step = 'grid h-10 w-9 shrink-0 place-items-center text-[18px] font-semibold leading-none text-[var(--mt5-blue)] disabled:opacity-30';
  return (
    <div className="min-w-0 flex-1 px-2 pt-1.5" title={title}>
      <div className="flex items-center">
        <button type="button" onClick={onDown} disabled={disabled} aria-label={`Lower ${label}`} className={step}>−</button>
        <span className="min-w-0 flex-1 truncate text-center font-mono text-[13px] font-semibold tabular-nums">
          {value === null
            ? <span className="text-[#5b6b7d]">{label}</span>
            : <span className="text-white">{value}</span>}
        </span>
        <button type="button" onClick={onUp} disabled={disabled} aria-label={`Raise ${label}`} className={step}>+</button>
      </div>
      <span aria-hidden data-level-underline={label} className="mt-0.5 block h-0.5 w-full rounded" style={{ background: underline }} />
    </div>
  );
}

/** A label and a value with MetaTrader's dotted leader between them, as its Trade screen draws. */
function Leader({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1 px-3 py-2">
      <span className="shrink-0 text-[12px] text-[var(--mt5-muted)]">{label}</span>
      <span
        aria-hidden
        className="min-w-4 flex-1 self-center"
        style={{
          height: '1px',
          backgroundImage: 'radial-gradient(circle, #2b3543 1px, transparent 1px)',
          backgroundSize: '4px 1px',
          backgroundRepeat: 'repeat-x',
        }}
      />
      <span className="shrink-0 font-mono text-[12px] text-[var(--mt5-muted)]">{value}</span>
    </div>
  );
}

/**
 * One of MetaTrader's two trade buttons: `SELL` over `by market`, in colour, on no fill at all.
 *
 * The second line is the execution mode, and MetaTrader changes it with the symbol's: "Market
 * Execution → Buy by market / Sell by market", where Instant and Exchange execution read just
 * "Buy" / "Sell". Every contract here is market execution, so it is always this pair.
 */
function SideButton({ top, colour, disabled, onPick, title }: {
  top: string;
  colour: string;
  disabled: boolean;
  onPick: () => void;
  title?: string | undefined;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled}
      title={title}
      aria-label={`${top} by market`}
      className="flex flex-1 flex-col items-center justify-center gap-0.5 py-3 transition active:bg-[var(--mt5-raised)] disabled:opacity-40"
      style={{ color: colour }}
    >
      <span className="text-[17px] font-bold leading-none tracking-wide">{top}</span>
      {/* `by market` in lower case, as the reference screen sets it: the top line is the shout and
          the second line is a quiet qualifier under it. */}
      <span className="text-[10px] font-semibold leading-none opacity-90">by market</span>
    </button>
  );
}
