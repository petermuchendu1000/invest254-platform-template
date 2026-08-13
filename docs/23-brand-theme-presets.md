# 23 — Brand Theme Presets (client palette library)

> Turnkey, hue-spaced theme presets for the `/platform` palette editor. Selecting one sets a
> single **seed hue**; `deriveMinimalPalette(seed, mode)` expands it into the full token set the
> whole UI reads. Extends docs/22 Task G's per-brand theming with a curated starting menu.

## The principle (recap of docs/20 § theming)

A brand theme is **ONE hue**. Background, surfaces, border, text, brand, accent and the P/L graph
gain/loss all derive from that hue by lightness/chroma — never extra hues. The P/L graph is
**mono**: gain = vivid brand, loss = muted neutral of the *same* hue (calm, on-brand,
colourblind-safe). Classic green/red is an opt-in per-user toggle (`html.pnl-classic`).

## Why a curated menu (not "grab 100 brand colours")

We researched the dominant colours of 105 major companies (crypto-first) — the raw set is in
`docs/brand-hues-reference.json` (`accent` / `light` / `dark` per brand). Crypto skews heavily
blue (37/105), so a raw dump yields dozens of look-alike clients. The curated menu instead keeps
**iconic, hue-spaced anchors** so distinct clients stay visually distinguishable. A colour is not
ownable; `source` is attribution only and has no runtime effect.

## The curated presets (`apps/web/src/lib/brand/presets.ts`)

| Preset | Seed | Group | Hue | Source hue |
|---|---|---|---|---|
| Ledger Orange | `#FF5300` | Warm | 20° | Ledger |
| Bitcoin Orange | `#FF9500` | Warm | 35° | Bitcoin |
| Binance Gold | `#F0B90A` | Warm | 46° | Binance |
| Avalanche Red | `#FF394A` | Warm | 355° | Avalanche |
| NVIDIA Lime | `#76B900` | Green | 82° | NVIDIA |
| Trezor Green | `#89DB7F` | Green | 113° | Trezor |
| Spotify Green | `#1ED760` | Green | 141° | Spotify |
| Solana Spring | `#00FFA3` | Green | 158° | Solana |
| Algorand Teal | `#00BEA5` | Teal | 172° | Algorand |
| Gemini Cyan | `#26DDF9` | Teal | 188° | Gemini |
| XRP Azure | `#008CFF` | Blue | 207° | Ripple |
| Coinbase Blue | `#0052FF` | Blue | 221° | Coinbase |
| Stripe Indigo | `#635BFF` | Blue | 243° | Stripe |
| Ethereum Violet | `#6C24E0` | Violet | 263° | Ethereum |
| Uniswap Magenta | `#FF007A` | Pink | 331° | Uniswap |
| Graphite Mono | `#8A8F98` | Mono | 215° | Graphite |

## How it's wired

- `apps/web/src/lib/brand/presets.ts` — the typed menu (`BRAND_PRESETS`, `groupedPresets()`,
  `presetForSeed()`). Pure data + helpers, no side effects.
- `apps/web/src/app/platform/page.tsx` — the `PaletteEditor` gains a grouped preset `<select>`
  above the free seed-colour input. Choosing a preset sets the seed → the palette re-derives and
  previews live → **Save palette** persists via `fn_platform_set_site_theme` (platform_superadmin,
  audited). The free colour picker remains for fully custom hues.
- `apps/web/src/lib/brand/presets.test.ts` — asserts structure, hue spacing, grouping, and that
  every preset derives a valid, WCAG-AA-contrast, mono-P/L token set in both modes.

Nothing about money/data changes: this is purely the per-brand presentation layer.
