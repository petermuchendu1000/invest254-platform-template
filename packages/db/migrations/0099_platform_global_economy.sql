-- 0099_platform_global_economy.sql — comprehensive platform-wide ECONOMY overrides ("global console
-- controls every client's game economy"). Extends 0092_platform_global_config (master switches +
-- maintenance banner + pool distributor) with per-field ENFORCE-able economy overrides that sit ABOVE
-- every brand's site_game_config and above per-user user_overrides (decision: global wins).
--
-- MODEL (decided with the operator):
--   * HARD ENFORCE per field: each field is { "v": <number>, "on": <boolean> }. Only fields with on=true
--     are enforced platform-wide; on=false (or absent) leaves every client on its own value.
--   * SEPARATE player vs marketer game economies (statistical / pool-OFF path): player_economy applies
--     to non-marketer statistical-path users; marketer_economy applies to marketers (always statistical,
--     pool-exempt). Enforcement happens in the engine via the shared loadOverride the open AND recovery
--     paths already consume (so open/recovery reprice identically), reusing the tested per-user
--     SettlementEngine calibration — no change to the curve / config-version / crash-recovery machinery.
--   * payments block carries platform-wide min/max DEPOSIT and min WITHDRAWAL (min deposit was a
--     HARDCODED constant before this — MIN_DEPOSIT_CENTS in packages/shared/src/payments.ts).
--
-- Defaults are empty objects ('{}') so this migration is BEHAVIOUR-NEUTRAL until the console enforces a
-- field. Additive, idempotent, platform_superadmin-gated, versioned + audited + notify (reuses the
-- existing 'platform_config_changed' channel and platform_global_config_versions history).
-- Money in integer cents (KES). Cross-field feasibility (RTP/winRate ∈ (1, maxMultiplier]) is validated
-- in TS (console live-preview + engine fail-safe fallback), since a partially-enforced block composes
-- with each brand's own base config; here we enforce per-field BOUNDS only.

-- ── columns (additive, behaviour-neutral) ─────────────────────────────────────────────────────────
alter table public.platform_global_config
  add column if not exists player_economy   jsonb not null default '{}'::jsonb,
  add column if not exists marketer_economy jsonb not null default '{}'::jsonb,
  add column if not exists payments         jsonb not null default '{}'::jsonb;

-- ── per-field bounds validator (mirrors packages/shared/src/config.ts CONFIG_BOUNDS + checkFeasible) ─
create or replace function public.fn_platform_validate_economy(p_block jsonb, p_kind text)
returns void language plpgsql immutable set search_path = public as $fn$
declare k text; f jsonb; val numeric; en boolean; is_cohort boolean;
begin
  if p_block is null then return; end if;
  if jsonb_typeof(p_block) <> 'object' then raise exception 'INVALID_ECONOMY_BLOCK:%', p_kind; end if;
  is_cohort := p_kind in ('player','marketer');
  for k, f in select key, value from jsonb_each(p_block) loop
    if jsonb_typeof(f) <> 'object' then raise exception 'INVALID_ECONOMY_FIELD:%.%', p_kind, k; end if;
    en  := coalesce((f->>'on')::boolean, false);
    if (f ? 'v') and (f->>'v') is not null and (f->>'v') <> '' then val := (f->>'v')::numeric; else val := null; end if;

    if val is null then
      -- cannot enforce a field that has no value
      if en then raise exception 'ENFORCE_WITHOUT_VALUE:%.%', p_kind, k; end if;
      continue;
    end if;

    if is_cohort then
      case k
        when 'houseEdge'        then if val < 0 or val >= 1                        then raise exception 'OUT_OF_BOUNDS:%.houseEdge', p_kind; end if;
        when 'targetWinRate'    then if val <= 0 or val > 1                        then raise exception 'OUT_OF_BOUNDS:%.targetWinRate', p_kind; end if;
        when 'maxMultiplier'    then if val <= 1                                   then raise exception 'OUT_OF_BOUNDS:%.maxMultiplier', p_kind; end if;
        when 'minStakeCents'    then if val <= 0 or val <> floor(val)              then raise exception 'OUT_OF_BOUNDS:%.minStakeCents', p_kind; end if;
        when 'maxStakeCents'    then if val <= 0 or val <> floor(val)              then raise exception 'OUT_OF_BOUNDS:%.maxStakeCents', p_kind; end if;
        when 'defaultDurationS' then if val < 1 or val > 3600 or val <> floor(val) then raise exception 'OUT_OF_BOUNDS:%.defaultDurationS', p_kind; end if;
        else raise exception 'UNKNOWN_ECONOMY_FIELD:%.%', p_kind, k;
      end case;
    else -- payments
      case k
        when 'minDepositCents'    then if val <= 0 or val <> floor(val) then raise exception 'OUT_OF_BOUNDS:payments.minDepositCents'; end if;
        when 'maxDepositCents'    then if val <= 0 or val <> floor(val) then raise exception 'OUT_OF_BOUNDS:payments.maxDepositCents'; end if;
        when 'minWithdrawalCents' then if val <= 0 or val <> floor(val) then raise exception 'OUT_OF_BOUNDS:payments.minWithdrawalCents'; end if;
        else raise exception 'UNKNOWN_ECONOMY_FIELD:payments.%', k;
      end case;
    end if;
  end loop;
