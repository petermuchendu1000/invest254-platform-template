'use client';

import { useRouter } from 'next/navigation';
import { useSession } from '@/lib/auth/session';

/**
 * Covert marketer entry point.
 *
 * Entry is covert (requirement): NO visible button a watching player could notice — only an
 * invisible tap hotspot in the top-left corner (over the logo) opens the dashboard. Renders nothing
 * for non-marketers, so a player on their own device has no entry point at all.
 *
 * A single TAP now navigates to the full-page dashboard at `/dashboard` (previously it opened an
 * inline modal). The page owns loading, self-heal enrollment, and the full marketer portal UI.
 */
export function MarketerHUD() {
  const role = useSession((s) => s.user?.role);
  const router = useRouter();
  if (role !== 'marketer') return null;

  return (
    <button
      type="button"
      onClick={() => router.push('/dashboard')}
      onContextMenu={(e) => e.preventDefault()}
      aria-label="Open marketer dashboard"
      className="fixed left-0 top-0 z-[60] h-11 w-11 cursor-default border-0 bg-transparent p-0"
      style={{ WebkitTapHighlightColor: 'transparent' }}
    />
  );
}
