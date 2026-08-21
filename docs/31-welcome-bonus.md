# 31 — Welcome Bonus (KES 200 sign-up deposit trigger)

Issue 1 deliverable. A KES 200 restricted welcome bonus granted on sign-up, celebrated with the
existing winning-card animation. This document is the authoritative design + implementation map.

## 1. Product intent & psychology (why KES 200, deliberately below min stake)

The core problem: **many users sign up but never deposit or play.** The KES 200 bonus is a
behavioural nudge engineered to convert those dormant sign-ups into first-time depositors. It is set
**KES 50 below the KES 250 minimum stake on purpose** — the gap *is* the mechanism, not a bug:

- **Endowment effect** — once the KES 200 sits in the user's wallet they psychologically *own* it and
  become loss-averse to letting it go to waste.
- **Goal-gradient effect** — motivation spikes as a goal nears completion. Being *almost* able to
  trade (holding KES 200 against a KES 250 min stake) pulls far harder than starting from zero. (The
  celebration CTA encourages depositing at least the DB min stake — "Deposit KES 250+ & play" — rather
  than naming the gap, so the copy never contradicts the configured minimum deposit.)
- **Zeigarnik effect** — an unused balance is an open loop that nags until closed.
- **Peak-end rule** — the winning-card celebration makes the *first* brand moment a "win", anchoring a
  positive emotional peak.

Design consequence: we **keep** KES 200 and **keep** the KES 250 min stake. We do NOT lower the min
stake or bump the bonus — removing the gap would remove the deposit trigger.

## 2. Money semantics (decision: restricted bonus)

- Credited to the restricted `bonus_balance` (non-withdrawable), tracked as a `bonuses` row
  (`type='welcome'`, `wagering_x = 3`, `status='active'`).
- **Bonus-first staking:** a stake draws `bonus_balance` before `real_balance`. So KES 200 bonus + a
  KES 50 real top-up funds a KES 250 trade (200 from bonus, 50 from real).
- **Wagering:** every staked shilling (real + bonus) accrues toward `amount × wagering_x` (KES 600).
  When met, remaining bonus converts to withdrawable `real_balance` (FIFO) and the row is `cleared`.
- **Withdrawal safety:** bonus funds never enter `real` until wagering clears, and `fn_create_withdrawal`
  only ever debits `real_balance` — so the gift can't be cashed out directly. Min withdrawal (KES 2,000)
  is a second gate.
- **Anti-abuse:** exactly one welcome bonus per user (partial unique index
  `idx_bonuses_one_welcome_per_user`). Demo/marketer (social-proof) accounts are excluded.
- **Scope:** global + default-on via the `bonus_config` singleton, so every brand (current and future)
  inherits it. Admin-tunable: `welcome_enabled`, `welcome_amount_cents` (20000), `welcome_wagering_x` (3).

## 3. Critical pre-existing finding this feature also fixes

Site-scoping (migration 0047) and the demo-isolation rewrite (0084) had **dropped all bonus handling**
from the live money RPCs: `fn_open_position`/`fn_settle_position` only moved real/demo balances, so
`bonus_balance` was frozen (never staked, wagered, or converted) and deposit-bonus *granting* was also
removed at 0077/0078. The `bonuses` table was empty platform-wide. Migration 0094 **restores** the
0037 bonus mechanics (bonus-first, wagering accrual, FIFO conversion) merged into the 0084 demo-aware,
site-scoped bodies — a no-op for every existing account (all have `bonus_balance = 0`) until a welcome
bonus is granted. Deposit-bonus granting is intentionally **not** re-enabled here (separate decision;
see docs/BUGLOG.md).

## 4. Implementation map

### DB — `packages/db/migrations/0094_welcome_bonus.sql` (additive; CREATE OR REPLACE)
- Drops the orphaned `fn_deposit_bonus_pct` — the welcome bonus is now the only bonus in the system.
- `bonus_config`: `welcome_enabled`, `welcome_amount_cents=20000`, `welcome_wagering_x=3`.
- `idx_bonuses_one_welcome_per_user` — one welcome per user (race-proof).
- `fn_grant_welcome_bonus(uuid) -> bigint` — idempotent, config/brand aware, skips demo accounts;
  credits `bonus_balance` + writes a `bonus` ledger row (`meta.kind='welcome_bonus'`). Returns cents.
