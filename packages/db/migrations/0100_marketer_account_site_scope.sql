-- 0100_marketer_account_site_scope.sql — fix: the demo/marketer classifier must be PER-SITE.
--
-- BUG (BUGLOG #5): fn_is_marketer_account (0084) matched a profile to the `marketers` cohort on PHONE
-- ALONE, across ALL brands (no site_id filter). But 0076 made `marketers` per-site (site_id +
-- unique(site_id, phone)) and docs/20 §7 states marketer identity is PER-SITE. Result: a real PLAYER on
-- brand B whose phone (significant-9) collides with a marketer on brand A was classified demo/marketer
-- on brand B → the engine's pool exemption (loadIsMarketer) set poolPath=false → that player BYPASSED
-- the withdrawal pool and settled on the statistical ("marketer") path, and the money layer routed them
-- to the demo bucket. Symptoms observed: "global pool fund not applying to some clients (e.g. 33traders)"
-- and "players using game config meant for marketers instead of the pool fund".
--
-- FIX: a user is a demo/marketer account IFF a `marketers` row exists ON THE USER'S OWN SITE matching
-- their significant-9 phone. PLUS a safety clause: an explicitly enrolled marketer profile
-- (profiles.role='marketer') stays demo on its own site regardless — so this migration NEVER un-demos an
-- existing marketer (which 0084 warns would turn funny-money into withdrawable cash). Net effect: the 5
-- cross-site-contaminated PLAYERS become real pool players (all have zero balance / zero trades); zero
-- marketers are un-flagged. The marketer_account_ids view and every money path that resolves through
-- this predicate are corrected automatically. Additive, idempotent, reversible. Money-neutral.

create or replace function public.fn_is_marketer_account(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    -- demo iff a marketer exists on THIS user's OWN brand (per-site identity; 0076)
    select 1
      from public.profiles p
      join public.marketers m
        on public.fn_phone_sig9(m.phone) = public.fn_phone_sig9(p.phone)
       and m.site_id = p.site_id
     where p.id = p_user
       and length(public.fn_phone_sig9(p.phone)) = 9
  )
  or exists (
    -- safety: an explicitly enrolled marketer profile is ALWAYS demo on its own site (never un-demo)
    select 1 from public.profiles p where p.id = p_user and p.role = 'marketer'
  )
$function$;
