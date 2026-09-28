# 50 — Bonuses on/off, per platform and per brand (migration 0173)

**Status:** applied to production 2026-09-28 (ledger 174/174). Behaviour-neutral on landing — every
platform and every brand defaults to ON.

## 1. What was missing

`bonus_config` is a **singleton** (`id int primary key check (id = 1)`), so `welcome_enabled` was one
global flag for every platform and every brand at once. There was no per-platform or per-brand
control, and **no admin surface for it at all** — the only way to stop bonuses was a manual `UPDATE`
on that singleton, which would have stopped them for all 15 brands on both platforms simultaneously.

An operator whose brand is overspending on sign-up bonuses had no way to stop just that brand; a
platform owner had no way to pause just their own platform.

## 2. The model — three levels, all must be ON

```
system (bonus_config.welcome_enabled)  AND  platform (platforms.bonuses_enabled)
                                       AND  brand    (sites.bonuses_enabled)
```

**AND, not "nearest wins."** A switch is a safety control: any level must be able to stop the spend,
and no lower level may re-enable what a higher one has stopped. This is the same composition the
existing money kill-switches use (`platform_global_config.withdrawals_enabled` AND
`sites.withdrawals_enabled`, migrations 0067/0092).

Resolution and enforcement both live in SQL:

| Function | Purpose |
|---|---|
| `fn_bonuses_enabled(site) -> boolean` | the effective answer — the AND of the three levels |
| `fn_bonus_switches(site) -> jsonb` | the breakdown (`system`/`platform`/`brand`/`effective`, plus the amount and wagering multiple) so the console can name the level holding a brand off |
| `fn_admin_set_bonuses_enabled(actor, role, site, enabled)` | flip THIS brand — `admin`, `platform_admin`, `platform_superadmin`; audited as `bonuses.toggle` |
| `fn_platform_set_bonuses_enabled(actor, role, platform, enabled)` | flip a PLATFORM — `platform_superadmin` for any, `platform_admin` for the one its `profiles.platform_id` names; audited as `platform.bonuses.toggle` |

A site that cannot be resolved (null/unknown id) falls back to the **system switch alone** — exactly
the behaviour before this migration. Fail-open at the scope levels, fail-closed at the system level.

### Why gating one function is complete coverage

`fn_grant_welcome_bonus` is the **only** routine in the database that grants a bonus. This was
verified, not assumed: every `prokind='f'` routine in `public` was scanned for an insert into
`bonuses`, and it is the single hit. The 0037 deposit-bonus grant was removed at 0077/0078 and its
tier helper dropped at 0094. `0173` replaces the 0094 body byte-for-byte apart from one line — the
global `welcome_enabled` test becomes `fn_bonuses_enabled(v_site)` (which still includes it) once the
wallet lock has resolved the brand.

## 3. Scope of a flip — future grants only

Switching bonuses off stops **new** grants. Bonuses already granted are untouched: they keep their
wagering progress and still convert to real balance on `fn_settle_position`. Turning the tap off must
never confiscate money a player was already given — at the time of writing, 12 brands hold 2,325
bonus rows and KES 244,700 of restricted balance.

## 4. Operator surface

**Console → Money → Bonuses** (`/platform/bonuses`), for both operator tiers:

- the platform switch the operator owns (a platform admin always acts on its own platform; the system
  owner may name another with `?platform=<uuid>`),
- every brand below it, each with its own switch **and** its effective state,
- an explicit "held off by the platform/system switch above" line on any brand whose own switch is on
  while a level above it is off — the failure mode of a plain toggle is an operator flipping a brand
  on and believing bonuses resumed.

Turning bonuses **off** is confirmed; turning them **on** is immediate. Same asymmetry as the
withdrawals kill switch: the disruptive direction asks, the safe direction does not get in the way.

API:

| Route | Who | What |
|---|---|---|
| `GET/PUT /api/v1/admin/bonuses-enabled` | brand admin (own brand) | this brand's switch + the levels above it |
| `GET/PUT /api/v1/platform/bonuses` | platform admin / system owner | the platform switch + every brand under it |
| `PUT /api/v1/platform/sites/:id/bonuses` | platform admin / system owner | one brand's switch (`scopeSiteParam` refuses a brand outside the caller's platform) |

## 5. Product note — what switching it off costs

The welcome bonus is a **deposit trigger**, not a giveaway: KES 200 is set KES 50 *below* the minimum
stake on purpose, so a new player owns a balance they cannot quite use and tops it up (docs/31 §1 —
endowment effect, goal-gradient, Zeigarnik open loop). Switching it off removes that nudge, so expect
fewer first-time deposits on the brands turned off. The console says so on the screen rather than
presenting the switch as free.

## 6. Verification

Before applying, the whole migration was run against **production inside a transaction and rolled
back**, asserting on live data: all-on grants; platform-off, brand-off and system-off each stop the
grant; an unknown/null site falls back to the system switch; a `platform_admin` is refused on another
platform and allowed on its own; a site admin is refused on the platform switch; the legacy
`superadmin` literal and `player` are refused; `fn_grant_welcome_bonus` returns 0 while off and
credits exactly 20000 again when switched back on; both toggles write their audit rows. The rollback
was confirmed clean (0 columns, 0 functions, 0 audit rows) before the real apply.

Automated coverage: `apps/api/src/app.bonusswitch.test.ts` (9 end-to-end cases — grant/no-grant on
sign-up, a brand cannot re-enable itself over its platform, one platform's switch does not reach
another's brands, cross-platform refusal, player/site-admin refusal, body validation, and the money
invariant that an already-granted bonus survives a flip).

> Note on role lists: 0067's allow-list also carried the legacy `superadmin` tier. That tier was
> removed (docs/42 UI-11 / BUGLOG #40), so it is deliberately **not** repeated in 0173 — the guard
> `apps/api/src/legacyroles.guard.test.ts` caught the first draft that did.
