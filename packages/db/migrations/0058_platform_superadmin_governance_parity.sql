-- 0058_platform_superadmin_governance_parity.sql — bring the pre-platform governance RPCs in line
-- with the platform_superadmin role (docs/22 Task H follow-on to 0052).
--
-- CONTEXT: 0052 introduced platform_superadmin (ROLE_RANK 5, superset of superadmin) and wired it
-- into the NEW platform RPCs (create/update site, economy, KPIs, overrides). But the OLDER admin
-- governance RPCs (0025/0026/0042/…) still hardcoded the pre-platform role set, so once the sole
-- owner was migrated superadmin -> platform_superadmin:
--   (1) fn_admin_set_user_role admitted ONLY 'superadmin' as actor -> role management became
--       impossible for everyone (no superadmin exists);
--   (2) status/balance RPCs admitted actors in ('admin','superadmin') only -> the platform owner
--       could not suspend users or adjust balances;
--   (3) the SUPERADMIN_PROTECTED target guard only shielded role='superadmin', so the platform
--       owner's own account was demotable/bannable/withdrawable — and some balance RPCs had lost
--       the guard entirely in a later redefinition.
--
-- This migration CREATE OR REPLACEs each affected RPC (bodies copied verbatim from the live DB,
-- only the guards changed) to:
--   • ADMIT platform_superadmin everywhere superadmin/admin were valid actors (it outranks both);
--   • PROTECT platform_superadmin targets exactly like superadmin (no demote / ban / balance-touch),
--     restoring the guard on the balance RPCs that had dropped it.
-- Creating a NEW superadmin/platform_superadmin via fn_admin_set_user_role is still blocked on
-- purpose (owner provisioning stays an out-of-band DB/script operation — see scripts/make_operator).
-- Idempotent (CREATE OR REPLACE); grants are preserved. No schema/table changes.

