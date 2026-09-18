'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { opsApi, type CreateTicketBody } from '@/lib/ops/endpoints';
import { useSession } from '@/lib/auth/session';

function useTok() { return useSession((s) => s.token) as string; }

// ── Tickets ──
export function useTickets(q: { status?: string | undefined; urgency?: string | undefined; limit?: number | undefined } = {}) {
  const t = useTok();
  return useQuery({ queryKey: ['tickets', q], queryFn: () => opsApi.listTickets(t, q), enabled: !!t });
}
export function useTicket(id: string | null) {
  const t = useTok();
  return useQuery({ queryKey: ['ticket', id], queryFn: () => opsApi.getTicket(t, id!), enabled: !!t && !!id });
}
export function useCreateTicket() {
  const t = useTok(); const qc = useQueryClient();
  return useMutation({ mutationFn: (b: CreateTicketBody) => opsApi.createTicket(t, b), onSuccess: () => qc.invalidateQueries({ queryKey: ['tickets'] }) });
}
function invalidateTicket(qc: ReturnType<typeof useQueryClient>, id: string) {
  void qc.invalidateQueries({ queryKey: ['ticket', id] }); void qc.invalidateQueries({ queryKey: ['tickets'] });
}
export function useCommentTicket(id: string) {
  const t = useTok(); const qc = useQueryClient();
  return useMutation({ mutationFn: (body: string) => opsApi.commentTicket(t, id, body), onSuccess: () => invalidateTicket(qc, id) });
}
export function useSetTicketStatus(id: string) {
  const t = useTok(); const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { status: string; note?: string }) => opsApi.setTicketStatus(t, id, v.status, v.note), onSuccess: () => invalidateTicket(qc, id) });
}
export function useEscalateTicket(id: string) {
  const t = useTok(); const qc = useQueryClient();
  return useMutation({ mutationFn: (note?: string) => opsApi.escalateTicket(t, id, note), onSuccess: () => invalidateTicket(qc, id) });
}

// ── Subscriptions / billing ──
export function usePlans() { const t = useTok(); return useQuery({ queryKey: ['sub-plans'], queryFn: () => opsApi.plans(t), enabled: !!t }); }
export function useSubscription(platformId: string | null) {
  const t = useTok();
  return useQuery({ queryKey: ['subscription', platformId], queryFn: () => opsApi.subscription(t, platformId!), enabled: !!t && !!platformId });
}
export function useMySubscription() { const t = useTok(); return useQuery({ queryKey: ['subscription', 'me'], queryFn: () => opsApi.mySubscription(t), enabled: !!t }); }
export function useSubEvents(platformId: string | null) {
  const t = useTok();
  return useQuery({ queryKey: ['sub-events', platformId], queryFn: () => opsApi.subEvents(t, platformId!), enabled: !!t && !!platformId });
}
function invalidateSub(qc: ReturnType<typeof useQueryClient>, platformId: string) {
  void qc.invalidateQueries({ queryKey: ['subscription', platformId] });
  void qc.invalidateQueries({ queryKey: ['sub-events', platformId] });
  void qc.invalidateQueries({ queryKey: ['platform', 'platforms-overview'] });
}
export function useSetPlan(platformId: string) {
  const t = useTok(); const qc = useQueryClient();
  return useMutation({ mutationFn: (b: { planKey: string; customPriceCents?: number | null; customMaxSites?: number | null; customMaxUsers?: number | null }) => opsApi.setPlan(t, platformId, b), onSuccess: () => invalidateSub(qc, platformId) });
}
export function useSetSubStatus(platformId: string) {
  const t = useTok(); const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { status: string; reason?: string }) => opsApi.setSubStatus(t, platformId, v.status, v.reason), onSuccess: () => invalidateSub(qc, platformId) });
}
export function useRecordPayment(platformId: string) {
  const t = useTok(); const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { amountCents: number; periodDays?: number }) => opsApi.recordPayment(t, platformId, v.amountCents, v.periodDays), onSuccess: () => invalidateSub(qc, platformId) });
}
