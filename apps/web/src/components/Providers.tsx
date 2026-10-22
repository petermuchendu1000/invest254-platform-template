 'use client';

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/lib/toast/ToastProvider';
import { OutcomeOverlay } from '@/components/game/OutcomeOverlay';
import { WelcomeBonusOverlay } from '@/components/game/WelcomeBonusOverlay';
import { ReferralCapture } from '@/components/ReferralCapture';
import { SecurityQuestionsGate } from '@/components/auth/SecurityQuestionsGate';
import { MfaEnrolmentGate } from '@/components/auth/MfaEnrolmentGate';
import { StepUpGate } from '@/components/auth/StepUpGate';
import { OperatorIdleWatch } from '@/components/auth/OperatorIdleWatch';
import { SessionCacheGuard } from '@/components/auth/SessionCacheGuard';
import { SoundBootstrap } from '@/components/layout/SoundToggle';

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
        {/**
          * The stored sound preference, restored for EVERY shell.
          *
          * It was mounted in the digits branch of AppShell alone, so on a terminal brand -- where
          * Settings is the only sound control there is -- the store kept its `muted: false` default
          * on every load and the row came back ticked however the trader had left it. The toggle
          * wrote `pp:sound-muted` faithfully; nothing ever read it back.
          *
          * Here rather than in the three remaining AppShell branches, because a preference that has
          * to be restored in four places is one a fifth shell will forget.
          */}
        <SoundBootstrap />
        <SessionCacheGuard />
        <ReferralCapture />
        <OutcomeOverlay />
        <WelcomeBonusOverlay />
        {/* Mandatory security-questions setup for privileged accounts (0097) — global so it blocks
            everywhere an admin lands after being force-logged-out, not just the /admin shell. */}
        <SecurityQuestionsGate />
        {/* Mandatory 2FA (TOTP) enrolment for privileged accounts (Issue 2) — shown after the
            security-questions gate so the two overlays never stack. */}
        <MfaEnrolmentGate />
        {/* Step-up second factor at the moment of the action (0196) — global, because a critical
            action can be taken from the brand back office, the operator console or an impersonated
            brand session, and a prompt mounted in one of them would strand the other two. Renders
            nothing, and registers nothing, for a player or marketer. */}
        <StepUpGate />
        {/* The matching idle timeout: the warning before it fires, and the sign-out when it has.
            Privileged roles only — see the component. */}
        <OperatorIdleWatch />
      </ToastProvider>
    </QueryClientProvider>
  );
}