-- ── fn_admin_set_user_role ──
CREATE OR REPLACE FUNCTION public.fn_admin_set_user_role(p_actor uuid, p_actor_role text, p_target uuid, p_role text)
 RETURNS TABLE(user_id uuid, role text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ declare v_old text; begin if p_actor_role not in ('superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if; if p_role not in ('player','marketer','admin','superadmin') then raise exception 'INVALID_ROLE'; end if; if p_role = 'superadmin' then raise exception 'SUPERADMIN_PROTECTED'; end if; if p_actor = p_target then raise exception 'NO_SELF_ACTION'; end if; select pr.role into v_old from public.profiles pr where pr.id = p_target for update; if not found then raise exception 'USER_NOT_FOUND'; end if; if v_old in ('superadmin','platform_superadmin') then raise exception 'SUPERADMIN_PROTECTED'; end if; update public.profiles pr set role = p_role where pr.id = p_target; insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail) values (p_actor, p_actor_role, 'user.role', 'user', p_target::text, jsonb_build_object('from', v_old, 'to', p_role)); return query select p_target, p_role; end; $function$
;

-- ── fn_admin_set_user_status ──
CREATE OR REPLACE FUNCTION public.fn_admin_set_user_status(p_actor uuid, p_actor_role text, p_target uuid, p_status text, p_reason text)
 RETURNS TABLE(user_id uuid, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ declare v_old text; v_target_role text; begin if p_actor_role not in ('admin', 'superadmin', 'platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if; if p_status not in ('active', 'suspended', 'banned') then raise exception 'INVALID_STATUS'; end if; if p_actor = p_target then raise exception 'NO_SELF_ACTION'; end if; select pr.status, pr.role into v_old, v_target_role from profiles pr where pr.id = p_target for update; if not found then raise exception 'USER_NOT_FOUND'; end if; if v_target_role in ('superadmin','platform_superadmin') then raise exception 'SUPERADMIN_PROTECTED'; end if; if v_target_role in ('admin', 'superadmin', 'platform_superadmin') and p_actor_role not in ('superadmin','platform_superadmin') then raise exception 'INSUFFICIENT_PRIVILEGE'; end if; update profiles pr set status = p_status where pr.id = p_target; insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail) values (p_actor, p_actor_role, 'user.status', 'user', p_target::text, jsonb_build_object('from', v_old, 'to', p_status, 'reason', p_reason)); return query select p_target, p_status; end; $function$
;

-- ── fn_admin_adjust_balance ──
CREATE OR REPLACE FUNCTION public.fn_admin_adjust_balance(p_actor uuid, p_actor_role text, p_target uuid, p_amount bigint, p_reason text)
 RETURNS TABLE(user_id uuid, amount bigint, new_balance bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_bal bigint; v_new bigint; v_action bigint;
begin
  if p_actor_role not in ('admin', 'superadmin', 'platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if p_amount = 0 then raise exception 'INVALID_AMOUNT'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'REASON_REQUIRED'; end if;
  if (select role from profiles where id = p_target) in ('superadmin','platform_superadmin') then raise exception 'SUPERADMIN_PROTECTED'; end if;
  -- atomic: lock the wallet, verify the debit does not overdraw, mutate, audit + ledger in one txn.
  -- Qualify wallets.user_id: the RETURNS TABLE out-column `user_id` would otherwise
  -- collide with the column, raising "column reference \"user_id\" is ambiguous".
  select w.real_balance into v_bal from wallets w where w.user_id = p_target for update;
  if not found then raise exception 'WALLET_NOT_FOUND'; end if;
  if v_bal + p_amount < 0 then raise exception 'INSUFFICIENT_FUNDS'; end if;
  update wallets set real_balance = wallets.real_balance + p_amount where wallets.user_id = p_target
    returning wallets.real_balance into v_new;
  insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'balance.adjust', 'user', p_target::text,
            jsonb_build_object('amount', p_amount, 'reason', p_reason, 'before', v_bal, 'after', v_new))
    returning id into v_action;
  insert into ledger_entries(user_id, type, amount, balance_kind, ref_table, ref_id, meta)
    values (p_target, 'adjustment', p_amount, 'real', 'admin_actions', v_action::text,
            jsonb_build_object('reason', p_reason, 'actor', p_actor));
  return query select p_target, p_amount, v_new;
end;
$function$
;

-- ── fn_admin_reset_balance_to_last_funded ──
CREATE OR REPLACE FUNCTION public.fn_admin_reset_balance_to_last_funded(p_actor uuid, p_actor_role text, p_target uuid, p_reason text)
 RETURNS TABLE(user_id uuid, last_funded bigint, previous_balance bigint, new_balance bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_bal bigint; v_last bigint; v_delta bigint; v_role text; v_action bigint;
begin
  if p_actor_role not in ('admin','superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'REASON_REQUIRED'; end if;

  select role into v_role from profiles where id = p_target;
  if not found then raise exception 'USER_NOT_FOUND'; end if;
  if v_role in ('superadmin','platform_superadmin') then raise exception 'SUPERADMIN_PROTECTED'; end if;

  -- Original last funded amount = the most recent SUCCESSFUL deposit.
  -- Alias the table: the RETURNS TABLE out-column `user_id` would otherwise make `user_id` ambiguous.
  select tx.amount into v_last from transactions tx
    where tx.user_id = p_target and tx.kind = 'deposit' and tx.status = 'success'
    order by tx.created_at desc, tx.id desc limit 1;
  if v_last is null then raise exception 'NO_FUNDING'; end if;

  -- Lock the wallet, set real_balance to the last funded amount, reconcile via a ledger entry.
  select w.real_balance into v_bal from wallets w where w.user_id = p_target for update;
  if not found then raise exception 'WALLET_NOT_FOUND'; end if;
  v_delta := v_last - v_bal;
  update wallets set real_balance = v_last where wallets.user_id = p_target;

  insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'balance.reset_last_funded', 'user', p_target::text,
            jsonb_build_object('reason', p_reason, 'before', v_bal, 'after', v_last,
                               'lastFunded', v_last, 'delta', v_delta))
    returning id into v_action;

  if v_delta <> 0 then
    insert into ledger_entries(user_id, type, amount, balance_kind, ref_table, ref_id, meta)
      values (p_target, 'adjustment', v_delta, 'real', 'admin_actions', v_action::text,
              jsonb_build_object('kind', 'reset_last_funded', 'reason', p_reason, 'actor', p_actor, 'lastFunded', v_last));
  end if;

  return query select p_target, v_last, v_bal, v_last;
end;
$function$
;

-- ── fn_admin_adjust_balance_kind ──
CREATE OR REPLACE FUNCTION public.fn_admin_adjust_balance_kind(p_actor uuid, p_actor_role text, p_target uuid, p_amount bigint, p_kind text, p_reason text)
 RETURNS TABLE(user_id uuid, kind text, amount bigint, new_balance bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_bal bigint; v_new bigint; v_action bigint;
begin
  if p_actor_role not in ('admin','superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if p_amount = 0 then raise exception 'INVALID_AMOUNT'; end if;
  if p_kind not in ('real','bonus') then raise exception 'INVALID_KIND'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'REASON_REQUIRED'; end if;
  if (select role from profiles where id = p_target) in ('superadmin','platform_superadmin') then raise exception 'SUPERADMIN_PROTECTED'; end if;

  if p_kind = 'real' then
    select w.real_balance into v_bal from wallets w where w.user_id = p_target for update;
    if not found then raise exception 'WALLET_NOT_FOUND'; end if;
    if v_bal + p_amount < 0 then raise exception 'INSUFFICIENT_FUNDS'; end if;
    update wallets set real_balance = wallets.real_balance + p_amount where wallets.user_id = p_target
      returning wallets.real_balance into v_new;
  else
    select w.bonus_balance into v_bal from wallets w where w.user_id = p_target for update;
    if not found then raise exception 'WALLET_NOT_FOUND'; end if;
    if v_bal + p_amount < 0 then raise exception 'INSUFFICIENT_FUNDS'; end if;
    update wallets set bonus_balance = wallets.bonus_balance + p_amount where wallets.user_id = p_target
      returning wallets.bonus_balance into v_new;
  end if;

  insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'balance.adjust', 'user', p_target::text,
            jsonb_build_object('kind', p_kind, 'amount', p_amount, 'reason', p_reason, 'before', v_bal, 'after', v_new))
    returning id into v_action;
  insert into ledger_entries(user_id, type, amount, balance_kind, ref_table, ref_id, meta)
    values (p_target, 'adjustment', p_amount, p_kind, 'admin_actions', v_action::text,
            jsonb_build_object('reason', p_reason, 'actor', p_actor));
  return query select p_target, p_kind, p_amount, v_new;
end;
$function$
;

-- ── fn_admin_clear_balance ──
CREATE OR REPLACE FUNCTION public.fn_admin_clear_balance(p_actor uuid, p_actor_role text, p_target uuid, p_kind text, p_reason text)
 RETURNS TABLE(user_id uuid, real_balance bigint, bonus_balance bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_real bigint; v_bonus bigint; v_action bigint;
begin
  if p_actor_role not in ('admin','superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if p_kind not in ('real','bonus','both') then raise exception 'INVALID_KIND'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'REASON_REQUIRED'; end if;
  if (select role from profiles where id = p_target) in ('superadmin','platform_superadmin') then raise exception 'SUPERADMIN_PROTECTED'; end if;

  select w.real_balance, w.bonus_balance into v_real, v_bonus from wallets w where w.user_id = p_target for update;
  if not found then raise exception 'WALLET_NOT_FOUND'; end if;

  insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'balance.clear', 'user', p_target::text,
            jsonb_build_object('kind', p_kind, 'reason', p_reason, 'before_real', v_real, 'before_bonus', v_bonus))
    returning id into v_action;

  if p_kind in ('real','both') and v_real <> 0 then
    update wallets set real_balance = 0 where wallets.user_id = p_target;
    insert into ledger_entries(user_id, type, amount, balance_kind, ref_table, ref_id, meta)
      values (p_target, 'adjustment', -v_real, 'real', 'admin_actions', v_action::text,
              jsonb_build_object('reason', p_reason, 'actor', p_actor, 'clear', true));
  end if;
  if p_kind in ('bonus','both') and v_bonus <> 0 then
    update wallets set bonus_balance = 0 where wallets.user_id = p_target;
    insert into ledger_entries(user_id, type, amount, balance_kind, ref_table, ref_id, meta)
      values (p_target, 'adjustment', -v_bonus, 'bonus', 'admin_actions', v_action::text,
              jsonb_build_object('reason', p_reason, 'actor', p_actor, 'clear', true));
  end if;

  select w.real_balance, w.bonus_balance into v_real, v_bonus from wallets w where w.user_id = p_target;
  return query select p_target, v_real, v_bonus;
end;
$function$
;

-- ── fn_admin_set_commission_rate ──
CREATE OR REPLACE FUNCTION public.fn_admin_set_commission_rate(p_actor uuid, p_actor_role text, p_target uuid, p_rate numeric)
 RETURNS TABLE(user_id uuid, commission_rate numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_old numeric;
begin
  if p_actor_role not in ('admin', 'superadmin', 'platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if p_rate < 0 or p_rate > 1 then raise exception 'INVALID_RATE'; end if;
  select a.commission_rate into v_old from affiliates a where a.user_id = p_target for update;
  if not found then raise exception 'NOT_AFFILIATE'; end if;
  update affiliates a set commission_rate = p_rate where a.user_id = p_target;
  insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'affiliate.rate', 'affiliate', p_target::text,
            jsonb_build_object('from', v_old, 'to', p_rate));
  return query select p_target, p_rate;
end;
$function$
;
