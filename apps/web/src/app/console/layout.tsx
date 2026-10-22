import { requireOperatorHost } from '@/lib/brand/operatorGuard';

/**
 * `/console` exists only on the operator domain.
 *
 * The page itself is a client component (it reads the session to route an operator to their tier),
 * so the host check needs a server boundary above it — this layout is that boundary, and it is the
 * only reason the layout exists. It renders nothing of its own, and deliberately exports NO
 * metadata: a `title: 'Console'` here was serialised into the flight payload of the 404 that a
 * player host returns, which told a reader of the page source the exact thing the 404 exists to
 * withhold. The middleware now blocks before the segment matches, and this stays bare so the
 * backstop cannot leak either.
 */
export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  requireOperatorHost();
  return <>{children}</>;
}
