-- 0214_stk_phone_failure_breaker.sql — stop spending PayHero's abuse budget on a number that keeps failing.
--
-- WHAT PAYHERO TOLD US (dashboard warning, 2026-10):
--   * STK Abuse Protection — more than 10 SUCCESSIVE failed/cancelled STK requests to the SAME phone
--     number blocks that number on our account for 24 hours. Other numbers are unaffected.
--   * General Abuse Protection — over 50 failed requests in a sliding 6-hour window restricts the
--     WHOLE ACCOUNT from sending STK pushes for 4 hours; 500 -> 24 hours; 1000 -> 72 hours.
--
-- WHAT THIS MIGRATION DOES AND DOES NOT ENFORCE. It enforces the FIRST rule only. PayHero support
-- confirmed on 2026-10-24 that the binding account-wide limit is a failure RATE, not the documented
-- count: "Failure rate more than 60%, Limit is 50%... it's a sliding window". A rate cannot be
-- derived from the merchant failure COUNT this migration keeps, because that count has no
-- denominator. The merchant-side check in fn_deposit_gate below is therefore left DISABLED by the
-- service (DEPOSIT_MERCHANT_FAIL_MAX defaults to 0) until it is rebuilt as a rate over
-- successes+failures. The per-phone breaker is unaffected and is a separate PayHero rule.
--
-- Measured at the time of writing: 144 successes / 180 failures over the 7 days to 2026-10-24
-- (55.6% failure rate; 69% on the final day) — already above PayHero's limit, which is why a rate
-- governor must not be switched on before the underlying failures are fixed.
--
-- WHY 0175 DOES NOT ALREADY COVER THIS. The gate shipped in 0175 counts a different thing. It keys on
-- the USER and only fires when the gateway REFUSES the initiate call (`fn_deposit_gate_reject` is
-- called from the catch block around initiateStk). Everything PayHero is counting here is a push that
-- was ACCEPTED — 201 QUEUED — and then failed at the Safaricom end. 0175 never sees those, so a number
-- can fail ten times in a row without the gate moving. That is exactly what happened on 2026-10-24:
-- 0760****919 failed five times in a row on ResultCode 2028 and nothing slowed it down.
--
-- THE SHAPE. Two halves, deliberately split so no policy number is buried in SQL:
--   * The TRIGGER only counts. It writes to `rate_gates` (0175) and nothing else, so it is incapable
--     of touching money, a wallet, a ledger row or a transaction's own columns.
--   * The GATE decides, from thresholds the service passes in from env — same contract as 0175, where
--     the merchant ceiling is a parameter and not a constant.
-- The one constant that IS hardcoded is PayHero's 6-hour account window, because it is THEIR number
-- describing THEIR accounting, not a policy of ours to tune.
--
-- WHAT COUNTS AS A FAILURE. Only a deposit that actually reached the gateway: the trigger requires
-- `checkout_request_id is not null`, which is set by fn_attach_stk after the provider accepted the
-- push. A row closed by fn_abandon_deposit (0174) never got a checkout id, never produced an STK
-- prompt, and so never spent any of PayHero's budget — it is correctly ignored here.
--
-- Money-neutral by construction. Additive and idempotent.
begin;

-- ── Bookkeeping: count terminal deposit outcomes per phone and per merchant ──────────────────────
-- Writes ONLY to public.rate_gates. `count` is the running failure count; `updated_at` is therefore
-- the time of the LAST failure, which is what the backoff below measures from. A success CLEARS the
-- phone key — "successive" is PayHero's word, and one real payment ends the streak.
create or replace function public.fn_tx_deposit_outcome_track()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  v_phone_key text;
  v_merch_key text;
  -- PayHero's own sliding window for the account-wide failure count. Their constant, not our policy.
  c_merchant_window constant interval := interval '6 hours';
begin
  v_phone_key := 'dep:phonefail:' || coalesce(new.provider, 'mpesa') || ':'
                 || coalesce(new.payment_scope, 'global') || ':' || new.phone;
  v_merch_key := 'dep:merchfail:' || coalesce(new.provider, 'mpesa') || ':'
                 || coalesce(new.payment_scope, 'global');

  if new.status = 'success' then
    -- The streak is broken. Drop the row entirely rather than zeroing it, so the prune below has
    -- less to do and a fresh streak starts from a clean window_start.
    delete from public.rate_gates where key = v_phone_key;
    return null;
  end if;

  -- status = 'failed': one more successive failure for this number.
  insert into public.rate_gates(key, window_start, count, updated_at)
       values (v_phone_key, now(), 1, now())
  on conflict (key) do update
    set count = public.rate_gates.count + 1,
        updated_at = now();

  -- ...and one more failure against the account-wide 6h window.
  insert into public.rate_gates(key, window_start, count, updated_at)
       values (v_merch_key, now(), 1, now())
  on conflict (key) do update
    set count = case when now() - public.rate_gates.window_start >= c_merchant_window
                     then 1 else public.rate_gates.count + 1 end,
        window_start = case when now() - public.rate_gates.window_start >= c_merchant_window
                            then now() else public.rate_gates.window_start end,
        updated_at = now();
  return null;
end;
$fn$;

-- AFTER UPDATE, and only on the pending -> terminal transition of a deposit that reached the gateway.
-- `is distinct from` keeps a re-write of an already-terminal row (an idempotent callback replay)
-- from counting the same failure twice.
drop trigger if exists trg_tx_deposit_outcome on public.transactions;
create trigger trg_tx_deposit_outcome
  after update on public.transactions
  for each row
  when (new.kind = 'deposit'
        and new.status in ('success', 'failed')
        and new.status is distinct from old.status
        and new.checkout_request_id is not null)
  execute function public.fn_tx_deposit_outcome_track();

