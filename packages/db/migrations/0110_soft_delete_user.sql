-- 0110_soft_delete_user.sql — soft-delete for users/admins (status='deleted') + a guarded RPC.
--
-- Real users/admins are referenced by transactions, ledgers, positions, referrals, commissions and
-- the audit log (mostly NO ACTION FKs), so a HARD delete is impossible without destroying the
-- financial audit trail. "Delete" is therefore a SOFT delete: status='deleted', force-logout (bump
-- sessions_valid_after), hidden from admin lists, and login-blocked (see AuthService). Money RPCs
-- already require status='active', so a deleted account can't move money even if a check is missed.
--
-- Idempotent + safe to re-apply.

-- 1) Allow the new terminal status.
alter table public.profiles drop constraint if exists profiles_status_check;
alter table public.profiles add  constraint profiles_status_check
  check (status = any (array['active','suspended','banned','deleted']));

-- 2) Guarded soft-delete RPC (mirrors fn_admin_set_user_status's guards + adds last-superadmin safety).
create or replace function public.fn_admin_delete_user(p_actor uuid, p_actor_role text, p_target uuid)
returns table(user_id uuid, status text)
language plpgsql security definer set search_path = public
as $function$
declare v_old text; v_target_role text;
begin
  if p_actor_role not in ('admin','superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if p_actor = p_target then raise exception 'NO_SELF_ACTION'; end if;
  select pr.status, pr.role into v_old, v_target_role from profiles pr where pr.id = p_target for update;
  if not found then raise exception 'USER_NOT_FOUND'; end if;

  -- Idempotent: already deleted -> report and stop (no re-audit, no error).
  if v_old = 'deleted' then return query select p_target, 'deleted'::text; return; end if;

  -- Platform superadmins are never deletable here; a plain admin may not delete another admin.
  if v_target_role in ('superadmin','platform_superadmin') then raise exception 'SUPERADMIN_PROTECTED'; end if;
  if v_target_role = 'admin' and p_actor_role not in ('superadmin','platform_superadmin') then
    raise exception 'INSUFFICIENT_PRIVILEGE';
  end if;
  -- A brand's default marketer must be reassigned before deletion (mirrors the status RPC).
  if exists (select 1 from public.sites s where s.owner_user_id = p_target) then
    raise exception 'DEFAULT_MARKETER_LOCKED';
  end if;

  update profiles pr
     set status = 'deleted', sessions_valid_after = now()   -- force-logout every existing session
   where pr.id = p_target;

  insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'user.delete', 'user', p_target::text,
            jsonb_build_object('from', v_old, 'to', 'deleted'));

  return query select p_target, 'deleted'::text;
end;
$function$;
