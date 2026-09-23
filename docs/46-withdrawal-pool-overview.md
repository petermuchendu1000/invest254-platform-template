# 46 — Withdrawal pool: per-brand overview and automatic distribution on by default (POOL-1)

Owner request (2026-09-23): *"under /pool, you must show how each brand has been distributed funds and all other
relevant details … set dynamic distribution on and as the default".*

## Findings

- **No per-brand view.** No page or endpoint listed each brand's pool for today: budget, paid, reserved and available. The closest was a single-brand card on the old brand game page, removed on 23 Sep (commit 1817807). The brand page's "Pool & payouts" tab showed one line of text.
- **Dynamic distribution had no stored on/off setting.** The daily job only ran if the `POOL_DAILY_TOTAL_CENTS` GitHub variable was set, and then as one global envelope across every platform.
- **Dynamic runs looked like manual edits.** A dynamic run was stored as `per_site`, so the history could not tell it apart from a hand edit. History never showed who got what.
- **Duplicate controls.** The pool controls appeared on both /platform/pool and Controls & economy, with different labels.

## Now

| Layer | What |
|---|---|
| DB `0164_pool_overview_auto.sql` | **`pool_auto_settings`** is one row per platform: mode `dynamic` \| `equal` \| `off`, daily total, look-back, last run. **A platform with no row is `dynamic`.** `platform_pool_distributions.source` records `manual` \| `dynamic` \| `auto`. New functions: `fn_pool_overview` (per brand, today: default, budget, paid, reserved, available, pool mode, kill switch, pending withdrawals, paid in the last 7 days); `fn_pool_auto_settings_get` / `_set` (validated and audited); `fn_pool_auto_record_run`. Scope: a platform admin sees its own platform; the System owner sees any platform or all of them. Service-role only. |
| Engine | `PoolOpsService.runAuto`: **dynamic** runs the water-fill over the configured daily total, or over the platform's **current** total when none is set. So turning dynamic on never budgets more money; it only moves money to where the demand is. **equal** splits the configured total evenly. **off** does nothing. The outcome is always recorded. If there is nothing to split, the run says so and writes no empty distribution. |
| Schedule | `scripts/pool_distribute_daily.mts` (workflow "Automatic Pool Distribution", 00:15 EAT) applies each platform's own setting, with source `auto`. It no longer needs the `POOL_DAILY_TOTAL_CENTS` variable. |
| API | New: `GET /platform/pool/overview`; `GET` and `PUT /platform/pool/auto-settings`; `POST /platform/pool/auto-run`. Changed: manual distributions are labelled `manual`, and the console's demand runs are labelled `dynamic`. |
| Web `/platform/pool` | **Today:** four KPIs, and a per-brand table (daily default, budget today, paid, reserved, available, a used bar, pending withdrawals, paid in the last 7 days) with a totals row and flags for "pool off" and "withdrawals off". **Automatic distribution:** status (On — by demand, marked as the default), the last run's outcome, mode cards, daily total ("keep the current total" when blank), look-back, Save, Preview the split, and Run now. **Set budgets by hand:** collapsed. **History:** how each distribution was made (Automatic / By demand / By hand / Even split); click a row for each brand's share by name. The owner can pick a single platform or all platforms. Controls & economy now links to this page instead of duplicating it. |

## Production note

- The default platform's brands currently total about KES 889,907 a day. With nothing configured, tonight's run re-splits that same total by demand.
- The real-time intra-day top-up (0118), which uses the global envelope, is unchanged.

## Tests

- `e2e_pool_overview.py`: BEFORE reproduces the gap; AFTER runs 22 checks covering exact figures, scope, the default being dynamic, validation, audit, the run recorder, `source` and grants.
- `poolops.test.ts` (3) and `poolops.pg.test.ts` (real schema: overview, default dynamic run, source `auto`, the total not increased, scope).
- Role e2e +8. `e2e_platform_pool` and `e2e_pool_realtime_topup` still pass.
