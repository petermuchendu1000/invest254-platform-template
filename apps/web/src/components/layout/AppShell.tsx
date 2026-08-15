'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import { TopBar } from '@/components/layout/TopBar';
import { BottomNav } from '@/components/layout/BottomNav';
import { Footer } from '@/components/layout/Footer';
import { AuthModal } from '@/components/auth/AuthModal';
import { WalletModal } from '@/components/wallet/WalletModal';
import { SessionBootstrap } from '@/components/auth/SessionBootstrap';
import { NotificationBanners } from '@/components/notifications/NotificationBanners';
import { RegisterSW } from '@/components/RegisterSW';
import { SupportWidget } from '@/components/support/SupportWidget';
import { env } from '@/lib/env';

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  // The admin console + platform console provide their own chrome (sidebar). Suppress the player
  // top bar / bottom nav / footer there, but keep session bootstrap + SW.
  if (pathname?.startsWith('/admin') || pathname?.startsWith('/platform')) {
    return (
      <>
        {children}
        <SessionBootstrap />
        <RegisterSW />
      </>
    );
  }

  // The trade screen is an app-like, single-viewport surface: it must never
  // page-scroll on mobile and the chart must flex-fill the space between the
  // header and the trade console. We lock the frame to the viewport height and
  // drop the marketing footer + spacer here (legal lives in Profile/Legal).
  const isTrade = pathname === '/';
  if (isTrade) {
    return (
      <div className="flex h-dvh flex-col overflow-hidden">
        <TopBar />
        <NotificationBanners />
        <main className="relative mx-auto flex w-full min-h-0 max-w-app flex-1 flex-col px-3 pb-[calc(4.75rem+env(safe-area-inset-bottom))] pt-2 md:px-4 md:pb-4">
          {children}
        </main>
        <BottomNav />
        <SessionBootstrap />
        <AuthModal />
        <WalletModal />
        <RegisterSW />
        {env.supportChatEnabled && <SupportWidget />}
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar />
      <NotificationBanners />
      <main className="mx-auto w-full max-w-app flex-1 px-4 py-4">{children}</main>
      <Footer />
      {/* Spacer so the fixed mobile BottomNav never covers footer content. */}
      <div aria-hidden className="h-20 md:hidden" />
      <BottomNav />
      <SessionBootstrap />
      <AuthModal />
      <WalletModal />
      <RegisterSW />
      {env.supportChatEnabled && <SupportWidget />}
    </div>
  );
}
