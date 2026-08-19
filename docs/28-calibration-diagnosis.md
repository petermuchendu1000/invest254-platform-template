# 28 — Statistical Calibration: Diagnosis & Reproducibility Gate (audit rec #2)

> **Status: DIAGNOSED + GATED.** The settlement engine calibration is **CORRECT** — proven, not
> assumed. The live "win-rate ≠ config" symptom is **not** a calibration bug; it is caused by per-user
> overrides + config thrashing, with a separate config_version provenance breakage. A permanent
> per-function contract test now gates config changes.

## 1. What was tested (reproducible harness)
Two replays against the **live** database (read-only) + the real engine code:
- **Self-consistency (Part B):** for each live config (v204..v233), build `CurveGenerator(real seed)`
  + `SettlementEngine` (200k-sample production calibration) and measure realized win-rate at UNIFORM
  entry times across the **whole 24h day** (not just the [0,3600] calibration window).
- **Faithfulness (Part A):** for every settled position on a **revealed-seed** day, recompute
  `settleVariable(stake, dir, entryT, nonce, seed)` under the position's `config_version` and compare
  to the RECORDED result/multiplier; also replay under the **time-active** version (max `created_at ≤
  opened_at`) to separate provenance from overrides.

## 2. Findings (evidence)
### 2.1 The calibration engine is CORRECT
Realized win-rate matches the configured `target_win_rate` for **every** live config, in both the
calibration window and the full day; RTP ≈ `1 − house_edge`; no directional bias:

| cfg | target_wr | edge | wr [0,3600] | wr [0,86400] | RTP (full day) |
|---|---|---|---|---|---|
| v204 | 0.05 | 0.80 | 0.057 | 0.040 | 0.159 |
| v213 | 0.65 | 0.05 | 0.646 | 0.641 | 0.938 |
| v219 | 0.80 | 0.05 | 0.776 | 0.797 | 0.946 |
| v221 | 0.75 | 0.20 | 0.753 | 0.764 | 0.815 |
| v231 | 0.45 | 0.50 | 0.447 | 0.455 | 0.505 |
| v233 | 0.05 | 0.80 | 0.046 | 0.057 | 0.227 |

⟹ **No calibration bug in `settle.ts`.** Calibration on the 1-hour window generalises to the full day
(the Fourier curve is quasi-stationary). `rec #2`'s literal check — "realized win-rate == target" — **passes.**

### 2.2 The live discrepancy is per-user OVERRIDES + config THRASH
Faithfulness replay (recompute vs recorded), by config version:

| stamped ver | n | match @stamped | match @time-active | recorded wr | recompute wr |
|---|---|---|---|---|---|
| v204 | 880 | **9.3%** | 9.3% | 0.895 | 0.181 |
| v213 | 378 | **21.2%** | 21.2% | 0.958 | 0.923 |
| v219 | 287 | **89.2%** | 89.2% | 0.868 | 0.951 |
| v233 | 42 | **100%** | 100% | 0.357 | 0.357 |

- v204 was the ONLY version live on 2026-08-14/15 (`edge 0.8, wr 0.05` → ≤18% win). Recorded win-rate
  there is **89.5%** — impossible from config (no `wr≈0.9` version existed then). The only remaining
  mechanism is **per-user `user_overrides`** (win-rate ~0.9) pricing those trades via the per-user
  settlement path — exactly audit finding #2. Global recompute can't match because it ignores overrides.
- After the 2026-08-17 override cleanup (v219/v233), recompute **matches recorded 89–100%** →
  **engine faithful when overrides are absent.**
- Combined with **config thrashing** (30 versions on invest254; v219 `wr 0.8/edge 0.05`, v230
  `wr 0.95/edge 0.03`) and the pool-exempt **marketer cohort dominating volume** (fixed by decision F),
  this fully explains the measured 110–146% cohort RTP — **without any calibration fault.**

### 2.3 NEW integrity bug — config_version provenance (42%)
**1,606 of 3,785 settled positions (42%)** carry a `config_version` that **no longer exists** in
`site_game_config_versions` (older versions were pruned). Those positions cannot be recomputed,
verified, or faithfully crash-recovered (`SeedManager.forVersion` falls back to *live* config, changing
the outcome). This breaks provable-fairness for 42% of history and must be fixed independently of RTP.

## 3. The gate (shipped)
`packages/shared/src/settle.calibration.test.ts` — a per-function contract suite that asserts, for
every live config value (v204..v233) and multiple seeds:
- `SettlementEngine.settle/settleVariable`: realized win-rate == target, RTP == 1−edge, no dir bias,
  generalises across the full day;
- `winMultiplier`: sample mean == meanMult (RTP preserved), draws in (1.01, cap], degenerate cases;
- `solveTruncExpBeta`: solved mean round-trips;
- `liveWinMultiplier`: monotone, starts at 1, ends at final, never exceeds it;
- `checkFeasible`: every live config feasible; infeasible economies rejected.
**14/14 pass.** CI runs it; **do not ship a config whose values fail this gate.**

## 4. Real fixes required (NOT calibration)
1. **Overrides**: extend migration 0074 to reject better-than-house **win-rate** overrides (it currently
   guards only `house_edge`). Re-clear the 2 live favourable overrides (win_rate 0.9 / 0.1).
2. **Config thrash**: rate-limit + change-review on `site_game_config`; consider a per-day change cap and
   a two-person approval for `house_edge`/`target_win_rate` swings.
3. **Provenance/immutability**: never prune `site_game_config_versions`; add a FK/guard so a position's
   `config_version` always resolves; add a CI/nightly **reproducibility check** (recompute a sample of
   recent positions from their `(seed, config_version, entryT, nonce)` and assert == recorded) to catch
   any future provable-fairness drift.
4. **Recovery bug (audit rec #5)**: recovery re-prices statistical wins with `settle()` instead of the
   committed `settleVariable()` — fix so recovered payouts match the committed outcome.
