-- 0054_brand_theme_tokens.sql — full per-brand design-token set (docs/22 Task G follow-on).
--
-- Until now branding stored only 3 colours (color_primary / color_accent / color_bg + theme), and
-- the app mapped just --pp-brand and --pp-accent — so brands shared the same background, surfaces,
-- text and gain/loss semantics, and the logo mark was hard-coded. Two brands therefore looked far
-- more alike than intended.
--
-- This adds an OPTIONAL `theme_tokens` jsonb holding the FULL, contrast-checked palette derived by
-- the app's colour engine (analogous/complementary/… harmony from one seed hue):
--   bg · surface · surface2 · border · fg · muted · brand · brandHover · accent · accentFg
--   · up (success) · down (danger) · warn (warning) · info
-- The web layer maps every token to --brand-* → --pp-* so the WHOLE UI (logo, marquee/TickerStrip,
-- live curve/CurveCanvas, buttons, cards) re-skins per brand from one source of truth.
--
-- Semantics (up/down/warn/info) stay in their CANONICAL hue bands (success green, danger red,
-- warning amber, info blue) so their MEANING is stable across every brand — uniqueness comes from
-- the brand/accent/surface tokens, never from bending the semantic hues. Additive + idempotent.

alter table public.sites add column if not exists theme_tokens jsonb;

-- Seed the default brand (Invest254) with its full derived palette (green, analogous scheme).
update public.sites
   set theme_tokens = '{"bg":"#0c100d","surface":"#161d18","surface2":"#212c25","border":"#36453b","fg":"#f1f3f2","muted":"#94a89c","brand":"#2cdd6d","brandHover":"#1fbd59","brandText":"#2cdd6d","accent":"#67e997","accentFg":"#0b0f14","up":"#2cdd6d","down":"#8fa396","warn":"#f6b128","info":"#5199ec"}'::jsonb
 where id = '00000000-0000-0000-0000-000000000001' and theme_tokens is null;

-- Persist a brand's palette from the platform console (platform_superadmin; audited). Additive RPC
-- so it can't disturb the existing fn_platform_* surface. Validates jsonb shape lightly.
create or replace function public.fn_platform_set_site_theme(
  p_actor uuid, p_actor_role text, p_site_id uuid, p_tokens jsonb
) returns public.sites
language plpgsql security definer set search_path = public
as $fn$
declare v_row public.sites;
begin
  if p_actor_role <> 'platform_superadmin' then raise exception 'NOT_AUTHORIZED'; end if;
  if p_tokens is null or jsonb_typeof(p_tokens) <> 'object' then raise exception 'INVALID_PATCH'; end if;
  update public.sites u set theme_tokens = p_tokens, updated_at = now()
   where u.id = p_site_id returning * into v_row;
  if not found then raise exception 'SITE_NOT_FOUND'; end if;
  insert into admin_actions(actor_id, actor_role, action, target_type, target_id, detail)
    values (p_actor, p_actor_role, 'platform.site.theme', 'site', p_site_id::text,
            jsonb_build_object('tokens', p_tokens));
  return v_row;
end;
$fn$;

do $g$
begin
  revoke all on function public.fn_platform_set_site_theme(uuid,text,uuid,jsonb) from public, anon, authenticated;
  grant execute on function public.fn_platform_set_site_theme(uuid,text,uuid,jsonb) to service_role;
end
$g$;
