# 48 — Add-ons marketplace (ADDON-1)

Owner request (2026-09-23): *"We need a complete overhaul of the /addons page (especially from the platform and
owner admin sides). The current one looks like a total joke, from UI, configs, implementations, etc. We need a
professional, industry-standard [page]."*

Owner decision (BILL-1): the owner chooses each add-on's pricing — **free, one-off or monthly**, with an optional **setup fee**. Charges land on the platform's consolidated invoice (docs/47).

## 1. What was wrong

| Area | Before | Now |
|---|---|---|
| Player experience | Brands could buy *Area*, *OHLC bars* or *Baseline*, but the API coerced every chart except candlestick to `line`. Players never saw what the brand paid for. | Every chart system reaches players. Line uses the canvas curve. Area, candlesticks, bars and baseline open the TradingView view on that series type. The mapping is `chartStyleOf` / `tradingViewTypeOf` in `@invest254/shared/chart`. |
| Catalog | A name and a price. The pricing model could not be edited. Nothing described an add-on. Add-ons could not be hidden. There were no adoption numbers. | Name, description, pricing model (free / one-off / monthly), price, setup fee and "offered" can all be edited, with rules enforced in SQL: free has no price, a paid model needs a price, and a category's default stays free and offered. The owner also sees adoption: brands that own it, brands using it, and open requests. |
| Requests | Deciding a request overwrote the brand's reason with the owner's note. A request could not be withdrawn. The decision returned `"rejectd"`. | The brand's reason and the owner's reply are stored separately. The requester (or anyone in its scope) can withdraw. The decision returns `approved` / `rejected`. |
| Billing | Changing a price between request and approval changed what the brand paid. Removing an add-on before it was invoiced still billed it. | The brand pays the **quoted** price: the request snapshots the model, price and setup fee, and the charge trigger uses them. Removing an add-on voids its un-invoiced charges. |
| Switching | Only the owner could change a brand's chart or trade screen, by re-granting it. | A brand admin or platform admin can switch between systems the brand **owns** (`fn_addon_activate`). |
| Notices | "admin requested \"area\" (chart) for brand tamu". | Product and brand names. An approval says exactly what is billed and when. A decline gives the reason. |
| Platform admins | No add-ons page; only a tab on each brand page. | `/platform/add-ons` in their navigation shows a brand picker, the marketplace and their platform's request history. |

## 2. Screens

- **System owner, `/platform/addons`:**
  - KPIs: open requests, paid add-ons owned, monthly add-on revenue, and how many add-ons are offered.
  - **Requests:** an inbox with Open / Approved / Declined / Withdrawn filters. Each card shows the product preview, the brand, platform and quoted price, who asked and when, and their reason. **Approve…** states exactly what gets billed; **Decline…** requires a reason the brand will see.
  - **Catalog:** grouped tables of pricing model, price, setup fee, brands and status, with an **Edit** dialog. The dialog has pricing-model radio cards and previews what brands will see.
  - **Brands:** one row per brand with its chart in use, its trade screen, and chips for the paid add-ons it owns. **Manage** opens the marketplace in owner mode, where the owner can assign, remove or review.
- **Marketplace** (brand admin `/admin/systems`, platform admin, and brand-page tab):
  - Cards in the Shopify App Store style: a preview (a sketch of the chart type, a gateway logo, or the trade screen), a one-line promise, an honest price ("KES 8,000 / month + KES 2,500 setup"), a state (In use / Owned / Requested / Available), and **one** next action: Request (with a reason), Withdraw request, Use this, or Set up.
  - The request history shows both sides' notes.

## 3. Data (migration 0166)

- `addon_catalog.description`.
- `addon_requests.billing_type`, `setup_fee_cents` and `decision_note`.
- RPCs:
  - `fn_addon_update(actor, role, category, key, patch)`.
  - `fn_addon_cancel_request`.
  - `fn_addon_activate`.
  - `fn_addon_brands`.
  - Richer `fn_addon_catalog_list`, `fn_addon_brand_view` and `fn_addon_list_requests`.
  - `fn_addon_request` and `fn_addon_decide_request` rewritten.
  - The quoted-price `trg_billing_addon_charge` and the void-on-remove `trg_billing_addon_uncharge`.
- Everything is service_role only and audited (`addon.update`, `addon.request.cancel`, `addon.activate`, `addon.request.reject`).
- API routes: `PATCH /addons/catalog/:category/:key` (owner), `POST /addons/requests/:id/cancel`, `POST /addons/activate`, `GET /addons/brands` (platform tier).

## 4. Tests

- `e2e_addon_marketplace.py`: BEFORE reproduces 4; AFTER 46 checks. `e2e_billing.py` is updated for void-on-remove.
- API: `app.addons.test.ts` has an ADDON-1 case. The shared chart-style test covers the player mapping.
- Role e2e: 21 new checks (owner inbox, decide, catalog edit, default lock, brands tab; platform admin marketplace, switch, request, withdraw, history, phone width); 181/181 pass.
- Real stack: a brand on Area now shows the TradingView area chart to players.
