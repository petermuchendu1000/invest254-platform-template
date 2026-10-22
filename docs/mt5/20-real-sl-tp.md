# 20. Making Stop Loss and Take Profit real

Asked for: *"We need to get away with the 'expiry' and implement the real thing - we must make it
work! SL and TP must work for this system to be functional... where we still maintain the advantage
already presented in the engine."*

## Why the current engine cannot have a real stop

Three facts about what is there today, all of them load-bearing:

1. **The price curve is a martingale by design.** `curve.ts`: *"A seed-derived RANDOM WALK
   (martingale)... increments are independent, so no strategy based on past prices beats the base
   rate"*, measured *"trend-following 0.2502, mean-reverting 0.2504 - neither beats the base rate"*.
2. **The outcome is committed at OPEN.** `game.ts openPosition` calls `settleVariable(...)` before a
   single tick passes; win, multiplier and payout are all fixed then. "Expiry" is only when that
   decision is revealed.
3. **The edge lives in a step function.** A contract pays nothing until the favourable move reaches
   `tau`, then jumps straight to `1 + gain*tau` = **1.70x**. `tau` is the (1 - targetWinRate)
   quantile of the move, `gain` is solved for RTP. That discontinuity IS the 75% house edge.

The first fact is the one that bites. By the optional stopping theorem, if the price alone decides
when a position closes, the expected close price equals the open price: **expected P/L is exactly
zero, RTP 100%, house edge nil.** No amount of engineering gets around that; it is a theorem. An
edge has to be injected structurally - as a cost, or as a cap on what a payout can be.

## What was measured

`scratchpad/sltpsim.ts` generalises settlement to an arbitrary stopping time (win iff
`move(close) >= tau`) and measures the realised economics over 40,000 trades per rule, three seeds:

| stopping rule | RTP | profitable |
| --- | --: | --: |
| held to horizon (today) | 25.5% | 12.8% |
| TP at tau, SL at tau | **32.9%** | 18.9% |
| TP at tau, SL at 2*tau | **33.3%** | 19.2% |
| TP only at tau | **32.8%** | 18.8% |
| tight: TP/SL at tau/4 | **0.00%** | **0.00%** |
| very tight: TP/SL at tau/20 | **0.00%** | **0.00%** |

Both failure modes are fatal, and they are the same defect seen from two sides:

* **A tight take profit wipes the trader out.** A target below `tau` closes the contract on the zero
  side of the step, so a trader who is right but modest is paid **nothing**. That is not a working
  take profit, it is a trap.
* **A target at or above `tau` leaks a third of the edge**, 25% RTP becoming 33%.

A step payout and a continuous target cannot both be sane. That is the finding.

## The fix: a continuous payout through a cost

Replace the step with a line through a cost `c`:

```
payout = clamp(1 + gain * (move_at_close - c), 0, maxMultiplier) * stake
```

* **Continuous.** A small favourable move makes a small profit; an adverse move a partial loss. A
  stop and a target can be put anywhere and behave the way a trader expects.
* **The floor at zero keeps the stake as the maximum loss**, exactly as today, so there is still no
  margin call and no negative balance.
* **`c` is economically the SPREAD** - the move a trader must make to break even - and it carries the
  whole house edge. This is the same thing a real broker does, and it is what MetaTrader models.

`scratchpad/sltpsim2.ts` solves `c` for the target RTP and then measures whether that RTP survives
arbitrary stopping. It does, across every sane rule and all three seeds:

| stopping rule | RTP (target 25%) |
| --- | --: |
| held to horizon | 25.1% |
| TP/SL at c | 24.5% |
| TP 2c / SL c | 24.8% |
| TP c / SL 2c | 24.5% |
| TP only at 2c | 24.6% |
| SL only at c | 24.8% |
| wide TP/SL at 5c | 24.6% |
| tight TP/SL at c/4 | 14.6% |
| very tight TP/SL at c/20 | 4.5% |

