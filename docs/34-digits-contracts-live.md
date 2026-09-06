# 34 — Deriv-style DIGIT contracts, live (Issue 1)

> Status: implemented on branch `feat/issue1-digits-live` — server-authoritative, crash-safe, and
> **pool-governed** (docs/25 applied to digits). Multipliers are the next increment and remain
> preview. Supersedes the "demo-first / unwired" state of the Phase-2 contracts described elsewhere.

## Governance: the pool fund is the central control point (docs/25 applied to digits)
Digit contracts follow **exactly** the rise/fall governance split:

- **POOL PATH — brand `pool_mode` ON + non-marketer (the production default for clients):** the
  outcome is decided at open by the SAME `PoolController` brain as rise/fall — decide →
  atomically **reserve** → **commit** at settle (release on refusal) — via the fixed-odds adaptation
  `decidePoolOutcomeFixed` / `decideReserveFixed`:
  - A win pays **exactly** the contract return (`stake × factor / winProb`) or the trade **loses** —
    budget clamps can never produce a shrunk win (strictly safer than the variable-amount path).
  - Same gates, same order: propensity (base win-prob = `targetRtp / m` where `m` is the contract's
    fixed multiplier — the edge invariant `E[RTP per trade] ≤ targetRtp = 1 − house_edge`), the pool
    **cash fuse** (`available`), the per-player **no-scoop share**, the **hard RTP-budget ceiling**
    (`paid + reserved ≤ ⌊targetRtp × turnover⌋`), and the min-withdrawal near-miss lever (a fixed
    payout that would cross the line becomes a near-miss loss unless let through).
  - Digits and rise/fall share **ONE budget per brand**: the same `withdrawal_pool` (site, EAT-day)
    row, the same turnover accumulator, the same `position_decision` audit and `pool_ledger`. Every
    central lever therefore governs digits automatically: per-client daily pools, recurring
    `default_daily_pool_cents`, the **dynamic demand-based distribution** across all clients
    (docs/25 §15, incl. the scheduled autonomous run), `pool_mode` toggles (live via LISTEN), and the
    global economy dials (`house_edge` → targetRtp).
  - The **displayed digit is decision-consistent**: drawn (seeded, uniform within the set) from the
    digits that reproduce the decided outcome; the owner's streamed tick at `settleIndex` carries it
    (per-owner override), so their chart always matches their result. As with rise/fall pool mode,
    the feed is presentation; the decision is the arbiter — do NOT advertise "provably fair" for
    pool-mode brands (docs/25 §1.1).
- **STATISTICAL PATH — pool OFF, or marketers/demo:** the provably-fair uniform digit
  `HMAC(daySeed, "dg:<instrument>:<index>") mod 10`; RTP = the digit payout factor. Marketers stake
  demo funds and never touch the real-cash pool (decision F), exactly as in rise/fall.

### ⚠ Operational sizing rules (surfaced by tests — read before enabling for a client)
1. **No-scoop share vs fixed payout:** a single player's daily winnings are capped at
   `playerShare (15%) × pool`. If the pool is smaller than `largest digit payout / 0.15`
   (≈ 7× the payout; e.g. ≈ KES 3,167 pool for a KES 475 even/odd win on a KES 250 stake),
   **players can never win a digit trade** on that brand. Size each client's daily pool accordingly.
2. **Pool vs target RTP:** realized RTP = `min(1 − house_edge, pool / turnover)` — an undersized pool
   pays below target; that is the safety working as designed (docs/25 §14.5).

## What the "bot" is (researched)
Deriv's binary "bot" (DBot) is a **client-side auto-trader**: it repeatedly places digit contracts
(Even/Odd, Over/Under, Matches/Differs) on a chosen Volatility Index using a money-management
strategy — stake, a Martingale-style multiplier on loss, a target profit and a stop loss — and runs
in the browser. It is **not** the pricing/settlement backend. So the "bot" is **(a) the auto-trader
UI**, but it must place **real** contracts against **(b) the server-authoritative contract engine**,
which decides win/loss, moves money atomically, and is provably fair. We implemented both: the AUTO
panel is the bot; the engine is the authoritative broker it trades against.

