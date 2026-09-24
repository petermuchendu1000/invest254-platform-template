'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useCan, useEffectiveRole } from '@/lib/auth/can';

/**
 * Old back-office URLs whose page moved to the system console. Operators who can open the console go
 * to the new page; a brand admin (who cannot) goes back to the back-office home instead of a 404.
 */
export function MovedToConsole({ to }: { to: string }) {
  const router = useRouter();
  const role = useEffectiveRole();
  const canConsole = useCan('console.enter');
  useEffect(() => {
    if (role === null) return; // session not read yet
    router.replace(canConsole ? to : '/admin');
  }, [router, role, canConsole, to]);
  return null;
}
