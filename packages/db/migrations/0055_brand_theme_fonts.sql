-- 0055_brand_theme_fonts.sql — per-brand typography (docs/23 follow-on to 0054).
--
-- 0054 gave each brand a full COLOUR token set in `theme_tokens`. This adds the two TYPOGRAPHY
-- keys the web layer reads — `fontTitle` (headings) and `fontBody` (text) — so a brand's type is
-- as brand-specific as its palette. The app maps them to --pp-font-title / --pp-font-body and
-- loads the faces from Google Fonts (a curated, free/self-serve set; see apps/web/.../fonts.ts).
--
-- Seeds the default brand (Invest254) to match the app's DEFAULT_BRAND. Additive + idempotent:
-- only fills the keys when they are absent, so re-runs and existing custom themes are untouched.
-- No new RPC is needed — fn_platform_set_site_theme (0054) already persists arbitrary theme_tokens
-- jsonb, including these font keys, from the platform palette editor.

update public.sites
   set theme_tokens = coalesce(theme_tokens, '{}'::jsonb)
     || jsonb_build_object('fontTitle', 'Space Grotesk', 'fontBody', 'Inter')
 where id = '00000000-0000-0000-0000-000000000001'
   and (theme_tokens is null or not (theme_tokens ? 'fontTitle'));
