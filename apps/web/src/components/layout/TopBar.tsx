import { AuthButtons } from '@/components/auth/AuthButtons';
import { AccountSwitcher } from '@/components/wallet/AccountSwitcher';
import { Logo } from '@/components/layout/Logo';

export function TopBar() {
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-surface/90 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-app items-center gap-1.5 px-3 sm:gap-2 sm:px-4">
        <Logo />

        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          {/* DEMO-3: the balance is now the Real/Demo switcher (it used to open the Withdraw tab,
              which on a Demo account offered a way out of play money). */}
          <AccountSwitcher />
          <AuthButtons />
        </div>
      </div>
    </header>
  );
}
