 'use client';

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/lib/toast/ToastProvider';
import { OutcomeOverlay } from '@/components/game/OutcomeOverlay';
import { WelcomeBonusOverlay } from '@/components/game/WelcomeBonusOverlay';
import { ReferralCapture } from '@/components/ReferralCapture';
import { SecurityQuestionsGate } from '@/components/auth/SecurityQuestionsGate';

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
        {/* Mandatory security-questions setup for privileged accounts (0097) — global so it blocks
            everywhere an admin lands after being force-logged-out, not just the /admin shell. */}
        <SecurityQuestionsGate />
      </ToastProvider>
    </QueryClientProvider>
  );
}
