-- 0175_deposit_rate_gate.sql — make the deposit initiate guard EXACT across every API machine.
--
-- 0174 shipped the guard in process memory. That bounds each machine independently: with N API
-- machines the real ceiling is N x the configured one, and a player's post-rejection cooldown is
-- only honoured by whichever machine happened to serve the rejection. It was a mitigation, not a
-- guarantee — and the guarantee is what matters, because PayHero's block is MERCHANT-WIDE: one
-- player's retry loop stops deposits for every brand sharing those credentials.
--
-- The shared store is Postgres. There is no Redis in this stack, and reaching for one would add an
-- availability dependency to the money path for no benefit: the deposit row is created in THIS
-- database on THIS request, so a gate here cannot be "down" while deposits are otherwise working.
--
-- EXACTNESS. `fn_deposit_gate` takes a row lock per key, so concurrent initiations serialise on that
-- key and the counter cannot be raced. The keys are disjoint namespaces and are always locked in the
-- same order (user, then merchant), so the function cannot deadlock against itself.
--
-- Money-neutral: this migration only counts requests. It can neither move money nor touch a wallet,
-- a ledger row or a transaction.
begin;

create table if not exists public.rate_gates (
  key           text primary key,
  window_start  timestamptz not null default now(),
  count         int         not null default 0,
  blocked_until timestamptz,
  updated_at    timestamptz not null default now()
);
create index if not exists idx_rate_gates_updated on public.rate_gates(updated_at);

alter table public.rate_gates enable row level security;
revoke all on table public.rate_gates from anon, authenticated;
grant select, insert, update, delete on table public.rate_gates to service_role;

-- ── The gate. One round trip, three answers ──────────────────────────────────────────────────────
--   'too_soon' — this player was refused by the gateway moments ago (see fn_deposit_gate_reject).
--   'busy'     — this MERCHANT is at its ceiling for the current window.
--   'ok'       — a slot was consumed; proceed.
-- A slot is consumed ONLY when the answer is 'ok', so a refused caller never eats the allowance.
create or replace function public.fn_deposit_gate(
  p_user_key text, p_merchant_key text, p_limit int, p_window_ms int)
returns text language plpgsql security definer set search_path = public as $fn$
declare u public.rate_gates; m public.rate_gates; v_win interval;
begin
  v_win := make_interval(secs => greatest(p_window_ms, 1) / 1000.0);

  -- 1) The player's post-rejection hold. Locked first, always, so the lock order is total.
  insert into public.rate_gates(key) values (p_user_key) on conflict (key) do nothing;
  select * into u from public.rate_gates where key = p_user_key for update;
  if u.blocked_until is not null and u.blocked_until > now() then
    return 'too_soon';
  end if;

  -- 2) The merchant ceiling for the current fixed window.
  insert into public.rate_gates(key) values (p_merchant_key) on conflict (key) do nothing;
  select * into m from public.rate_gates where key = p_merchant_key for update;
  if now() - m.window_start >= v_win then
    update public.rate_gates set window_start = now(), count = 1, updated_at = now() where key = p_merchant_key;
    return 'ok';
  end if;
  if m.count >= greatest(p_limit, 1) then
    return 'busy';
  end if;
  update public.rate_gates set count = count + 1, updated_at = now() where key = p_merchant_key;
  return 'ok';
end;
$fn$;

-- ── Record a gateway rejection, holding this player off for p_ms ─────────────────────────────────
-- Never shortens an existing hold (a second rejection cannot buy a player a shorter wait).
create or replace function public.fn_deposit_gate_reject(p_user_key text, p_ms int)
returns timestamptz language plpgsql security definer set search_path = public as $fn$
declare v_until timestamptz;
begin
  v_until := now() + make_interval(secs => greatest(p_ms, 0) / 1000.0);
  insert into public.rate_gates(key, blocked_until, updated_at) values (p_user_key, v_until, now())
  on conflict (key) do update
    set blocked_until = greatest(coalesce(public.rate_gates.blocked_until, v_until), v_until),
        updated_at = now()
  returning blocked_until into v_until;
  return v_until;
end;
$fn$;

-- ── Housekeeping: the table is a scratchpad, not a record ────────────────────────────────────────
-- Rows are per (provider,user) and (provider,merchant), so the user side grows with the player base.
-- Anything untouched for an hour is meaningless — no window is longer, no hold is longer.
create or replace function public.fn_deposit_gate_prune()
returns int language plpgsql security definer set search_path = public as $fn$
declare n int;
begin
  delete from public.rate_gates
   where updated_at < now() - interval '1 hour'
     and (blocked_until is null or blocked_until < now());
  get diagnostics n = row_count;
  return n;
end;
$fn$;

do $g$
begin
  revoke all on function public.fn_deposit_gate(text,text,int,int)   from public, anon, authenticated;
  revoke all on function public.fn_deposit_gate_reject(text,int)     from public, anon, authenticated;
  revoke all on function public.fn_deposit_gate_prune()              from public, anon, authenticated;
  grant execute on function public.fn_deposit_gate(text,text,int,int) to service_role;
  grant execute on function public.fn_deposit_gate_reject(text,int)   to service_role;
  grant execute on function public.fn_deposit_gate_prune()            to service_role;
end
$g$;

commit;

-- REVERT (manual, if ever needed):
--   drop function if exists public.fn_deposit_gate_prune();
--   drop function if exists public.fn_deposit_gate_reject(text,int);
--   drop function if exists public.fn_deposit_gate(text,text,int,int);
--   drop table if exists public.rate_gates;
--   NOTE: the service FAILS CLOSED — an initiate whose gate cannot be consulted is refused with a
--   429, never sent to the gateway. Dropping these objects therefore stops deposits until the
--   service is redeployed without the gate. That is the deliberate cost of "no request reaches a
--   provider without a granted slot"; it is also nearly unreachable, since the deposit row is
--   created in this same database on the same request.
