'use client';

import { useSession } from '@/lib/auth/session';
import { useWallet } from '@/lib/wallet/hooks';

/**
 * Is this account a MARKETER, for client-side routing purposes?
 *
 * The JWT `role` claim is not enough, and the server already says so: `requireMarketer` resolves the
 * marketer from the DATABASE — "the DB is the source of truth for access (NOT the JWT role claim)".
 * The client was the only layer still trusting the claim, and it locked real marketers out of their
 * own app: three accounts on `madolar` carry `role='player'` while their money identity is marketer
 * (a `marketers` row on their brand and a funded `marketer_wallets` balance). They were demo-locked
 * by the money layer with no way to reach the dashboard they withdraw from.
 *
 * `wallet.modeLocked` is the server's own authoritative answer — it is `fn_is_marketer_account`, the
 * same predicate that routes their stakes to the demo bucket. Gating on it makes the client agree
 * with the money layer.
 *
 * This is a ROUTING hint, never an authorisation: every marketer endpoint is still gated server-side
 * by `requireMarketer`, so a false positive lands on a page whose calls return 403 — it cannot leak
 * anything. The covert entry (an invisible hotspot, no visible button) is unchanged.
 */
export function useIsMarketer(): { isMarketer: boolean; resolved: boolean } {
  const role = useSession((s) => s.user?.role);
  const { data: wallet, isPending } = useWallet();
  if (role === 'marketer') return { isMarketer: true, resolved: true };
  if (isPending || !wallet) return { isMarketer: false, resolved: false };
  return { isMarketer: wallet.modeLocked === true, resolved: true };
}
