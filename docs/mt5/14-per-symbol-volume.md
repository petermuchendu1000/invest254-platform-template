# Volume is per symbol, not one setting for the whole book

## What MetaTrader does

Every symbol carries its own volume spec, and the Specification dialog prints three rows for it:

```
Minimal volume   0.01
Maximal volume   100.00
Volume step      0.01
```

The ticket obeys *that symbol's* three numbers: its stepper moves by the symbol's step, its slider
spans the symbol's range, and a typed volume snaps to the symbol's grid. Selecting another symbol
changes all of it.

## What this was

One brand-wide range with a hard-coded step, in four places:

| | before |
|---|---|
| `useOrderEntry` min/max | `limits.minCents / LOT_STAKE_CENTS` … `limits.maxCents / LOT_STAKE_CENTS` |
| step, phone ticket | `volumeSteps(lots, { …, step: 0.01 })` |
| step, phone dialog slider | `step={0.01}` |
| step, desktop ticket | `const VOLUME_STEPS = [0.01, 0.1]` |
| Specification dialog | `volumeStep: 0.01`, `volumeDigits: 3` |

So gold, a stock index and a coin all claimed the same volumes, and the dialog's three rows were the
same three numbers on every instrument in the book. That is not a book; it is one setting shown
ninety times.

## The rule

`conventionalVolume(group)` in `packages/shared/src/symbols.ts`, stated and asserted the same way
`conventionalDigits` is, because brokers differ on volume limits more than on anything else in a
specification and ninety hand-picked rows are ninety chances to be quietly wrong.

| group | min | step | max |
|---|---|---|---|
| Forex\Majors | 0.01 | 0.01 | 100 |
| Forex\Minors | 0.01 | 0.01 | 50 |
| Forex\Exotics | 0.01 | 0.01 | 20 |
| Metals | 0.01 | 0.01 | 50 |
| Energies | 0.01 | 0.01 | 50 |
| Indices | **0.1** | **0.1** | 50 |
| Crypto | 0.01 | 0.01 | **10** |

Two things shape it, and both are reasons rather than taste:

- **Liquidity sets the ceiling.** A major absorbs size an exotic does not, and one crypto lot
  carries the largest notional in the book, so its ceiling is the lowest.
- **Contract size sets the step.** An index contract is large enough that a hundredth of a lot is
  granularity nobody trades in, which is why brokers quote index volume in tenths. Everything else
  steps in hundredths, the figure MetaTrader's own screenshots show.

## What it cannot do

It cannot loosen the money path. A volume is only a way of saying a stake
(`stakeCents = lots * LOT_STAKE_CENTS`) and the engine validates the CENTS against the brand's own
minimum and maximum whatever a symbol's spec says. `effectiveVolume` is the intersection:

- the **minimum** is the larger of the symbol's and the brand's, because a ticket showing a volume
  the engine refuses is worse than a ticket showing a bigger number;
- the **maximum** is the smaller, for the same reason;
- the **step** is always the symbol's, because granularity is not a limit: an index steps in tenths
  on a brand with a small minimum too.

A brand whose minimum lands above a symbol's ceiling leaves one tradable volume rather than an
inverted range the stepper could not clamp into.

## Decimals, and the off-grid minimum

The step decides the decimals: tenths on an index, hundredths elsewhere. One more place where the
brand's minimum is not a whole number of steps, which is the live brand's case: a KES 250 minimum is
0.025 lots on a hundredth step, so the ticket prints three places. Printing two would show a rounded
volume that does not match the stake actually sent.

That off-grid minimum is also why volume is now snapped to the grid **measured from the minimum**
rather than from zero: the grid is 0.025, 0.035, 0.045, and a stepper that walked off it stayed off
it.

## Verified

| | |
|---|---|
| `packages/shared/src/volumespec.test.ts` | 10 tests: every row has its group's spec, every spec is steppable, the specs are not all one, an index steps in tenths, liquidity orders the ceilings, the brand's limits win, no inverted range |
| `scratchpad/volspec.mjs` (1440x900) | 7/7 — the dialog prints MetaTrader's three rows, gold steps in hundredths with the brand's minimum still binding above gold's own, an index steps in tenths, and its three rows are not gold's |
