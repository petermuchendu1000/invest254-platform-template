'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/lib/toast/ToastProvider';
import { useSession } from '@/lib/auth/session';
import {
  pushSupport,
  isSubscribed,
  enableWithdrawalAlerts,
  disableWithdrawalAlerts,
} from '@/lib/notifications/adminPush';

/**
 * "Enable withdrawal alerts" toggle (Issue 1). When on, this device receives a real-time Web Push
 * with Approve/Reject actions the instant a player requests a withdrawal — so an admin no longer has
 * to log in and poll this queue. Per-device (a browser push subscription is device-bound), so each
 * admin enables it on the phone/desktop where they want to be paged.
 */
export function WithdrawalAlertsToggle() {
  const token = useSession((s) => s.token);
  const toast = useToast();
  const [supported, setSupported] = useState<boolean>(true);
  const [on, setOn] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);

  useEffect(() => {
    setSupported(pushSupport() === 'supported');
    isSubscribed().then(setOn).catch(() => setOn(false));
  }, []);

  if (!supported) {
    return <span className="text-[11px] text-muted">Push alerts aren’t supported on this device/browser.</span>;
  }

  async function toggle() {
    if (!token || busy) return;
    setBusy(true);
    try {
      if (on) {
        await disableWithdrawalAlerts(token);
        setOn(false);
        toast.push({ tone: 'success', title: 'Withdrawal alerts off', description: 'This device will no longer be paged.' });
        return;
      }
      const r = await enableWithdrawalAlerts(token);
      if (r.ok) {
        setOn(true);
        toast.push({ tone: 'success', title: 'Withdrawal alerts on', description: 'You’ll get a push here with Approve/Reject the moment a player requests a withdrawal.' });
        return;
      }
      const msg =
        r.reason === 'permission-denied' ? 'Allow notifications for this site in your browser settings, then try again.'
        : r.reason === 'not-configured' ? 'Push isn’t configured on the server yet (missing VAPID keys).'
        : r.reason === 'unsupported' ? 'This device/browser can’t receive push notifications.'
        : r.message || 'Could not enable alerts. Try again.';
      toast.push({ tone: 'error', title: 'Couldn’t enable alerts', description: msg });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant={on ? 'secondary' : 'outline'} size="sm" onClick={toggle} disabled={busy}>
      {busy ? '…' : on ? '🔔 Alerts on' : '🔕 Enable alerts'}
    </Button>
  );
}
