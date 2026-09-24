# 44 — Operator console UI overhaul (UI-A … )

Owner request (2026-09-23): *"improve the UI — the sidebar (use dividers etc), make sure the UI is well presented,
well organized, and easy to use … all UI interfaces. Fix confusing or dead designs … Focus on all admin levels."*

## Method

1. **Audit on realistic data.** A local database is built from every migration and seeded with a System owner, a
   platform (Alpha Markets) with two brands, a platform admin, brand admins, marketers, 25 players with deposits,
   bets and withdrawals, tickets and audit rows. The real API runs against it and the production web build is
   screenshotted per tier (brand admin, platform admin, System owner) at desktop (1440) and phone (390) widths:
   74 screens. Nothing touches production.
2. **Reference patterns.** NN/g vertical navigation and menu guidelines (visible left nav, labelled groups,
   "you are here", frequent items first, familiar patterns), Atlassian side navigation, Shopify Polaris and the
   shadcn/ui sidebar anatomy (workspace header, labelled groups, separators, footer user menu, icon-rail
   collapse with ⌘/Ctrl+B, sheet on mobile).
3. **One issue at a time**, each with failing checks first (role e2e in headless Chromium), then the fix, then
   merge → deploy → verify.

## Findings (abridged; P1 = broken/misleading)

| Area | P1 | P2 (selection) |
|---|---|---|
| Navigation shell | owner collapse chevron drawn over page titles; no Log out on phones; phone strip hid the current page | flat lists of 10–16 items; duplicate icons; loud active fill; unclear/near-duplicate labels; "client"/"brand"/"site" and "System admin"/"System owner" used interchangeably |
| Shared components | "now ago" relative time | 3 date formats; mixed money formats and wrapping; table header casing/number alignment; disabled buttons never say why; three tab styles; badge colours/casing |
| Pages | Withdrawals Reject/Mark paid clipped; announcement "edit the body" with no body field; read-only overrides that look editable; fake "▲100%" deltas; two phone pages scroll sideways | nearly-empty Billing/Deployment pages; duplicated pool controls; developer notes in the UI; jargon (RTP, GGR, drift) unexplained |

## UI-A — navigation shell (this change)

One shared `ConsoleShell` (components/console) for every admin tier, navigation defined once in
`components/console/nav.tsx` (capability-gated on the token role):

- **Brand admin**: Overview · MONEY Withdrawals, Finance, Marketer payouts, Reports · PLAYERS Users, Announcements ·
  SUPPORT Player chats, Platform tickets · BRAND Add-ons & gateways.
- **Platform admin**: Overview, Tickets · BRANDS Onboard brand, Domain registrar · MONEY Payment accounts,
  Withdrawal pool · OVERSIGHT Audit log · ACCOUNT Billing.
- **System owner**: Overview, Tickets · BRANDS & PLATFORMS Platforms, Onboard brand, Domain registrar, Brand back
  office · MONEY Payment accounts, Gateways, M-Pesa defaults, Withdrawal pool · COMMERCIAL Billing, Add-ons &
  requests · SYSTEM Controls & economy, Audit log, System logs, Deployment.

Details: workspace header that truncates instead of overflowing; labelled groups with dividers (dividers stay in
the collapsed rail); one current item (longest match; a brand page keeps Overview current) with a quiet highlight
and accent bar; a distinct icon per destination; footer with collapse (⌘/Ctrl+B) and the account (avatar,
@username, role, Log out); ⌘K palette lists every page of the tier plus brands. Phones: sticky top bar naming
the current page + a drawer with the same navigation and Log out (Escape/backdrop close, scroll lock).
The owner's brand picker now opens inside the console. Page titles match nav labels; role names come from one
helper (`lib/roles.ts`: System owner / Platform admin / Brand admin).

Tests: `nav.test.ts` (unique routes/labels, tier separation, current-item rules); role e2e +16 checks (grouping,
header containment, current item, all routes reachable, distinct icons, picker inside the console, phone drawer
with current page + Log out + Escape, no sideways scroll) — 15 failed before, all pass after.

## UI-B — shared formatting and primitives

