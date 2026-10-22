-- 0199_marketer_rpc_tenant_fence.sql — Issue 3 / A1 (security audit 2026-10, docs/59). Follows F-46 (0156).
--
-- DEFECT (defence-in-depth gap, NOT a live exploit): the six marketer MUTATING RPCs
--   fn_marketer_credit / _withdraw / _set_pin / _set_status / _set_fuliza / _set_airtime
-- took only the marketer id and had NO actor/brand awareness at the database. The ONLY thing standing
-- between a site admin of brand A and re-PINning (account takeover), disabling, crediting or draining
-- a marketer of brand B was the TypeScript `marketerInScope` guard on each admin route. That guard is
-- correct today, but it is the single point of failure: one future route (or refactor) that forgets to
-- call it is an immediate cross-tenant takeover with no backstop. The user/brand/advance RPCs already
-- got the DB-level brand fence in 0156 (F-46); the marketer RPCs were the one surface left relying on
-- the API alone. This closes that gap by extending the SAME fence to them.
--
-- FIX — add an OPTIONAL actor to each RPC and fence it with the existing helper, bodies otherwise
-- BYTE-IDENTICAL to production (verified line-by-line by packages/db/_testkit/e2e_marketer_rpc_tenant_fence.py):
--   * Two trailing OPTIONAL params `p_actor uuid DEFAULT NULL, p_actor_role text DEFAULT NULL`.
--   * First statement: PERFORM public.fn_assert_actor_site_scope(p_actor, p_actor_role,
--                        (SELECT site_id FROM public.marketers WHERE id = p_marketer_id));
--     The helper (0156) raises SITE_SCOPE_FORBIDDEN only for a site-tier actor (role admin|superadmin)
--     acting outside its permitted brand set; for a platform tier, the owner, or a NULL actor it is a
--     no-op, so platform admins / the owner and every current caller behave exactly as before.
--
-- WHY OPTIONAL (not required like the 0156 RPCs):
--   fn_marketer_credit is also called INTERNALLY by fn_marketer_game_withdraw (0109) with NO actor —
--   the instant demo→wallet game settlement, a legitimate SYSTEM path. A required actor would break
--   that live flow. Optional + NULL-means-skip keeps the system path untouched while the admin routes
--   pass the real token actor (apps/api/src/marketers.pg.ts), so the fence engages on 100% of admin
--   calls and never on the internal one. The marketer self-service PIN reset (verified security
--   answers, no admin) likewise passes no actor, so it stays unfenced — correct, it is not cross-tenant.
--
-- DEPLOY-ORDER SAFE (both directions). The migrate job applies this BEFORE the new API deploys:
--   * Old API still running against the new DB calls the OLD arity (e.g. _set_pin($1,$2)); it resolves
--     to the new signature with the two defaults → actor NULL → fence skipped → identical behaviour.
--   * New API passes the actor → fenced.
--   * A rollback (new code reverted, migration kept) is equally safe for the same reason.
-- Each signature CHANGES (adds params), so a plain CREATE OR REPLACE would leave a second overload and
-- make the internal 4-arg credit call ambiguous — so each old signature is DROPPED first, then the new
-- one created. plpgsql bodies carry no hard dependency, so dropping does not cascade; verified on a
-- throwaway Postgres 16 (full 0001..0199 apply + the e2e above). Idempotent (drop if exists).

begin;

-- ── fn_marketer_credit (prod body from 0158; +actor fence) ──────────────────────────────────────
drop function if exists public.fn_marketer_credit(uuid, bigint, text, jsonb);
CREATE OR REPLACE FUNCTION public.fn_marketer_credit(p_marketer_id uuid, p_amount_cents bigint, p_ref text DEFAULT NULL::text, p_meta jsonb DEFAULT '{}'::jsonb, p_actor uuid DEFAULT NULL, p_actor_role text DEFAULT NULL)
 RETURNS bigint
 LANGUAGE plpgsql
AS $function$
DECLARE new_bal bigint; existing bigint;
BEGIN
  PERFORM public.fn_assert_actor_site_scope(p_actor, p_actor_role, (SELECT site_id FROM public.marketers WHERE id = p_marketer_id));   -- Issue 3 / A1: DB-level brand fence
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
$function$;

