'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api/client';
import { useSession } from '@/lib/auth/session';

/** BILL-1 (docs/47): the billing API client + React Query hooks. Types mirror apps/engine/src/billing.ts. */
export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';
export interface InvoiceSummary {
  id: string; number: string; platformId: string; platformName: string; kind: 'renewal' | 'manual'; status: InvoiceStatus;
  issuedAt: string; dueAt: string; periodStart: string | null; periodEnd: string | null;
  totalCents: number; amountPaidCents: number; amountDueCents: number; overdue: boolean; paidAt: string | null;
}
export interface InvoiceLine {
  id: string; kind: string; description: string; siteId: string | null; siteName: string | null;
  quantity: number; unitCents: number; amountCents: number; periodStart: string | null; periodEnd: string | null;
}
export interface InvoicePayment {
  id: string; method: 'mpesa' | 'bank' | 'cash' | 'other'; status: 'pending' | 'succeeded' | 'failed'; amountCents: number;
  reference: string | null; phone: string | null; note: string | null; failureReason: string | null; createdAt: string; settledAt: string | null;
}
export interface Seller {
  name: string; address: string; taxPin: string; email: string; phone: string; taxLabel: string;
  paymentInstructions: string; footerNote: string; mpesaPayEnabled: boolean;
}
export interface Invoice extends InvoiceSummary {
  currency: string; planKey: string | null; subtotalCents: number; taxRateBp: number; taxCents: number;
  voidedAt: string | null; statusReason: string | null; notes: string | null;
  lines: InvoiceLine[]; payments: InvoicePayment[]; seller: Seller;
}
export interface BillingAccount {
  platformId: string; platformName: string; platformSlug: string; planKey: string; planName: string | null;
  priceCents: number | null; customPrice: boolean; billingPeriod: string | null; status: string; billingExempt: boolean;
  trialEndsAt: string | null; currentPeriodStart: string | null; currentPeriodEnd: string | null; graceEndsAt: string | null;
  lastPaymentAt: string | null; nextInvoiceAt: string | null; monthlyAddonsCents: number; pendingChargesCents: number;
  balanceDueCents: number; overdueCents: number; openInvoices: number;
  maxSites: number | null; maxUsers: number | null; sites: number; users: number;
}
export interface PendingCharge { id: string; kind: string; description: string; siteId: string | null; siteName: string | null; amountCents: number; createdAt: string }
export interface BillingOverview {
  mrrCents: number; arrCents: number; outstandingCents: number; overdueCents: number;
  collectedThisMonthCents: number; collectedLastMonthCents: number;
  aging: { current: number; d1_30: number; d31_60: number; d61_90: number; d90p: number };
  statusCounts: Record<string, number>;
  upcoming: { platformId: string; platformName: string; at: string; amountCents: number }[];
  recentPayments: { id: string; invoiceId: string; number: string; platformName: string; method: string; amountCents: number; reference: string | null; settledAt: string }[];
}
export interface BillingSettings {
  businessName: string; businessAddress: string; taxPin: string; billingEmail: string; billingPhone: string;
  invoicePrefix: string; nextNumber: number; daysUntilDue: number; taxRateBp: number; taxLabel: string;
  paymentInstructions: string; mpesaPayEnabled: boolean; footerNote: string;
  trialDays: number; pastDueDays: number; graceDays: number; updatedAt: string | null;
}
export interface BillingPlan {
  key: string; name: string; priceCents: number | null; maxSites: number | null; maxUsers: number | null;
  billingPeriod: string; isCustom: boolean; active: boolean; sort: number; platforms: number;
}
export interface NewLine { description: string; unitCents: number; quantity?: number; siteId?: string | null }
export interface SubscriptionEvent {
  id: number; platformId: string; fromStatus: string | null; toStatus: string | null; planKey: string | null;
  reason: string; amountCents: number | null; actorId: string | null; actorRole: string | null; createdAtMs: number;
}

