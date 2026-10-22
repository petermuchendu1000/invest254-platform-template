import { notFound } from 'next/navigation';
import { requestHost } from './currentBrand.js';
import { operatorSurfaceAllowed } from './adminHost.js';

/**
 * The host gate for the operator surfaces, called from the SERVER layout of each one.
 *
 * It is a layout and not the middleware on purpose. `notFound()` is the framework's own answer:
 * it renders `app/not-found.tsx` with a real 404 status, in the brand the host resolves to, so a
 * player domain answers `/console` with exactly the page it answers `/nonsense` with. A middleware
 * rewrite would have to synthesise that, and a hand-built 404 body is the kind of thing that drifts
 * from the real one. A layout also covers every nested route by construction — `/admin/withdrawals`
 * and `/platform/billing/invoices/x` are gated because they render inside a gated layout, with no
 * matcher pattern to keep in step with the route tree.
 *
 * Cost: none worth counting. `app/layout.tsx` already reads `headers()` on every request to resolve
 * the brand, so these routes were dynamic before this existed; this adds a string comparison.
 */
export function requireOperatorHost(): void {
  if (!operatorSurfaceAllowed(requestHost())) notFound();
}
