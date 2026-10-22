# 61 — Corrections to Issue 1 (force sign-out) and Issue 2 (phone masking)

**BUGLOG:** #132, #133 · **Migration:** `0200_force_logout_marketer_website_sessions.sql`

Both original fixes were real but hit the **wrong surface**. The owner reported, correctly, that no
marketer had been signed out and that the phone was still fully visible at sign-in. This documents what
was actually wrong and what now closes it.

---

## A. Force sign-out never reached the marketers' real session (#132)

### What 0198 did
It added a force-logout epoch to `public.marketers` and stamped all 24 rows. That identity is the
**till app**: token subject = `marketers.id`, enforced in `requireMarketer`, which gates `/marketers/*`
routes and nothing else.

### What marketers actually use
A marketer who signs in on the **website** holds an ordinary `profiles` token with `role='marketer'`.
That session was never ended, for **two independent reasons**:

1. **Never stamped** — `profiles.sessions_valid_after` was null for most marketer profiles
   (measured in production: 28 marketer profiles, only 11 carried any value, and those from unrelated
   earlier admin actions).
2. **Never read** — even a stamped value would have been ignored. The verifier's gate is:

   ```ts
   async assertSessionValid(userId, role, iat) {
     if (!isPrivilegedRole(role)) return;        // ← marketer returns HERE
     ...
   }
   ```
   with `PRIVILEGED_ROLES = {admin, platform_admin, platform_superadmin}`. `marketer` is not in it, so
   the DB read was skipped entirely for marketer tokens. (That early return is a deliberate performance
   choice: player traffic must not do a DB read per request.)

Net effect: the headline control of Issue 1 did nothing for the accounts it was written for.

### The fix
**Code** — `apps/engine/src/authservice.ts`:

```ts
export const SESSION_GATED_ROLES: ReadonlySet<string> = new Set([...PRIVILEGED_ROLES, "marketer"]);
```
`assertSessionValid` now gates on `isSessionGatedRole(role)`.

Three deliberate boundaries:
- **A separate set, not an addition to `PRIVILEGED_ROLES`.** That set also drives the password-reset
  knowledge-factor gate and the MFA requirement; a marketer must stay non-privileged there.
- **Players still excluded**, so the high-volume path keeps skipping the DB read.
- **The 0196 five-minute IDLE timeout stays operator-only.** Applying it to marketers would sign them
  out mid-demo every five minutes — worse than the bug.

**Data** — migration 0200 stamps `profiles.sessions_valid_after = now()` for every `role='marketer'`
and re-stamps `public.marketers`, so both identities end at the same moment.

### Deploy-window caveat
`migrate` runs **before** the new API rolls out, so a marketer who signs in during that gap gets a
token issued *after* the epoch and stays signed in. Close it by re-stamping once the deploy is green:

```sql
update public.profiles  set sessions_valid_after = now() where role = 'marketer';
update public.marketers set sessions_valid_after = now(), updated_at = now();
```

---

## B. The phone was visible where it is TYPED, not where it is returned (#133)

### What Issue 2 did
It masked `phone` in the three `/marketers/*` responses (`login`, `login-web`, `me`) via
`maskedMarketer()`. That is still correct — but it is about **response bodies**.

### What was actually on screen
The number a marketer exposes is the one they **type into the website sign-in / sign-up form**, which
rendered plaintext with no hide toggle — while the password field right beneath it already had one.
Marketers demo the platform on live streams from sign-up onwards, so their real MSISDN was on camera.

### The required shape — a PARTIAL mask, not a password blob
Owner's requirement, verbatim: the field *"should look like `0798***61`, and the user can click the eye
thing to see the hidden characters, **not completely hide the number**"*. So the field reads as the
house partial mask `0798****061` (`maskPhoneForDisplay`) — head and tail visible, so you recognise it
as your own number — and the eye reveals the hidden middle digits. A `type="password"` blob of dots is
explicitly **not** what is wanted.

### How it is implemented, and why `focused` exists
`apps/web/src/lib/auth/phoneMask.ts` (unit-tested in `phoneMask.test.ts`):

```ts
phoneDisplay(real, revealed, focused) => (revealed || focused || !real) ? real : maskPhoneForDisplay(real)
isMaskedValue(v) => v.includes('*')
```

An `<input>` renders whatever is in its `value`. Showing the mask *while someone is typing* would feed
the mask straight back through `onChange`, where the digits-only normaliser would strip the `*` and
silently post a **different, valid-looking number** (`0798****061` → `0798061`) — on the sign-in field.
So:
- **at rest** (not focused, not revealed) → the partial mask. This is the state that is on screen for
  almost the whole stream, including immediately after browser autofill.
- **while focused** → the real digits, because you cannot type into or correct a value you cannot see.
- **eye on** → the full number, without needing focus, and it stays shown.
- every `onChange` is guarded by `isMaskedValue`, so a masked value can never be read back as input.

Sites fixed:

| Site | Was | Now |
|---|---|---|
| `auth/AuthModal.tsx` phone field (serves **signin + signup + reset**) | `type="tel"`, full number plaintext, no toggle | `phoneDisplay(...)` → `0798****061` at rest, eye reveals |
| `auth/AdminSignIn.tsx` phone field (operator sign-in) | same | same (its local `Field` gained `onFocus`/`onBlur`) |
| `billing/parts.tsx` "Enter your M-Pesa PIN on **{phone}**" | raw own number | `maskPhoneForDisplay(phone)` |
| `billing/parts.tsx` phone input, prefilled from `me.phone` | plaintext prefill | `phoneDisplay(...)` + Show/Hide |

`type` stays `tel` and `inputMode` is unchanged on every field, so the numeric keypad and autofill
behave exactly as before, and the **submitted value is identical** — only the rendering changes.

### Residual exposure, stated plainly
While the field has focus the digits are visible. That is unavoidable for an editable field (and the
owner asked for a partially-visible number, not a blob). What this closes is the resting state: the
number is masked before focus, after blur, and immediately on autofill — i.e. for all of the stream
except the seconds spent actively typing it.

### Deliberately NOT changed (and why)
- **Deposit / withdrawal destination inputs** (`DepositForm`, `WithdrawForm`): you must be able to read
  a destination number back before money moves; masking it by default invites a mistyped payout. These
  screens already display the *stored* number masked — only a freshly typed replacement is visible, and
  the field is explicitly cleared when you tap "Change".
- **`/auth/me` still returns the full number.** The client needs it to prefill deposit/withdraw; a
  masked string fails `normalizeMsisdn`. Every render of it already routes through
  `maskPhoneForDisplay` (account menu, settings panel, deposit/withdraw cards).
- **Admin "edit user" / "edit marketer" phone inputs** keep their full prefill — the value is saved
  back, and these are operator-only screens, not the marketer sign-in path.
- **`InvoiceDocument.tsx`** payer MSISDN stays raw (a printable financial record; noted as out of scope
  in docs/58).

---

## Lesson for future work on this pair
"Masked at the API boundary" and "not visible on screen" are different claims. Issue 2 verified the
first and asserted the second. Likewise, "the epoch is stamped" and "the session ends" are different
claims — the gate that reads the epoch has a role allow-list, and stamping an identity nobody
authenticates as changes nothing. Both now have tests that assert the *observable* behaviour.
