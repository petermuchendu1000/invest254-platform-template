-- 0177_welcome_bonus_amount.sql — the welcome bonus AMOUNT and WAGERING become a per-brand setting,
-- entered in the brand's OWN display currency. Nothing about the bonus is hard-wired any more.
--
-- WHAT EXISTS TODAY (verified against production, 2026-09-29):
--   The ONLY welcome-bonus amount is the global singleton `bonus_config.welcome_amount_cents`
--   (= 20000 => KES 200) and `bonus_config.welcome_wagering_x` (= 3.0). Those two numbers are shared
--   by EVERY platform and EVERY brand, and the only surface that could change them was a manual UPDATE
--   on the singleton (there is no admin input for it — 0173 added on/off switches only). For the one
--   live non-KES brand (USD), a KES-cents figure shows as an odd converted amount (KES 200 ≈ $1.54)
--   and cannot express an operator intent like "a $5 welcome bonus".
--
-- WHAT THIS ADDS — a PER-BRAND welcome bonus amount + wagering, in the brand's DISPLAY currency,
-- mirroring the currency-native pattern already proven for the minimum withdrawal (0120) and stake
-- limits (STAKE-1 / 0170):
--   * `sites.welcome_bonus_native`  — the operator's intent in the brand's display-currency MAJOR units
--     (5 => $5 for a USD brand, 200 => KES 200 for a KES brand). This is what the console shows/edits.
--   * `sites.welcome_bonus_cents`   — the SAME amount resolved to authoritative KES cents (the money of
--     record) at the brand's live FX rate WHEN IT WAS SET. The grant reads this, so the registration
--     hot path stays FX-free inside the database (FX lives only at the admin edge, as everywhere else).
--   * `sites.welcome_bonus_wagering_x` — a per-brand wagering multiple.
--   All three are NULLABLE. NULL => fall back to the global `bonus_config` default, so this migration is
--   BEHAVIOUR-NEUTRAL until an operator sets a brand's amount: every brand keeps granting KES 200 @ 3x.
--
-- Additive + idempotent. Money-neutral: no balance, bonus row or ledger row is touched here.
begin;

-- ── 1. Per-brand amount + wagering (all nullable => use the global default) ──────────────────────
alter table public.sites
  add column if not exists welcome_bonus_native     numeric check (welcome_bonus_native     is null or welcome_bonus_native     >= 0),
  add column if not exists welcome_bonus_cents       bigint  check (welcome_bonus_cents       is null or welcome_bonus_cents       >= 0),
  add column if not exists welcome_bonus_wagering_x  numeric check (welcome_bonus_wagering_x  is null or welcome_bonus_wagering_x  >= 0);

comment on column public.sites.welcome_bonus_native is
  'Per-brand welcome bonus in the brand DISPLAY currency major units (operator intent; e.g. 5 => $5). '
  'NULL => fall back to bonus_config.welcome_amount_cents. Set via fn_admin_set_welcome_bonus.';
comment on column public.sites.welcome_bonus_cents is
  'The welcome_bonus_native amount resolved to authoritative KES cents at the brand live FX rate when '
  'it was set (money of record; the grant reads this). NULL => fall back to bonus_config.welcome_amount_cents.';
comment on column public.sites.welcome_bonus_wagering_x is
  'Per-brand wagering multiple for the welcome bonus. NULL => fall back to bonus_config.welcome_wagering_x.';

-- ── 2. The grant honours the per-brand amount + wagering (fallback: the global default) ───────────
-- Byte-for-byte the live 0173 body, with ONE change: after the wallet lock resolves the brand, the
-- amount and wagering are taken from the brand override when set, else the global default. The `<= 0`
-- guard is moved AFTER that resolution so a brand override can never be pre-empted by a zero global.
-- With no brand override anywhere, the outcome is identical to today for every account.
create or replace function public.fn_grant_welcome_bonus(p_user uuid)
returns bigint
language plpgsql security definer set search_path = public
as $fn$
declare v_amount bigint; v_wx numeric; v_site uuid; v_bonus_id uuid;
begin
  select welcome_amount_cents, welcome_wagering_x
    into v_amount, v_wx
    from bonus_config where id = 1;
  if not found then
    return 0;
  end if;

  -- Demo/marketer (social-proof) accounts never receive a real welcome bonus.
  if public.fn_is_marketer_account(p_user) then
    return 0;
  end if;

  -- Lock the wallet row for the duration; also resolves the account's brand for scoping + amount.
  select site_id into v_site from wallets where user_id = p_user for update;
  if not found then
    return 0;   -- no wallet (should never happen post-registration) → nothing to credit
  end if;

  -- Per-brand override (0177): the amount + wagering entered in the console for THIS brand, in KES
  -- cents (resolved from the brand-currency figure at set-time). NULL => the global default above.
  select coalesce(s.welcome_bonus_cents, v_amount),
         coalesce(s.welcome_bonus_wagering_x, v_wx)
    into v_amount, v_wx
    from sites s where s.id = v_site;

  -- Nothing to grant when the effective amount is zero (brand set it to 0, or the global is 0).
  if coalesce(v_amount, 0) <= 0 then
    return 0;
  end if;

  -- Switched off by the system owner, by this brand's platform, or by the brand itself (0173).
  if not public.fn_bonuses_enabled(v_site) then
    return 0;
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

