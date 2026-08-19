-- 0093_marketer_login_brand_resolve.sql — resolve a marketer PIN login by the CREDENTIAL, not a brand.
--
-- WHY: the marketer apps (mpesa_2, truecaller) are a single generic build that CANNOT know which
-- brand a marketer belongs to — the sign-in screen collects only phone + PIN/password. A marketer
-- phone is unique only WITHIN a brand (e.g. 0706597235 belongs to different marketers on the
-- default brand AND on "33 Traders"). The old fn_marketer_login filtered by (phone, site_id) and
-- DEFAULTED the site to the default brand, so it authenticated whichever marketer sat on the
-- default brand and rejected the real one on another brand (the "Patricia Muthoni cannot log in"
-- bug). We do NOT want the client to send a brand (it can't know it) and we must NOT hard-code one.
--
-- FIX: make p_site_id OPTIONAL (NULL = search every brand). Resolve the marketer by matching the
-- PIN across all brands that hold the phone — the PIN itself identifies which brand's marketer is
-- signing in. A brand-aware caller (the web/tests) may still pass p_site_id to scope the search.
-- Lockout/anti-bruteforce is preserved: a failed attempt bumps failed_attempts on the candidate(s)
-- and locks after 5, exactly as before (the API also rate-limits logins per IP).
--
-- Idempotent (create or replace). Money-neutral. Security model unchanged (INVOKER; the API calls it
-- with the service connection, same as the previous version).

create or replace function public.fn_marketer_login(
  p_phone text,
  p_pin text,
  p_site_id uuid default null
) returns uuid
  language plpgsql
as $function$
declare
  m record;
  c record;
  v_phone text := btrim(coalesce(p_phone, ''));
begin
  -- Walk every marketer holding this phone (optionally scoped to one brand), oldest first for a
  -- deterministic order. Match the PIN against each candidate's credentials; the first active,
  -- unlocked marketer whose PIN verifies is the one signing in.
  for m in
    select id, status
      from public.marketers
     where phone = v_phone
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
  -- every credentialed candidate for this phone, mirroring the original per-account lockout.
  update public.marketer_credentials cc
     set failed_attempts = cc.failed_attempts + 1,
         locked_until = case when cc.failed_attempts + 1 >= 5 then now() + interval '15 minutes' else cc.locked_until end,
         updated_at = now()
   from public.marketers mm
  where mm.id = cc.marketer_id
    and mm.phone = v_phone
    and (p_site_id is null or mm.site_id = p_site_id);

  return null;
end
$function$;

comment on function public.fn_marketer_login(text, text, uuid) is
  'Marketer PIN login. Resolves the marketer by matching the PIN across every brand holding the phone (p_site_id NULL = all brands; pass it to scope). A phone is unique only within a brand, so the PIN — not a client-supplied brand — identifies the account. Preserves failed-attempt lockout.';