const B = '/platform/billing';
export const billingApi = {
  overview: (t: string) => apiFetch<BillingOverview>(`${B}/overview`, { token: t }),
  accounts: (t: string) => apiFetch<{ accounts: BillingAccount[] }>(`${B}/accounts`, { token: t }),
  invoices: (t: string, f: { platform?: string; status?: string; q?: string; limit?: number }) =>
    apiFetch<{ invoices: InvoiceSummary[] }>(`${B}/invoices`, { token: t, query: { platform: f.platform || undefined, status: f.status || undefined, q: f.q || undefined, limit: f.limit } }),
  invoice: (t: string, id: string) => apiFetch<Invoice>(`${B}/invoices/${id}`, { token: t }),
  createInvoice: (t: string, b: { platformId: string; lines: NewLine[]; includePending: boolean; dueDays?: number | null; notes?: string }) =>
    apiFetch<Invoice>(`${B}/invoices`, { method: 'POST', token: t, body: b }),
  recordPayment: (t: string, id: string, b: { method: string; amountCents: number; reference?: string; note?: string }) =>
    apiFetch<Invoice>(`${B}/invoices/${id}/payments`, { method: 'POST', token: t, body: b }),
  setStatus: (t: string, id: string, b: { status: 'void' | 'uncollectible'; reason: string }) =>
    apiFetch<Invoice>(`${B}/invoices/${id}/status`, { method: 'POST', token: t, body: b }),
  payNow: (t: string, id: string, phone: string) =>
    apiFetch<{ paymentId: string; amountCents: number; invoiceNumber: string; checkoutRequestId: string }>(`${B}/invoices/${id}/pay`, { method: 'POST', token: t, body: { phone } }),
  charges: (t: string, platform: string) => apiFetch<{ charges: PendingCharge[] }>(`${B}/charges`, { token: t, query: { platform } }),
  addCharge: (t: string, b: { platformId: string; siteId?: string | null; description: string; amountCents: number }) =>
    apiFetch<{ id: string }>(`${B}/charges`, { method: 'POST', token: t, body: b }),
  voidCharge: (t: string, id: string) => apiFetch<{ ok: true }>(`${B}/charges/${id}`, { method: 'DELETE', token: t }),
  settings: (t: string) => apiFetch<BillingSettings>(`${B}/settings`, { token: t }),
  saveSettings: (t: string, patch: Partial<BillingSettings>) => apiFetch<BillingSettings>(`${B}/settings`, { method: 'PATCH', token: t, body: patch }),
  plans: (t: string) => apiFetch<{ plans: BillingPlan[] }>(`${B}/plans`, { token: t }),
  upsertPlan: (t: string, key: string, b: { name: string; priceCents: number | null; maxSites: number | null; maxUsers: number | null; active: boolean }) =>
    apiFetch<{ plans: BillingPlan[] }>(`${B}/plans/${key}`, { method: 'PUT', token: t, body: b }),
  setExempt: (t: string, platformId: string, exempt: boolean) => apiFetch<{ ok: true }>(`${B}/accounts/${platformId}/exempt`, { method: 'POST', token: t, body: { exempt } }),
  run: (t: string) => apiFetch<{ issued: number; transitions: number; reminders: number }>(`${B}/run`, { method: 'POST', token: t }),
  // existing subscription routes (plan / status / history)
  setPlan: (t: string, platformId: string, b: { planKey: string; customPriceCents?: number | null; customMaxSites?: number | null; customMaxUsers?: number | null }) =>
    apiFetch<unknown>(`/platform/subscriptions/${platformId}/plan`, { method: 'POST', token: t, body: b }),
  setSubStatus: (t: string, platformId: string, status: string, reason: string) =>
    apiFetch<unknown>(`/platform/subscriptions/${platformId}/status`, { method: 'POST', token: t, body: { status, reason } }),
  events: (t: string, platformId: string) => apiFetch<{ events: SubscriptionEvent[] }>(`/platform/subscriptions/${platformId}/events`, { token: t, query: { limit: 50 } }),
};

function useTok() { return useSession((s) => s.token) as string; }
function useInvalidate() {
  const qc = useQueryClient();
  return () => { void qc.invalidateQueries({ queryKey: ['billing'] }); };
}

