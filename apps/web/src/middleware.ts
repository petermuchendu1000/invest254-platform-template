import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Dedicated admin/operator domain routing (Issue 1).
 *
 * On an admin host (ADMIN_HOST, default triocodes.com) the ROOT must be the operator console, not the
 * player app. We REDIRECT `/` -> `/console` (not a rewrite) so the browser URL actually becomes
 * `/console`; the app chrome keys off the pathname, so this is what stops the player top-bar
 * (brand + Login/Sign Up) from ever rendering on the admin domain.
 */
const ADMIN_HOSTS = (process.env.ADMIN_HOST || 'triocodes.com')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

export function middleware(req: NextRequest) {
  const host = (req.headers.get('host') || '').split(':')[0]?.toLowerCase() ?? '';
  const isAdminHost = ADMIN_HOSTS.some((h) => host === h || host === `www.${h}`);
  if (isAdminHost && req.nextUrl.pathname === '/') {
    const url = req.nextUrl.clone();
    url.pathname = '/console';
    return NextResponse.redirect(url, 307);
  }
  return NextResponse.next();
}

// Only run on the root — cheap, and all other admin paths already render bare.
export const config = { matcher: ['/'] };