**No stopping rule beats the house** (worst case 25.45% against a 25% target, versus 33% under the
step). Over-trading with very tight stops costs the trader more, not less, which is how a real
spread behaves and is the correct direction for the leak to run.

## The one trade-off, quantified

With the continuous payout, the two config knobs can no longer both be honoured
(`scratchpad/sltpsim3.ts`). `c` pins the profitable-trade rate, because `P(payout > 1) = P(move > c)`;
`gain` then sets how far payouts spread around it. With `c` pinned to `targetWinRate` = 12.5%, the
**minimum reachable RTP is 30.3%** (at gain 882) - 25% is not reachable at `maxMultiplier` 5:

| gain | RTP |
| --: | --: |
| 100 | 79.8% |
| 342 | 42.5% |
| **882** | **30.3%** (minimum) |
| 2000 | 36.3% |
| 5000 | 48.3% |

So one of three must give:

* **RTP 25% wins** (what is implemented): `c` solves the house edge, and the profitable-trade rate
  lands near 5%. The money knob is exact; the win-rate knob becomes an output.
* **Win rate 12.5% wins**: house edge falls from 75% to ~70%.
* **Lower `maxMultiplier`**: capping winners harder lets both hold, at the cost of the 5x headline.

RTP is the operator's revenue and `targetWinRate` is a feel knob, so RTP binds and the achieved
win rate is surfaced rather than silently missed.

## What shipped

