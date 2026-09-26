'use client';

/**
 * docs/42 UI-9 — manage Platform Admins by PERSON, not by pasted uuid.
 *
 * Recognition over recall: the System admin sees who currently runs each platform (name, phone, platform,
 * home brand) and appoints by searching for someone across every brand — never by copying an id from
 * another page. Each consequential action is confirmed with a plain statement of what changes (who, which
 * platform, what they lose). Ineligible people are shown but disabled WITH the reason, so the refusal is
 * explained up-front instead of arriving as an error.
 */
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/lib/toast/ToastProvider';
import { ApiError } from '@/lib/api/client';
import { ROLE_LABELS } from '@/lib/roles';
import { usePlatformAdmins, useUserSearch, useAppointPlatformAdmin, useRevokePlatformAdmin } from '@/lib/platform/hooks';
import type { DirectoryUserDto, PlatformAdminDto, PlatformDto } from '@/lib/platform/endpoints';

const ROLE_LABEL = ROLE_LABELS;

function useDebounced(value: string, ms = 300): string {
  const [v, setV] = useState(value);
  useEffect(() => { const id = setTimeout(() => setV(value), ms); return () => clearTimeout(id); }, [value, ms]);
  return v;
}

/** Why this person cannot be appointed (mirrors fn_platform_appoint_platform_admin), or null. */
export function appointBlocker(u: DirectoryUserDto, platformId: string): string | null {
  if (u.role === 'platform_superadmin') return 'The System owner cannot be appointed.';
  if (u.isDefaultMarketer) return "A brand's default marketer — reassign that brand's default marketer first.";
  if (platformId && u.role === 'platform_admin' && u.platformId === platformId) return 'Already runs this platform.';
  return null;
}

const who = (x: { username: string | null; phone: string | null }) => (x.username ? `@${x.username}` : x.phone ?? 'Unknown user');

