/**
 * The curated site themes, re-exported from the shared package.
 *
 * The data moved to `@invest254/shared/siteThemes` because the API needs it too: a brand onboarded
 * without a theme renders with three CSS variables and falls back to the stock design system, which
 * is why seven live brands looked unthemed (BUGLOG #137). The onboarding path now auto-assigns one
 * server-side, and server and console must choose from the SAME library — two copies would drift,
 * and a brand's look would then depend on which screen created it.
 *
 * This file stays so every existing web import keeps working.
 */
export { SITE_THEMES, siteTheme, type SiteTheme, type SiteThemeTokens } from '@invest254/shared/siteThemes';
