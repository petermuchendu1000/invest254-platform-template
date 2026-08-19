-- 0084_marketer_demo_isolation.sql — Decision F (docs/25 §8): marketers are demo / social-proof
-- accounts, so their game money must be STRUCTURALLY non-withdrawable and excluded from the real
-- cash economy — never dependent on a run-time phone check.
--
-- Problem this fixes (docs/26 §2, winning-algorithm audit):
--   Marketer game trades ran on the statistical engine and CREDITED wallets.real_balance — the same
--   column real players withdraw from. Separation existed only at withdrawal time (fn_marketer_game_
--   withdraw's phone match) and in reporting (marketer_account_ids). A missed/edge-case phone match,
--   or a deleted marketers row, would turn funny-money winnings into real, M-Pesa-withdrawable cash;
--   and the raw economy (turnover/GGR/RTP) was polluted (measured RTP 110–146% for the cohort).
--
-- Fix: a dedicated, non-withdrawable `wallets.demo_balance`. Marketer open/settle/withdraw operate on
-- demo_balance only; real players are UNTOUCHED (real_balance path unchanged). One canonical predicate
-- (fn_is_marketer_account) is the single source of truth for "is this a demo account", used by the
-- money RPCs AND aligned with the reporting view. Additive + idempotent. Fully revertible (see tail).
--
-- Money can never cross demo <-> real inside these RPCs, so a marketer win can never become real cash.

-- ── 1. The demo (non-withdrawable) bucket ──────────────────────────────────────────────────────────
alter table public.wallets add column if not exists demo_balance bigint not null default 0
  check (demo_balance >= 0);

-- Allow the non-withdrawable 'demo' ledger kind — the money RPCs below write balance_kind='demo' for
-- marketer/demo accounts; the pre-existing CHECK only allowed ('real','bonus'). Idempotent.
alter table public.ledger_entries drop constraint if exists ledger_entries_balance_kind_check;
alter table public.ledger_entries add constraint ledger_entries_balance_kind_check
  check (balance_kind = any (array['real'::text, 'bonus'::text, 'demo'::text]));

-- ── 2. Canonical "is this account a demo/marketer account?" — ONE definition, reused everywhere ─────
-- A marketer account = a profile whose phone matches a `marketers` row (role-independent). We match on
-- the SIGNIFICANT 9 digits (Kenyan MSISDN: 7XXXXXXXX / 1XXXXXXXX) after stripping non-digits, so every
-- stored form matches uniformly: +254712000003 / 254712000003 / 0712000003 / 712000003 all reduce to
-- 712000003. This is a SUPERSET of the old `^\+?254`->`0` rule (0070/0036): it additionally catches the
-- bare 7XXXXXXXX form, closing a gap where a marketer could otherwise be treated as a real player. This
-- is the single canonical "is this a demo account" predicate, reused by every money RPC and the report view.
create or replace function public.fn_is_marketer_account(p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
      from public.profiles p
      join public.marketers m
        on right(regexp_replace(m.phone, '[^0-9]', '', 'g'), 9)
         = right(regexp_replace(p.phone, '[^0-9]', '', 'g'), 9)
     where p.id = p_user
       and length(regexp_replace(p.phone, '[^0-9]', '', 'g')) >= 9   -- guard against empty/short phones
  )
$$;

-- Re-point the reporting view at the canonical predicate so there is a single source of truth.
create or replace view public.marketer_account_ids as
  select id as user_id from public.profiles p where public.fn_is_marketer_account(p.id);
grant select on public.marketer_account_ids to service_role;

-- ── 3. One-time: move existing marketer game balances real -> demo (no marketer keeps real cash) ────
-- Idempotent: only moves a POSITIVE real_balance for marketer accounts; running twice is a no-op
-- because after the first run their real_balance is 0.
do $mig$
declare v_moved int;
begin
  with mk as (select user_id from public.marketer_account_ids)
  update public.wallets w
     set demo_balance = w.demo_balance + w.real_balance,
         real_balance = 0
    from mk
   where w.user_id = mk.user_id and w.real_balance > 0;
  get diagnostics v_moved = row_count;
  raise notice '0084: migrated real->demo for % marketer wallet(s)', v_moved;
end
$mig$;

-- ── 4. fn_open_position: marketer stakes debit demo_balance; real players unchanged ────────────────
create or replace function public.fn_open_position(
  p_user uuid, p_stake bigint, p_direction text, p_entry_rate numeric,
  p_duration_s int, p_game_day bigint, p_nonce bigint, p_opened_at timestamptz,
  p_config_version bigint, p_site_id uuid
) returns table(position_id uuid, new_balance bigint)
language plpgsql security definer set search_path = public
as $fn$
declare v_bal bigint; v_id uuid; v_min bigint; v_max bigint; v_demo boolean; v_kind text;
begin
  if p_stake <= 0 then raise exception 'INVALID_STAKE'; end if;
  if p_direction not in ('buy','sell') then raise exception 'INVALID_DIRECTION'; end if;

  -- Live stake bounds for THIS brand (defence in depth; last gate before money moves).
  select min_stake, max_stake into v_min, v_max from site_game_config where site_id = p_site_id;
  if v_min is not null and p_stake < v_min then raise exception 'STAKE_BELOW_MIN'; end if;
  if v_max is not null and p_stake > v_max then raise exception 'STAKE_ABOVE_MAX'; end if;

  v_demo := public.fn_is_marketer_account(p_user);      -- authoritative, server-side (unspoofable)
  v_kind := case when v_demo then 'demo' else 'real' end;

  -- Lock the wallet and confirm it belongs to this site (cross-site open is impossible).
  if v_demo then
    select demo_balance into v_bal from wallets where user_id = p_user and site_id = p_site_id for update;
  else
    select real_balance into v_bal from wallets where user_id = p_user and site_id = p_site_id for update;
  end if;
  if not found then raise exception 'WALLET_NOT_FOUND'; end if;
  if v_bal < p_stake then raise exception 'INSUFFICIENT_FUNDS'; end if;

  if v_demo then
    update wallets set demo_balance = demo_balance - p_stake where user_id = p_user
      returning demo_balance into v_bal;
  else
    update wallets set real_balance = real_balance - p_stake where user_id = p_user
      returning real_balance into v_bal;
  end if;

  v_id := gen_random_uuid();
  insert into positions(id, user_id, site_id, game_day_id, direction, stake, entry_rate, duration_s,
                        status, nonce, opened_at, config_version)
    values (v_id, p_user, p_site_id, p_game_day, p_direction, p_stake, p_entry_rate, p_duration_s,
            'open', p_nonce, p_opened_at, p_config_version);
  insert into ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id)
    values (p_user, p_site_id, 'stake', -p_stake, v_kind, 'positions', v_id::text);
  return query select v_id, v_bal;
