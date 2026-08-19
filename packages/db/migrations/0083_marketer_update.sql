-- 0083_marketer_update.sql — admin edit of a marketer's name / phone (marketers table, 0033).
--
-- fn_marketer_create can only upsert-by-phone (so it can change a NAME but never the PHONE, and can't
-- rename without knowing the phone). This adds a direct edit keyed by marketer id, with per-brand
-- phone uniqueness (uq_marketers_site_phone). Admin/superadmin gating is enforced in the API layer.

create or replace function public.fn_marketer_update(p_marketer_id uuid, p_name text, p_phone text)
returns public.marketers
language plpgsql security definer set search_path = public
as $fn$
declare m public.marketers; v_name text; v_phone text;
begin
  select * into m from public.marketers where id = p_marketer_id for update;
  if not found then raise exception 'MARKETER_NOT_FOUND'; end if;

  v_name  := nullif(btrim(coalesce(p_name, '')), '');
  v_phone := nullif(btrim(coalesce(p_phone, '')), '');

  if v_phone is not null and exists (
    select 1 from public.marketers x where x.site_id = m.site_id and x.phone = v_phone and x.id <> p_marketer_id
  ) then
    raise exception 'PHONE_TAKEN';
  end if;

  update public.marketers
     set name  = coalesce(v_name,  name),
         phone = coalesce(v_phone, phone),
         updated_at = now()
   where id = p_marketer_id
   returning * into m;
  return m;
end;
$fn$;

revoke all on function public.fn_marketer_update(uuid,text,text) from public, anon, authenticated;
grant execute on function public.fn_marketer_update(uuid,text,text) to service_role;
