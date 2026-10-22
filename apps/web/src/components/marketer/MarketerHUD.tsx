'use client';

import { useRouter } from 'next/navigation';
import { useIsMarketer } from '@/lib/marketer/isMarketer';

/**
 * Covert marketer entry point — a tap on the brand logo opens /dashboard.
 *
 * Entry is covert (requirement): NO visible button a watching player could notice. It renders
 * nothing at all for non-marketers, so a player on their own device has no entry point, and nothing
 * about the title bar looks different on a marketer's screen — which matters more than ever now that
 * marketers get the player interface exactly (lib/marketer/skinPolicy).
 *
 * Two mountings, because the two shells put their logo in different places:
 *
 *  - `MarketerLogoHotspot` overlays whatever it is mounted inside, and TopBar mounts it over the
 *    logo lockup. Anchoring it to the element rather than to a screen corner is the point: the
 *    terminal's title bar grew a hamburger at the far left (MT5Drawer), and a corner-anchored
 *    hotspot sat on top of it — so a marketer tapping the hamburger got the dashboard and could not
 *    open the menu at all. Overlaying the logo cannot drift onto a neighbour at any width.
 *
 *  - `MarketerHUD` is the fixed corner hotspot, still used by the digits shell, whose wordmark is
 *    hidden entirely on a narrow phone (DigitsTopBar) and so cannot carry an overlay.
 */

/** Navigate to the dashboard; shared by both mountings. */
function useOpenDashboard(): { show: boolean; open: () => void } {
  const { isMarketer } = useIsMarketer();
  const router = useRouter();
  // Gated on the money layer's own answer, not the JWT role claim — a marketer whose profile still
  // reads `player` was previously left with no entry point to the app they withdraw from.
  return { show: isMarketer, open: () => router.push('/dashboard') };
}

const HOTSPOT = 'cursor-default border-0 bg-transparent p-0';
const TAP: React.CSSProperties = { WebkitTapHighlightColor: 'transparent' };

/**
 * The entry as an overlay on its parent. Mount inside a `relative` wrapper around the brand logo.
 *
 * It covers the logo, so a marketer's tap opens the dashboard instead of following the logo's own
 * link home. That is the trick as it has always worked; the logo is simply where it now lives.
 *
 * It is mounted INSIDE a link in both of its homes, so it stops the event as well as handling it.
 * Without that the browser runs the handler and then follows the enclosing anchor anyway, which on
 * the drawer's account card raced the dashboard against /account and landed on whichever won.
 */
export function MarketerLogoHotspot() {
  const { show, open } = useOpenDashboard();
  if (!show) return null;
  return (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); open(); }}
      onContextMenu={(e) => e.preventDefault()}
      aria-label="Open marketer dashboard"
      className={`absolute inset-0 z-[5] ${HOTSPOT}`}
      style={TAP}
    />
  );
}

/** The entry as a fixed top-left corner hotspot (digits shell only — see the note above). */
export function MarketerHUD() {
  const { show, open } = useOpenDashboard();
  if (!show) return null;
  return (
    <button
      type="button"
      onClick={open}
      onContextMenu={(e) => e.preventDefault()}
      aria-label="Open marketer dashboard"
      className={`fixed left-0 top-0 z-[60] h-11 w-11 ${HOTSPOT}`}
      style={TAP}
    />
  );
}