export function useBillingOverview(enabled = true) { const t = useTok(); return useQuery({ queryKey: ['billing', 'overview'], queryFn: () => billingApi.overview(t), enabled: !!t && enabled }); }
export function useBillingAccounts() { const t = useTok(); return useQuery({ queryKey: ['billing', 'accounts'], queryFn: () => billingApi.accounts(t), enabled: !!t }); }
export function useInvoices(f: { platform?: string; status?: string; q?: string; limit?: number }) {
  const t = useTok(); return useQuery({ queryKey: ['billing', 'invoices', f], queryFn: () => billingApi.invoices(t, f), enabled: !!t });
}
/** Polls while an M-Pesa payment is pending so the page flips to Paid on its own. */
export function useInvoice(id: string | null) {
  const t = useTok();
  return useQuery({
    queryKey: ['billing', 'invoice', id], queryFn: () => billingApi.invoice(t, id!), enabled: !!t && !!id,
    refetchInterval: (q) => (q.state.data?.payments.some((p) => p.status === 'pending') ? 4000 : false),
  });
}
export function useCharges(platform: string | null) { const t = useTok(); return useQuery({ queryKey: ['billing', 'charges', platform], queryFn: () => billingApi.charges(t, platform!), enabled: !!t && !!platform }); }
export function useBillingSettings() { const t = useTok(); return useQuery({ queryKey: ['billing', 'settings'], queryFn: () => billingApi.settings(t), enabled: !!t }); }
export function useBillingPlans() { const t = useTok(); return useQuery({ queryKey: ['billing', 'plans'], queryFn: () => billingApi.plans(t), enabled: !!t }); }
export function useSubEvents(platformId: string | null) { const t = useTok(); return useQuery({ queryKey: ['billing', 'events', platformId], queryFn: () => billingApi.events(t, platformId!), enabled: !!t && !!platformId }); }

function useM<A, R>(fn: (t: string, a: A) => Promise<R>) {
  const t = useTok(); const inv = useInvalidate();
  return useMutation({ mutationFn: (a: A) => fn(t, a), onSuccess: inv });
}
export const useCreateInvoice = () => useM(billingApi.createInvoice);
export const useRecordInvoicePayment = () => useM((t, a: { id: string; method: string; amountCents: number; reference?: string; note?: string }) =>
  billingApi.recordPayment(t, a.id, { method: a.method, amountCents: a.amountCents, ...(a.reference ? { reference: a.reference } : {}), ...(a.note ? { note: a.note } : {}) }));
export const useSetInvoiceStatus = () => useM((t, a: { id: string; status: 'void' | 'uncollectible'; reason: string }) => billingApi.setStatus(t, a.id, { status: a.status, reason: a.reason }));
export const usePayNow = () => useM((t, a: { id: string; phone: string }) => billingApi.payNow(t, a.id, a.phone));
export const useAddCharge = () => useM(billingApi.addCharge);
export const useVoidCharge = () => useM(billingApi.voidCharge);
export const useSaveBillingSettings = () => useM(billingApi.saveSettings);
export const useUpsertPlan = () => useM((t, a: { key: string; name: string; priceCents: number | null; maxSites: number | null; maxUsers: number | null; active: boolean }) =>
  billingApi.upsertPlan(t, a.key, { name: a.name, priceCents: a.priceCents, maxSites: a.maxSites, maxUsers: a.maxUsers, active: a.active }));
export const useSetExempt = () => useM((t, a: { platformId: string; exempt: boolean }) => billingApi.setExempt(t, a.platformId, a.exempt));
export const useRunBilling = () => useM((t, _a: void) => billingApi.run(t));
export const useChangePlan = () => useM((t, a: { platformId: string; planKey: string; customPriceCents?: number | null; customMaxSites?: number | null; customMaxUsers?: number | null }) =>
  billingApi.setPlan(t, a.platformId, { planKey: a.planKey, customPriceCents: a.customPriceCents ?? null, customMaxSites: a.customMaxSites ?? null, customMaxUsers: a.customMaxUsers ?? null }));
export const useSetSubscriptionStatus = () => useM((t, a: { platformId: string; status: string; reason: string }) => billingApi.setSubStatus(t, a.platformId, a.status, a.reason));
