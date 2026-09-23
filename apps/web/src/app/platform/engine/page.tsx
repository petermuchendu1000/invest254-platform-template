'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/lib/toast/ToastProvider';
import { PageHeader, Section } from '@/components/admin/ui';
import { RequireCapability } from '@/components/auth/RequireCapability';
import { useFlyStatus, useFlyRestart } from '@/lib/admin/hooks';
import { formatDateTime } from '@/lib/format';

function FlyBody() {
  const statusQ = useFlyStatus();
  const restart = useFlyRestart();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [lastResult, setLastResult] = useState<{ at: string; machines: number } | null>(null);

  if (statusQ.isLoading) return <Skeleton className="h-48 w-full" />;

  const configured = statusQ.data?.configured ?? false;
  const apps = statusQ.data?.apps ?? [statusQ.data?.app ?? 'invest254-api'];

  const doRestart = async () => {
    setConfirming(false);
    try {
      const r = await restart.mutateAsync();
      setLastResult({ at: r.at, machines: r.machinesRestarted });
      const failed = r.apps.filter((a) => a.error);
      if (failed.length === 0) {
        toast.push({ tone: 'success', title: `Restarted ${r.machinesRestarted} machine(s) across ${r.apps.length} app(s)` });
      } else {
        toast.push({ tone: 'error', title: 'Some apps failed', description: failed.map((a) => `${a.app}: ${a.error}`).join('; ') });
      }
    } catch (e) {
      toast.push({ tone: 'error', title: 'Restart failed', description: e instanceof Error ? e.message : 'Try again.' });
    }
  };

  return (
    <div className="space-y-6">
      <Section title="Fly.io engine restart">
        <p className="text-sm text-muted">
          Restart the Fly machines running the API/engine so freshly deployed code picks up. System owner only.
        </p>
        <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-5">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-muted">Target apps:</span>
            {apps.map((a) => (
              <code key={a} className="rounded bg-surface-2 px-2 py-0.5 font-mono text-xs">{a}</code>
            ))}
            <span
              className={
                'ml-auto inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ' +
                (configured ? 'bg-up/15 text-up' : 'bg-down/15 text-down')
              }
            >
              <span className={'h-1.5 w-1.5 rounded-full ' + (configured ? 'bg-up' : 'bg-down')} />
              {configured ? 'Configured' : 'FLY_API_TOKEN not set on server'}
            </span>
          </div>

          {!confirming ? (
            <div>
              <Button
                variant="down"
                disabled={!configured || restart.isPending}
                onClick={() => setConfirming(true)}
              >
                {restart.isPending ? 'Restarting…' : 'Restart engine'}
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-down/40 bg-down/10 p-4">
              <p className="text-sm">
                Restart all running machines on <strong>{apps.join(' + ')}</strong>? Brief unavailability (~10–30s) per app.
              </p>
              <div className="ml-auto flex gap-2">
                <Button variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
                <Button variant="down" onClick={doRestart} disabled={restart.isPending}>
                  {restart.isPending ? 'Restarting…' : 'Confirm restart'}
                </Button>
              </div>
            </div>
          )}

          {lastResult && (
            <p className="text-xs text-muted">
              Last restart: {formatDateTime(lastResult.at)} · {lastResult.machines} machine(s)
            </p>
          )}
        </div>
      </Section>
    </div>
  );
}

export default function FlyAdminPage() {
  return (
    <>
      <PageHeader title="Deployment" subtitle="Deployment controls — restart the engine after shipping updates." />
      <RequireCapability cap="backoffice.governance" title="Owner-only area" hint="System governance is managed by the system owner from their own console session.">
        <FlyBody />
      </RequireCapability>
    </>
  );
}