-- ── fn_marketer_withdraw (prod body from 0033; +actor fence) ─────────────────────────────────────
drop function if exists public.fn_marketer_withdraw(uuid, bigint, text, jsonb, text);
CREATE OR REPLACE FUNCTION public.fn_marketer_withdraw(
  p_marketer_id uuid, p_amount_cents bigint, p_ref text DEFAULT NULL,
  p_meta jsonb DEFAULT '{}'::jsonb, p_method text DEFAULT 'internal',
  p_actor uuid DEFAULT NULL, p_actor_role text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql AS $func$
DECLARE cur bigint; fuliza bigint; new_bal bigint; new_fuliza bigint; wid uuid; lid bigint; mstatus text; ex public.marketer_ledger;
BEGIN
  PERFORM public.fn_assert_actor_site_scope(p_actor, p_actor_role, (SELECT site_id FROM public.marketers WHERE id = p_marketer_id));   -- Issue 3 / A1: DB-level brand fence
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN RAISE EXCEPTION 'AMOUNT_MUST_BE_POSITIVE'; END IF;
  IF p_ref IS NOT NULL THEN
    SELECT * INTO ex FROM public.marketer_ledger WHERE ref = p_ref;
    IF FOUND THEN
      RETURN jsonb_build_object('idempotent', true, 'balance_cents', ex.balance_after_cents, 'ledger_id', ex.id);
    END IF;
  END IF;
  SELECT status INTO mstatus FROM public.marketers WHERE id = p_marketer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'MARKETER_NOT_FOUND'; END IF;
  IF mstatus <> 'active' THEN RAISE EXCEPTION 'MARKETER_NOT_ACTIVE:%', mstatus; END IF;
  SELECT balance_cents, available_fuliza_cents INTO cur, fuliza
    FROM public.marketer_wallets WHERE marketer_id = p_marketer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MARKETER_NOT_FOUND'; END IF;
  -- Spending power = cash balance + available Fuliza overdraft (Fuliza covers the shortfall).
  IF cur + COALESCE(fuliza,0) < p_amount_cents THEN
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS: have %, need %', cur + COALESCE(fuliza,0), p_amount_cents;
  END IF;
  IF cur >= p_amount_cents THEN
    new_bal := cur - p_amount_cents;
    new_fuliza := COALESCE(fuliza,0);
  ELSE
    new_bal := 0;
    new_fuliza := COALESCE(fuliza,0) - (p_amount_cents - cur);
  END IF;
  UPDATE public.marketer_wallets
    SET balance_cents = new_bal, available_fuliza_cents = new_fuliza, updated_at = now()
    WHERE marketer_id = p_marketer_id;
  INSERT INTO public.marketer_ledger(marketer_id, entry_type, amount_cents, balance_after_cents, ref, meta)
    VALUES (p_marketer_id, 'withdrawal', -p_amount_cents, new_bal, p_ref,
            COALESCE(p_meta,'{}'::jsonb) || jsonb_build_object('fuliza_used_cents', (COALESCE(fuliza,0) - new_fuliza)))
    RETURNING id INTO lid;
  INSERT INTO public.marketer_withdrawals(marketer_id, amount_cents, status, method, reference, ledger_id, paid_at)
    VALUES (p_marketer_id, p_amount_cents, 'paid', p_method, p_ref, lid, now())
    RETURNING id INTO wid;
  RETURN jsonb_build_object('idempotent', false, 'balance_cents', new_bal, 'withdrawal_id', wid, 'ledger_id', lid);
END
$func$;

-- ── fn_marketer_set_fuliza (prod body from 0033; +actor fence) ───────────────────────────────────
drop function if exists public.fn_marketer_set_fuliza(uuid, bigint);
CREATE OR REPLACE FUNCTION public.fn_marketer_set_fuliza(p_marketer_id uuid, p_amount_cents bigint, p_actor uuid DEFAULT NULL, p_actor_role text DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql AS $func$
DECLARE v bigint;
BEGIN
  PERFORM public.fn_assert_actor_site_scope(p_actor, p_actor_role, (SELECT site_id FROM public.marketers WHERE id = p_marketer_id));   -- Issue 3 / A1: DB-level brand fence
  IF p_amount_cents IS NULL OR p_amount_cents < 0 THEN RAISE EXCEPTION 'AMOUNT_MUST_BE_NONNEGATIVE'; END IF;
  UPDATE public.marketer_wallets SET available_fuliza_cents = p_amount_cents, updated_at = now()
    WHERE marketer_id = p_marketer_id RETURNING available_fuliza_cents INTO v;
  IF NOT FOUND THEN RAISE EXCEPTION 'MARKETER_NOT_FOUND'; END IF;
  RETURN v;
END $func$;

-- ── fn_marketer_set_airtime (prod body from 0033; +actor fence) ──────────────────────────────────
drop function if exists public.fn_marketer_set_airtime(uuid, bigint);
CREATE OR REPLACE FUNCTION public.fn_marketer_set_airtime(p_marketer_id uuid, p_amount_cents bigint, p_actor uuid DEFAULT NULL, p_actor_role text DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql AS $func$
DECLARE v bigint;
BEGIN
  PERFORM public.fn_assert_actor_site_scope(p_actor, p_actor_role, (SELECT site_id FROM public.marketers WHERE id = p_marketer_id));   -- Issue 3 / A1: DB-level brand fence
  IF p_amount_cents IS NULL OR p_amount_cents < 0 THEN RAISE EXCEPTION 'AMOUNT_MUST_BE_NONNEGATIVE'; END IF;
  UPDATE public.marketer_wallets SET airtime_balance_cents = p_amount_cents, updated_at = now()
    WHERE marketer_id = p_marketer_id RETURNING airtime_balance_cents INTO v;
  IF NOT FOUND THEN RAISE EXCEPTION 'MARKETER_NOT_FOUND'; END IF;
  RETURN v;
END $func$;

-- ── fn_marketer_set_pin (prod body from 0034; +actor fence) ──────────────────────────────────────
drop function if exists public.fn_marketer_set_pin(uuid, text);
CREATE OR REPLACE FUNCTION public.fn_marketer_set_pin(p_marketer_id uuid, p_pin text, p_actor uuid DEFAULT NULL, p_actor_role text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql AS $func$
BEGIN
  PERFORM public.fn_assert_actor_site_scope(p_actor, p_actor_role, (SELECT site_id FROM public.marketers WHERE id = p_marketer_id));   -- Issue 3 / A1: DB-level brand fence
  IF p_pin IS NULL OR p_pin !~ '^\d{4,6}$' THEN RAISE EXCEPTION 'INVALID_PIN'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.marketers WHERE id = p_marketer_id) THEN RAISE EXCEPTION 'MARKETER_NOT_FOUND'; END IF;
  INSERT INTO public.marketer_credentials(marketer_id, pin_hash)
    VALUES (p_marketer_id, extensions.crypt(p_pin, extensions.gen_salt('bf')))
    ON CONFLICT (marketer_id) DO UPDATE
      SET pin_hash = EXCLUDED.pin_hash, failed_attempts = 0, locked_until = NULL, updated_at = now();
  RETURN true;
END
$func$;

-- ── fn_marketer_set_status (prod body from 0034; +actor fence) ───────────────────────────────────
drop function if exists public.fn_marketer_set_status(uuid, text);
CREATE OR REPLACE FUNCTION public.fn_marketer_set_status(p_marketer_id uuid, p_status text, p_actor uuid DEFAULT NULL, p_actor_role text DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql AS $func$
DECLARE v text;
BEGIN
  PERFORM public.fn_assert_actor_site_scope(p_actor, p_actor_role, (SELECT site_id FROM public.marketers WHERE id = p_marketer_id));   -- Issue 3 / A1: DB-level brand fence
  IF p_status NOT IN ('active','suspended','disabled') THEN RAISE EXCEPTION 'INVALID_STATUS'; END IF;
  UPDATE public.marketers SET status = p_status, updated_at = now() WHERE id = p_marketer_id RETURNING status INTO v;
  IF NOT FOUND THEN RAISE EXCEPTION 'MARKETER_NOT_FOUND'; END IF;
  RETURN v;
END
$func$;

commit;

-- ── Revert (manual) ───────────────────────────────────────────────────────────────────────────
-- Restores the pre-0199 signatures (no actor param, no fence). Each new signature must be DROPPED
-- first (it differs from the old one), then the production body recreated.
-- begin;
--   drop function if exists public.fn_marketer_credit(uuid, bigint, text, jsonb, uuid, text);
--   CREATE OR REPLACE FUNCTION public.fn_marketer_credit(p_marketer_id uuid, p_amount_cents bigint, p_ref text DEFAULT NULL::text, p_meta jsonb DEFAULT '{}'::jsonb)
--    RETURNS bigint LANGUAGE plpgsql AS $function$
--   DECLARE new_bal bigint; existing bigint;
--   BEGIN
--     IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN RAISE EXCEPTION 'AMOUNT_MUST_BE_POSITIVE'; END IF;
--     IF p_ref IS NOT NULL THEN
--       SELECT balance_after_cents INTO existing FROM public.marketer_ledger WHERE ref = p_ref;
--       IF FOUND THEN RETURN existing; END IF;
--     END IF;
--     SELECT balance_cents INTO new_bal FROM public.marketer_wallets WHERE marketer_id = p_marketer_id FOR UPDATE;
--     IF NOT FOUND THEN RAISE EXCEPTION 'MARKETER_NOT_FOUND'; END IF;
--     new_bal := new_bal + p_amount_cents;
--     UPDATE public.marketer_wallets SET balance_cents = new_bal, updated_at = now() WHERE marketer_id = p_marketer_id;
--     INSERT INTO public.marketer_ledger(marketer_id, entry_type, amount_cents, balance_after_cents, ref, meta)
--       VALUES (p_marketer_id, 'credit', p_amount_cents, new_bal, p_ref, COALESCE(p_meta,'{}'::jsonb));
--     RETURN new_bal;
--   END $function$;
--   drop function if exists public.fn_marketer_withdraw(uuid, bigint, text, jsonb, text, uuid, text);
--   -- (recreate the 5-arg 0033 fn_marketer_withdraw body)
--   drop function if exists public.fn_marketer_set_fuliza(uuid, bigint, uuid, text);
--   drop function if exists public.fn_marketer_set_airtime(uuid, bigint, uuid, text);
--   drop function if exists public.fn_marketer_set_pin(uuid, text, uuid, text);
--   drop function if exists public.fn_marketer_set_status(uuid, text, uuid, text);
--   -- (recreate the 0033/0034 2-arg bodies for the four above)
-- commit;
