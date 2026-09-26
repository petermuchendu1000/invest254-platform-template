'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/Button';

// Route-segment error boundary. Catches render/runtime errors in any page under
// the root layout and offers a recovery path without a full reload.
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Lightweight client error reporting hook (no PII, no money state).
    if (typeof window !== 'undefined') {
      // eslint-disable-next-line no-console
      console.error('[pp:error]', error?.digest ?? '', error?.message);
    }
  }, [error]);

  return (
    <section className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
      <h1 className="text-xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="max-w-sm text-sm text-muted">Your balance is safe.</p>
      <div className="flex gap-3">
        <Button onClick={reset}>Try again</Button>
        <Button variant="outline" onClick={() => (window.location.href = '/')}>
          Go home
        </Button>
      </div>
    </section>
  );
}