## Architecture (how digits work now)
1. **Per-instrument authoritative feed** — `packages/shared/instrumentfeed.ts`.
   The daily-seed model is extended to each instrument. Everything a tick carries is a pure function
   of `(daySeed, instrumentId, tickIndex)`:
   - **Settlement digit** = `HMAC-SHA256(daySeed, "dg:<instrument>:<index>") mod 10` → **exactly
     uniform** over 0–9. Even/Odd = 0.5, each digit = 0.1, Over/Under exact — so the house edge equals
     the payout factor with zero distributional drift.
   - **Quote** = a smooth band-limited walk (scaled by the instrument's volatility) whose **last pip is
     set to that fair digit**, so the digit shown on the chart is the digit that settles.
   - Provably fair: once the day's seed is revealed (existing commit-then-reveal, migration 0011),
     anyone recomputes every quote and digit. Clients render **streamed** ticks (the seed stays
     server-side until reveal), exactly like the classic curve.
2. **Engine** — `apps/engine/src/game.ts`.
   `openDigitContract` records `openIndex`, `settleIndex = openIndex + ticks` (Deriv "ticks", default
   1) and persists `{kind,target,instrumentId,openIndex,settleIndex}` in `positions.contract`
   (atomic stake debit via `fn_open_contract`). `settleDueDigits(instrument, index)` settles every
   contract whose `settleIndex` has arrived; payout uses the **digit factor** (below) via
   `fn_settle_position`. Digits are pool-/override-exempt.
3. **Payout factor** — `packages/shared/config.ts` `digitPayoutFactor` (default **0.95 → 5% edge**),
   **independent of the rise/fall `houseEdge`**. (Fixes BUGLOG #18: `1 − houseEdge` = 0.25 would have
   paid 0.5× on an even/odd win.) Set 0.976 to mirror Deriv's on-screen "95.2% payout".
4. **Transport** — `apps/engine/src/multiengine.ts`.
   `subscribe_instrument` → `inst_history` (backfill) + live `inst_tick`; `open_digit` →
   `digit_opened` + `balance`; a per-`(site,instrument)` streamer ticks at the instrument cadence,
   fans ticks to watchers, and settles due contracts → `digit_settled` + `balance`. It auto-stops when
   idle (no watchers and no open contracts). Unknown instrument ids are rejected.
5. **Crash recovery** — `apps/engine/src/recovery.ts`.
   Open `kind='digit'` positions re-settle deterministically from the committed
   `{instrument, settleIndex}`, idempotently — a restart can never strand a debited stake.
6. **Web** — `GameSocketProvider` (one socket, extended) + `DigitsTradeScreen`.
   The screen streams the authoritative feed into the Deriv-style chart/heatmap and places **real**
   contracts (MANUAL and the AUTO Martingale bot). Settlement, session P/L, and balances come from
   `digit_settled` / `balance`. The old client-side simulation is gone; the UI layout is unchanged.

## Fairness & money guarantees (tested)
- Uniform digits (Monte-Carlo): each digit ≈ 10%, even/odd ≈ 50%; RTP ≈ payout factor.
- Chart digit == settled digit (WS end-to-end).
- Stake debited on open; win credits `round(stake × factor / winProb)`, loss pays 0; idempotent.
- Deterministic crash recovery (no double credit).
- Full suite **787/787**, `tsc -b` + web `tsc` clean.

## Follow-ups (not in this branch)
- Optional migration to make `digitPayoutFactor` a per-brand `site_game_config` column and advertise
  it to the client (today the client renders the shared default; the engine is authoritative).
- Configurable contract length (ticks 1–10) surfaced in the UI.

---

# Addendum — MULTIPLIERS, live (same governance)

> Status: implemented on branch `feat/issue1-multipliers-live`. Multipliers now ride the
> per-instrument feed and are governed by the SAME pool brain and central budget as digits/rise-fall.

**Statistical path (pool OFF, or marketers/demo):** honest, path-dependent P/L on the authoritative
instrument quote — `±(move%) × multiplier × stake`, floored at −stake (stop-out). Optional TP/SL,
optional Deal Cancellation (stake refunded on a stop-out inside its window; SL disabled while DC is
active, per Deriv), manual close any time. The per-(site,instrument) streamer evaluates every open
multiplier on every tick (`tickMultipliers`) and pushes `mult_update` / `mult_closed`.

**Pool path (brand `pool_mode` ON + non-marketer):** a **timed bracket contract** decided at open.
Take Profit is the contract's fixed upside (default +100% of stake); the pool decides via
`decideReserveFixed` (candidate payout = stake + TP; base win-prob = targetRtp/m) and atomically
reserves it. Live P/L renders the seeded reversing path (`poolLiveMultiplier`) over a seeded 20–60s
window (`poolMultiplierDurationMs`), then auto-settles: WIN closes at exactly +TP (commit), LOSS
stops out at −stake. **SL, Deal Cancellation and manual close are unavailable in pool mode**
(docs/25 decision B — a player must never cash the green feint of a decided loss). Digits,
multipliers and rise/fall reserve from **ONE `withdrawal_pool` row per brand**, share turnover and
the RTP ceiling, and every central lever (per-client pools, dynamic all-client distribution,
`pool_mode`, `house_edge`) governs all three with zero extra configuration.

**Crash recovery:** pool-decided multipliers recover from the persisted decision — settle at the
(seeded, recomputable) endpoint if the window elapsed during the outage (+commit a win), else re-arm
the decided path; statistical multipliers re-arm from `positions.contract` and re-evaluate on the
next tick. The transport re-arms instrument streamers at boot for every recovered open contract, so
recovered positions keep evaluating even before any client connects.

**Transport:** `open_multiplier` / `close_multiplier` (C→S); `mult_opened` / `mult_update` /
`mult_closed` + `balance` (S→C). Web `MultipliersPanel` now trades real contracts (server-acked
open, authoritative live P/L and closes); the preview simulation is gone.
