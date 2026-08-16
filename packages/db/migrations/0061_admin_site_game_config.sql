-- 0061_admin_site_game_config.sql — FIX: operator "Game configuration" panel must write the
-- table the ENGINE actually reads.
--
-- ROOT CAUSE (control-plane / data-plane split): the per-brand operator console
-- (GET/PATCH /admin/game-config) wrote the LEGACY singleton `game_config` via
-- fn_admin_update_game_config, but the multiplexed engine prices every brand from
-- `site_game_config` (see apps/engine/src/server.ts -> SiteGameConfigStore). So lowering the
-- win rate / edge / cap in the panel had ZERO effect on the live game — the knob was
-- disconnected. This adds the SITE-AWARE admin config RPC the fixed repo layer calls, so an
-- operator's edit lands on `site_game_config` and the 0046 trigger (version bump + history +
-- pg_notify('site_game_config_changed', site_id)) makes the engine re-price the NEXT round.
--
-- Also adds a defensive per-user override cap guard: a user's max_win_multiplier can never
-- exceed the brand's advertised max_multiplier (clamped, never raised). This neutralises the
-- catastrophic "cap 100" rig class without breaking the legitimate per-VIP raise-within-cap flow.
--
-- Additive + idempotent (CREATE OR REPLACE, DROP TRIGGER IF EXISTS). No behaviour change to any
-- existing RPC; the legacy fn_admin_update_game_config is left intact for backward compatibility.

-- ── fn_admin_set_site_game_config: per-brand economy edit written to site_game_config ──────────
-- Accepts admin/superadmin/platform_superadmin (the API route still gates the edit at superadmin;
-- platform_superadmin is the cross-brand owner). Patch keys are the SAME camelCase keys the API's
-- GameConfigPatch already sends (houseEdge/maxMultiplier/minStakeCents/maxStakeCents/
-- minWithdrawalCents/defaultDurationS/tickRateMs/driftBias/volatility/targetWinRate), so the engine
-- repo passes the patch JSON verbatim — exactly as it did for the legacy singleton RPC.
--
-- Feasibility (RTP/targetWinRate ∈ (1, maxMultiplier], ranges) is enforced by the site_game_config
-- CHECK constraint (migration 0046); a violation surfaces as INVALID_CONFIG. The 0046 BEFORE trigger
-- bumps `version`, snapshots into site_game_config_versions, and fires the change NOTIFY, so we do
-- NOT set the version here. Every edit writes a before/after admin_actions row carrying the site_id.
create or replace function public.fn_admin_set_site_game_config(
  p_actor uuid, p_actor_role text, p_site_id uuid, p_patch jsonb
) returns public.site_game_config
language plpgsql security definer set search_path = public
as $fn$
declare v_row public.site_game_config; v_before jsonb;
begin
  if p_actor_role not in ('admin','superadmin','platform_superadmin') then raise exception 'NOT_AUTHORIZED'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'INVALID_CONFIG'; end if;
  select to_jsonb(c) into v_before from public.site_game_config c where c.site_id = p_site_id;
  if v_before is null then raise exception 'SITE_NOT_FOUND'; end if;

  begin
    update public.site_game_config u set
      house_edge         = coalesce((p_patch->>'houseEdge')::numeric,          u.house_edge),
      max_multiplier     = coalesce((p_patch->>'maxMultiplier')::numeric,      u.max_multiplier),
      min_stake          = coalesce((p_patch->>'minStakeCents')::bigint,       u.min_stake),
      max_stake          = coalesce((p_patch->>'maxStakeCents')::bigint,       u.max_stake),
      min_withdrawal     = coalesce((p_patch->>'minWithdrawalCents')::bigint,  u.min_withdrawal),
      default_duration_s = coalesce((p_patch->>'defaultDurationS')::int,       u.default_duration_s),
      tick_rate_ms       = coalesce((p_patch->>'tickRateMs')::int,             u.tick_rate_ms),
      drift_bias         = coalesce((p_patch->>'driftBias')::numeric,          u.drift_bias),
      volatility         = coalesce((p_patch->>'volatility')::numeric,         u.volatility),
      target_win_rate    = coalesce((p_patch->>'targetWinRate')::numeric,      u.target_win_rate),
      updated_by         = p_actor
    where u.site_id = p_site_id
    returning * into v_row;
  exception
    when check_violation then raise exception 'INVALID_CONFIG';
    when invalid_text_representation or numeric_value_out_of_range or division_by_zero then raise exception 'INVALID_CONFIG';
  end;

  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'game.config', 'site_game_config', p_site_id::text,
            jsonb_build_object('patch', p_patch, 'before', v_before, 'after', to_jsonb(v_row)), p_site_id);
  return v_row;
end;
$fn$;

-- ── Per-user override cap guard: a user's payout cap can NEVER exceed the brand's cap ──────────
-- Silent clamp (reduce-only): raising a VIP's cap within the brand max stays allowed; a rig above
-- the advertised maximum (e.g. the observed max_win_multiplier = 100 on a 5x brand) is impossible.
create or replace function public.fn_user_override_cap_guard() returns trigger
language plpgsql security definer set search_path = public
as $fn$
declare v_site_max numeric;
begin
  if new.max_win_multiplier is not null then
    select max_multiplier into v_site_max from public.site_game_config where site_id = new.site_id;
    if v_site_max is not null and new.max_win_multiplier > v_site_max then
      new.max_win_multiplier := v_site_max;   -- clamp to the brand cap; never raise above it
    end if;
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_user_override_cap on public.user_overrides;
create trigger trg_user_override_cap
  before insert or update on public.user_overrides
  for each row execute function public.fn_user_override_cap_guard();

-- ── Grants: service-role only (the engine/API hold the service-role connection) ───────────────
do $g$
begin
  revoke all on function public.fn_admin_set_site_game_config(uuid,text,uuid,jsonb) from public, anon, authenticated;
  grant execute on function public.fn_admin_set_site_game_config(uuid,text,uuid,jsonb) to service_role;
end
$g$;
