/**
 * Who wears the simplified "basic" skin — the policy, with no dependencies.
 *
 * OWNER POLICY: a marketer gets the PLAYER interface, exactly. Same shell, same chart, same wording,
 * same money. One app, one UI.
 *
 * It used to be the opposite. The P1–P3 neutral skin was built so the marketer app would be
 * TikTok-safe — not readable as a binary-options terminal — and a marketer was pinned to it
 * permanently: money as game points, Buy/Sell as wordless arrows, neutral nav and instrument names,
 * the 18+/licence/responsible-gaming rows hidden, and (once the terminal landed) no MetaTrader chrome
 * at all, because `isTerminalScreen` disqualifies a basic-skin screen. The result was two products: a
 * marketer demonstrating the app was not demonstrating the app a player would open.
 *
 * With `NEUTRALISE_SHARED_UI` off, every shared surface gets the player's own presentation, because
 * all of them ask `useMarketerSkin()` rather than testing the role themselves. Nothing else changes.
 *
 * What this does NOT touch:
 *  - Marketer ROLE — routing, the covert HUD, the dashboard, referral earnings — which reads
 *    `useIsMarketer()`. Marketers keep every feature that is theirs; this removes only the
 *    DIFFERENCE in the screens they share with players.
 *  - Access of any kind: every marketer endpoint stays gated server-side by `requireMarketer`.
 *  - The money rules. A marketer still spends the demo bucket (migration 0084) and their practice
 *    bucket (0176), and `canWithdraw` comes from the wallet alone (wallet/figures.ts), never from the
 *    skin — so what they may cash out is unchanged by how it is painted.
 *
 * The flag stays rather than the code being deleted, because it is one line to reverse if the app
 * ever has to be demonstrated on a platform that reads a trading terminal as prohibited content.
 *
 * This file is deliberately import-free: the policy is the thing worth testing, and a module that
 * reaches for React or the `@/` aliases cannot be loaded by the plain node test runner.
 */
const NEUTRALISE_SHARED_UI: boolean = false;

/**
 * Does this screen wear the basic skin?
 *
 * `playerBasic` is the per-device preference set by the trade-screen gear, and with the policy off it
 * is the only thing that turns the skin on — for a marketer exactly as for anyone else.
 */
export const marketerSkinOn = (isMarketerRole: boolean, playerBasic: boolean): boolean =>
  (NEUTRALISE_SHARED_UI && isMarketerRole) || playerBasic;
