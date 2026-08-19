-- 0070_marketer_account_isolation.sql — canonical "marketer account" identity for reporting.
--
-- "Marketers" (migration 0033) are internal accounts keyed by PHONE: they are CREDITED internally
-- (admin ledger adjustments, not real M-Pesa deposits), they play the game on that funny money, and
-- their game-winnings "withdrawals" are internal transfers into the companion marketer wallet
-- (transactions.provider='internal', migration 0036). NONE of it is real money. A marketer account
-- is therefore any profile whose phone matches a row in `marketers` (role-independent: some are
-- role='player', some role='marketer').
--
-- This view is the single, canonical way the admin/finance reports isolate that cohort so real-player
-- financial + game stats (deposits, withdrawals, wallet liability, turnover, GGR, RTP) exclude it and
-- the marketer figures are reported separately. Phones are normalised to the local 0XXXXXXXXX form on
-- both sides (mirrors fn_marketer_game_withdraw) so 254-prefixed identities still match. Read-only,
-- additive, idempotent.

create or replace view public.marketer_account_ids as
select distinct p.id as user_id
from public.profiles p
join public.marketers m
  on regexp_replace(m.phone, '^\+?254', '0') = regexp_replace(p.phone, '^\+?254', '0');

grant select on public.marketer_account_ids to service_role;
