-- 0187_paynicorn_display_payx.sql — admins see the Paynicorn gateway as "PayX".
--
-- Display names only. The provider code stays `paynicorn`, which is what every transaction, entitlement,
-- config row and site override keys on, so nothing that references the gateway changes. Players never
-- see either name: their deposit tab reads "Online checkout" (docs/35, docs/53). Idempotent.
begin;

update public.payment_providers set display_name = 'PayX', updated_at = now()
 where code = 'paynicorn' and display_name is distinct from 'PayX';

update public.addon_catalog set display_name = 'PayX', description = 'PayX deposits through its hosted checkout page.'
 where category = 'payment_gateway' and key = 'paynicorn';

commit;
