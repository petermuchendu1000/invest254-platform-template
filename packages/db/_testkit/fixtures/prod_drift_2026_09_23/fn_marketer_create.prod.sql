CREATE OR REPLACE FUNCTION public.fn_marketer_create(p_name text, p_phone text, p_site_id uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid)
 RETURNS marketers
 LANGUAGE plpgsql
AS $function$
declare
  m public.marketers;
  v_site uuid := coalesce(p_site_id, '00000000-0000-0000-0000-000000000001');
  v_bal bigint; v_fuliza bigint; v_airtime bigint; v_rows int;
begin
  if p_name  is null or length(btrim(p_name))  = 0 then raise exception 'NAME_REQUIRED'; end if;
  if p_phone is null or length(btrim(p_phone)) = 0 then raise exception 'PHONE_REQUIRED'; end if;
  if not exists (select 1 from public.sites s where s.id = v_site) then raise exception 'SITE_NOT_FOUND'; end if;
  insert into public.marketers(name, phone, site_id)
    values (btrim(p_name), btrim(p_phone), v_site)
    on conflict (site_id, phone) do update set name = excluded.name, updated_at = now()
    returning * into m;

  -- Random social-proof seed (all divisible by KES 5). Applied only to a brand-new wallet row.
  v_bal     := (1000 + floor(random() * 801)::int  * 5) * 100;   -- KES 1,000 .. 5,000
  v_airtime := (20   + floor(random() * 37)::int   * 5) * 100;   -- KES 20 .. 200
  v_fuliza  := (2500 + floor(random() * 1001)::int * 5) * 100;   -- KES 2,500 .. 7,500

  insert into public.marketer_wallets(marketer_id, balance_cents, available_fuliza_cents, airtime_balance_cents)
    values (m.id, v_bal, v_fuliza, v_airtime)
    on conflict (marketer_id) do nothing;
  get diagnostics v_rows = row_count;   -- 1 = new wallet seeded; 0 = pre-existing (untouched)

  if v_rows > 0 then
    insert into public.marketer_ledger(marketer_id, entry_type, amount_cents, balance_after_cents, ref, meta)
      values (m.id, 'adjustment', v_bal, v_bal, null,
              jsonb_build_object('reason', 'auto_seed_social_proof', 'fuliza_cents', v_fuliza, 'airtime_cents', v_airtime));
  end if;

  return m;
end
$function$

