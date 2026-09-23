'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { ApiError } from '@/lib/api/client';
import { useToast } from '@/lib/toast/ToastProvider';
import { useSession } from '@/lib/auth/session';
import { PageHeader, Section, ConfirmButton, Empty } from '@/components/admin/ui';
import { adminApi } from '@/lib/admin/endpoints';
import type { BroadcastAudienceInput, NotificationTemplateRow } from '@/lib/admin/types';
import { formatNumber } from '@/lib/format';

// One-click audiences. "affected" is the key ask: only users hit by the incident (failed deposit).
const AUDIENCES: { key: string; label: string; value: BroadcastAudienceInput }[] = [
  { key: 'all', label: 'All active users', value: {} },
  { key: 'affected_dep', label: 'Only affected (failed deposit, last 24h)', value: { affected_within_hours: 24, affected_kind: 'deposit' } },
  { key: 'affected_wd', label: 'Only affected (failed withdrawal, last 24h)', value: { affected_within_hours: 24, affected_kind: 'withdrawal' } },
  { key: 'players', label: 'Players only', value: { roles: ['player'] } },
  { key: 'marketers', label: 'Marketers only', value: { roles: ['marketer'] } },
  { key: 'admins', label: 'Admins only', value: { roles: ['admin', 'platform_superadmin'] } },
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

  // UI-C (0162): the text is editable, pre-filled from the chosen template (the "Announcement" template
  // told admins to edit the title and body, but there was nowhere to do it).
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  useEffect(() => { setTitle(selected?.title ?? ''); setBody(selected?.body ?? ''); }, [selected?.key, selected?.title, selected?.body]);
  const edited = !!selected && (title.trim() !== selected.title || body.trim() !== selected.body);
  const tooLong = title.trim().length > 120 || body.trim().length > 2000;

  // Live recipient count for the chosen audience (drives the preview + Send label).
  const countQ = useQuery({
    queryKey: ['admin', 'notification-audience', audienceKey],
    queryFn: () => adminApi.notificationAudienceCount(token, audience),
    enabled: !!token,
  });
  const recipients = countQ.data?.count ?? 0;

  const broadcast = useMutation({
    mutationFn: () => adminApi.notificationBroadcast(token, selected!.key, audience, edited ? { title: title.trim(), body: body.trim() } : undefined),
    onSuccess: (r) =>
      toast.push({ tone: 'success', title: 'Notice sent', description: `Delivered to ${r.recipients} user(s).` }),
    onError: (e) =>
      toast.push({ tone: 'error', title: 'Send failed', description: e instanceof ApiError ? e.message : 'Please try again.' }),
  });

  const resolve = useMutation({
    mutationFn: (category: string) => adminApi.notificationResolveCategory(token, category),
    onSuccess: (r) =>
      toast.push({ tone: 'success', title: 'Notice cleared', description: `Removed ${r.cleared} active notice(s).` }),
    onError: (e) =>
      toast.push({ tone: 'error', title: 'Clear failed', description: e instanceof ApiError ? e.message : 'Please try again.' }),
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Announcements"
        subtitle="Send a notice to your players: pick a template, adjust the wording, choose who gets it."
      />

      {templatesQ.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : templates.length === 0 ? (
        <Empty title="No templates" description="The notification template library is empty." />
      ) : (
        <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Compose */}
          <Section title="Compose">
            <div className="flex min-w-0 flex-col gap-4">
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium text-fg">Template</span>
                <select
                  value={selected?.key ?? ''}
                  onChange={(e) => setTemplateKey(e.target.value)}
                  className="h-10 w-full min-w-0 rounded-lg border border-border bg-surface-2 px-3 text-sm text-fg outline-none focus:border-accent"
                >
                  {templates.map((t) => <option key={t.key} value={t.key}>{t.title}</option>)}
                </select>
                {selected?.description ? <span className="text-xs text-muted">{selected.description}</span> : null}
              </label>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium text-fg">Title</span>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={120}
                  className="h-10 w-full min-w-0 rounded-lg border border-border bg-surface-2 px-3 text-sm text-fg outline-none focus:border-accent"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="flex items-center justify-between font-medium text-fg">
                  Message <span className="text-xs font-normal text-muted">{body.trim().length}/2000</span>
                </span>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={6}
                  maxLength={2000}
                  className="w-full min-w-0 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:border-accent"
                />
                {edited ? (
                  <button type="button" onClick={() => { setTitle(selected?.title ?? ''); setBody(selected?.body ?? ''); }} className="self-start text-xs text-accent hover:underline">
                    Reset to the template text
                  </button>
                ) : null}
              </label>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium text-fg">Send to</span>
                <select
                  value={audienceKey}
                  onChange={(e) => setAudienceKey(e.target.value)}
                  className="h-10 w-full min-w-0 rounded-lg border border-border bg-surface-2 px-3 text-sm text-fg outline-none focus:border-accent"
                >
                  {AUDIENCES.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
                </select>
                <span className="flex items-center gap-1.5 text-xs text-muted">
                  {countQ.isFetching ? <Skeleton className="h-3 w-8" /> : <b className="font-semibold text-fg">{formatNumber(recipients)}</b>}
                  {recipients === 1 ? 'person' : 'people'} will get this notice
                </span>
              </label>
              <ConfirmButton
                label={`Send to ${formatNumber(recipients)} ${recipients === 1 ? 'person' : 'people'}`}
                confirmLabel="Yes, send it"
                variant="primary"
                size="md"
                busy={broadcast.isPending}
                disabled={!selected || recipients === 0 || !title.trim() || !body.trim() || tooLong}
                onConfirm={() => broadcast.mutate()}
              />
              {selected ? (
                <div className="border-t border-border pt-3">
                  <p className="mb-2 text-xs text-muted">
                    Is the issue over? Remove every active &quot;{selected.category.replace(/_/g, ' ')}&quot; notice for your players.
                  </p>
                  <ConfirmButton
                    label="Remove active notices"
                    confirmLabel="Yes, remove them"
                    variant="outline"
                    size="sm"
                    busy={resolve.isPending}
                    onConfirm={() => resolve.mutate(selected.category)}
                  />
                </div>
              ) : null}
            </div>
          </Section>

          {/* Preview */}
          <Section title="Preview">
            {selected ? (
              <Card className={`flex flex-col gap-2 rounded-2xl border p-4 ${LEVEL_STYLES[selected.level] ?? LEVEL_STYLES.info}`}>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium capitalize text-muted">{selected.level}</span>
                  <span className="text-xs text-muted">{selected.dismissible ? 'Players can dismiss it' : 'Stays until removed'}</span>
                </div>
                <h3 className="break-words text-base font-semibold text-fg">{title.trim() || selected.title}</h3>
                <p className="whitespace-pre-line break-words text-sm text-fg/90">{body.trim() || selected.body}</p>
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
