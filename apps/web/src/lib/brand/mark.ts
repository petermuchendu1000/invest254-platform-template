/**
 * The brand mark + favicon generator, re-exported from the shared package.
 *
 * It moved so the API can regenerate a brand's favicon when onboarding auto-assigns its theme (see
 * `@invest254/shared/siteThemes`). It is pure string/SVG work with no DOM, which is what makes it
 * safe to run on the server. This file stays so every existing web import keeps working.
 */
export {
  buildMarkSvg, faviconDataUri, markColorsFromTokens, markVariant, MARK_COLORS_LIVE, type MarkColors,
} from '@invest254/shared/brandMark';
