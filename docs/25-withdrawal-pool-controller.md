# 25 — Withdrawal-Pool Controller (the "managed-book" brain)

> **Status: PARTIALLY IMPLEMENTED (Phases 1–3b live).** The pool ledger, per-brand `pool_mode` flag,
> superadmin pool RPCs, and the engine `PoolController` (decide → reserve → commit, EAT-day pacing) are
> in code (migrations 0062–0066; `apps/engine/src/poolcontroller.ts`; `packages/shared` pool brain).
> `pool_mode=true` on invest254 + tamutraders. **Caveat:** historically the controller governed <1% of
> trades (see docs/26 §2) — most settled statistically. Under pool mode the **RTP monitor reflects the
> virtual curve, not real cash** (docs/26 §3). The Decision Points in §12 remain the source of truth for
> unshipped behaviour (full pacing, SELL rule, marketer routing, legal sign-off).

---

## 1. The paradigm shift (read this first)

The **current** brain (docs/02) is a *provably-fair, statistical-edge* game:
- ONE shared seeded curve decides every outcome; the result is **committed at open** from a published
  daily seed; anyone can recompute it. House edge is enforced statistically by per-direction RTP
  calibration. Winners may cash out early; losers ride to expiry.

The **proposed** brain is a *managed book with a hard daily payout budget*:
- A superadmin sets a **daily withdrawal pool** (the max KES the house will pay out in wins that day).
- A **controller** decides each trade's outcome (win/loss/amount) subject to the remaining pool and a
  pacing target, using randomness so no player is favored. Each trade renders a **controlled P&L path**
  that can swing green→red (a decided loss) or red→green (a decided win).
- Total daily winnings are **hard-capped at the pool**, protecting disbursement/cash-flow.

**These two models are mutually exclusive on the core outcome path.** You cannot keep "outcome
committed from a public seed" AND "outcome decided later by pool state." The pool brain **replaces**
the settlement decision; the shared curve becomes *cosmetic chrome* (a backdrop), not the arbiter.

### 1.1 What the pool brain BREAKS (must be acknowledged, not discovered later)
| Current guarantee | Under the pool brain |
|---|---|
| **Provable fairness** (commit/reveal seed; player can verify) | **GONE as a public claim.** Outcomes depend on private pool state + a controller. We can keep *internal auditability* (every decision logged + seeded), but must **remove public "provably fair" wording** (docs/02 §4, 03, 14). Advertising provable fairness while running a controller is misleading. |
| **One shared curve drives everyone** (docs/00–02) | Curve becomes display-only; each trade gets its own controlled path to a decided endpoint. |
| **RTP = 1 − house_edge**, calibrated (`settle.ts`) | RTP becomes **emergent**: realized RTP = min(demand, pool)/turnover. `target_win_rate`/`house_edge` become *soft inputs* (base propensity / amount shape), not the governor. |
| **Manual SELL** locks ≤ committed; losers can't sell (docs/02 §3) | SELL must be **constrained or disabled** (§7) — you cannot let a player cash the green peak of a trade the controller decided will lose. |
| **Deterministic crash recovery** from seed (docs/02 §6) | Recovery now needs **persisted controller decisions + pool ledger** (§10), not just a seed. |
| **Regulatory posture** (docs/14, Kenya/BCLB) | A centrally-controlled, non-random, budget-managed outcome that can flip mid-trade is a materially different (and riskier) regulatory product. **Legal review required** before launch. This doc is technical, not legal advice. |

---

## 2. The five requirements, restated precisely
1. **Daily pool** — `withdrawal_pool(site_id, trade_day)`: a KES amount the superadmin sets per day
   (day boundary per §12-D). It is the day's **maximum total winnings** (payouts − stakes-returned).
2. **Wins never exceed the pool** — Σ(daily payouts to pool-eligible players) ≤ pool amount, enforced
   atomically at settlement (hard cap).
3. **Distribute by pool balance** — the controller grants wins based on remaining pool + pacing (§6).
4. **Marketers exempt** — marketer accounts do not draw from the pool (they don't withdraw real
   money); their outcomes use a separate path (§8).
5. **Balance the math through the day + controlled per-trade path** — outcomes are random per trade,
   spread across the day, and the live P&L can reverse (green→red / red→green) to the decided endpoint;
   equal fairness with high uncertainty (§5, §7). Winners can still withdraw (§9).

---