end;
$fn$;

-- ── setter: master switches / banner (0092) PLUS the economy blocks (0099) ─────────────────────────
--   Economy blocks are SHALLOW-merged per field (jsonb ||) so the console can toggle one field without
--   resending the rest; send { "v":x, "on":false } to stop enforcing a field while keeping its value.
create or replace function public.fn_platform_set_global_config(p_actor uuid, p_actor_role text, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare g public.platform_global_config; v_site uuid;
        v_player jsonb; v_marketer jsonb; v_payments jsonb;
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'INVALID_PATCH'; end if;

  -- validate any economy blocks present BEFORE mutating
  if p_patch ? 'player_economy'   then perform public.fn_platform_validate_economy(p_patch->'player_economy',   'player');   end if;
  if p_patch ? 'marketer_economy' then perform public.fn_platform_validate_economy(p_patch->'marketer_economy', 'marketer'); end if;
  if p_patch ? 'payments'         then perform public.fn_platform_validate_economy(p_patch->'payments',         'payments'); end if;

  -- admin_actions.site_id is NOT NULL; anchor platform-level rows to the default (first) site.
  select id into v_site from public.sites order by created_at limit 1;

  update public.platform_global_config set
    deposits_enabled      = coalesce((p_patch->>'deposits_enabled')::boolean,      deposits_enabled),
    withdrawals_enabled   = coalesce((p_patch->>'withdrawals_enabled')::boolean,   withdrawals_enabled),
    play_enabled          = coalesce((p_patch->>'play_enabled')::boolean,          play_enabled),
    marketers_enabled     = coalesce((p_patch->>'marketers_enabled')::boolean,     marketers_enabled),
    registrations_enabled = coalesce((p_patch->>'registrations_enabled')::boolean, registrations_enabled),
    maintenance_message   = case when p_patch ? 'maintenance_message'
                                 then nullif(p_patch->>'maintenance_message','') else maintenance_message end,
    player_economy   = case when p_patch ? 'player_economy'
                            then coalesce(player_economy,'{}'::jsonb)   || (p_patch->'player_economy')   else player_economy   end,
    marketer_economy = case when p_patch ? 'marketer_economy'
                            then coalesce(marketer_economy,'{}'::jsonb) || (p_patch->'marketer_economy') else marketer_economy end,
    payments         = case when p_patch ? 'payments'
                            then coalesce(payments,'{}'::jsonb)         || (p_patch->'payments')         else payments         end,
    version    = version + 1,
    updated_by = p_actor,
    updated_at = now()
  where id returning * into g;

  insert into public.platform_global_config_versions(version, snapshot, changed_by)
    values (g.version, to_jsonb(g), p_actor);
  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'platform.global_config.set', 'platform', 'global', p_patch, v_site);
  perform pg_notify('platform_config_changed', g.version::text);
  return to_jsonb(g);
end;
$fn$;

do $g$
begin
  revoke all on function public.fn_platform_validate_economy(jsonb,text)              from public, anon, authenticated;
  revoke all on function public.fn_platform_set_global_config(uuid,text,jsonb)        from public, anon, authenticated;
  grant execute on function public.fn_platform_validate_economy(jsonb,text)            to service_role;
  grant execute on function public.fn_platform_set_global_config(uuid,text,jsonb)      to service_role;
end $g$;
