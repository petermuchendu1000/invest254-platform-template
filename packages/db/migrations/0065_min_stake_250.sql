-- 0065_min_stake_250.sql — raise the minimum stake to KES 250 (25 000 cents) for every brand.
-- Rationale (operator decision): a KES 250 floor sizes a typical deposit into ~10–40 trades and keeps
-- the pool-paced economy legible; superadmin can always retune per-brand from /admin/game afterwards.
-- Writing site_game_config fires the version-bump trigger + pg_notify, so the live engine re-prices the
-- next round with no redeploy. Legacy game_config is kept in step for any code still reading the singleton.
-- Idempotent: only rows below the new floor are raised.

update public.site_game_config
   set min_stake = 25000, updated_at = now()
 where min_stake < 25000;

update public.game_config
   set min_stake = 25000
 where min_stake < 25000;
