'use client';

import { cn } from '@/lib/cn';
import { useMyNotifications, useDismissNotification } from '@/lib/notifications/hooks';
import type { NotificationDto } from '@/lib/api/types';
import { useSession } from '@/lib/auth/session';
import { useTerminalSkin } from '@/lib/ui/useTerminalSkin';
import { MT5_TOKENS } from '@/lib/ui/mt5Tokens';

// Per-level palette with dark-mode counterparts. Blocking (non-dismissible) notices use the
// same colour but keep the X hidden, so they persist until an admin resolves them.
const LEVEL_STYLES: Record<NotificationDto['level'], string> = {
  info: 'border-border bg-surface-2 text-fg',
  success: 'border-up/40 bg-up/10 text-fg',
  warning: 'border-warn/40 bg-warn/10 text-fg',
  error: 'border-down/40 bg-down/10 text-fg',
};

/**
 * Sticky, per-user notification banners (J7). Rendered at the top of the app content for
 * logged-in players. Dismissible banners show an X (cleared server-side); blocking banners
 * (e.g. account limits) have no X and stay until an admin resolves them.
 */
export function NotificationBanners() {
  const token = useSession((s) => s.token);
  const q = useMyNotifications();
  const dismiss = useDismissNotification();
  const items = token ? q.data?.items ?? [] : [];   // never the previous user's notices
  /**
   * These sit directly under the app bar, so on a terminal brand they are the first thing below
   * MetaTrader's blue band and the last place a brand-green notice should appear. The palette comes
   * from re-pointing the theme tokens (lib/ui/mt5Tokens), which keeps the per-level colouring below
   * exactly as written; only the frame changes — full width and square, like the chrome around them.
   */
  const mt5 = useTerminalSkin();
  if (items.length === 0) return null;

  return (
    <div
      // The per-level colours are translucent tints, so the container has to carry MetaTrader's own
      // surface under them — without it they sit on the brand's page background and read as a
      // different product's notice stuck to the top of the terminal.
      // Each branch carries its OWN spacing rather than overriding the other's: Tailwind resolves
      // `pt-0` against `pt-3` by stylesheet order, not by the order they appear here, so emitting
      // both leaves a gap the override looks like it removed.
      className={cn('flex w-full flex-col', mt5 ? 'gap-px bg-[var(--mt5-surface)]' : 'mx-auto max-w-app gap-2 px-4 pt-3')}
      {...(mt5 ? { style: MT5_TOKENS } : {})}
    >
      {items.map((n) => (
        <div
          key={n.id}
          role="alert"
          className={cn(
            'flex items-start justify-between gap-3 border px-3 py-2',
            mt5 ? 'border-x-0 border-t-0' : 'rounded-xl shadow-sm',
            LEVEL_STYLES[n.level],
          )}
        >
          <div className="min-w-0">
            <p className="text-sm font-semibold">{n.title}</p>
            {n.body ? <p className="mt-0.5 text-xs text-muted">{n.body}</p> : null}
          </div>
          {n.dismissible ? (
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => dismiss.mutate(n.id)}
              className="-mr-1 shrink-0 rounded-md px-2 text-lg leading-none text-muted transition hover:bg-surface hover:text-fg"
            >
              ×
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
