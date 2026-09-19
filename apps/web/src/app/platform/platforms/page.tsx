'use client';

/**
 * System-admin PLATFORMS console (Issue 1). The System Admin (platform_superadmin) manages the
 * platform tier here: create platforms, see per-platform KPIs, re-parent brands, and appoint /
 * revoke the Platform Admins who each run ONE platform in strict isolation.
 *
 * UX/psychology notes (deliberate):
 *  - Scope framing up top removes "which hat am I wearing" confusion (mode-error prevention).
 *  - Colour-coded status + count chips use pre-attentive processing so the operator scans, not reads.
 *  - Consequential actions (appoint / revoke / suspend) sit behind an explicit modal with a plain-
 *    language summary of the blast radius (consequence salience → fewer slips).
 *  - Empty states offer ONE clear next action (less decision paralysis).
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { PageHeader, StatCard, Section, TableWrap, Th, Td } from '@/components/admin/ui';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/lib/toast/ToastProvider';
import {
  usePlatforms, usePlatformsOverview, useCreatePlatform, useUpdatePlatform,
  useAssignSiteToPlatform, useAppointPlatformAdmin, useRevokePlatformAdmin, usePlatformSites,
} from '@/lib/platform/hooks';
import type { PlatformKpisDto } from '@/lib/platform/endpoints';
import { ApiError } from '@/lib/api/client';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

function StatusBadge({ status }: { status: string }) {
  const tone = status === 'active' ? 'border-up/40 bg-up/10 text-up'
    : status === 'suspended' ? 'border-warn/40 bg-warn/10 text-warn'
    : 'border-border bg-surface-2 text-muted';
  return <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${tone}`}>{status}</span>;
}

export default function PlatformsPage() {
  const toast = useToast();
  const platformsQ = usePlatforms();
  const overviewQ = usePlatformsOverview();
  const sitesQ = usePlatformSites();
  const createMut = useCreatePlatform();
  const updateMut = useUpdatePlatform();
  const assignMut = useAssignSiteToPlatform();
  const appointMut = useAppointPlatformAdmin();
  const revokeMut = useRevokePlatformAdmin();

  const overview = useMemo(() => overviewQ.data?.platforms ?? [], [overviewQ.data]);
  const sites = useMemo(() => sitesQ.data?.sites ?? [], [sitesQ.data]);
  const totalSites = overview.reduce((n, p) => n + p.sites, 0);
  const totalPlatformAdmins = overview.reduce((n, p) => n + p.platformAdmins, 0);

  const [createOpen, setCreateOpen] = useState(false);
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');

  const [edit, setEdit] = useState<PlatformKpisDto | null>(null);
  const [editName, setEditName] = useState('');
  const [editStatus, setEditStatus] = useState('active');

  const [adminsOpen, setAdminsOpen] = useState(false);
  const [appointUserId, setAppointUserId] = useState('');
  const [appointPlatformId, setAppointPlatformId] = useState('');
  const [revokeUserId, setRevokeUserId] = useState('');

  const [assignOpen, setAssignOpen] = useState(false);
  const [assignSiteId, setAssignSiteId] = useState('');
  const [assignPlatformId, setAssignPlatformId] = useState('');

  const err = (e: unknown) => toast.push({ tone: 'error', title: 'Failed', description: e instanceof ApiError ? e.message : String(e) });
  const ok = (title: string) => toast.push({ tone: 'success', title });

  async function createPlatform() {
    if (!SLUG_RE.test(slug)) return err(new Error('Slug must be lowercase letters, digits and hyphens (2–41 chars).'));
    if (!name.trim()) return err(new Error('Name is required.'));
    try { await createMut.mutateAsync({ slug, name: name.trim() }); ok('Platform created'); setCreateOpen(false); setSlug(''); setName(''); }
    catch (e) { err(e); }
  }
  async function saveEdit() {
    if (!edit) return;
    try { await updateMut.mutateAsync({ id: edit.platformId, patch: { name: editName.trim(), status: editStatus } }); ok('Platform updated'); setEdit(null); }
    catch (e) { err(e); }
  }
  async function appoint() {
    if (!appointUserId.trim() || !appointPlatformId) return err(new Error('User id and platform are required.'));
    try { await appointMut.mutateAsync({ userId: appointUserId.trim(), platformId: appointPlatformId }); ok('Platform admin appointed'); setAppointUserId(''); }
    catch (e) { err(e); }
  }
  async function revoke() {
    if (!revokeUserId.trim()) return err(new Error('User id is required.'));
    try { await revokeMut.mutateAsync({ userId: revokeUserId.trim(), newRole: 'admin' }); ok('Platform admin revoked → site admin'); setRevokeUserId(''); }
    catch (e) { err(e); }
  }
  async function assign() {
    if (!assignSiteId || !assignPlatformId) return err(new Error('Pick a site and a platform.'));
    try { await assignMut.mutateAsync({ siteId: assignSiteId, platformId: assignPlatformId }); ok('Site re-parented'); setAssignOpen(false); }
    catch (e) { err(e); }
  }

  const platforms = platformsQ.data?.platforms ?? [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Platforms"
        subtitle="You are the System Admin. Platforms group sites; each Platform Admin manages only their own platform's sites and site-admins — fully isolated from other platforms."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setAssignOpen(true)}>Re-parent a site</Button>
            <Button variant="outline" onClick={() => setAdminsOpen(true)}>Platform admins</Button>
            <Button onClick={() => setCreateOpen(true)}>New platform</Button>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Platforms" value={overview.length} />
        <StatCard label="Sites (all platforms)" value={totalSites} />
        <StatCard label="Platform admins" value={totalPlatformAdmins} tone={totalPlatformAdmins > 0 ? 'up' : 'default'} />
      </div>

      <Section title="All platforms">
        {overviewQ.isLoading ? (
          <Card><div className="p-6 text-sm text-muted">Loading platforms…</div></Card>
        ) : overview.length === 0 ? (
          <Card><div className="flex flex-col items-start gap-3 p-6"><p className="text-sm text-muted">No platforms yet.</p><Button onClick={() => setCreateOpen(true)}>Create your first platform</Button></div></Card>
        ) : (
          <TableWrap>
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <Th>Platform</Th><Th>Status</Th><Th className="text-right">Sites</Th>
                  <Th className="text-right">Users</Th><Th className="text-right">Site admins</Th>
                  <Th className="text-right">Platform admins</Th><Th className="text-right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {overview.map((p) => (
                  <tr key={p.platformId} className="border-t border-border">
                    <Td><div className="flex flex-col"><span className="font-medium">{p.name}</span><span className="text-xs text-muted">{p.slug}</span></div></Td>
                    <Td><StatusBadge status={p.status} /></Td>
                    <Td className="text-right tabular-nums">{p.sites}</Td>
                    <Td className="text-right tabular-nums">{p.users}</Td>
                    <Td className="text-right tabular-nums">{p.siteAdmins}</Td>
                    <Td className="text-right tabular-nums">{p.platformAdmins}</Td>
                    <Td className="text-right">
                      <Button size="sm" variant="outline" onClick={() => { setEdit(p); setEditName(p.name); setEditStatus(p.status); }}>Edit</Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Section>

      {/* Create platform */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New platform"
        description="A platform groups brands under one Platform Admin."
        chrome
        footer={
          <>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={createPlatform} disabled={createMut.isPending}>{createMut.isPending ? 'Creating…' : 'Create platform'}</Button>
          </>
        }
      >
        <div className="flex flex-col gap-5">
          <Input label="Slug" placeholder="acme" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} hint="Lowercase letters, digits and hyphens." />
          <Input label="Name" placeholder="Acme Group" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      </Modal>

      {/* Edit platform */}
      <Modal
        open={!!edit}
        onClose={() => setEdit(null)}
        title={edit ? `Edit ${edit.name}` : 'Edit'}
        chrome
        footer={
          <>
            <Button variant="outline" onClick={() => setEdit(null)}>Cancel</Button>
            <Button onClick={saveEdit} disabled={updateMut.isPending}>Save</Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Input label="Name" value={editName} onChange={(e) => setEditName(e.target.value)} />
          <Select label="Status" value={editStatus} onChange={(e) => setEditStatus(e.target.value)}>
            <option value="active">active</option>
            <option value="suspended">suspended</option>
            <option value="archived">archived</option>
          </Select>
          <p className="text-xs text-muted">Suspending a platform is a scope-wide action — its brands stay live but the platform is flagged for review.</p>
        </div>
      </Modal>

      {/* Platform admins */}
      <Modal open={adminsOpen} onClose={() => setAdminsOpen(false)} title="Platform admins" chrome>
        <div className="flex flex-col gap-5">
          <div className="rounded-xl border border-border bg-surface-2 p-3 text-xs leading-relaxed text-muted">
            A Platform Admin runs ONE platform and can never see or touch another platform's sites, users, or finances.
            Get a user's id from a brand's Users page. Appointing moves them out of any site role.
          </div>
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold">Appoint</h3>
            <Input label="User id" placeholder="uuid" value={appointUserId} onChange={(e) => setAppointUserId(e.target.value)} />
            <Select label="Platform" value={appointPlatformId} onChange={(e) => setAppointPlatformId(e.target.value)}>
              <option value="">Select a platform…</option>
              {platforms.map((p) => <option key={p.platformId} value={p.platformId}>{p.name} ({p.slug})</option>)}
            </Select>
            <div><Button onClick={appoint} disabled={appointMut.isPending}>Appoint platform admin</Button></div>
          </div>
          <div className="flex flex-col gap-3 border-t border-border pt-4">
            <h3 className="text-sm font-semibold text-down">Revoke</h3>
            <Input label="User id" placeholder="uuid" value={revokeUserId} onChange={(e) => setRevokeUserId(e.target.value)} hint="Demotes them back to site admin and clears their platform." />
            <div><Button variant="down" onClick={revoke} disabled={revokeMut.isPending}>Revoke platform admin</Button></div>
          </div>
        </div>
      </Modal>

      {/* Re-parent a site */}
      <Modal
        open={assignOpen}
        onClose={() => setAssignOpen(false)}
        title="Re-parent a site"
        chrome
        footer={
          <>
            <Button variant="outline" onClick={() => setAssignOpen(false)}>Cancel</Button>
            <Button onClick={assign} disabled={assignMut.isPending}>Re-parent</Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-xs text-muted">Move a brand into a platform. Its data moves with it — the platform's admin will then see it, and other platforms will not.</p>
          <Select label="Site" value={assignSiteId} onChange={(e) => setAssignSiteId(e.target.value)}>
            <option value="">Select a site…</option>
            {sites.map((s) => <option key={s.siteId} value={s.siteId}>{s.name} ({s.slug})</option>)}
          </Select>
          <Select label="Platform" value={assignPlatformId} onChange={(e) => setAssignPlatformId(e.target.value)}>
            <option value="">Select a platform…</option>
            {platforms.map((p) => <option key={p.platformId} value={p.platformId}>{p.name} ({p.slug})</option>)}
          </Select>
        </div>
      </Modal>

      <p className="text-xs text-muted">Isolation is enforced in the database (RLS + SECURITY DEFINER RPCs) and the API — see <Link className="underline" href="/platform">Overview</Link>. Design: docs/38.</p>
    </div>
  );
}
