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
import { useSession } from '@/lib/auth/session';
import { ApiError } from '@/lib/api/client';
import { ROLE_LABELS } from '@/lib/roles';
import { maskPhoneForDisplay } from '@invest254/shared/payments';
import { usePlatformAdmins, useUserSearch, useAppointPlatformAdmin, useRevokePlatformAdmin, useResetSecurityAnswers } from '@/lib/platform/hooks';
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
  if (u.isDefaultMarketer) return "A brand's default marketer: reassign that brand's default marketer first.";
  if (platformId && u.role === 'platform_admin' && u.platformId === platformId) return 'Already runs this platform.';
  return null;
}

/**
 * Why this person's security answers cannot be reset here (mirrors fn_admin_reset_security_answers,
 * 0210), or null. Shown on the row so the refusal is explained before it is attempted, which is the
 * same contract `appointBlocker` keeps above.
 *
 * `selfId` matters as much as the role rules: the RPC refuses a self-reset, because an operator who
 * could clear their OWN knowledge factor from inside a live session could simply re-enrol one, and
 * step-up would be protecting nothing.
 */
export function resetBlocker(u: DirectoryUserDto, selfId: string | null): string | null {
  if (selfId && u.userId === selfId) return 'You cannot reset your own answers — ask another operator above you.';
  if (u.role === 'platform_superadmin') return 'The System owner is recovered out-of-band, not from here.';
  if (u.role === 'player' || u.role === 'marketer') return 'Only operator accounts use security questions.';
  return null;
}

/**
 * The person-label used in every sentence on this panel ("X will lose access to …"). A nameless
 * account used to be labelled with its raw number, so the one place a username is missing was also
 * the one place a full MSISDN was printed. It now falls back to the MASKED number: still unique
 * enough to tell two nameless accounts apart (and it matches the masked number shown beside it),
 * without putting a login identity on screen. "Unknown user" is kept for an account with neither.
 */
const who = (x: { username: string | null; phone: string | null }) =>
  (x.username ? `@${x.username}` : x.phone ? maskPhoneForDisplay(x.phone) : 'Unknown user');

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

  // The reset flow keeps its OWN search state. Sharing the appoint box would mean one box whose
  // result list means two different things depending on which button you press next.
  const self = useSession((x) => x.user);
  const resetMut = useResetSecurityAnswers();
  const [resetQuery, setResetQuery] = useState('');
  const resetDebounced = useDebounced(resetQuery);
  const resetSearchQ = useUserSearch(resetDebounced);
  const resetResults = resetSearchQ.data?.users ?? [];
  const [resetPicked, setResetPicked] = useState<DirectoryUserDto | null>(null);

  async function doReset() {
    if (!resetPicked) return;
    try {
      const out = await resetMut.mutateAsync({ userId: resetPicked.userId });
      toast.push({
        tone: 'success',
        title: 'Security answers cleared',
        description: out.cleared > 0
          ? `${who(resetPicked)} must set a new set at next sign-in. ${out.cleared} answer${out.cleared === 1 ? '' : 's'} discarded, and their sessions were ended.`
          : `${who(resetPicked)} had none stored, so there was nothing to discard. Their sessions were ended and they will be asked to set a new set.`,
      });
      setResetPicked(null);
      setResetQuery('');
    } catch (e) {
      toast.push({ tone: 'error', title: 'Could not reset', description: e instanceof ApiError ? e.message : 'Try again.' });
    }
  }
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
          : admins.length === 0 ? <p className="text-sm text-muted">No platform admins yet: appoint one below.</p>
          : (
          <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
            {admins.map((a) => (
              <li key={a.userId} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                <div className="flex min-w-0 flex-col">
                  <span className="font-medium">{who(a)}</span>
                  <span className="text-xs text-muted">{maskPhoneForDisplay(a.phone) || '-'} · runs <strong className="text-fg">{a.platformName ?? '-'}</strong>{a.homeSiteName ? ` · home brand ${a.homeSiteName}` : ''}</span>
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
                      {/* Masked: the search above matches on the real column server-side, so an
                          operator who already knows the number can still find the person. */}
                      <span className="text-xs text-muted">{maskPhoneForDisplay(u.phone) || '-'} · {u.siteName ?? 'no brand'}{u.platformName ? ` · ${u.platformName}` : ''}</span>
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

      {/*
        Forgotten security answers (0210, docs/68).
        Separate section rather than a per-row button on the list above, because the person who gets
        locked out is usually a BRAND admin — for whom the answers are the step-up factor itself —
        and brand admins never appear in the platform-admins list. Searching covers both.
      */}
      <section className="flex flex-col gap-3 border-t border-border pt-4" aria-labelledby="pa-reset">
        <h3 id="pa-reset" className="text-sm font-semibold">Reset someone&apos;s security answers</h3>
        <p className="text-xs text-muted">
          For an operator who has forgotten the answers they set. The answers are stored hashed and
          cannot be read or chosen for them — this clears the set so they pick three new questions at
          next sign-in. Their current sessions end immediately.
        </p>
        <Input
          label="Find the person"
          placeholder="Username or phone (any brand)"
          value={resetQuery}
          onChange={(e) => { setResetQuery(e.target.value); setResetPicked(null); }}
          hint="At least 2 characters. Searches every brand."
        />
        {resetDebounced.trim().length >= 2 ? (
          resetSearchQ.isLoading ? <p className="text-sm text-muted">Searching…</p>
            : resetResults.length === 0 ? <p className="text-sm text-muted">No one matches &ldquo;{resetDebounced.trim()}&rdquo;.</p>
            : (
            <ul className="flex max-h-64 flex-col divide-y divide-border overflow-y-auto rounded-xl border border-border" role="listbox" aria-label="Reset search results">
              {resetResults.map((u) => {
                const blocker = resetBlocker(u, self?.userId ?? null);
                const selected = resetPicked?.userId === u.userId;
                return (
                  <li key={u.userId}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      disabled={!!blocker}
                      onClick={() => setResetPicked(u)}
                      className={`flex w-full flex-col items-start gap-0.5 p-3 text-left text-sm disabled:cursor-not-allowed disabled:opacity-60 ${selected ? 'bg-accent/10' : 'hover:bg-surface-2'}`}
                    >
                      <span className="font-medium">{who(u)} <span className="text-xs font-normal text-muted">· {ROLE_LABEL[u.role] ?? u.role}</span></span>
                      <span className="text-xs text-muted">{maskPhoneForDisplay(u.phone) || '-'} · {u.siteName ?? 'no brand'}{u.platformName ? ` · ${u.platformName}` : ''}</span>
                      {blocker ? <span className="text-xs text-warn">{blocker}</span> : null}
                    </button>
                  </li>
                );
              })}
            </ul>)
        ) : null}
        {resetPicked ? (
          <div className="flex flex-col gap-2 rounded-xl border border-warn/40 bg-warn/5 p-3 text-sm">
            <p>
              <strong>{who(resetPicked)}</strong> ({ROLE_LABEL[resetPicked.role] ?? resetPicked.role}
              {resetPicked.siteName ? `, ${resetPicked.siteName}` : ''}) will be signed out everywhere and asked to
              set three new security questions the next time they sign in. Nothing else about their
              account changes.
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="down" onClick={doReset} disabled={resetMut.isPending}>
                {resetMut.isPending ? 'Resetting…' : 'Reset their answers'}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setResetPicked(null)} disabled={resetMut.isPending}>Cancel</Button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
