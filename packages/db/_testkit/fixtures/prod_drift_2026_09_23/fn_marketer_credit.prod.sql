CREATE OR REPLACE FUNCTION public.fn_marketer_credit(p_marketer_id uuid, p_amount_cents bigint, p_ref text DEFAULT NULL::text, p_meta jsonb DEFAULT '{}'::jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
AS $function$
DECLARE new_bal bigint; existing bigint;
BEGIN
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN RAISE EXCEPTION 'AMOUNT_MUST_BE_POSITIVE'; END IF;
  IF p_ref IS NOT NULL THEN
    SELECT balance_after_cents INTO existing FROM public.marketer_ledger WHERE ref = p_ref;
    IF FOUND THEN RETURN existing; END IF;              -- idempotent replay
  END IF;
  SELECT balance_cents INTO new_bal FROM public.marketer_wallets WHERE marketer_id = p_marketer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MARKETER_NOT_FOUND'; END IF;
  new_bal := new_bal + p_amount_cents;
  UPDATE public.marketer_wallets SET balance_cents = new_bal, updated_at = now() WHERE marketer_id = p_marketer_id;
  INSERT INTO public.marketer_ledger(marketer_id, entry_type, amount_cents, balance_after_cents, ref, meta)
    VALUES (p_marketer_id, 'credit', p_amount_cents, new_bal, p_ref, COALESCE(p_meta,'{}'::jsonb));
  RETURN new_bal;
END
$function$