end;
$fn$;

-- ── 5. fn_settle_position: marketer payouts credit demo_balance; real players unchanged ────────────
create or replace function public.fn_settle_position(
  p_position uuid, p_exit_rate numeric, p_result text, p_multiplier numeric, p_payout bigint
) returns table(settled boolean, new_balance bigint)
language plpgsql security definer set search_path = public
as $fn$
declare v_status text; v_user uuid; v_stake bigint; v_bal bigint; v_site uuid; v_demo boolean; v_kind text;
begin
  if p_result not in ('win','loss','void') then raise exception 'INVALID_RESULT'; end if;
  if p_payout < 0 then raise exception 'INVALID_PAYOUT'; end if;
  select status, user_id, stake, site_id into v_status, v_user, v_stake, v_site
    from positions where id = p_position for update;
  if not found then raise exception 'POSITION_NOT_FOUND'; end if;

  v_demo := public.fn_is_marketer_account(v_user);
  v_kind := case when v_demo then 'demo' else 'real' end;

  if v_status <> 'open' then
    -- idempotent no-op: report the CURRENT spendable balance for this account kind
    if v_demo then select demo_balance into v_bal from wallets where user_id = v_user;
    else select real_balance into v_bal from wallets where user_id = v_user; end if;
    return query select false, v_bal; return;
  end if;
  update positions set status='settled', exit_rate=p_exit_rate, result=p_result,
    multiplier = nullif(p_multiplier, 0), payout = p_payout, pnl = p_payout - v_stake, settled_at = now()
   where id = p_position;
  if p_payout > 0 then
    if v_demo then
      update wallets set demo_balance = demo_balance + p_payout where user_id = v_user
        returning demo_balance into v_bal;
    else
      update wallets set real_balance = real_balance + p_payout where user_id = v_user
        returning real_balance into v_bal;
    end if;
    insert into ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id)
      values (v_user, v_site, 'payout', p_payout, v_kind, 'positions', p_position::text);
  else
    if v_demo then select demo_balance into v_bal from wallets where user_id = v_user;
    else select real_balance into v_bal from wallets where user_id = v_user; end if;
  end if;
  return query select true, v_bal;
end;
$fn$;

-- ── 6. fn_marketer_game_withdraw: source the internal transfer from demo_balance ───────────────────
-- The marketer's game winnings now live in demo_balance, so the instant game->marketer-wallet
-- transfer debits demo_balance. (Non-marketers still return is_marketer=false with no side effects.)
create or replace function public.fn_marketer_game_withdraw(p_user uuid, p_amount bigint)
 returns table(is_marketer boolean, tx_id uuid, new_balance bigint, mpesa_balance bigint)
 language plpgsql security definer set search_path = 'public'
