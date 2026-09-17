-- 0124_default_marketer_role_lock.sql — remove-default always works + role-demotion lock (BUGLOG #26).
--
-- Business rules (authoritative — extends 0104; see docs/09 §3, docs/24 §6.7, BUGLOG #26):
--   The 0104 guards made a brand's DEFAULT marketer (sites.owner_user_id) un-BAN/SUSPEND-able while
--   they hold that role (fn_admin_set_user_status → DEFAULT_MARKETER_LOCKED), and let a brand admin
--   assign/clear their own brand's default (fn_admin_set_site_owner). But two gaps remained and BOTH
--   are the exact live bug (1000wins→claudia, cpfmarket→marketer001, muchwins→sheila — each a brand
--   default whose role was demoted to 'player'):
--
--   GAP 1 — REMOVAL was too strict. fn_admin_set_site_owner validated `role = 'marketer'` for BOTH
--     the assign AND the clear path. So once a default's role drifted off 'marketer' (see gap 2),
--     the admin could NEVER remove them: the clear raised OWNER_NOT_MARKETER, and the admin panel
--     hid the control (role-gated). Removing a default must ALWAYS be possible, whatever the current
--     owner's role/status is — that is the whole point of "remove default marketer". Only ASSIGNING a
--     new default still requires an ACTIVE marketer. This migration splits the validation accordingly
--     and derives the cleared brand from the ownership itself (robust even if profiles.site_id drifts).
--
--   GAP 2 — DEMOTION was unguarded. fn_admin_set_user_role happily changed a brand default's role to
--     'player'/'admin', stranding the brand with a non-marketer default (no dashboard for them; money
--     still routed to them by fn_pay_referral_commissions). The ban/suspend lock existed but the role
--     lock did not. This adds the symmetric lock: a brand default cannot be moved OUT of 'marketer'
--     until it is removed/reassigned as the brand default first. Keeping/​setting 'marketer' is always
--     allowed, so promotion and re-enrollment are unaffected.
--
-- Additive & idempotent (CREATE OR REPLACE); no schema/data changes; money math unchanged (Model B).
-- The pre-existing corrupt rows are repaired by a separate, operator-confirmed data step (not here),
-- and after this migration the admin can also remove them directly from the panel.

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- (1) fn_admin_set_site_owner — assign requires an ACTIVE marketer; CLEAR works for ANY current owner.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_admin_set_site_owner(
  p_actor uuid, p_actor_role text, p_marketer uuid, p_make_default boolean
) returns public.sites
language plpgsql security definer set search_path = public
as $fn$
declare v_row public.sites; v_role text; v_status text; v_target_site uuid; v_site uuid; v_actor_site uuid;
begin
  if p_actor_role not in ('admin','superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  select role, status, site_id into v_role, v_status, v_target_site from public.profiles where id = p_marketer;
  if not found then raise exception 'OWNER_NOT_FOUND'; end if;

  if p_make_default then
    -- ── ASSIGN ── unchanged semantics: the target must be an ACTIVE marketer on their own brand,
    --    and a site-scoped admin may only act on their own brand.
    if v_role <> 'marketer' then raise exception 'OWNER_NOT_MARKETER'; end if;
    v_site := v_target_site;
    if not exists (select 1 from public.sites where id = v_site) then raise exception 'SITE_NOT_FOUND'; end if;
    if p_actor_role in ('admin','superadmin') then
      select site_id into v_actor_site from public.profiles where id = p_actor;
      if v_actor_site is distinct from v_site then raise exception 'SITE_SCOPE_FORBIDDEN'; end if;
    end if;
    if v_status <> 'active' then raise exception 'OWNER_NOT_ACTIVE'; end if;
    update public.sites set owner_user_id = p_marketer, updated_at = now() where id = v_site returning * into v_row;
  else
    -- ── CLEAR ── remove this user as the default of whatever brand they currently own, regardless of
    --    their CURRENT role/status (a demoted/suspended/deleted ex-marketer must still be removable).
    --    The cleared brand is derived from the ownership row itself, not the (possibly-drifted) profile.
    select id into v_site from public.sites where owner_user_id = p_marketer;
    if not found then
      -- Idempotent no-op: they are not a default anywhere. Scope-check against their own brand and
      -- return that brand's current (unchanged) row so the caller still gets a sites row back.
      v_site := v_target_site;
      if p_actor_role in ('admin','superadmin') then
        select site_id into v_actor_site from public.profiles where id = p_actor;
        if v_actor_site is distinct from v_site then raise exception 'SITE_SCOPE_FORBIDDEN'; end if;
      end if;
      select * into v_row from public.sites where id = v_site;
    else
      if p_actor_role in ('admin','superadmin') then
        select site_id into v_actor_site from public.profiles where id = p_actor;
        if v_actor_site is distinct from v_site then raise exception 'SITE_SCOPE_FORBIDDEN'; end if;
      end if;
      update public.sites set owner_user_id = null, updated_at = now() where id = v_site returning * into v_row;
    end if;
  end if;

  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'admin.set_site_owner', 'site', v_site::text,
            jsonb_build_object('owner_user_id', case when p_make_default then p_marketer else null end,
                               'marketer', p_marketer, 'make_default', p_make_default), v_site);
  return v_row;
end;
$fn$;

revoke all on function public.fn_admin_set_site_owner(uuid,text,uuid,boolean) from public, anon, authenticated;
grant execute on function public.fn_admin_set_site_owner(uuid,text,uuid,boolean) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- (2) fn_admin_set_user_role — a brand DEFAULT marketer cannot be demoted out of 'marketer' until
--     removed/reassigned as the brand default first (symmetric to the ban/suspend lock, 0104).
--     Full body preserved verbatim from 0080 + the one new guard; auto-enroll on promotion unchanged.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_admin_set_user_role(p_actor uuid, p_actor_role text, p_target uuid, p_role text)
returns table(user_id uuid, role text)
language plpgsql security definer set search_path = public
as $function$
declare v_old text;
begin
  if p_actor_role not in ('admin','superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if p_role not in ('player','marketer','admin','superadmin') then raise exception 'INVALID_ROLE'; end if;
  if p_role = 'superadmin' then raise exception 'SUPERADMIN_PROTECTED'; end if;
  if p_actor = p_target then raise exception 'NO_SELF_ACTION'; end if;
  select pr.role into v_old from public.profiles pr where pr.id = p_target for update;
  if not found then raise exception 'USER_NOT_FOUND'; end if;
  if v_old in ('superadmin','platform_superadmin') then raise exception 'SUPERADMIN_PROTECTED'; end if;
  -- A plain admin is confined to the player<->marketer transition (cannot mint admins or touch them).
  if p_actor_role = 'admin' and (p_role not in ('player','marketer') or v_old not in ('player','marketer')) then
    raise exception 'NOT_AUTHORIZED';
  end if;
  -- A brand's DEFAULT marketer cannot be moved OUT of 'marketer' while they still hold that brand
  -- (sites.owner_user_id) — it would strand the brand with a non-marketer default (unmanageable in the
  -- admin panel, dashboard hidden, yet still earning). Remove/reassign the brand default first, then
  -- change the role. Keeping/setting 'marketer' is always allowed. Mirrors fn_admin_set_user_status (0104).
  if p_role <> 'marketer' and exists (select 1 from public.sites s where s.owner_user_id = p_target) then
    raise exception 'DEFAULT_MARKETER_LOCKED';
  end if;

  update public.profiles pr set role = p_role where pr.id = p_target;

  if p_role = 'marketer' then
    perform * from public.fn_affiliate_enroll(p_target);
  end if;

  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'user.set_role', 'user', p_target::text,
            jsonb_build_object('old', v_old, 'new', p_role));
  return query select p_target, p_role;
end;
$function$;
