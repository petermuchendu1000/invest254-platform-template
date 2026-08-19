# 26 — Financial Integrity Audit & RTP Diagnosis (invest254)

> **Status: AUTHORITATIVE FINDINGS (2026-08-17).** Produced from a full trace of the live database +
> engine simulation. Explains where every dashboard number comes from, diagnoses the ~137% realised
> RTP, and records the fixes applied + the operator decisions still required.

## 1. Data lineage (where the numbers come from)
- **Admin daily dashboard (`reportDay`)** and **Reports → Daily trend / Top players** are computed
  **live** from `transactions` (cash) + settled `positions` (game). No cached table.
  - `Net revenue (GGR)` = `Σ(stake − payout)` over settled positions. **This is a game metric, not a
    deposit.** A day can show GGR with zero deposits (players trading an existing balance). Example:
    2026-08-17 showed GGR/turnover KES 250 = one real player (`fuuti`) staking 250 and losing —
    **nobody deposited 250**.
  - `Deposits/Withdrawals` = successful M‑Pesa `transactions` (withdrawals exclude `provider='internal'`
    marketer transfers).
  - **Top players** = ranked by **GGR descending** = net revenue to the house (biggest net **losers**
    first). Negative GGR = a player who is net‑**winning**. UI now states this + a losers/winners toggle.
- **RTP monitor** = `Σpayout ÷ Σturnover` over settled positions per window (7d/30d/all).
- **All** of the above **exclude the internal marketer cohort** (`marketer_account_ids`, migration 0070).

## 2. The RTP anomaly (137% vs 95% target) — root cause
Realised RTP is **~137%** over 5.9k real bets. **The settlement engine is NOT the cause** — running the
actual engine (`CurveGenerator`+`SettlementEngine.settleVariable`) at the current live config
(house_edge 0.05, target_win_rate 0.65) yields **win rate 64.9%, RTP 95.0%** (200k‑trade sim). The math
is sound: `E[win multiplier] = (1−houseEdge)/targetWinRate`, and `RTP = winRate × E[mult]`.

The 137% is the aggregate of **three operational causes**, not a code bug:
1. **Config thrashing.** `site_game_config` has **~221 versions** with reckless values (house_edge swung
   0.05↔0.98, target_win_rate 0.01↔0.8, mean win multiplier up to ~4x). Because
   `RTP = (realisedWinRate/targetWinRate)×(1−houseEdge)`, a low target_win_rate paired with a high
   multiplier makes RTP explode whenever the realised win rate drifts above the (tiny) target.
2. **Per‑user overrides.** `user_overrides` on 10 accounts. Most were **punitive band‑aids** applied
   *after* the config‑thrash losses (implied RTP = `1 − house_edge`: e.g. Ali 2%, deemcqen 55%, joy254
   61%), plus a few RTP‑neutral win‑frequency tweaks; only one (a marketer) was favourable. They still
   represent an **arbitrary per‑user RTP lever** (fairness/regulatory anti‑pattern). **RESOLVED (2026‑08‑17):**
   all overrides backed up (`user_overrides_backup_2026-08-17.csv` + restore SQL) and cleared, and migration
   `0074` now **rejects any override that grants better‑than‑house RTP** (per‑user `house_edge` below the
   site’s) plus range validation. Note: in pool mode overrides were already ignored for pool‑eligible players.
3. **Pool controller inactive for history.** Although `pool_mode=true` for invest254/tamutraders,
   only **77 of 9,116 positions** (0.8%) were ever pool‑decided — the rest settled statistically with
   **no daily cap**. The pool (docs/25) only reserves wins when the controller runs.

### Why the house hasn't actually lost cash
Real deposits IN = **KES 94,574**; real withdrawals OUT = **KES 0**. Winnings were contained by
**admin action**: **KES 837,547** clawed back via `ledger_entries.type='adjustment'` and **KES 1,388,137**
of withdrawal attempts **rejected/reversed** (`fn_reject_withdrawal` → `status='reversed'`). These are
*working-as-designed* admin tools, but using them to mask an over‑paying game **pollutes the ledger and
makes GGR meaningless as revenue**, and blocks legitimate cashouts (trust/regulatory risk).

## 3. RTP monitor under pool mode (important)
When `pool_mode=true`, in‑game payouts are (meant to be) capped by the daily `withdrawal_pool`, so the
**RTP monitor measures the *virtual* curve, not real cash exposure.** Real cash RTP ≈ real payouts ÷ real
turnover is bounded by the pool budget. Operators must read the RTP monitor as a *game‑calibration* signal,
not a cash‑loss signal, on pool‑mode brands.

## 4. Fixes applied (this audit)
- **Clean platform data** (migration 0072) — platform overview/performance exclude the marketer cohort.
- **Reporting timezone standardised to EAT** (Africa/Nairobi) across `reportDay`, `reportDaily`,
  `reportByUser` — cash + game + registrations + FTD now bucket on the same EAT day as the operator’s
  calendar and the frontend date picker (previously cash used UTC `created_at::date` while game used the
  UTC fairness `trade_date`).
- **Reports made self‑documenting** — in‑product definitions, GGR≠deposits note, Top‑players ranking
  explanation + losers/winners toggle.

## 5. Recommendations / open decisions
1. **Audit & remove dangerous `user_overrides`.** ✅ DONE (2026‑08‑17): backed up + cleared; migration
   `0074` guards against favourable (better‑than‑house) overrides going forward.
2. **Guard config thrashing.** ✅ DONE (2026‑08‑17): migration `0075` adds a **minimum house‑edge
   floor (0.02, RTP ≤ 98%)** to the `site_cfg_feasible` CHECK so no economy edit can set a
   non‑profitable book; admin + platform paths surface it as a clean 422. Config edits remain
   version‑audited (`site_game_config_versions`, `updated_by`). Follow‑up: a change‑review/alerting UI.
3. **Confirm pool‑controller coverage.** ✅ CONFIRMED LIVE (2026‑08‑17): after the engine redeploy,
   new non‑marketer trades on pool‑mode brands are pool‑decided (verified: today's real trade has a
   `position_decision`). Wins are now capped at the daily `withdrawal_pool`. Monitor `position_decision`
   coverage → 100% of new pool‑mode trades.
4. **Surface manual clawbacks/reversals.** ✅ DONE (2026‑08‑17): `listUserActivity` now unions
   `ledger_entries type='adjustment'` (signed), so every manual admin credit/debit shows in the player
   activity timeline (labelled "Manual adjustment", warn‑styled). Reversed withdrawals already show as
   `withdrawal` rows with `status='reversed'`. Manual balance changes are no longer invisible.
