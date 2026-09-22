'use client';

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { api } from '@/lib/api/endpoints';
import { useSession } from '@/lib/auth/session';
import { authErrorMessage } from '@/lib/auth/errors';
import type { MfaStatusDto } from '@/lib/api/types';

const PRIVILEGED = new Set(['admin', 'platform_admin', 'platform_superadmin']);

/**
 * Account → Security (Issue 2). Management surface for the operator's two-factor authentication.
 * Enrolment itself is FORCED by the global MfaEnrolmentGate; this card lets an operator see their 2FA
 * state and rotate it (disable → the gate immediately re-prompts enrolment because 2FA is required).
 * Shown only for privileged roles; a player sees nothing here.
 */
export function SecurityCard() {
  const token = useSession((s) => s.token);
  const user = useSession((s) => s.user);
  const setUser = useSession((s) => s.setUser);
  const [status, setStatus] = useState<MfaStatusDto | null>(null);
  const [disarming, setDisarming] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const privileged = Boolean(user && PRIVILEGED.has(user.role));

  useEffect(() => {
    if (!token || !privileged) return;
    let active = true;
    api.mfaStatus(token).then((s) => { if (active) setStatus(s); }).catch(() => {});
    return () => { active = false; };
  }, [token, privileged]);

  if (!privileged) return null;

  async function disable(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!token) return;
    if (!/^\d{6}$/.test(code.trim()) && code.trim().length < 8) {
      setError('Enter a current 6-digit code or a recovery code.');
      return;
    }
    setBusy(true);
    try {
      await api.mfaDisable(token, code.trim());
      const [me, s] = await Promise.all([api.me(token), api.mfaStatus(token)]);
      setUser(me); // mfaSetupRequired flips true → the enrolment gate re-appears (2FA is required)
      setStatus(s);
      setDisarming(false);
      setCode('');
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-fg">Two-factor authentication</span>
        {status ? (
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${status.enabled ? 'bg-up/20 text-up' : 'bg-warn/20 text-warn'}`}>
            {status.enabled ? 'Enabled' : 'Required · not set'}
          </span>
        ) : (
          <span className="text-xs text-muted">…</span>
        )}
      </div>
      <p className="text-sm text-muted">
        {status?.enabled
          ? `An authenticator code is required at sign-in. ${status.recoveryCodesLeft} recovery code${status.recoveryCodesLeft === 1 ? '' : 's'} left.`
          : 'Two-factor authentication is required for your role. You will be prompted to set it up.'}
      </p>

      {status?.enabled ? (
        !disarming ? (
          <div>
            <Button variant="secondary" size="sm" onClick={() => setDisarming(true)}>Reset / disable 2FA</Button>
          </div>
        ) : (
          <form onSubmit={disable} className="flex flex-col gap-2" noValidate>
            <p className="text-xs text-muted">Enter a current authenticator code (or a recovery code) to confirm. Because 2FA is required, you&apos;ll be asked to set it up again immediately.</p>
            <Input
              name="disable-code"
              inputMode="text"
              autoComplete="one-time-code"
              placeholder="123456 or recovery code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            {error ? <p className="text-sm text-down" role="alert">{error}</p> : null}
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={busy}>{busy ? 'Working…' : 'Confirm'}</Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => { setDisarming(false); setError(null); setCode(''); }}>Cancel</Button>
            </div>
          </form>
        )
      ) : null}
    </Card>
  );
}