-- ── 3. Admin breakdown extended: the per-brand override, the effective amount, and the default ────
-- Adds, to the 0173 shape, the brand override (native + wagering), the brand's display currency, and
-- the global default, so the console can prefill the input in the brand's currency and show whether a
-- brand is on its own amount or inheriting the default. `amount_cents`/`wagering_x` are now EFFECTIVE
-- (brand override else default) — the same values the grant would use — not the raw singleton.
create or replace function public.fn_bonus_switches(p_site uuid)
returns jsonb language sql stable security definer set search_path = public as $fn$
  select jsonb_build_object(
    'site_id',              p_site,
    'platform_id',          (select s.platform_id from public.sites s where s.id = p_site),
    'system',               coalesce((select c.welcome_enabled from public.bonus_config c where c.id = 1), false),
    'platform',             coalesce((select pl.bonuses_enabled from public.sites s
                                        join public.platforms pl on pl.id = s.platform_id
                                       where s.id = p_site), true),
    'brand',                coalesce((select s.bonuses_enabled from public.sites s where s.id = p_site), true),
    'effective',            public.fn_bonuses_enabled(p_site),
    'currency',             coalesce((select s.currency from public.sites s where s.id = p_site), 'KES'),
    -- EFFECTIVE amount + wagering the grant would use (brand override else global default):
    'amount_cents',         coalesce((select s.welcome_bonus_cents      from public.sites s where s.id = p_site),
                                     (select c.welcome_amount_cents     from public.bonus_config c where c.id = 1)),
    'wagering_x',           coalesce((select s.welcome_bonus_wagering_x from public.sites s where s.id = p_site),
                                     (select c.welcome_wagering_x       from public.bonus_config c where c.id = 1)),
    -- The per-brand override itself (NULL => inheriting the default):
    'amount_native',        (select s.welcome_bonus_native     from public.sites s where s.id = p_site),
    'amount_cents_override',(select s.welcome_bonus_cents       from public.sites s where s.id = p_site),
    'wagering_x_override',  (select s.welcome_bonus_wagering_x  from public.sites s where s.id = p_site),
    -- The global default (for the console to show as the inherited/placeholder value):
    'default_amount_cents', (select c.welcome_amount_cents from public.bonus_config c where c.id = 1),
    'default_wagering_x',   (select c.welcome_wagering_x   from public.bonus_config c where c.id = 1));
$fn$;

-- ── 4. Per-brand amount setter (audited) — mirrors fn_admin_set_bonuses_enabled (0173) ───────────
-- The API resolves the brand-currency figure to KES cents at the live FX rate and passes BOTH (native
-- for redisplay, cents as the money of record). Any argument NULL clears that override back to the
-- global default. SECURITY DEFINER so it works regardless of the API's DB role.
create or replace function public.fn_admin_set_welcome_bonus(
  p_actor uuid, p_actor_role text, p_site uuid,
  p_native numeric, p_cents bigint, p_wagering numeric)
returns jsonb
language plpgsql security definer set search_path = public
as $fn$
begin
  if p_actor_role not in ('admin','platform_admin','platform_superadmin') then
    raise exception 'NOT_AUTHORIZED';
  end if;
  if p_native   is not null and p_native   < 0 then raise exception 'INVALID_BONUS_AMOUNT'; end if;
  if p_cents    is not null and p_cents    < 0 then raise exception 'INVALID_BONUS_AMOUNT'; end if;
  if p_wagering is not null and p_wagering < 0 then raise exception 'INVALID_BONUS_WAGERING'; end if;
  -- Both parts of the amount move together: native without its resolved cents (or vice versa) would
  -- desynchronise the display figure from the money of record.
  if (p_native is null) <> (p_cents is null) then raise exception 'INVALID_BONUS_AMOUNT'; end if;

  update public.sites set
    welcome_bonus_native    = p_native,
    welcome_bonus_cents     = p_cents,
    welcome_bonus_wagering_x = p_wagering,
    updated_at              = now()
  where id = p_site;
  if not found then raise exception 'SITE_NOT_FOUND'; end if;

  insert into public.admin_actions(actor_id, actor_role, action, target_type, target_id, detail, site_id)
    values (p_actor, p_actor_role, 'bonuses.amount', 'site', p_site::text,
            jsonb_build_object('native', p_native, 'cents', p_cents, 'wagering_x', p_wagering), p_site);
  return public.fn_bonus_switches(p_site);
end;
$fn$;

-- ── 5. Grants: service-role only (player/admin reads go through the API) ─────────────────────────
do $g$
begin
  revoke all on function public.fn_admin_set_welcome_bonus(uuid,text,uuid,numeric,bigint,numeric) from public, anon, authenticated;
  grant execute on function public.fn_admin_set_welcome_bonus(uuid,text,uuid,numeric,bigint,numeric) to service_role;
end
$g$;

commit;

-- REVERT (manual, if ever needed):
--   1. Restore fn_grant_welcome_bonus and fn_bonus_switches from 0173 (verbatim bodies).
--   2. drop function if exists public.fn_admin_set_welcome_bonus(uuid,text,uuid,numeric,bigint,numeric);
--   3. alter table public.sites
--        drop column if exists welcome_bonus_wagering_x,
--        drop column if exists welcome_bonus_cents,
--        drop column if exists welcome_bonus_native;
