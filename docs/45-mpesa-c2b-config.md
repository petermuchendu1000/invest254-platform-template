# 45 — M-Pesa C2B (Pay Bill) configuration and URL registration (PAY-2)

Owner question (2026-09-23): *"Under /platform/mpesa I see B2C command. Are there no C2B configs?"*

## Before

- **C2B receiving already existed.**
  - The manual "Lipa na M-PESA · Pay Bill" rail was added in 0115.
  - `POST /deposits/c2b/confirmation` stores every payment Safaricom reports in `c2b_payments`.
  - Players claim a payment by its M-PESA code.
  - `paybill_config` holds what players are shown.
- **What was missing:**
  - There was no way to edit `paybill_config`: it was seed-only.
  - There was nowhere to set the Confirmation and Validation URLs.
  - The URLs were never registered with Safaricom (Daraja C2B RegisterURL). Safaricom only sends confirmations to URLs that have been registered for the shortcode.
  - The M-Pesa page had no C2B section at all.

## Now

| Layer | What |
|---|---|
| DB `0163_c2b_config.sql` | `paybill_config` gains `confirmation_url`, `validation_url`, `response_type` and the last registration's outcome. New functions: `fn_admin_get_c2b_config` (adds health: payments received in the last 7 days, unclaimed payments, last payment), `fn_admin_update_c2b_config` (validated and audited as `c2b.config`), `fn_admin_record_c2b_registration` (audited as `c2b.register_urls`), and `fn_c2b_url_ok` (Safaricom's URL rules). All are owner tier and callable by service_role only. |
| Engine | `registerC2bUrls` calls Daraja `POST /mpesa/c2b/v2/registerurl` with the System app's credentials. A Safaricom "no" is returned as a result, not thrown. `C2bConfigService` does the registration and always records the outcome. |
| API | `GET` and `PATCH /admin/c2b-config`, and `POST /admin/c2b-config/register`. Owner tier. Errors come back as plain messages. |
| Web | `/platform/mpesa` is split into four tabs by purpose: **Deposits (STK)**, **Payouts (B2C)**, **Pay Bill (C2B)** and **Credentials** (`?tab=` in the URL). The C2B tab has three sections. **Status**: Not set up, Not registered, Re-register or Registered, plus received, unclaimed and last payment. **What players pay into**: whether it is offered, the Pay Bill/Till number, the account number, the business name and instructions. **Where Safaricom sends payments**: the URLs are pre-filled for this deployment, Safaricom's rejected words are flagged inline, and the setting "if validation can't be reached" can be accept or reject. The **Register with Safaricom** button asks for confirmation. Endpoint URLs pre-filled into empty fields count as suggestions, so the page no longer says "Save 3 changes" before you have touched anything. |

## Safaricom rules applied

- C2B URLs must be public `https://`.
- A C2B URL must not contain M-PESA, MPESA, Safaricom, exec, exe, cmd, sql or query.
- `ResponseType` must be `Completed` or `Cancelled`.
- Validation is only called if Safaricom has enabled external validation on the shortcode. When no validation URL is set, the confirmation URL is sent in its place.

## Limits

- Per-platform Pay Bill shortcodes are still out of scope. The manual Pay Bill rail stays System-only (docs/43 §3.6).

## Tests

- `e2e_c2b_config.py`: BEFORE reproduces the gap; AFTER runs 18 checks covering authorization, validation, Safaricom's URL rules, audit, how a registration is recorded, health and grants.
- `c2bconfig.test.ts` (3): the v2 request body sent to Daraja, a rejection being recorded, and the preconditions.
- `app.c2b.pay2.test.ts`: role gating, validation, register, and 409s.
- Role e2e +5: suggested versus unsaved changes, the C2B tab, status and health, Register calls the API, and a rejected URL is flagged.