- `fn_open_position` (10-arg, identical signature) — demo path unchanged; real path draws bonus-first
  then real, splits the stake ledger by `balance_kind`, accrues wagering on active bonuses.
- `fn_settle_position` (5-arg, identical signature) — demo path unchanged; real path credits payout to
  real, then FIFO-converts any bonus whose wagering is met (`meta.kind='wagering_conversion'`).
- `fn_clear_welcome_bonus(uuid)` + `trg_clear_welcome_on_marketer` trigger on `profiles` — when a
  player is promoted to a marketer (`role → 'marketer'` via ANY path), the welcome bonus is voided and
  the restricted balance removed (`meta.kind='welcome_void'`). Catches admin set-role, affiliate
  enrollment, and direct role updates with no RPC surgery.
- Signatures are byte-identical to 0084 so `PgGameRepository` calls them unchanged. Revert notes in tail.

### Engine
- `identity.ts` — `IdentityRepository.grantWelcomeBonus(userId)`; Pg calls `fn_grant_welcome_bonus`;
  InMemory mirrors it (test knob `welcomeBonusCents`, default 0).
- `authservice.ts` — `AuthSession.welcomeBonusCents?`; `register()` grants after the atomic register RPC.
  The grant is **non-fatal** (idempotent in the DB), so a transient failure never blocks sign-up.

### API
- `app.auth.ts` — `POST /auth/register` echoes `welcomeBonusCents` when > 0.

### Web
- `lib/game/welcomeBonusFx.ts` — celebration bus (separate from the game `outcomeFx` bus).
- `components/game/WelcomeBonusOverlay.tsx` — reuses the winning-card language (confetti, count-up,
  chip-flies-to-balance-pill, haptics, `pp-pop`); the CTA references the **DB-driven min stake**
  (`GameConfigDto.minStakeCents`, never hard-coded), encourages depositing at least that ("or more"),
  and seeds the deposit sheet with it.
- `components/Providers.tsx` — mounts the overlay beside `OutcomeOverlay`.
- `lib/auth/useAuthActions.ts` — on register with `welcomeBonusCents > 0`: refresh `['wallet']` and
  fire the celebration (short delay so the auth sheet closes first).
- `components/game/BetPanel.tsx` — affordability now counts `real + bonus` (spendable), so the bonus
  plus a real deposit can reach the min stake.
- `lib/game/GameSocketProvider.tsx` — invalidate `['wallet']` on settle (bonus/wagering stay live).
- `components/wallet/WalletWidget.tsx` — label corrected from "Deposit bonus" to "Bonus".
- **Deposit-bonus removed:** `DepositForm` preview deleted; shared `bonus.ts` (tiers/`bonusPctForDeposit`)
  and its `./bonus` export + tests removed. The welcome bonus is the only bonus.

### Promotion → marketer
A DB trigger (`trg_clear_welcome_on_marketer`) clears the welcome bonus the instant `profiles.role`
becomes `'marketer'` — no engine/API wiring needed, so it holds for every current and future promotion
path. Demo/marketer accounts never keep a real welcome bonus.

## 5. Tests
- **DB e2e:** `packages/db/_testkit/e2e_welcome_bonus.py` — 23 assertions: grant idempotency,
  marketer/disabled guards, bonus-first staking + ledger split + wagering accrual, insufficient-funds &
  min-stake gates, FIFO wagering conversion, zero-bonus non-regression, demo isolation.
- **Engine unit:** `apps/engine/src/authservice.test.ts` — grant surfaced on register, omitted when
  disabled, and never blocks registration on failure.
- Full `npm run typecheck` clean; full `npm test` green except one **pre-existing** unrelated failure
  (see docs/BUGLOG.md #3).

## 6. Rollout / ops
1. Deploy applies `0094` and records it in `schema_migrations` (runner / `scripts/migrations_status.mts --record`).
2. No engine/API signature changes — the deploy is drop-in.
3. Tune or disable per platform: `update bonus_config set welcome_enabled=…, welcome_amount_cents=…, welcome_wagering_x=… where id=1;`
4. Backfill (optional): existing never-deposited sign-ups can be granted by calling
   `select fn_grant_welcome_bonus(id) from profiles where …;` (idempotent, skips demo accounts).

## 7. Revert
See the REVERT block at the tail of `0094_welcome_bonus.sql` (restore 0084 RPC bodies verbatim, drop
the grant fn + index + config columns). Existing granted bonuses can be voided via the admin bonus tools.
