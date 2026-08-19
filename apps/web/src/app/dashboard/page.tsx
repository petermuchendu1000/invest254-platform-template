'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Skeleton } from '@/components/ui/Skeleton';
import { useSession } from '@/lib/auth/session';
import { useHydrated } from '@/lib/useHydrated';
import { MarketerDashboardView } from '@/components/marketer/MarketerDashboardView';

/**
 * Marketer dashboard route. This is the destination the covert top-left hotspot navigates to
 * (replacing the old modal). Gated to marketers only: unauthenticated or non-marketer users are
 * redirected home so the page — and its idempotent enroll self-heal — is only ever reached by a
 * confirmed marketer.
 */
export default function DashboardPage() {
  const hydrated = useHydrated();
  const token = useSession((s) => s.token);
  const user = useSession((s) => s.user);
  const router = useRouter();
  const isMarketer = user?.role === 'marketer';

  useEffect(() => {
    if (!hydrated) return;
    // No token, or a resolved profile that isn't a marketer -> this page isn't for them.
    if (!token || (user && !isMarketer)) router.replace('/');
  }, [hydrated, token, user, isMarketer, router]);

  // While hydrating, awaiting the profile, or redirecting a non-marketer, show a neutral skeleton.
  if (!hydrated || !token || !user || !isMarketer) return <Skeleton className="h-64 w-full" />;

  return <MarketerDashboardView />;
}
