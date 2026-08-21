-- 0094_welcome_bonus.sql — Sign-up welcome bonus (restricted, wagered) + revive the bonus engine.
--
-- PRODUCT / PSYCHOLOGY (docs/31):
--   A KES 200 welcome bonus is granted to every new PLAYER on sign-up, credited to the restricted
--   `bonus_balance` (non-withdrawable; converts to real only after it is wagered `welcome_wagering_x`).
--   The amount is DELIBERATELY KES 50 below the KES 250 min stake: the goal is not a free trade but a
--   deposit trigger. Endowment effect (they now "own" KES 200) + goal-gradient (they are only KES 50
--   short of their first trade) + the Zeigarnik open-loop (an unused balance nags) convert sign-ups
--   who never deposit into first-time depositors. Global + default-on so every brand — current and
--   future — inherits it automatically.
--
-- WHY THIS MIGRATION ALSO TOUCHES fn_open_position / fn_settle_position:
--   Site-scoping (0047) and the demo-isolation rewrite (0084) dropped ALL bonus handling from the live
--   money RPCs: the current versions only move real/demo balances, so `bonus_balance` is frozen —
--   never staked, never wagered, never converted. The `bonuses` table is empty platform-wide, so
--   restoring the bonus path is a NO-OP for every existing account (all have bonus_balance = 0); it
--   only begins to matter once a welcome bonus is granted. We faithfully re-merge the original 0037
--   bonus mechanics (bonus-first staking, wagering accrual, FIFO conversion) INTO the 0084 demo-aware,
--   site-scoped bodies — signatures are byte-for-byte identical so the engine keeps calling them
--   unchanged. Deposit-bonus GRANTING (removed at 0077/0078) is intentionally NOT re-enabled here.
--
--   Money never crosses demo <-> real (marketer isolation preserved). All movement stays inside
--   SECURITY DEFINER RPCs (service-role only). Additive + idempotent. Fully revertible (see tail).

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 0. Remove the (dormant) deposit-bonus remnants. Deposit-bonus GRANTING was already removed at
--    0077/0078 (fn_complete_deposit no longer awards it); this drops the now-orphaned tier helper so
--    the ONLY bonus in the system is the welcome bonus. The frontend deposit-bonus preview is removed
--    in the same change set. bonus_config's legacy tiers/wagering_x columns are left in place (inert).
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
drop function if exists public.fn_deposit_bonus_pct(bigint);

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 1. Config: welcome-bonus knobs on the existing singleton bonus_config (0037). Global + default-on.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
alter table public.bonus_config add column if not exists welcome_enabled      boolean not null default true;
alter table public.bonus_config add column if not exists welcome_amount_cents  bigint  not null default 20000 check (welcome_amount_cents >= 0);
alter table public.bonus_config add column if not exists welcome_wagering_x    numeric not null default 3.0   check (welcome_wagering_x >= 0);
-- Ensure the singleton row exists (it does since 0037; harmless if already present).
insert into public.bonus_config(id) values (1) on conflict (id) do nothing;

-- One welcome bonus per user — hard, race-proof anti-abuse backstop (one free gift per account).
create unique index if not exists idx_bonuses_one_welcome_per_user
  on public.bonuses(user_id) where type = 'welcome';

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 2. fn_grant_welcome_bonus: idempotent one-time grant. Returns cents granted (0 = nothing granted).
--    Skips demo/marketer accounts and already-granted users. Credits bonus_balance + writes ledger.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_grant_welcome_bonus(p_user uuid)
returns bigint
language plpgsql security definer set search_path = public
as $fn$
declare v_enabled boolean; v_amount bigint; v_wx numeric; v_site uuid; v_bonus_id uuid;
begin
  select welcome_enabled, welcome_amount_cents, welcome_wagering_x
    into v_enabled, v_amount, v_wx
    from bonus_config where id = 1;
  if not found or not coalesce(v_enabled, false) or coalesce(v_amount, 0) <= 0 then
    return 0;
  end if;

  -- Demo/marketer (social-proof) accounts never receive a real welcome bonus.
  if public.fn_is_marketer_account(p_user) then
    return 0;
  end if;

  -- Lock the wallet row for the duration; also resolves the account's brand for scoping.
  select site_id into v_site from wallets where user_id = p_user for update;
  if not found then
    return 0;   -- no wallet (should never happen post-registration) → nothing to credit
  end if;

  -- Idempotent: one welcome bonus per user. The partial unique index is the race-proof backstop.
  if exists (select 1 from bonuses where user_id = p_user and type = 'welcome') then
    return 0;
  end if;

  insert into bonuses(user_id, site_id, type, amount, wagering_x, status)
    values (p_user, v_site, 'welcome', v_amount, v_wx, 'active')
    on conflict (user_id) where type = 'welcome' do nothing
    returning id into v_bonus_id;
  if v_bonus_id is null then
    return 0;   -- lost the race; another connection granted it
  end if;

  update wallets set bonus_balance = bonus_balance + v_amount where user_id = p_user;
  insert into ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id, meta)
    values (p_user, v_site, 'bonus', v_amount, 'bonus', 'bonuses', v_bonus_id::text,
            jsonb_build_object('kind', 'welcome_bonus', 'wagering_x', v_wx));
  return v_amount;
