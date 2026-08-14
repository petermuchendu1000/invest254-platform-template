import { apiFetch } from '@/lib/api/client';
import type {
  SupportAnswerResult,
  SupportConversationDto,
  SupportStartResult,
  SupportThreadDto,
} from '@/lib/support/types';

/**
 * Support-chat REST client. The public endpoints are anonymous-friendly: a bearer token is
 * optional and, when present, attributes the conversation to the logged-in player and scopes
 * it to their brand. The operator endpoints are admin-gated (bearer required).
 */
export const supportApi = {
  // Public (optional auth)
  start: (body: { visitorId?: string; siteId?: string } = {}, token?: string | null) =>
    apiFetch<SupportStartResult>('/support/conversations', { method: 'POST', body, token: token ?? null }),
  ask: (conversationId: string, message: string, token?: string | null) =>
    apiFetch<SupportAnswerResult>(`/support/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: { message },
      token: token ?? null,
    }),
  escalate: (conversationId: string, contact: { email?: string; phone?: string }, token?: string | null) =>
    apiFetch<{ status: string }>(`/support/conversations/${conversationId}/escalate`, {
      method: 'POST',
      body: contact,
      token: token ?? null,
    }),

  // Operator (admin+)
  conversations: (token: string, limit = 50) =>
    apiFetch<{ items: SupportConversationDto[] }>('/support/conversations', { token, query: { limit } }),
  thread: (token: string, id: string) =>
    apiFetch<SupportThreadDto>(`/support/conversations/${id}`, { token }),
};