## 3. Data model (additive; money in integer cents)
```sql
-- Per-brand, per-day payout budget (superadmin-set). One row per (site, day).
withdrawal_pool(
  site_id uuid, trade_day date,                 -- day boundary: see Decision §12-D
  amount_cents bigint not null check (amount_cents >= 0),   -- the day's max winnings
  paid_cents bigint not null default 0,          -- winnings actually credited today (settled)
  reserved_cents bigint not null default 0,      -- winnings reserved for in-flight decided-wins
  set_by uuid, updated_at timestamptz,
  primary key (site_id, trade_day)
)
-- Immutable audit of every pool movement (reserve / commit / release), for reconciliation + recovery.
pool_ledger(id bigserial, site_id uuid, trade_day date, position_id uuid,
            kind text check (kind in ('reserve','commit','release')),
            amount_cents bigint, created_at timestamptz)
-- Controller decision per position (reproducible/auditable; replaces the seed as the source of truth).
position_decision(position_id uuid primary key, site_id uuid,
                  decided_result text, decided_multiplier numeric, decided_payout_cents bigint,
                  pool_day date, decision_seed text, pacing_snapshot jsonb, created_at timestamptz)
```
`available = amount_cents − paid_cents − reserved_cents`. A win is only granted if it fits `available`.

---

## 4. Where the controller lives
`apps/engine`: a new `PoolController` consulted by `GameServer` at the moment the outcome is fixed
(open or expiry — see §7). It reads the brand's `withdrawal_pool` row (cached + `LISTEN`-refreshed like
`SiteGameConfigStore`) and atomically reserves/commits via SECURITY DEFINER RPCs, mirroring the existing
money-RPC discipline (`FOR UPDATE`, idempotent by `position_id`).

---

## 5. The controller decision (per trade)
```
available = pool.amount − pool.paid − pool.reserved         # hard budget left today
headroom  = pace_target(now) − pool.paid                    # how much we MAY pay to stay on pace (§6)
propensity = seeded_random() < base_win_rate                # uncertainty; equal for all players
amount    = draw_win_amount(stake, cap)                     # engagement spread, mean ~ soft target
GRANT WIN  iff  propensity AND amount ≤ available AND amount ≤ headroom
otherwise LOSS
```
- **Equal fairness:** `base_win_rate` and the amount distribution are identical for every pool-eligible
  player at a given instant; only the *budget gates* bind. No per-player bias (overrides interaction: §12-E).