end;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 3. fn_open_position (10-arg, site-scoped) — 0084 demo isolation + restored 0037 bonus-first staking.
--    Signature IDENTICAL to 0084 so PgGameRepository keeps calling it unchanged.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_open_position(
  p_user uuid, p_stake bigint, p_direction text, p_entry_rate numeric,
  p_duration_s int, p_game_day bigint, p_nonce bigint, p_opened_at timestamptz,
  p_config_version bigint, p_site_id uuid
) returns table(position_id uuid, new_balance bigint)
language plpgsql security definer set search_path = public
as $fn$
declare v_bal bigint; v_id uuid; v_min bigint; v_max bigint; v_demo boolean;
        v_real bigint; v_bonus bigint; v_from_bonus bigint; v_from_real bigint;
begin
  if p_stake <= 0 then raise exception 'INVALID_STAKE'; end if;
  if p_direction not in ('buy','sell') then raise exception 'INVALID_DIRECTION'; end if;

  -- Live stake bounds for THIS brand (defence in depth; last gate before money moves).
  select min_stake, max_stake into v_min, v_max from site_game_config where site_id = p_site_id;
  if v_min is not null and p_stake < v_min then raise exception 'STAKE_BELOW_MIN'; end if;
  if v_max is not null and p_stake > v_max then raise exception 'STAKE_ABOVE_MAX'; end if;

  v_demo := public.fn_is_marketer_account(p_user);      -- authoritative, server-side (unspoofable)

  if v_demo then
    -- ── Demo/marketer path: unchanged from 0084 (demo_balance only; no bonus, no wagering) ──
    select demo_balance into v_bal from wallets where user_id = p_user and site_id = p_site_id for update;
    if not found then raise exception 'WALLET_NOT_FOUND'; end if;
    if v_bal < p_stake then raise exception 'INSUFFICIENT_FUNDS'; end if;
    update wallets set demo_balance = demo_balance - p_stake where user_id = p_user
      returning demo_balance into v_bal;
    v_id := gen_random_uuid();
    insert into positions(id, user_id, site_id, game_day_id, direction, stake, entry_rate, duration_s,
                          status, nonce, opened_at, config_version)
      values (v_id, p_user, p_site_id, p_game_day, p_direction, p_stake, p_entry_rate, p_duration_s,
              'open', p_nonce, p_opened_at, p_config_version);
    insert into ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id)
      values (p_user, p_site_id, 'stake', -p_stake, 'demo', 'positions', v_id::text);
    return query select v_id, v_bal;
    return;
  end if;

  -- ── Real player path: bonus-first staking + wagering accrual (restored from 0037) ──
  select real_balance, bonus_balance into v_real, v_bonus
    from wallets where user_id = p_user and site_id = p_site_id for update;
  if not found then raise exception 'WALLET_NOT_FOUND'; end if;
  if v_real + v_bonus < p_stake then raise exception 'INSUFFICIENT_FUNDS'; end if;

  -- Spend restricted bonus funds before real cash so wagering rules can be satisfied.
  v_from_bonus := least(v_bonus, p_stake);
  v_from_real  := p_stake - v_from_bonus;
  update wallets set bonus_balance = bonus_balance - v_from_bonus,
                     real_balance  = real_balance  - v_from_real
   where user_id = p_user returning real_balance into v_bal;

  v_id := gen_random_uuid();
  insert into positions(id, user_id, site_id, game_day_id, direction, stake, entry_rate, duration_s,
                        status, nonce, opened_at, config_version)
    values (v_id, p_user, p_site_id, p_game_day, p_direction, p_stake, p_entry_rate, p_duration_s,
            'open', p_nonce, p_opened_at, p_config_version);
  if v_from_real > 0 then
    insert into ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id)
      values (p_user, p_site_id, 'stake', -v_from_real, 'real', 'positions', v_id::text);
  end if;
  if v_from_bonus > 0 then
    insert into ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id)
      values (p_user, p_site_id, 'stake', -v_from_bonus, 'bonus', 'positions', v_id::text);
  end if;
  -- Wagering progress: every staked shilling (real + bonus) counts toward this user's active bonuses.
  update bonuses set wagered = wagered + p_stake
   where user_id = p_user and status = 'active';

  return query select v_id, v_bal;   -- new_balance = remaining REAL (spendable/withdrawable) balance
