import { apiFetch } from '@/lib/api/client';

/** Internal ticketing + subscription/billing API client (Issue 2). */
export interface Ticket {
  id: string; platformId: string; siteId: string | null; createdBy: string; createdByRole: string;
  subject: string; body: string; urgency: 'low' | 'medium' | 'high' | 'critical';
  status: 'open' | 'in_progress' | 'resolved' | 'closed'; escalationLevel: number; assigneeRole: string;
  slaDueAtMs: number | null; firstResponseAtMs: number | null; resolvedAtMs: number | null; resolvedBy: string | null;
  closedAtMs: number | null; createdAtMs: number; updatedAtMs: number;
}
export interface TicketComment { id: number; ticketId: string; authorId: string; authorRole: string; body: string; createdAtMs: number; }
export interface TicketEscalation { id: number; ticketId: string; fromLevel: number; toLevel: number; fromRole: string | null; toRole: string | null; reason: string; note: string | null; actorId: string | null; actorRole: string | null; createdAtMs: number; }
export interface TicketDetail { ticket: Ticket; comments: TicketComment[]; escalations: TicketEscalation[]; }
export interface CreateTicketBody { subject: string; body?: string; urgency: string; platformId?: string; siteId?: string }

export interface SubscriptionPlan { key: string; name: string; maxSites: number | null; maxUsers: number | null; priceCents: number | null; currency: string; billingPeriod: string; isCustom: boolean; sort: number; }
export interface PlatformSubscription { platformId: string; planKey: string; status: string; trialEndsAt: string | null; currentPeriodStart: string | null; currentPeriodEnd: string | null; graceEndsAt: string | null; customPriceCents: number | null; customMaxSites: number | null; customMaxUsers: number | null; lastPaymentAt: string | null; notes: string | null; }
export interface PlatformUsage { planKey: string; status: string; sites: number; users: number; maxSites: number | null; maxUsers: number | null; trialEndsAt: string | null; currentPeriodEnd: string | null; graceEndsAt: string | null; }
export interface SubscriptionEvent { id: number; platformId: string; fromStatus: string | null; toStatus: string | null; planKey: string | null; reason: string; amountCents: number | null; actorId: string | null; actorRole: string | null; createdAtMs: number; }

export const opsApi = {
  // ── Tickets ──
  listTickets: (t: string, q: { status?: string | undefined; urgency?: string | undefined; limit?: number | undefined }) =>
    apiFetch<{ tickets: Ticket[] }>('/tickets', { token: t, query: { status: q.status, urgency: q.urgency, limit: q.limit } }),
  getTicket: (t: string, id: string) => apiFetch<TicketDetail>(`/tickets/${id}`, { token: t }),
  createTicket: (t: string, body: CreateTicketBody) => apiFetch<Ticket>('/tickets', { method: 'POST', token: t, body }),
  commentTicket: (t: string, id: string, body: string) => apiFetch<TicketComment>(`/tickets/${id}/comments`, { method: 'POST', token: t, body: { body } }),
  setTicketStatus: (t: string, id: string, status: string, note?: string) => apiFetch<{ ticket: Ticket }>(`/tickets/${id}/status`, { method: 'POST', token: t, body: { status, note } }),
  escalateTicket: (t: string, id: string, note?: string) => apiFetch<{ ticket: Ticket }>(`/tickets/${id}/escalate`, { method: 'POST', token: t, body: { note } }),
  // ── Subscriptions / billing ──
  plans: (t: string) => apiFetch<{ plans: SubscriptionPlan[] }>('/platform/subscription-plans', { token: t }),
  subscription: (t: string, platformId: string) => apiFetch<{ subscription: PlatformSubscription | null; usage: PlatformUsage | null }>(`/platform/subscriptions/${platformId}`, { token: t }),
  mySubscription: (t: string) => apiFetch<{ subscription: PlatformSubscription | null; usage: PlatformUsage | null }>('/platform/subscriptions/me', { token: t }),
  subEvents: (t: string, platformId: string) => apiFetch<{ events: SubscriptionEvent[] }>(`/platform/subscriptions/${platformId}/events`, { token: t }),
  setPlan: (t: string, platformId: string, body: { planKey: string; customPriceCents?: number | null; customMaxSites?: number | null; customMaxUsers?: number | null }) =>
    apiFetch<PlatformSubscription>(`/platform/subscriptions/${platformId}/plan`, { method: 'POST', token: t, body }),
  setSubStatus: (t: string, platformId: string, status: string, reason?: string) =>
    apiFetch<PlatformSubscription>(`/platform/subscriptions/${platformId}/status`, { method: 'POST', token: t, body: { status, reason } }),
  recordPayment: (t: string, platformId: string, amountCents: number, periodDays?: number) =>
    apiFetch<PlatformSubscription>(`/platform/subscriptions/${platformId}/payment`, { method: 'POST', token: t, body: { amountCents, periodDays } }),
};