- **Atomicity:** on GRANT, `reserve` the amount immediately (so concurrent trades racing the last of the
  pool can't both win); on settle, `commit` (reserve→paid); on void/expiry-without-pay, `release`.
- **Determinism/audit:** `decision_seed` = HMAC(masterSeed, position_id) → the propensity draw, amount, and
  path are reproducible for audit and crash recovery.

---

## 6. Pacing (spreading winnings across the day)
Goal: don't exhaust the pool by 10:00 (starving evening) nor leave it largely unpaid at midnight.
`pace_target(now)` = `pool.amount × F(now)` where **F is the target cumulative-payout fraction by time**.
Two candidate definitions (Decision §12-C):
- **Volume-paced** `F = fraction of the day's expected STAKE volume elapsed` (from historical hourly
  weights). Fairest *per trade* (every trade equally treated); payout concentrates when activity is high
  (evening). *Simulated: pool respected, evening-weighted.*
- **Clock-paced** `F = fraction of wall-clock time elapsed` (even KES/hour). Favors low-traffic hours'
  players (thin morning traffic shares an equal budget slice). More "even across the day".
Feedback: if `paid < target` we're behind → allow wins; if `paid ≥ target` → suppress (force loss) even
when budget remains. A hard floor keeps *some* liquidity for the tail of the day (reserve K% for the last
N hours). Unknown future volume is handled by re-estimating F each hour from the running arrival rate.

---

## 7. The per-trade P&L path + SELL
- The controller decides the **endpoint** (win x, or loss). A **seeded path generator** renders the live
  multiplier from x1.0 to that endpoint with a deliberate **overshoot in the opposite direction**: a
  decided LOSS shows green first then collapses; a decided WIN dips red then rallies. C¹-smooth, seeded by
  `decision_seed` → reproducible. (Demonstrated in the sim: loss `1.0→1.32→0.0`, win `1.0→0.88→2.4`.)
- **SELL is the hard problem.** If a player can cash the green peak of a decided-loss trade, the pool
  math breaks. Options (Decision §12-B):
  1. **Disable SELL** in pool mode (auto-settle at expiry only). Simplest, safe, matches the "runs to the
     end" description. Recommended for Phase 1.
  2. **SELL only when the decided outcome is a win**, and only up to the *current shown* value (≤ final).
     The red/green feint still shows, but the green shown during a decided-loss trade is **non-sellable**.
     Richer UX, more engine bookkeeping.
- Whichever is chosen, the **settlement uses the controller's decided outcome**, never the path peak.

---

## 8. Marketer exemption
Marketer accounts (`profiles.role='marketer'`) are **pool-exempt**: their trades are decided by a
separate path that does **not** reserve/commit against `withdrawal_pool`. Decision §12-F: do marketers
(a) use the old statistical settlement, (b) always win a scripted amount, or (c) win but flagged as
non-withdrawable "promo" balance? Their activity may still feed the social feed. Their winnings must be
excluded from real disbursement accounting.

---

## 9. Winners & withdrawals
Unchanged mechanically: a pool-committed win credits `real_balance` via the existing atomic settle RPC,
and the player withdraws via M-Pesa B2C (docs/08). The pool guarantees Σ daily credited winnings ≤ pool,
so the day's withdrawable liability is bounded by design.

---

## 10. Concurrency, atomicity, crash recovery
- **Race on the last of the pool:** N simultaneous decided-wins each `reserve` under `FOR UPDATE` on the
  pool row; the reserve that would breach `available` is refused → that trade becomes a loss. No overspend.
- **Crash mid-trade:** on boot, for each still-open position, read `position_decision` (decided outcome)
  and `pool_ledger` (reserved?) and resume: settle decided outcome at expiry, keeping the reservation.
  Idempotent by `position_id`. The pool's `paid`/`reserved` are rebuilt from `pool_ledger` (source of truth).
- **Day rollover:** at the day boundary, a new `withdrawal_pool` row applies; in-flight trades keep their
  `pool_day`. Reservations that never committed are released.

---

## 11. Scenarios tested (simulation) + edge cases to cover in code
Tested in sim (all held): demand << pool (no bind), demand >> pool (caps at pool, spreads), per-player
fairness (tight win-rate spread), greedy-vs-paced contrast, green→red / red→green path.
Edge cases the implementation MUST handle:
- pool = 0 for the day → every pool-eligible trade loses (no wins that day).
- pool set/raised/lowered mid-day → apply live (LISTEN), never make `available` negative.
- void/refunded trade → release its reservation; never double-count.
- config change mid-day (win rate / cap) → interacts with pool gates (pool is the hard ceiling).
- timezone/day boundary + DST-free EAT vs UTC game_days (Decision §12-D).
- marketer + overridden user + pool-eligible user all trading concurrently.
- reconciliation: Σ pool_ledger.commit == withdrawal_pool.paid == Σ payout ledger entries for the day.

---

## 12. DECISION POINTS (need operator answers before engine code)
- **A. Provable fairness / legal:** confirm we DROP the public provably-fair claim and pass legal review
  for a controlled-outcome model (Kenya/BCLB). Blocking for launch.
- **B. SELL behavior:** disable SELL in pool mode (recommended P1) vs winners-only sellable.
- **C. Pacing:** volume-paced (fairest per trade) vs clock-paced (even across the day). Reserve % for the tail?
- **D. Day boundary:** UTC (matches `game_days`) vs EAT/local midnight (matches "midnight to midnight").
- **E. Overrides coexistence:** do per-user `user_overrides` still apply inside pool mode (VIP boosts that
  bypass the pool?), or does pool mode ignore overrides for pool-eligible players?
- **F. Marketer outcome path:** statistical / scripted-win / non-withdrawable promo (see §8).
- **G. Base win propensity + amount shape:** starting values (the sim used ~0.34 propensity, mean ~2.2x).
- **H. Rollout scope:** pool mode per-brand (a `sites` / config flag) so it can be enabled on invest254
  first while lucky7/tamutraders stay statistical.

---

## 13. Phased delivery (cautious commits; each independently revertible)
- **Phase 0 (this commit):** design doc + `winrate_monitor.py`. No behavior change.
- **Phase 1 — Pool ledger, read-only:** migration for `withdrawal_pool` / `pool_ledger` /
  `position_decision`; superadmin RPC + `/admin/withdrawal-pool` (GET/PUT daily amount) + platform UI;
  a per-site `pool_mode` flag (default OFF). Engine still settles statistically. Fully inert until flagged.
- **Phase 2 — Controller in shadow mode:** engine computes pool decisions and WRITES `position_decision`
  + `pool_ledger` but still settles the OLD way; the monitor compares "would-pay" vs pool. Zero player impact.
- **Phase 3 — Enforce hard cap only:** when `pool_mode` ON, clamp/deny wins that breach `available`
  (keep statistical propensity). Bleed is impossible from here on. Reversible via the flag.
- **Phase 4 — Full controller:** pacing + controlled P&L path + SELL rule + marketer routing.
- **Phase 5 — Crash recovery, reconciliation job, admin dashboards, load test, legal sign-off.**
Each phase: unit + in-memory e2e + live rolled-back RPC e2e + typecheck, behind the per-brand flag.

---

## 14. RTP redesign — pace to turnover, cap to a hard RTP budget, unify win frequency

The original controller paced payouts against **pool size × elapsed-day-fraction**. That coupled realized
RTP to how big the daily pool was rather than to the operator's `house_edge`, and left the aggregate edge
unguaranteed. This redesign decouples the two: **`house_edge` is the RTP dial; the pool is only a cash
ceiling.** It fixes three bugs (see BUGLOG #6/#7/#8) and keeps the near-miss / streak-nudge / no-scoop
engagement logic untouched.

### 14.1 The model (all three engines now agree)
- **Unified win frequency.** The pool derives its mean winning multiplier the same way the statistical
  `SettlementEngine` calibrates it: `meanMultiplier = targetRtp / targetWinRate` (with `targetRtp = 1 −
  house_edge`). The pool's base win-probability is then `targetRtp / meanMultiplier = targetWinRate`, so
  **both engines share `targetWinRate` as the single win-frequency knob** and both deliver RTP = `1 −
  house_edge`. (An infeasible/degenerate config falls back to the controller's default multiplier;
  `site_game_config` is feasibility-checked on write, so this is defence-in-depth.)
- **Turnover pacing (not pool pacing).** `sessionWinProbability` paces realized RTP toward `targetRtp`
  using cumulative **player** turnover for the brand's EAT day: the pace error is `targetRtp −
  paid/turnover`. Behind pace nudges the win-prob up toward — but never above — `base`; ahead of pace
  pulls it below `base`.
- **Edge invariant (probability).** The win-prob is capped at `base = targetRtp/meanMultiplier`, so
  `E[RTP per trade] = p · meanMultiplier ≤ targetRtp < 1` — a structurally positive expected edge, and a
  **downward-only** correction (which is what makes realized RTP ≤ target, not just ≈ target).
- **HARD RTP-BUDGET CEILING (the definitive edge guarantee).** In `decidePoolOutcome`, a win's payout is
  additionally clamped so that **`paid + reserved ≤ ⌊targetRtp × turnover⌋` at all times.** This makes the
  positive-edge guarantee hold at **every volume** — including thin/low-volume days, where a probability
  cap alone leaves the house underwater on a large fraction of days (measured: up to ~29% of days at 8
  trades/day under the cap-only design). Subtracting **reserved** (in-flight, not-yet-settled wins) makes
  it concurrency-safe: many simultaneously open positions can never collectively commit past the budget.
  The pool `available()` remains the absolute cash fuse. Net effect: **realized RTP = min(targetRtp,
  pool/turnover)** — the pool binds only when it is undersized relative to `targetRtp × turnover`.

### 14.2 Turnover tracking (no schema change)
Cumulative player turnover is tracked in-memory per `${eatDay}:${siteId}` in the `PoolController`
(mirroring how player sessions are tracked) and **seeded from the database on first access** via
`PoolRepo.turnoverSeed`, which sums stakes over the day's persisted `position_decision` rows (joined to
`positions`). Because `position_decision` rows exist **only for pool-decided, non-marketer trades** and
are written at open, this turnover is **player-only by construction** and survives restarts — no migration
and no change to the money-critical reserve/commit/release RPCs.

### 14.3 Marketer / player separation (unchanged, and now load-bearing)
Marketers never reach the pool: `game.ts` routes `poolPath = poolActive && !isMarketer`, so marketer
trades settle on the statistical path with their own economy (`marketer_economy`) and never contribute to
pool turnover, pacing, or the RTP budget. Players in a pool-mode brand are governed entirely by the pool
using the **player** `house_edge`/`targetWinRate`.

### 14.4 Validation (derived from the engine's own output, not assumed)
Simulations driving the real `decidePoolOutcome`/`PoolController` confirm: realized RTP tracks
`1 − house_edge` and never exceeds it at any volume; `maxIntradayRTP = target` exactly (ceiling holds);
win frequency = `targetWinRate`; pool binds only when undersized (`RTP = pool/turnover`); determinism and
graceful zero-pool/zero-turnover behaviour. Covered by `packages/shared/src/pool.redesign.test.ts` and
`apps/engine/src/poolcontroller.redesign.test.ts`; the legacy (no-turnover) path is byte-identical and all
pre-existing pool tests stay green.

### 14.5 ⚠ Operational note (RTP activation is a config decision, not code)
The redesign is the *enabler* for coherent RTP. Its live effect depends on each brand's `house_edge`,
`targetWinRate`, and daily pool size:
- If pools are **large** relative to turnover, realized player RTP will now settle at `1 − house_edge`
  (bounded there) instead of drifting above it — i.e. payouts drop toward the configured edge.
- If pools are **small** relative to `targetRtp × turnover`, RTP is capped by `pool/turnover` and can sit
  below target — the pool must be sized `≥ targetRtp × expected_turnover` to actually pay the target RTP.
Set `house_edge`/`targetWinRate` and pool sizes deliberately **before/at** rollout; the code guarantees
RTP ≤ target and a positive edge, but the *level* of the target is the operator's dial.