end;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 4. fn_settle_position (5-arg) — 0084 demo isolation + restored 0037 FIFO wagering conversion.
--    Signature IDENTICAL to 0084 so PgGameRepository keeps calling it unchanged.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_settle_position(
  p_position uuid, p_exit_rate numeric, p_result text, p_multiplier numeric, p_payout bigint
) returns table(settled boolean, new_balance bigint)
language plpgsql security definer set search_path = public
as $fn$
declare v_status text; v_user uuid; v_stake bigint; v_bal bigint; v_site uuid; v_demo boolean;
        v_bonus record; v_convert bigint;
begin
  if p_result not in ('win','loss','void') then raise exception 'INVALID_RESULT'; end if;
  if p_payout < 0 then raise exception 'INVALID_PAYOUT'; end if;
  select status, user_id, stake, site_id into v_status, v_user, v_stake, v_site
    from positions where id = p_position for update;
  if not found then raise exception 'POSITION_NOT_FOUND'; end if;

  v_demo := public.fn_is_marketer_account(v_user);

  if v_status <> 'open' then
    -- idempotent no-op: report the CURRENT spendable balance for this account kind
    if v_demo then select demo_balance into v_bal from wallets where user_id = v_user;
    else select real_balance into v_bal from wallets where user_id = v_user; end if;
    return query select false, v_bal; return;
  end if;

  update positions set status='settled', exit_rate=p_exit_rate, result=p_result,
    multiplier = nullif(p_multiplier, 0), payout = p_payout, pnl = p_payout - v_stake, settled_at = now()
   where id = p_position;

  if v_demo then
    -- ── Demo/marketer path: unchanged from 0084 (payout to demo_balance; no bonus conversion) ──
    if p_payout > 0 then
      update wallets set demo_balance = demo_balance + p_payout where user_id = v_user
        returning demo_balance into v_bal;
      insert into ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id)
        values (v_user, v_site, 'payout', p_payout, 'demo', 'positions', p_position::text);
    else
      select demo_balance into v_bal from wallets where user_id = v_user;
    end if;
    return query select true, v_bal; return;
  end if;

  -- ── Real player path: payout to real, then convert any cleared bonuses (restored from 0037) ──
  if p_payout > 0 then
    update wallets set real_balance = real_balance + p_payout where user_id = v_user;
    insert into ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id)
      values (v_user, v_site, 'payout', p_payout, 'real', 'positions', p_position::text);
  end if;

  -- Wagering conversion: bonuses whose requirement is met convert remaining bonus_balance -> real
  -- (FIFO by created_at). A bonus already spent as stake converts 0 (no double credit) but still clears.
  for v_bonus in
    select id, amount, wagering_x, wagered from bonuses
     where user_id = v_user and status = 'active'
       and wagered >= floor(amount * wagering_x)
     order by created_at for update
  loop
    select bonus_balance into v_convert from wallets where user_id = v_user;
    v_convert := least(v_convert, v_bonus.amount);
    if v_convert > 0 then
      update wallets set bonus_balance = bonus_balance - v_convert,
                         real_balance  = real_balance  + v_convert
       where user_id = v_user;
      insert into ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id, meta)
        values (v_user, v_site, 'bonus', v_convert, 'real', 'bonuses', v_bonus.id::text,
                jsonb_build_object('kind', 'wagering_conversion', 'wagered', v_bonus.wagered,
                                   'required', floor(v_bonus.amount * v_bonus.wagering_x)));
    end if;
    update bonuses set status = 'cleared', converted_at = now() where id = v_bonus.id;
  end loop;

  select real_balance into v_bal from wallets where user_id = v_user;
  return query select true, v_bal;