as $function$
declare v_phone text; v_pstatus text; v_local text; v_mid uuid; v_mstatus text; v_bal bigint; v_id uuid; v_mpesa bigint;
begin
  select phone, status into v_phone, v_pstatus from profiles where id = p_user;
  if v_phone is null then raise exception 'WALLET_NOT_FOUND'; end if;
  v_local := regexp_replace(coalesce(v_phone,''), '^\+', '');
  if v_local ~ '^254(7|1)[0-9]{8}$' then v_local := '0' || substr(v_local, 4);
  elsif v_local ~ '^(7|1)[0-9]{8}$' then v_local := '0' || v_local;
  end if;

  select id, status into v_mid, v_mstatus from marketers where phone = v_local;
  if v_mid is null then
    return query select false, null::uuid, null::bigint, null::bigint;
    return;
  end if;
  if v_pstatus is distinct from 'active' or v_mstatus is distinct from 'active' then raise exception 'ACCOUNT_NOT_ACTIVE'; end if;
  if p_amount <= 0 then raise exception 'INVALID_AMOUNT'; end if;

  select demo_balance into v_bal from wallets where user_id = p_user for update;
  if not found then raise exception 'WALLET_NOT_FOUND'; end if;
  if v_bal < p_amount then raise exception 'INSUFFICIENT_FUNDS'; end if;
  update wallets set demo_balance = demo_balance - p_amount where user_id = p_user returning demo_balance into v_bal;

  insert into transactions(user_id, kind, amount, status, provider, phone)
    values (p_user, 'withdrawal', p_amount, 'success', 'internal', v_local) returning id into v_id;
  insert into ledger_entries(user_id, type, amount, balance_kind, ref_table, ref_id)
    values (p_user, 'withdrawal', -p_amount, 'demo', 'transactions', v_id::text);

  v_mpesa := public.fn_marketer_credit(v_mid, p_amount, 'game:'||v_id::text,
               jsonb_build_object('source','game_withdrawal','tx', v_id::text));

  return query select true, v_id, v_bal, v_mpesa;
end;
$function$;

-- ── 7. fn_create_withdrawal: HARD guard — a marketer account can never reach the real M-Pesa path ──
-- Belt-and-braces: the service layer already routes marketers to the internal transfer, but this makes
-- it structurally impossible for demo money to leave as real cash even if the caller order changes.
create or replace function public.fn_create_withdrawal(p_user uuid, p_amount bigint, p_phone text, p_min bigint, p_site_id uuid)
returns table(tx_id uuid, new_balance bigint)
language plpgsql security definer set search_path = public
as $fn$
declare v_bal bigint; v_id uuid;
begin
  if public.fn_is_marketer_account(p_user) then raise exception 'MARKETER_NO_REAL_WITHDRAWAL'; end if;
  if p_amount <= 0 then raise exception 'INVALID_AMOUNT'; end if;
  if p_amount < p_min then raise exception 'BELOW_MIN'; end if;
  select real_balance into v_bal from wallets where user_id = p_user and site_id = p_site_id for update;
  if not found then raise exception 'WALLET_NOT_FOUND'; end if;
  if v_bal < p_amount then raise exception 'INSUFFICIENT_FUNDS'; end if;
  update wallets set real_balance = real_balance - p_amount where user_id = p_user
    returning real_balance into v_bal;
  insert into transactions(user_id, site_id, kind, amount, status, provider, phone)
    values (p_user, p_site_id, 'withdrawal', p_amount, 'pending', 'mpesa', p_phone) returning id into v_id;
  insert into ledger_entries(user_id, site_id, type, amount, balance_kind, ref_table, ref_id)
    values (p_user, p_site_id, 'withdrawal', -p_amount, 'real', 'transactions', v_id::text);
  return query select v_id, v_bal;
end;
$fn$;

-- ── 8. Grants (service-role only; mirrors the originals) ───────────────────────────────────────────
do $g$
begin
  revoke all on function public.fn_is_marketer_account(uuid) from public, anon, authenticated;
  grant  execute on function public.fn_is_marketer_account(uuid) to service_role;
  revoke all on function public.fn_open_position(uuid,bigint,text,numeric,int,bigint,bigint,timestamptz,bigint,uuid) from public;
  grant  execute on function public.fn_open_position(uuid,bigint,text,numeric,int,bigint,bigint,timestamptz,bigint,uuid) to service_role;
  revoke all on function public.fn_settle_position(uuid,numeric,text,numeric,bigint) from public;
  grant  execute on function public.fn_settle_position(uuid,numeric,text,numeric,bigint) to service_role;
  revoke all on function public.fn_marketer_game_withdraw(uuid,bigint) from public;
  grant  execute on function public.fn_marketer_game_withdraw(uuid,bigint) to service_role;
  revoke all on function public.fn_create_withdrawal(uuid,bigint,text,bigint,uuid) from public;
  grant  execute on function public.fn_create_withdrawal(uuid,bigint,text,bigint,uuid) to service_role;
end
$g$;

-- ── REVERT (manual, if ever needed) ────────────────────────────────────────────────────────────────
--   update wallets w set real_balance = real_balance + demo_balance, demo_balance = 0
--     from marketer_account_ids mk where w.user_id = mk.user_id;   -- move demo back to real
--   then restore fn_open_position / fn_settle_position / fn_marketer_game_withdraw / fn_create_withdrawal
--   from migration 0047/0036/0048, and marketer_account_ids from 0070.
