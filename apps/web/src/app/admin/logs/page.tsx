'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** docs/42 UI-2: owner governance moved to the system console — this old back-office URL forwards there. */
export default function Moved() {
  const router = useRouter();
  useEffect(() => { router.replace('/platform/logs'); }, [router]);
  return null;
}