**The engine holds the levels.** A position carries `slPrice`/`tpPrice` as chart prices, armed with
the order or moved later through `set_levels` (MetaTrader's Modify position). Every tick converts
the current rate to a price and compares; a buy stops at or below its stop and takes profit at or
above its target, a sell mirrors it. The **stop is checked first**, because a tick spanning both
levels cannot be known to have touched the better one first and the trader does not get the benefit
of that doubt.

**The browser stopped watching.** `useTakeProfitLevelWatch` fired a sell from a React effect when
the price reached the level. That only worked while the tab was open, receiving ticks and connected:
a trader who set a target and shut the laptop had no target. It is deleted rather than kept as a
weaker second copy of the same rule.

**Expiry is gone from the ticket.** It was never a MetaTrader control. A position now ends at its
stop, its target, a manual close, or the brand's horizon, and choosing a term alongside a stop would
be two contradictory ways to end one trade. The horizon is the BRAND's: a brand with a price axis
ignores whatever duration the client sends.

### The horizon: why there is one, and why it is fifteen minutes

Asked directly: *"Do we really need defaultDurationS here? what was the point of SL and TP?"*

Fair, and the first answer shipped was a hedge. The default was left at ten seconds and called the
operator's call. At ten seconds a stop has no room to be reached, so the levels were decoration.

**Is a horizon needed at all?** MetaTrader has none: a position lives until it is closed or margin
stops it out. This engine cannot quite do that, for two reasons that are about correctness rather
than taste:

* **The settlement curve is per day.** A position is valued from `entryT`, an offset into the day it
  opened in, and the price axis re-anchors at every UTC midnight. A position cannot meaningfully
  outlive its own day, and the code already treats one re-armed across a boundary as a special case.
* **There is no margin call to end an abandoned position.** The payout floors at zero, so a position
  can never go so far against a trader that it must be closed. Without a horizon an abandoned one
  would sit in the engine's in-memory book for ever.

So a horizon is real. What it must not be is short.

**And it is not a free knob.** The break-even cost is calibrated AT the horizon and scales as its
square root. A brand holding positions for an hour while pricing them for ten seconds would charge a
ten-second spread against hour-sized moves and hand the trader the house edge. The horizon a position
is VALUED over and the horizon it is HELD to have to be the same number.

**The economics do not constrain the choice.** The calibration re-solves for whatever horizon it is
given, and the realized RTP lands on target at every one of them (one seed, 200k entries drawn over
the whole calibration window, both directions):

| horizon | measured RTP (target 25%) | measured win-rate (target 0.125) | break-even cost |
| --: | --: | --: | --: |
| 10s | 24.93% | 0.1247 | 0.00291 |
| 60s | 25.05% | 0.1252 | 0.00726 |
| 300s | 24.82% | 0.1241 | 0.01702 |
| 900s | 24.83% | 0.1240 | 0.03119 |
| 1800s | 24.99% | 0.1250 | 0.04538 |
| 3600s | 25.12% | 0.1257 | 0.06981 |

**The CURVE constrains it, at exactly 900s.** The `market` walk is a `Float64Array` of
`86_400 + 900 + 2` one-second samples, and `CurveGenerator.walkAt` CLAMPS its index to the end of
that array. A position entered at `t` is valued at `t + horizon`, so a horizon above the 900s of
headroom means late-day entries are valued against a FROZEN price: the exit index saturates, the
move stops growing, and nothing can reach the win threshold. It is not a rounding concern, it is
total:

| horizon | entries valued against a frozen price | win-rate, last hour of the day | RTP, last hour |
| --: | --: | --: | --: |
| 900s | none | 0.1539 | 29.45% |
| 1800s | the last 900s | 0.1000 | 18.50% |
| 3600s | the last 2700s | **0.0000** | **0.00%** |

A trader who opened a position in the last hour of a UTC day under a 3600s horizon could not win,
whatever the price did. The whole-day average hides it completely (24.91% at 3600s) because the
calibration sees the same frozen tail and compensates by selling the rest of the day cheaper, which
is why this is caught by bucketing the day rather than by the aggregate RTP gate.

900s is therefore not a compromise, it is the largest horizon at which NO entry in the day is valued
against a clamped price. `CONFIG_BOUNDS.defaultDurationS.max` is pinned there so an operator cannot
configure the frozen tail back in. Raising it means extending `WALK_POINTS` by the same amount, which
changes every historical day's path and is therefore a migration, not a setting.

An operator who wants shorter contracts lowers it per brand, and in doing so shortens the leash on
every stop, which is the trade-off stated rather than hidden.

### The longer horizon broke the anti-exploit gates, and the gates were wrong

Lengthening the horizon from ten seconds to fifteen minutes turned three green tests red:

```
EXPLOIT: the PRICE LEVEL carries no edge    low band beats its control by 0.0753 (t=1.77)
EXPLOIT: the TIME OF DAY carries no edge    seed xau-day-1 bucket 5: win-rate 0.1758 vs target 0.125
calibration generalises to entryT           4h bucket 2 wr 0.702 drifts from target
```

Three gates on the house edge going red is the one result you do not widen a tolerance to make go
away. They were investigated to a conclusion instead, and the conclusion is that the curve is clean
and both gates were measuring the wrong thing.

**The curve cannot leak either of them, and that is a proof rather than a measurement.**
`CurveGenerator.value` on the `market` profile is `bias + scale * walkAt(t)`, with `squash` the
identity because the walk never reaches its knee. `walkAt` is a fixed linear combination of four
neighbouring samples of a walk with iid increments. The settled move is
`±(value(t + horizon) - value(t))`, an affine image of a sum of iid increments, so its distribution
does not depend on `t` and does not depend on `value(t)`. Any measured dependence is therefore either
sampling noise or a selection rule reading something the price does not contain. Both turned out to
be present, one of each.

**Time of day: noise, because a day is only 96 samples long.** A contract held 900s means two entries
less than 900s apart look through overlapping windows and count as nearly one observation, so a day
holds about `86_400 / 900 = 96` independent samples and a 4h bucket about 16, however many entries
are drawn. Measured over 150 seeds the per-seed bucket win-rate has a standard deviation of 0.033 to
0.038, so **15% of honest buckets fall outside the old ±0.05 gate** and a run of 18 of them failed
about 88% of the time. At ten seconds a bucket held 1,440 independent windows and the same gate was
sound. Across 48 seeds every bucket's mean sits on target to within 0.0065.

**Price level: the rule was reading the future.** It normalised the price against the day's FULL
realized `[lo, hi]`, extremes that include times after the entry. Conditioning on them biases the
forward move mechanically: at the day's realized maximum the forward move cannot be upward at all, so
the middle of the range is exactly where the unconstrained moves live. That is not a rule any player
can run, and it measured a spurious +0.0586 (t = 2.81) on a process that provably has no level
dependence. Against the RUNNING range, which is all a trader or MetaTrader ever sees, the three
terciles come in at +0.0033, +0.0006 and -0.0039, every one inside t = 0.7.

**Both gates now carry a positive control, asserted in the same test.** A tolerance that no longer
catches a leak is not a weaker test, it is not a test:

| gate | honest `market` curve | the leak it must still catch |
| --- | --: | --- |
| time of day, across 48 seeds | worst bucket deviation **0.0065** | a day-scale volatility ramp: **0.1160**, t = 68.7 |
| price level, running-range terciles | worst deviation **0.0039** | the `wave` (tanh) profile: **0.1420**, t = 20.1 |

The gates sit at 0.02, which leaves the honest curve three times the room it needs and fails every
control by three to seven times over.

### A restart used to disarm the stop (closed by migration 0183)

A **re-armed** position used to come back with `continuous: false` and no levels. That was recorded
here as a known gap, and it was worse than the word "gap" suggests, because the engine restarts on
every merge to main: it happened to real trades routinely, and it did three things at once.

* The trader's stop and target **silently vanished**. Nothing told them.
* The position **changed how it was priced**, from the continuous payout it was opened under to the
  committed step contract. The same trade settled one way before the restart and another way after.
* A losing position that could be **closed by hand** a second earlier could not be closed at all,
  because `sellable` was re-derived as `outcome.result === "win"` instead of the
  `continuous || won` rule `openPosition` uses.

Migration 0183 adds `positions.sl_price` and `positions.tp_price`, on exactly the terms migration
0180 set for the execution prices: their own UPDATE after the atomic money RPC, never inside it, so
`fn_open_position` keeps the ten-argument signature every caller uses and a failed stamp can never
fail or alter a trade. The write is fire-and-forget for the same reason the price stamp is, and it
is a plain assignment rather than a `coalesce`, because moving a level and clearing one are what
Modify position IS.

Recovery then re-arms from `GameServer.hasPriceAxis`, the same test `openPosition` makes, rather
than from a guess: a brand that charts a line still has nothing to put a level on and still keeps
the committed contract.

Verified against a real PostgreSQL 16 rather than by typecheck: the migration is idempotent, the
unchanged ten-argument `fn_open_position` still opens, a separate UPDATE stamps the levels, the
recovery query reads them back, clearing one gives NULL rather than 0, and the unchanged
`fn_settle_position` pays out the same 42,500 it always did.

### Proof

* `apps/engine/src/game.levels.test.ts` — 7 tests. Opens a position, steps the clock, and proves the
  stop closes it before its horizon with nothing watching; that a level set through Modify fires the
  same way; that a loser can now be closed by hand; and that a brand with no axis keeps the
  committed contract untouched. The stop level is chosen from the curve's own path, so the test
  cannot pass by firing instantly on the wrong side of entry.
* `packages/shared/src/settle.continuous.test.ts` — 4 tests pinning the economics under eight
  stopping rules.
* `scratchpad/sltp.mjs` — 9/9 in a real browser against the real engine. Reads the websocket frames:
  the order carries the levels as prices, the engine acknowledges what it took, and after a RELOAD
  the engine hands the stop back because it never lost it.
* `apps/engine/src/recovery.test.ts` — crashes a brand that has a price axis and proves the
  recovered position is continuous again, still carries the stop, is still closeable by hand, and
  that the stop then FIRES on a tick with `closedBy: "sl"`.
