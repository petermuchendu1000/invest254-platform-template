 'use client';

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/lib/toast/ToastProvider';
import { OutcomeOverlay } from '@/components/game/OutcomeOverlay';
import { WelcomeBonusOverlay } from '@/components/game/WelcomeBonusOverlay';
import { ReferralCapture } from '@/components/ReferralCapture';

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: false },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        {children}
        <ReferralCapture />
        <OutcomeOverlay />
        <WelcomeBonusOverlay />
      </ToastProvider>
    </QueryClientProvider>
  );
}
