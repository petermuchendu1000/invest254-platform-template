-- 0073_affiliate_clicks.sql — referral link click tracking (docs/19 funnel P2 gap).
--
-- Completes the affiliate funnel (Clicks → Registrations → FTDs → Active → Commission). Clicks are
-- the only funnel stage with no data source; FTDs are derived from existing transactions (no table
-- needed). This adds a lightweight append-only click log + a tolerant recorder.
--
-- A click is logged when a visitor lands on /r/<code> (before signup). Matching mirrors attribution:
-- case-insensitive, and an unknown/suspended code is a silent no-op (a stale link never errors). No
-- PII is stored (no IP/user) — just which affiliate + brand + when, which is all the funnel needs.
-- Additive + idempotent.

create table if not exists public.affiliate_clicks (
  id           bigserial primary key,
  affiliate_id uuid not null references public.profiles(id) on delete cascade,
  code         text not null,
  site_id      uuid references public.sites(id),
  created_at   timestamptz not null default now()
);
create index if not exists idx_affiliate_clicks_aff  on public.affiliate_clicks(affiliate_id, created_at desc);
create index if not exists idx_affiliate_clicks_site on public.affiliate_clicks(site_id, created_at desc);

-- Record a click for a referral code. Tolerant: resolves the code case-insensitively to an ACTIVE
-- affiliate and inserts a row; unknown/inactive codes are a silent no-op (returns false). Never
-- raises, so the public tracking endpoint can be fire-and-forget. SECURITY DEFINER (service-role).
create or replace function public.fn_affiliate_record_click(p_code text, p_site uuid default null)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_aff uuid;
begin
  if p_code is null or length(trim(p_code)) = 0 then return false; end if;
  select user_id into v_aff from public.affiliates
    where lower(referral_code) = lower(trim(p_code)) and status = 'active'
    limit 1;
  if v_aff is null then return false; end if;
  insert into public.affiliate_clicks(affiliate_id, code, site_id)
    values (v_aff, upper(trim(p_code)), p_site);
  return true;
exception when others then
  return false;  -- click tracking must never break the landing page
end;
$function$;
