'use client';

import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { useSession } from '@/lib/auth/session';
import { useAuthUi } from '@/lib/auth/ui';
import { useAuthActions } from '@/lib/auth/useAuthActions';
import { useHydrated } from '@/lib/useHydrated';
import { PnlColorToggle } from '@/components/settings/PnlColorToggle';

export default function AccountPage() {
  const hydrated = useHydrated();
  const token = useSession((s) => s.token);
  const user = useSession((s) => s.user);
  const openAuth = useAuthUi((s) => s.openAuth);
  const { logout } = useAuthActions();

  if (!hydrated) return <Skeleton className="h-48 w-full" />;

  if (!token) {
    return (
      <EmptyState
        title="Sign in to view your account"
        description="Log in or create an account to manage your profile."
        action={<Button onClick={() => openAuth('login')}>Log in</Button>}
      />
    );
  }

  if (!user) return <Skeleton className="h-48 w-full" />;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Account</h1>
        <Button variant="secondary" size="sm" onClick={logout}>
          Log out
        </Button>
      </div>

      <Card className="flex flex-col gap-3">
        <Row label="Username" value={`@${user.username}`} />
      </Card>

      <Card className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold tracking-tight">Preferences</h2>
        <PnlColorToggle />
      </Card>

      <Card className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-6 items-center rounded-full border border-down px-2 text-xs font-bold text-down">
            18+
          </span>
          <h2 className="text-sm font-semibold tracking-tight">Responsible gaming</h2>
        </div>
        <p className="text-sm leading-relaxed text-muted">
          Invest254 is for entertainment and involves real money. Only stake what you can afford to
          lose, and take a break whenever you need one.
        </p>
        <div className="flex flex-col gap-2">
          <Link
            href="/legal#responsible-gaming"
            className="text-sm text-accent hover:underline"
          >
            Responsible gaming &amp; self-exclusion →
          </Link>
          <a href="tel:1190" className="text-sm text-accent hover:underline">
            Gambling helpline 1190 →
          </a>
          <Link href="/legal#terms" className="text-sm text-muted hover:text-fg">
            Terms, Privacy &amp; Licence
          </Link>
        </div>
      </Card>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted">{label}</span>
      <span className="font-medium text-fg">{value}</span>
    </div>
  );
}