export function PlatformAdminsPanel({ platforms }: { platforms: PlatformDto[] }) {
  const toast = useToast();
  const adminsQ = usePlatformAdmins();
  const appointMut = useAppointPlatformAdmin();
  const revokeMut = useRevokePlatformAdmin();
  const admins = useMemo(() => adminsQ.data?.admins ?? [], [adminsQ.data]);

  const [platformId, setPlatformId] = useState('');
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query);
  const searchQ = useUserSearch(debounced);
  const results = searchQ.data?.users ?? [];
  const [picked, setPicked] = useState<DirectoryUserDto | null>(null);
  const [revoking, setRevoking] = useState<PlatformAdminDto | null>(null);
  const [newRole, setNewRole] = useState('admin');

  const platformName = (id: string | null) => platforms.find((p) => p.platformId === id)?.name ?? 'this platform';
  const fail = (e: unknown) => toast.push({ tone: 'error', title: 'Failed', description: e instanceof ApiError ? e.message : 'Try again.' });

  async function appoint() {
    if (!picked || !platformId) return;
    try {
      await appointMut.mutateAsync({ userId: picked.userId, platformId });
      toast.push({ tone: 'success', title: `${who(picked)} now runs ${platformName(platformId)}` });
      setPicked(null); setQuery('');
    } catch (e) { fail(e); }
  }
  async function revoke() {
    if (!revoking) return;
    try {
      await revokeMut.mutateAsync({ userId: revoking.userId, newRole });
      toast.push({ tone: 'success', title: `${who(revoking)} is no longer a platform admin` });
      setRevoking(null); setNewRole('admin');
    } catch (e) { fail(e); }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-xl border border-border bg-surface-2 p-3 text-xs leading-relaxed text-muted">
        A Platform Admin runs ONE platform and can never see or touch another platform&apos;s sites, users or finances.
        Appointing moves the person out of their site role.
      </div>

      <section className="flex flex-col gap-2" aria-labelledby="pa-current">
        <h3 id="pa-current" className="text-sm font-semibold">Current platform admins</h3>
        {adminsQ.isLoading ? <p className="text-sm text-muted">Loading…</p>
          : admins.length === 0 ? <p className="text-sm text-muted">No platform admins yet — appoint one below.</p>
          : (
          <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
            {admins.map((a) => (
              <li key={a.userId} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                <div className="flex min-w-0 flex-col">
                  <span className="font-medium">{who(a)}</span>
                  <span className="text-xs text-muted">{a.phone ?? '—'} · runs <strong className="text-fg">{a.platformName ?? '—'}</strong>{a.homeSiteName ? ` · home brand ${a.homeSiteName}` : ''}</span>
                </div>
                {revoking?.userId === a.userId ? (
                  <div className="flex flex-wrap items-end gap-2">
                    <Select label="Make them" value={newRole} onChange={(e) => setNewRole(e.target.value)}>
                      <option value="admin">Brand admin (home brand)</option>
                      <option value="marketer">Marketer</option>
                      <option value="player">Player</option>
                    </Select>
                    <Button size="sm" variant="outline" onClick={() => setRevoking(null)}>Cancel</Button>
                    <Button size="sm" variant="down" onClick={revoke} disabled={revokeMut.isPending}>Confirm revoke</Button>
                  </div>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => { setRevoking(a); setNewRole('admin'); }}>Revoke…</Button>
                )}
              </li>
            ))}
          </ul>)}
        {revoking ? (
          <p className="text-xs text-down">{who(revoking)} will immediately lose access to {revoking.platformName ?? 'their platform'} and every brand in it.</p>
        ) : null}
      </section>

      <section className="flex flex-col gap-3 border-t border-border pt-4" aria-labelledby="pa-appoint">
        <h3 id="pa-appoint" className="text-sm font-semibold">Appoint a platform admin</h3>
        <Select label="Platform" value={platformId} onChange={(e) => { setPlatformId(e.target.value); setPicked(null); }}>
          <option value="">Choose a platform…</option>
          {platforms.map((p) => <option key={p.platformId} value={p.platformId}>{p.name} ({p.slug})</option>)}
        </Select>
        <Input
          label="Find a person"
          placeholder="Username or phone (any brand)"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setPicked(null); }}
          hint="At least 2 characters. Searches every brand."
        />
        {debounced.trim().length >= 2 ? (
          searchQ.isLoading ? <p className="text-sm text-muted">Searching…</p>
            : results.length === 0 ? <p className="text-sm text-muted">No one matches “{debounced.trim()}”.</p>
            : (
            <ul className="flex max-h-64 flex-col divide-y divide-border overflow-y-auto rounded-xl border border-border" role="listbox" aria-label="Search results">
              {results.map((u) => {
                const blocker = appointBlocker(u, platformId);
                const selected = picked?.userId === u.userId;
                return (
                  <li key={u.userId}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      disabled={!!blocker}
                      onClick={() => setPicked(u)}
                      className={`flex w-full flex-col items-start gap-0.5 p-3 text-left text-sm disabled:cursor-not-allowed disabled:opacity-60 ${selected ? 'bg-accent/10' : 'hover:bg-surface-2'}`}
                    >
                      <span className="font-medium">{who(u)} <span className="text-xs font-normal text-muted">· {ROLE_LABEL[u.role] ?? u.role}</span></span>
                      <span className="text-xs text-muted">{u.phone ?? '—'} · {u.siteName ?? 'no brand'}{u.platformName ? ` · ${u.platformName}` : ''}</span>
                      {blocker ? <span className="text-xs text-warn">{blocker}</span> : null}
                    </button>
                  </li>
                );
              })}
            </ul>)
        ) : null}
        {picked && !platformId ? <p className="text-xs text-warn">Now choose the platform {who(picked)} will run.</p> : null}
        {picked && platformId ? (
          <div className="flex flex-col gap-2 rounded-xl border border-accent/40 bg-accent/5 p-3 text-sm">
            <p>
              <strong>{who(picked)}</strong> ({ROLE_LABEL[picked.role] ?? picked.role}{picked.siteName ? `, ${picked.siteName}` : ''}) will run{' '}
              <strong>{platformName(platformId)}</strong> and leave their current role.
            </p>
            <div><Button onClick={appoint} disabled={appointMut.isPending}>{appointMut.isPending ? 'Appointing…' : 'Appoint platform admin'}</Button></div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
