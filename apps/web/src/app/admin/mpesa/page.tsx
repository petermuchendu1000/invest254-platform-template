'use client';

import { MovedToConsole } from '@/components/admin/MovedToConsole';

/** docs/42 UI-2: this old back-office URL moved to the system console. */
export default function Moved() {
  return <MovedToConsole to="/platform/mpesa" />;
}
