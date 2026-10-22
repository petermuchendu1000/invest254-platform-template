# 58 — Hide the phone number on the marketer side

**No migration.** Code-only, `apps/api/src/app.marketers.ts`.

The marketer till app only ever renders the agent's **own** number — it never sees another person's
number, and it never uses the number functionally (no self-withdraw route; the M-PESA confirmation
feed reads the brand name, not a phone). So the whole marketer-side surface is the `phone` field in
three responses: `POST /marketers/auth/login`, `POST /marketers/auth/login-web`, and
`GET /marketers/me`.

Those three now mask it with the canonical `maskPhoneForDisplay` (`0798****061` — 4 head + `****` +
3 tail, the house-standard mask already used on ~18 web surfaces; the brief's `07981****61` is the
same idea). Masking is applied at the **marketer-app response boundary only** via `maskedMarketer()`:

- The full number never leaves the server on a marketer-facing response (a test asserts the raw
  digits appear nowhere in the body), so this is a real hide, not a client-side cosmetic.
- **Admin / platform reads of a marketer keep the full number** (`/admin/marketers`,
  `/admin/marketers/:id`, etc.) — their web masks at render and offers a deliberate full-number
  copy/export, and operators legitimately need it to pay out. A test asserts the admin list and
  detail still return the full number, so the marketer-side mask cannot regress the operator view.
- No payment, identity or dedupe path is touched: the mask is on the display field of a response the
  app only renders. `maskPhoneForDisplay`'s own output provably fails `normalizeMsisdn`, so a masked
  value can never be mistaken for a dialable number downstream.

Attacker-facing phone exposure elsewhere (the platform-billing invoice payer MSISDN, and the
phone-substring search predicates that could confirm a full number even behind a masked display)
is **not** marketer-side and is handled in the Issue 3 hardening pass, not here.
