'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** UI-F: one audit log for every tier — this old platform-admin URL forwards to it (keeping ?site=). */
export default function Moved() {
  const router = useRouter();
  useEffect(() => { router.replace(`/platform/audit${window.location.search}`); }, [router]);
  return null;
}
