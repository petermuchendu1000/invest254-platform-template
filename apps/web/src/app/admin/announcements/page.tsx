'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { ApiError } from '@/lib/api/client';
import { useToast } from '@/lib/toast/ToastProvider';
import { useSession } from '@/lib/auth/session';
import { PageHeader, Section, FilterSelect, ConfirmButton, Empty } from '@/components/admin/ui';
import { adminApi } from '@/lib/admin/endpoints';
import type { BroadcastAudienceInput, NotificationTemplateRow } from '@/lib/admin/types';

// One-click audiences. "affected" is the key ask: only users hit by the incident (failed deposit).
const AUDIENCES: { key: string; label: string; value: BroadcastAudienceInput }[] = [
  { key: 'all', label: 'All active users', value: {} },
  { key: 'affected_dep', label: 'Only affected (failed deposit, last 24h)', value: { affected_within_hours: 24, affected_kind: 'deposit' } },
  { key: 'affected_wd', label: 'Only affected (failed withdrawal, last 24h)', value: { affected_within_hours: 24, affected_kind: 'withdrawal' } },
  { key: 'players', label: 'Players only', value: { roles: ['player'] } },
  { key: 'marketers', label: 'Marketers only', value: { roles: ['marketer'] } },
  { key: 'admins', label: 'Admins only', value: { roles: ['admin', 'superadmin', 'platform_superadmin'] } },
];

const LEVEL_STYLES: Record<string, string> = {
  info: 'border-accent/40 bg-accent/5',
  success: 'border-up/40 bg-up/10',
  warning: 'border-warn/50 bg-warn/10',
  error: 'border-down/40 bg-down/10',
};

export default function AnnouncementsPage() {
  const token = useSession((s) => s.token) as string;
  const toast = useToast();

  const templatesQ = useQuery({
    queryKey: ['admin', 'notification-templates'],
    queryFn: () => adminApi.notificationTemplates(token),
    enabled: !!token,
  });
  const templates = templatesQ.data?.items ?? [];

  const [templateKey, setTemplateKey] = useState<string>('');
  const [audienceKey, setAudienceKey] = useState<string>('all');

  const selected: NotificationTemplateRow | undefined = useMemo(
    () => templates.find((t) => t.key === templateKey) ?? templates[0],
    [templates, templateKey],
  );
  const audience = AUDIENCES.find((a) => a.key === audienceKey)?.value ?? {};

  // Live recipient count for the chosen audience (drives the preview + Send label).
  const countQ = useQuery({
    queryKey: ['admin', 'notification-audience', audienceKey],
    queryFn: () => adminApi.notificationAudienceCount(token, audience),
    enabled: !!token,
  });
  const recipients = countQ.data?.count ?? 0;

  const broadcast = useMutation({
    mutationFn: () => adminApi.notificationBroadcast(token, selected!.key, audience),
    onSuccess: (r) =>
      toast.push({ tone: 'success', title: 'Notice sent', description: `Delivered to ${r.recipients} user(s).` }),
    onError: (e) =>
      toast.push({ tone: 'error', title: 'Send failed', description: e instanceof ApiError ? e.message : 'Please try again.' }),
  });

  const resolve = useMutation({
    mutationFn: (category: string) => adminApi.notificationResolveCategory(token, category),
    onSuccess: (r) =>
      toast.push({ tone: 'success', title: 'Notice cleared', description: `Removed ${r.cleared} active notice(s) platform-wide.` }),
    onError: (e) =>
      toast.push({ tone: 'error', title: 'Clear failed', description: e instanceof ApiError ? e.message : 'Please try again.' }),
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Announcements"
        subtitle="Send a saved system notice to everyone, or only the users affected by an incident, in one click."
      />

      {templatesQ.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : templates.length === 0 ? (
        <Empty title="No templates" description="The notification template library is empty." />
      ) : (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          {/* Compose */}
          <Section title="Compose">
            <div className="flex flex-col gap-4">
              <FilterSelect
                label="Template"
                value={selected?.key ?? ''}
                onChange={setTemplateKey}
                options={templates.map((t) => ({ value: t.key, label: t.title }))}
              />
              <FilterSelect
                label="Send to"
                value={audienceKey}
                onChange={setAudienceKey}
                options={AUDIENCES.map((a) => ({ value: a.key, label: a.label }))}
              />
              <div className="flex items-center gap-2 text-sm text-muted">
                <span>Recipients:</span>
                {countQ.isFetching ? (
                  <Skeleton className="h-4 w-10" />
                ) : (
                  <span className="font-semibold text-fg">{recipients.toLocaleString()}</span>
                )}
                {selected?.description ? <span className="ml-auto text-xs">{selected.description}</span> : null}
              </div>
              <ConfirmButton
                label={`Send to ${recipients.toLocaleString()} user(s)`}
                confirmLabel="Confirm send to all selected"
                variant="primary"
                size="md"
                busy={broadcast.isPending}
                disabled={!selected || recipients === 0}
                onConfirm={() => broadcast.mutate()}
              />
              {selected ? (
                <ConfirmButton
                  label={`Clear active "${selected.category}" notices`}
                  confirmLabel="Confirm clear platform-wide"
                  variant="ghost"
                  size="sm"
                  busy={resolve.isPending}
                  onConfirm={() => resolve.mutate(selected.category)}
                />
              ) : null}
            </div>
          </Section>

          {/* Preview */}
          <Section title="Preview">
            {selected ? (
              <Card className={`flex flex-col gap-2 rounded-2xl border p-4 ${LEVEL_STYLES[selected.level] ?? LEVEL_STYLES.info}`}>
                <div className="flex items-center justify-between">
                  <span className="text-xs uppercase tracking-wide text-muted">{selected.level}</span>
                  <span className="text-xs text-muted">{selected.dismissible ? 'Dismissible' : 'Blocking'}</span>
                </div>
                <h3 className="text-base font-semibold text-fg">{selected.title}</h3>
                <p className="whitespace-pre-line text-sm text-fg/90">{selected.body}</p>
                {selected.resolvesCategory ? (
                  <p className="text-xs text-muted">
                    Sending this also clears any active &quot;{selected.resolvesCategory}&quot; notices.
                  </p>
                ) : null}
              </Card>
            ) : null}
          </Section>
        </div>
      )}
    </div>
  );
}
