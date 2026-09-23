'use client';

import { can, type Capability } from '@invest254/shared/capabilities';
import { useSession } from '@/lib/auth/session';
import { roleFromToken, actorFromToken, type TokenActor } from '@/lib/auth/token';

/**
 * docs/42 P2/P3 — the role every visibility decision uses is the TOKEN's role: exactly what the API
 * authorises. While impersonating that is `admin` (never the operator's own tier from /auth/me), so the
 * UI can neither show a control the brand session will be refused, nor hide one it may use.
 */
export function useEffectiveRole(): string | null {
  return roleFromToken(useSession((s) => s.token));
}

/** May the current session use `cap`? Single source: packages/shared/src/capabilities.ts. */
export function useCan(cap: Capability): boolean {
  return can(useEffectiveRole(), cap);
}

/** The impersonation marker of the active token (who is really acting), or null. */
export function useActor(): TokenActor | null {
  return actorFromToken(useSession((s) => s.token));
}

export { can };
export type { Capability };