-- ── The gate, extended ───────────────────────────────────────────────────────────────────────────
-- A 7-argument overload of 0175's fn_deposit_gate. The 4-argument original is UNTOUCHED and still
-- works, so nothing that calls it has to change.
--
-- Two new answers, both checked BEFORE a merchant slot is consumed so a refused caller never eats
-- the allowance (0175's rule, kept):
--   'phone_blocked'    — this number's successive-failure count is at the ceiling and its backoff
--                        has not elapsed.
--   'merchant_failing' — the account has failed too often inside PayHero's 6h window.
--
-- BACKOFF, AND WHY IT IS EXPONENTIAL. A block that lifts only on success is a deadlock: a player who
-- cannot attempt can never produce the success that would clear them. So the block is always time-
-- bounded. But a FIXED cooldown would let a genuinely broken number creep up to PayHero's 10 at a
-- steady drip (3 failures, wait, 1 more, wait, 1 more...). Doubling the wait for every failure past
-- the ceiling means reaching 10 successive failures takes days, not hours, while a player whose first
-- three attempts failed for an ordinary reason waits only the base cooldown.
--
-- The phone row is read WITHOUT a lock on purpose: it is written only by the trigger above, the
-- decision tolerates a few milliseconds of staleness, and taking a lock here would put a second
-- lock-ordering constraint on a function that already locks two other keys.
create or replace function public.fn_deposit_gate(
  p_user_key text, p_merchant_key text, p_phone_key text, p_merchant_fail_key text,
  p_limit int, p_window_ms int,
  p_phone_max int, p_phone_cooldown_ms int, p_merchant_fail_max int)
returns text language plpgsql security definer set search_path = public as $fn$
declare
  p public.rate_gates;
  f public.rate_gates;
  v_cooldown interval;
  v_over int;
  c_merchant_window constant interval := interval '6 hours';
  c_max_backoff     constant interval := interval '24 hours';
begin
  -- 1) This number's successive-failure breaker.
  if p_phone_key is not null and p_phone_max > 0 then
    select * into p from public.rate_gates where key = p_phone_key;
    if found and p.count >= p_phone_max then
      v_over := p.count - p_phone_max;                       -- 0 at the ceiling, +1 per failure after
      v_cooldown := make_interval(secs => greatest(p_phone_cooldown_ms, 0) / 1000.0)
                    * power(2::numeric, least(v_over, 16));  -- least() keeps the multiply finite
      if v_cooldown > c_max_backoff then v_cooldown := c_max_backoff; end if;
      if now() < p.updated_at + v_cooldown then
        return 'phone_blocked';
      end if;
    end if;
  end if;

  -- 2) The account-wide failure rate inside PayHero's 6h window. Counting only; a window older than
  --    6 hours is spent and the trigger will restart it on the next failure.
  if p_merchant_fail_key is not null and p_merchant_fail_max > 0 then
    select * into f from public.rate_gates where key = p_merchant_fail_key;
    if found and f.count >= p_merchant_fail_max and now() - f.window_start < c_merchant_window then
      return 'merchant_failing';
    end if;
  end if;

  -- 3) Delegate the user hold + merchant ceiling to the original, unchanged.
  return public.fn_deposit_gate(p_user_key, p_merchant_key, p_limit, p_window_ms);
end;
$fn$;

-- ── Housekeeping, corrected ──────────────────────────────────────────────────────────────────────
-- 0175's prune deletes anything untouched for an hour. That is right for its own keys — no window
-- and no hold there is longer — but it would quietly RESET this breaker an hour after the last
-- failure, which is the one thing it must not do: the whole point is that the count survives long
-- enough to matter. Phone and merchant-failure keys are kept for 25 hours instead, just past the
-- longest backoff this gate can impose.
create or replace function public.fn_deposit_gate_prune()
returns int language plpgsql security definer set search_path = public as $fn$
declare n int;
begin
  delete from public.rate_gates
   where (blocked_until is null or blocked_until < now())
     and case
           when key like 'dep:phonefail:%' or key like 'dep:merchfail:%'
             then updated_at < now() - interval '25 hours'
           else updated_at < now() - interval '1 hour'
         end;
  get diagnostics n = row_count;
  return n;
end;
$fn$;

do $g$
begin
  revoke all on function public.fn_tx_deposit_outcome_track() from public, anon, authenticated;
  revoke all on function public.fn_deposit_gate(text,text,text,text,int,int,int,int,int) from public, anon, authenticated;
  grant execute on function public.fn_deposit_gate(text,text,text,text,int,int,int,int,int) to service_role;
end
$g$;

commit;

-- REVERT (manual, if ever needed):
--   drop trigger if exists trg_tx_deposit_outcome on public.transactions;
--   drop function if exists public.fn_tx_deposit_outcome_track();
--   drop function if exists public.fn_deposit_gate(text,text,text,text,int,int,int,int,int);
--   delete from public.rate_gates where key like 'dep:phonefail:%' or key like 'dep:merchfail:%';
--   -- and restore 0175's one-hour prune:
--   --   (re-run the fn_deposit_gate_prune body from 0175_deposit_rate_gate.sql)
--   NOTE: the 4-argument fn_deposit_gate is untouched by this migration, so dropping the overload
--   leaves 0175's gate working exactly as it did. The service FAILS CLOSED on a gate it cannot
--   consult, so drop the overload only together with a deploy that stops calling it.
