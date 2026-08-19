# Database Migrations

Idempotent, dependency-ordered SQL migrations for the Invest254 Supabase Postgres.

## Principles
- **Parity:** the SQL in these files is exactly what was applied to the live database.
- **Idempotent:** every migration uses `IF NOT EXISTS` / `CREATE OR REPLACE` /
  `DROP POLICY IF EXISTS`, so re-running is safe.
- **Single-command form:** each file is one statement (a `DO $$…$$` block where multiple
  DDL statements are needed) because the runtime SQL channel executes one command per call.
- **Money:** all monetary columns are `BIGINT` cents (KES). KES 50.00 = 5000.

## Order
| File | Purpose |
|------|---------|
| 0001_helpers.sql | `set_updated_at()` trigger function |
| 0002_identity_roles.sql | `profiles` (+ role/status/kyc, referral attribution) |
| 0003_wallet_ledger.sql | `wallets` (non-negative balances) + immutable `ledger_entries` |
| 0004_game.sql | `game_config` (singleton), `game_days` (fairness seeds), `positions` |
| 0005_payments.sql | `transactions` (M-Pesa deposits/withdrawals) |
| 0006_affiliate.sql | `affiliates`, `referrals`, `affiliate_commissions`, `affiliate_payouts` |
| 0007_engagement.sql | `activity_feed`, `chat_messages`, `bonuses`, `promo_codes`, `audit_log` |
| 0008_rls_policies.sql | Enable RLS + access policies on all tables |
| 0009_seed.sql | Seed `game_config` singleton with MVP parameters |
| 0010_money_rpcs.sql | Atomic `fn_open_position` / `fn_settle_position` (SECURITY DEFINER, service-role only) |
| 0011_fairness.sql | Daily seed rotation: `v_fairness` view (read-only), `fn_ensure_game_day`, `fn_reveal_game_day` (commitment-checked, past-only) |
| 0012_open_with_opened_at.sql | `fn_open_position` accepts engine-authoritative `opened_at` (deterministic recovery) |
| 0013_seed_engagement.sql | Seed ≥500 simulated `activity_feed` + ≥500 `chat_messages` (deterministic, idempotent; `is_simulated=true` / `user_id IS NULL`) |
| 0014_payment_rpcs.sql | Atomic + idempotent M-Pesa RPCs: deposit (`fn_create_deposit`/`fn_attach_stk`/`fn_complete_deposit`) and withdrawal (`fn_create_withdrawal` hold, `fn_approve_withdrawal`, `fn_reject_withdrawal`, `fn_complete_withdrawal` with reversal) — service-role only |
| 0015_self_managed_auth.sql | Self-managed phone+password identity: drop `profiles_id_fkey` → `auth.users`, add locked-down `user_credentials` (RLS, no policies), atomic `fn_register_user` (SECURITY DEFINER, service-role only) |
| 0016_age_verification.sql | Age-gate (≥18) for real-money play: `kyc_status` default → `'none'`, age check in `fn_create_deposit` / `fn_open_position` (`AGE_NOT_VERIFIED`), and `fn_set_basic_profile` (name + DOB, DOB immutable, `AGE_RESTRICTED` for minors; service-role only) |
| 0017_affiliate_enroll_attribution.sql | Affiliate foundation (M5): idempotent `fn_affiliate_enroll` (mints a unique URL-safe `referral_code`, promotes player→marketer) + `fn_register_user` extended with optional `p_referral_code` for atomic first-touch, permanent referral attribution (`profiles.referred_by` + `referrals` row; unknown/suspended code ignored) — both SECURITY DEFINER, service-role only |
| 0018_affiliate_commission_accrual.sql | Daily revenue-share accrual: `fn_accrue_affiliate_commissions(period)` upserts `affiliate_commissions` with `commission = floor(rate × GGR)`, where per-player-day `GGR = greatest(0, Σ(stake − payout))` over positions settled on that `game_days.trade_date`; idempotent, never re-touches paid/reversed buckets; SECURITY DEFINER, service-role only |
| 0019_affiliate_payouts.sql … 0027_admin_mfa.sql | Affiliate payouts, role consolidation, admin actions/balance-adjust audit, admin game-config + M-Pesa config RPCs, superadmin singleton, admin TOTP MFA |
| 0028_live_game_config.sql | Makes `game_config` the engine's source of truth: adds the missing `target_win_rate` knob and a monotonic `version`, an immutable `game_config_versions` snapshot per change, `positions.config_version` (so crash recovery re-prices a position under the parameters that were live when it opened), a feasibility CHECK mirroring `assertFeasible` (RTP / targetWinRate must lie in (1, maxMultiplier]) plus bounds on `tick_rate_ms`/`drift_bias`/`default_duration_s`, a `pg_notify('game_config_changed')` trigger the engine LISTENs on, `fn_open_position` extended with `p_config_version` (and a live min/max stake re-check), and `fn_admin_update_game_config` extended with `targetWinRate` |

| 0044_sites.sql | **Multi-tenant foundation:** `sites` (brand/tenant) registry holding every brand-diverse variable (name, logo, colours, domain, currency, licence, per-brand M-Pesa + seed refs); seeds a default site so existing data becomes "site #1". See docs/20. |
| 0045_site_scoping.sql | Threads `site_id` (FK → `sites`, backfilled to default, NOT NULL, indexed) through every tenant table; makes identity unique **per site** (`unique(site_id, phone/username)`) and fairness per site (`unique(site_id, trade_date)`). |
| 0046_site_game_config.sql | Per-site `site_game_config` (own RTP/stakes/×cap/tick/win-rate) + immutable `site_game_config_versions` + `pg_notify('site_game_config_changed', site_id)` the multiplexed engine LISTENs on; seeds the default site from the old singleton. |

> **Multi-tenant status:** 0044–0046 are the schema FOUNDATION. The money RPCs, engine
> multiplexing, RLS and UI still need `site_id` wiring — tracked task-by-task in
> [docs/22 — Conversion Checklist](../../../docs/22-conversion-checklist.md).

## Applying
With the Supabase/Postgres connection, apply each file in order. They are safe to re-run.

After applying, stamp the ledger so applied-state stays deterministic and tamper-evident:
`node --import tsx scripts/migrations_status.mts --record` (backfill / after each new migration), and
`node --import tsx scripts/migrations_status.mts` to verify (0 problems). See `docs/30` and
`0091_migration_ledger.sql` (`public.schema_migrations`).

## ⚠️ Super-admin bootstrap (manual, required)
As of `0015` identity is self-managed (phone + password, no Supabase Auth). Create the first
super-admin by registering through the app (or calling `fn_register_user` as `service_role`),
then promote it:

```sql
-- replace with the admin's phone (E.164)
update public.profiles set role = 'super_admin' where phone = '+2547XXXXXXXX';
```
