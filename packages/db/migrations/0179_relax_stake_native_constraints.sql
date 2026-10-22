-- 0179_relax_stake_native_constraints.sql — relax the per-brand native stake bounds to whole units ≥ 1.
--
-- WHY: `site_stake_native` (migration 0170) carried the original STAKE-1 rule as DB CHECK constraints:
-- min_native >= 5 AND both min/max multiples of 5. That blocked an operator from offering a sub-$5 or
-- non-multiple-of-5 minimum (e.g. a $1 stake on a USD brand). The application rule was relaxed to
-- "whole units ≥ 1" (stakelimits.ts validateNative), so the DB checks must match or a valid save fails.
--
-- New rule (mirrors validateNative): min is a whole number ≥ 1; max is a whole number ≥ min. Existing
-- rows (all multiples of 5 ≥ 5) trivially satisfy the looser rule, so no data migration is needed.

alter table public.site_stake_native
  drop constraint if exists site_stake_native_min_native_check,
  drop constraint if exists site_stake_native_check;

alter table public.site_stake_native
  add constraint site_stake_native_min_native_check
    check (min_native >= 1 and min_native = floor(min_native)),
  add constraint site_stake_native_check
    check (max_native >= min_native and max_native = floor(max_native));
