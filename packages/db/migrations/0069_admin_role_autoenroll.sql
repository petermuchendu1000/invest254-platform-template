-- 0069_admin_role_autoenroll.sql — keep the two marketer write-paths consistent.
--
-- Root cause of the "Couldn't load your dashboard" bug: there are two ways to become a marketer,
-- but only ONE of them created the required `affiliates` row.
--   * fn_affiliate_enroll (0017/0047): mints the referral code AND inserts the affiliates row.
--   * fn_admin_set_user_role (0025/0026/0058): only flips profiles.role.
-- An admin-promoted marketer therefore had role='marketer' but no affiliates row, so
-- /affiliate/summary raised NOT_AFFILIATE (404) and the dashboard dead-ended.
--
-- Fix at the un-bypassable chokepoint: when this RPC sets a user's role to 'marketer', it now also
-- runs the idempotent, site-aware enroll so the affiliates row always exists. This is the exact
-- same guarantee the self-service enroll gives — both paths now converge. Demotion never removes the
-- affiliates row (referrals/commissions reference it), matching enroll's non-destructive semantics.
--
-- Rebased on the 0058 body (superadmin OR platform_superadmin actors; privileged targets protected;
-- promotion to superadmin blocked). SECURITY DEFINER + idempotent; safe to re-run.

create or replace function public.fn_admin_set_user_role(p_actor uuid, p_actor_role text, p_target uuid, p_role text)
 returns table(user_id uuid, role text)
 language plpgsql security definer set search_path to 'public'
as $fn$
declare v_old text;
begin
  if p_actor_role not in ('superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if p_role not in ('player','marketer','admin','superadmin') then raise exception 'INVALID_ROLE'; end if;
  if p_role = 'superadmin' then raise exception 'SUPERADMIN_PROTECTED'; end if;
  if p_actor = p_target then raise exception 'NO_SELF_ACTION'; end if;
  select pr.role into v_old from public.profiles pr where pr.id = p_target for update;
  if not found then raise exception 'USER_NOT_FOUND'; end if;
  if v_old in ('superadmin','platform_superadmin') then raise exception 'SUPERADMIN_PROTECTED'; end if;

  update public.profiles pr set role = p_role where pr.id = p_target;

  -- Consistency: a marketer must always have an affiliates row. Idempotent + site-aware; a repeat
  -- call (already enrolled) is a no-op. Runs in the same transaction so role + affiliate row commit
  -- together (or roll back together), which is exactly the invariant we want.
  if p_role = 'marketer' then
    perform * from public.fn_affiliate_enroll(p_target);
  end if;

  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'user.role', 'user', p_target::text,
            jsonb_build_object('from', v_old, 'to', p_role));
  return query select p_target, p_role;
end;
$fn$;

revoke all on function public.fn_admin_set_user_role(uuid,text,uuid,text) from public;
grant execute on function public.fn_admin_set_user_role(uuid,text,uuid,text) to service_role;