- One time/date/number vocabulary (`lib/format.ts`): `formatAgo`, `formatDate`, `formatDateTime`, `formatNumber`, all en-KE. Money is `formatKes` / `<Money>`, which never wraps.
- `Th`/`Td` take `numeric` (right-aligned, tabular, no wrap). Headers never wrap, and sortable headers use the same casing as the others.
- `StatCard` values never wrap. `StatusBadge` uses sentence case and never wraps. `Empty` takes an action. `PageHeader` caps its subtitle width and wraps its actions.
- `SearchInput`: one 36px toolbar search with an icon.
- Disabled buttons use a neutral style whatever their variant, and can carry a tooltip that says why.
- Overview: "Brands" (was "Clients") and "Onboard brand". The KPI grid now wraps as 4 + 3 instead of squeezing 7 tiles until values truncate.

## UI-C — page-level P1 fixes

- **Withdrawals.** The Action column is pinned to the right edge and the phone view uses cards. The columns are Player (with phone and receipt), Amount, Status, Balance, Lifetime (in/out/net) and Requested. Above the table sits one summary line ("2 awaiting review · KES 1,520 held"), and the kill switch is a compact row.
- **Announcements.** Title and message can be edited and are sent through migration 0162. There is a live preview, a plain count of people, and a brand-scoped "Remove active notices".
- **Overview trends.** A metric with no activity in the earlier half shows "New", never a fake "▲100%". Each metric is coloured by what counts as good news for it.
- **User page.** Read-only overrides are shown as values.
- **Tabs.** `PageTabs` (underline tabs, arrow-key navigation, scrolls on phones) replaces the old tab controls. `useTabParam` keeps the open tab in the URL. The brand page gains an Add-ons tab.

## UI-D — Payment accounts and Gateways (owner request, 2026-09-23)

- **Gateways** (`/platform/payments`) is now one list, following the Stripe "payment methods" pattern:
  - M-Pesa is listed first. It used to be missing from this page.
  - Each row shows a plain-language description and what the gateway offers (Deposits / Payouts).
  - Status is one word or phrase: Live, Ready · not offered, Not set up, or Coming soon. This replaces "Hidden" and "Config only".
  - Each row has an in-place **Offered to players** switch. It is disabled until the gateway is set up, and turning it off asks for confirmation.
  - A summary line counts the live gateways.
- **Gateway detail:**
  - A status pill sits next to the name, with a plain description.
  - A **Setup** checklist shows Credentials saved, Connection tested and Offered to players.
  - Per-brand availability is a list of every brand with Default / On / Off. Before, you had to pick a brand first.
  - Jargon is gone: "AES-256-GCM", "clients", and so on.
- **Payment accounts:**
  - Go-live readiness is a two-step checklist (Deposits, Withdrawals) that says what is still needed. The disabled Go-live button says why it is disabled.
  - Gateway cards show chevrons and plain descriptions, and missing fields are listed in words.
  - A single-option environment is shown as read-only text.
  - The M-Pesa labels are plain: Deposit type, Payout shortcode, Initiator name, Payout type. The shared engine schema changed only its labels; the keys are unchanged.
- **Tests:** role e2e +3, plus the payment-accounts readiness check updated (142/142 pass).

## UI-E / UI-F — focused pages (owner request, 2026-09-24)

The rule is that each job has one home, and every other page links to it. Research basis: the task-oriented IA used by Stripe and Shopify admin, where each object page is the single place to change that object and summaries elsewhere link to it rather than copying controls, and the two-level scope switchers of multi-tenant consoles (org → project).

| Job | Its one home | Places that now only link |
|---|---|---|
| Pool mode and today's budget | Withdrawal pool (owner "Adjust…") | Brand → Economy (a note) |
| Gateway on/off, per brand | Gateway page (only brands that own the add-on) | Gateways list (state only), brand page |
| Audit | `/platform/audit` (owner: any platform; platform admin: its own) | Brand header "Audit log", `/platform/activity` (redirect) |
| Brand admins | Console → brand → People | Back-office user page (a note) |
| Player status, balance, notices | Back office → user page | Console People ("Manage in back office") |
| Player overrides | Console → brand → People | Back-office user page (read-only) |
| Marketer expenses, advances, demo wallets | Back office → Marketer payouts | User page (deep links, `?marketer=`) |
| Return to player and game health | Back office → Reports → Health | Overview "Needs attention" |
| Choosing a brand to work on (owner) | Brand back office: platform, then brand | — |

Copy was rewritten in plain words: "House revenue" instead of GGR, "Return to player" instead of RTP, and "Price trend" and "Price movement" instead of drift and volatility. Audit actions are shown in words, with the raw record in a disclosure.