end;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 5. Clear the welcome bonus when a player is promoted to a marketer.
--    Marketers are demo / social-proof accounts, so they must not keep a real, restricted welcome
--    bonus. A trigger on profiles.role -> 'marketer' catches EVERY promotion path (admin set-role RPC,
--    affiliate self-enrollment, or a direct role update) with no rewrite of those RPCs.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_clear_welcome_bonus(p_user uuid)
returns bigint
language plpgsql security definer set search_path = public
as $fn$
declare v_bal bigint; v_site uuid; v_voided int;
begin
  select bonus_balance, site_id into v_bal, v_site from wallets where user_id = p_user for update;
  if not found then return 0; end if;
  -- Void the account's active welcome bonus(es).
  update bonuses set status = 'void', converted_at = now()
   where user_id = p_user and type = 'welcome' and status = 'active';
  get diagnostics v_voided = row_count;
  if v_voided = 0 then return 0; end if;   -- no welcome bonus to clear
  -- Remove the still-restricted welcome funds from bonus_balance. Deposit bonuses are not granted
  -- (see §0), so all bonus_balance is welcome-derived; a fully-staked bonus leaves v_bal = 0.
  if v_bal > 0 then
    update wallets set bonus_balance = bonus_balance - v_bal where user_id = p_user;
    insert into ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id, meta)
      values (p_user, v_site, 'bonus', -v_bal, 'bonus', 'wallets', p_user::text,
              jsonb_build_object('kind', 'welcome_void', 'reason', 'promoted_to_marketer'));
  end if;
  return v_bal;
end;
$fn$;

create or replace function public.trg_clear_welcome_on_marketer()
returns trigger language plpgsql security definer set search_path = public
as $fn$
begin
  if new.role = 'marketer' and coalesce(old.role, '') <> 'marketer' then
    perform public.fn_clear_welcome_bonus(new.id);
  end if;
  return new;
end;
$fn$;

drop trigger if exists clear_welcome_on_marketer on public.profiles;
create trigger clear_welcome_on_marketer
  after update of role on public.profiles
  for each row execute function public.trg_clear_welcome_on_marketer();

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- 6. Grants: service-role only (mirrors 0037/0084). Player reads go through the API.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
do $g$
begin
  revoke all on function public.fn_grant_welcome_bonus(uuid) from public, anon, authenticated;
  grant  execute on function public.fn_grant_welcome_bonus(uuid) to service_role;
  revoke all on function public.fn_clear_welcome_bonus(uuid) from public, anon, authenticated;
  grant  execute on function public.fn_clear_welcome_bonus(uuid) to service_role;
  revoke all on function public.fn_open_position(uuid,bigint,text,numeric,int,bigint,bigint,timestamptz,bigint,uuid) from public;
  grant  execute on function public.fn_open_position(uuid,bigint,text,numeric,int,bigint,bigint,timestamptz,bigint,uuid) to service_role;
  revoke all on function public.fn_settle_position(uuid,numeric,text,numeric,bigint) from public;
  grant  execute on function public.fn_settle_position(uuid,numeric,text,numeric,bigint) to service_role;
end
$g$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- REVERT (manual, if ever needed):
--   1. Restore fn_open_position / fn_settle_position from migration 0084 (verbatim bodies).
--   2. drop trigger if exists clear_welcome_on_marketer on public.profiles;
--      drop function if exists public.trg_clear_welcome_on_marketer();
--      drop function if exists public.fn_clear_welcome_bonus(uuid);
--   3. drop function if exists public.fn_grant_welcome_bonus(uuid);
--   4. drop index if exists public.idx_bonuses_one_welcome_per_user;
--   5. alter table public.bonus_config drop column if exists welcome_enabled,
--        drop column if exists welcome_amount_cents, drop column if exists welcome_wagering_x;
--   6. (optional) recreate fn_deposit_bonus_pct from 0037 if deposit bonuses are ever reinstated.
--   (Existing granted welcome bonuses can be voided via the admin bonus tools if desired.)
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
