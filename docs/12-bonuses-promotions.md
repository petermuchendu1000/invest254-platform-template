# 12 — Bonuses & Promotions

## 1. Bonus balance & wagering
- Bonuses credit **bonus_balance** (restricted), tracked in `bonuses` with a **wagering requirement**
  (`wagering_x`): the bonus must be staked `amount × wagering_x` before it converts to **real_balance**.
- Play debits bonus before real (configurable); `wagered` increments by qualifying stake.
- When `wagered ≥ amount × wagering_x` → bonus `status='cleared'`, remaining bonus moves to real.
- Expiry: uncleared bonus past `expires_at` → `status='expired'` (removed from bonus_balance).

## 2. Bonus types
| Type | Trigger | Example |
|------|---------|---------|
| welcome | first sign-up | **KES 200** restricted bonus, wagering ×3 (global default; per `bonus_config`, can disable). Credited to `bonus_balance` on registration; celebrated with the winning-card animation. See §6 + docs/31 + migration 0094. |
| promo (deposit-match) | redeem `promo_code` on deposit | 100% match up to KES 500, wagering ×5 |
| promo (fixed) | redeem code | flat KES 50, wagering ×2 |
| manual | admin-issued | goodwill / retention |

## 3. Promo codes
- `promo_codes`: `type` (deposit_match/fixed), `value`, `max_amount`, `wagering_x`, `uses_left`,
  `expires_at`, `active`.
- `POST /promo/redeem { code }` validates active/uses/expiry, applies bonus, decrements `uses_left`.

## 4. Rules & anti-abuse
- One welcome bonus per phone/device.
- Bonus funds are **non-withdrawable** until wagering cleared; withdrawal attempts with active
  wagering are blocked (clear message shown).
- Affiliate commission does **not** accrue on bonus-funded turnover (see Affiliate doc).
- Max bonus exposure per user; admin can void abusive bonuses (audited).

## 5. Activity feed
- Bonus issuance can emit a feed item ("BONUS of X issued"), matching the screenshot.

## 6. Welcome bonus (KES 200) — sign-up deposit trigger
Full design + psychology + implementation map: **docs/31-welcome-bonus.md**. Summary:
- **What:** every new PLAYER is granted **KES 200** to `bonus_balance` on registration (restricted;
  wagering ×3; non-withdrawable until wagered). Global + default-on (`bonus_config.welcome_*`), so
  every brand — current and future — inherits it. Demo/marketer accounts are excluded.
- **Why KES 200 (deliberately below the KES 250 min stake):** the goal is a **deposit trigger**, not
  a free trade. Endowment effect + goal-gradient (a user is "only KES 50 away") + the Zeigarnik
  open-loop convert sign-ups-who-never-deposit into first-time depositors. Bonus is spent bonus-first,
  so KES 200 bonus + a KES 50 top-up funds the first KES 250 trade.
- **How it's used:** the money RPCs (`fn_open_position`/`fn_settle_position`) stake bonus-first, accrue
  wagering on every staked shilling, and convert cleared bonuses to real (this bonus machinery was
  dormant since site-scoping 0047; migration 0094 restores it while preserving demo isolation).
- **UX:** the winning-card animation (`WelcomeBonusOverlay`, reusing `OutcomeOverlay`'s confetti /
  count-up / chip-to-balance-pill) fires on sign-up. The CTA encourages depositing at least the
  **min stake read from the DB** (`site_game_config.min_stake` → `minStakeCents`; never hard-coded) —
  "Deposit KES 250+ & play" — and seeds the deposit sheet with that amount ("always encourage more").
  Active bonus + wagering progress show in the wallet widget.
- **Lifecycle:** if a player is later **promoted to a marketer** (any path — admin set-role, affiliate
  self-enrollment, or a direct role change), the welcome bonus is **cleared immediately** (bonus voided,
  restricted balance removed, audit ledger entry) — marketers are demo accounts and must not hold a
  real welcome bonus. Enforced by a DB trigger on `profiles.role → 'marketer'`.
