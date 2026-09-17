-- 0126_marketer_login_phone_sig9.sql — marketer PIN login must match the phone on the canonical
-- significant-9-digits rule, like every other marketer lookup (BUGLOG #30).
--
-- Bug: fn_marketer_login (0093) matched `marketers.phone = v_phone` EXACTLY (btrim only). Every other
-- marketer lookup — profileByPhone (marketers.pg.ts), fn_marketer_game_withdraw / fn_is_marketer_account
-- (0086), marketer_account_ids (0100) — long ago moved to fn_phone_sig9 (right-9 digits) so a phone
-- entered as +254…/254…/bare 7… still resolves the stored 07… identity. fn_marketer_login was the one
-- lookup left on exact match. The marketer apps send the phone exactly as typed (mpesa_2 PinLoginScreen
-- reuses AppState.phone captured at first sign-in), so a marketer who typed a non-07 format could sign in
-- with a PASSWORD (login-web → profileByPhone normalizes) but then FAILED the PIN quick-login on relaunch
-- (login → fn_marketer_login exact match) — on ANY brand. This is unrelated to the default-marketer work.
--
-- Fix: match candidates (and the failed-attempts throttle) on fn_phone_sig9, with a length-9 validity
-- guard so a malformed phone matches nothing (and never churns lockout counters). PIN verification,
-- per-account lockout, active-status and optional site scoping are all unchanged. CREATE OR REPLACE,
-- same 3-arg signature (no call-site change, no deploy window). Idempotent.

create or replace function public.fn_marketer_login(p_phone text, p_pin text, p_site_id uuid default null)
returns uuid
language plpgsql
as $fn$
declare
  m record;
  c record;
  v_phone text := btrim(coalesce(p_phone, ''));
  v_sig   text := public.fn_phone_sig9(v_phone);
begin
  -- A malformed / too-short phone can never identify a marketer; bail before touching any counters.
  if length(v_sig) <> 9 then return null; end if;

  -- Walk every marketer holding this phone (canonical sig-9 match; optionally scoped to one brand),
  -- oldest first for a deterministic order. Match the PIN against each candidate's credentials; the
  -- first active, unlocked marketer whose PIN verifies is the one signing in.
  for m in
    select id, status
      from public.marketers
     where public.fn_phone_sig9(phone) = v_sig
       and (p_site_id is null or site_id = p_site_id)
     order by created_at asc, id asc
  loop
    select * into c from public.marketer_credentials where marketer_id = m.id for update;
    if not found then continue; end if;                               -- no PIN set on this candidate
    if c.locked_until is not null and c.locked_until > now() then continue; end if;  -- locked out
    if m.status <> 'active' then continue; end if;                    -- suspended/disabled
    if c.pin_hash = extensions.crypt(coalesce(p_pin, ''), c.pin_hash) then
      update public.marketer_credentials
         set failed_attempts = 0, locked_until = null, updated_at = now()
       where marketer_id = m.id;
      return m.id;                                                    -- authenticated
    end if;
  end loop;

  -- No candidate matched: throttle brute force by bumping failed_attempts (and locking after 5) on
  -- every credentialed candidate for this phone (same canonical sig-9 cohort), mirroring the original.
  update public.marketer_credentials cc
     set failed_attempts = cc.failed_attempts + 1,
         locked_until = case when cc.failed_attempts + 1 >= 5 then now() + interval '15 minutes' else cc.locked_until end,
         updated_at = now()
   from public.marketers mm
  where mm.id = cc.marketer_id
    and public.fn_phone_sig9(mm.phone) = v_sig
    and (p_site_id is null or mm.site_id = p_site_id);

  return null;
end
$fn$;
