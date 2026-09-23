'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { supportApi } from '@/lib/support/endpoints';
import type { SupportCitation } from '@/lib/support/types';
import { errorMessageFor, shouldResetSupportChat, subjectFromToken } from '@/lib/support/format';
import { ApiError } from '@/lib/api/client';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: SupportCitation[];
  confidence?: number;
  shouldEscalate?: boolean;
  error?: boolean;
}

interface SupportChatState {
  open: boolean;
  conversationId: string | null;
  /** Capability token for `conversationId` (Issue 1 / F-48) — required by the server on every write. */
  conversationToken: string | null;
  /** The signed-in account that started the stored conversation (null = anonymous visitor). */
  ownerUserId: string | null;
  visitorId: string | null;
  messages: ChatMessage[];
  sending: boolean;
  escalated: boolean;
  /** True after the assistant's last answer suggested a human handoff. */
  needsEscalation: boolean;
  setOpen: (open: boolean) => void;
  send: (text: string, token: string | null) => Promise<void>;
  escalate: (contact: { email?: string; phone?: string }, token: string | null) => Promise<boolean>;
  /** Drop the stored conversation when the person using this browser changed (F-48). */
  syncIdentity: (token: string | null) => void;
  reset: () => void;
}

const MAX_MESSAGES = 60;
const rid = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

/**
 * Client-side support conversation. The public API cannot read a visitor's own transcript
 * (operator-only), so the widget keeps its message log here and persists the conversation id, its
 * capability token and an anonymous visitor id for continuity across reloads.
 *
 * Issue 1 / F-48: a conversation started by a signed-in account is wiped from this browser as soon as a
 * different person uses it (another account, or signed out) — the transcript is never shown to, and the
 * conversation never continued by, someone else. A conversation the server no longer accepts (legacy,
 * pre-token) is replaced by a fresh one transparently.
 */
export const useSupportChat = create<SupportChatState>()(
  persist(
    (set, get) => ({
      open: false,
      conversationId: null,
      conversationToken: null,
      ownerUserId: null,
      visitorId: null,
      messages: [],
      sending: false,
      escalated: false,
      needsEscalation: false,

      setOpen: (open) => set({ open }),

      async send(text, token) {
        const trimmed = text.trim();
        if (!trimmed || get().sending) return;
        get().syncIdentity(token);   // before appending, so a reset never swallows this message

        const userMsg: ChatMessage = { id: rid(), role: 'user', content: trimmed };
        set((s) => ({ messages: [...s.messages, userMsg].slice(-MAX_MESSAGES), sending: true }));

        try {
          let visitorId = get().visitorId;
          if (!visitorId) {
            visitorId = rid();
            set({ visitorId });
          }
          const open = async (): Promise<void> => {
            const started = await supportApi.start({ visitorId: visitorId! }, token);
            set({ conversationId: started.conversationId, conversationToken: started.conversationToken ?? null, ownerUserId: subjectFromToken(token) });
          };
          if (!get().conversationId) await open();

          let res;
          try {
            res = await supportApi.ask(get().conversationId!, get().conversationToken, trimmed, token);
          } catch (err) {
            // A conversation the server no longer accepts (legacy, pre-token): start a fresh one, retry once.
            if (!(err instanceof ApiError && err.status === 404)) throw err;
            set({ conversationId: null, conversationToken: null, escalated: false, needsEscalation: false });
            await open();
            res = await supportApi.ask(get().conversationId!, get().conversationToken, trimmed, token);
          }
          const assistant: ChatMessage = {
            id: rid(),
            role: 'assistant',
            content: res.answer,
            citations: res.citations,
            confidence: res.confidence,
            shouldEscalate: res.shouldEscalate,
          };
          set((s) => ({
            messages: [...s.messages, assistant].slice(-MAX_MESSAGES),
            needsEscalation: res.shouldEscalate,
          }));
        } catch (err) {
          const message = errorMessageFor(err instanceof ApiError ? err.status : 0);
          set((s) => ({
            messages: [...s.messages, { id: rid(), role: 'assistant' as const, content: message, error: true }].slice(-MAX_MESSAGES),
          }));
        } finally {
          set({ sending: false });
        }
      },

      async escalate(contact, token) {
        get().syncIdentity(token);
        const conversationId = get().conversationId;
        if (!conversationId) return false;
        try {
          await supportApi.escalate(conversationId, get().conversationToken, contact, token);
          set((s) => ({
            escalated: true,
            needsEscalation: false,
            messages: [
              ...s.messages,
              {
                id: rid(),
                role: 'assistant' as const,
                content: 'Thanks. A member of our team will follow up using the contact you shared.',
              },
            ].slice(-MAX_MESSAGES),
          }));
          return true;
        } catch {
          return false;
        }
      },

      syncIdentity: (token) => {
        const s = get();
        if (shouldResetSupportChat(s.ownerUserId, s.conversationId, subjectFromToken(token))) {
          // A different person: forget the conversation, its token, the transcript AND the visitor id.
          set({ conversationId: null, conversationToken: null, ownerUserId: null, visitorId: null, messages: [], escalated: false, needsEscalation: false });
        }
      },

      reset: () => set({ conversationId: null, conversationToken: null, ownerUserId: null, messages: [], escalated: false, needsEscalation: false }),
    }),
    {
      name: 'pp-support-chat',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        conversationId: s.conversationId,
        conversationToken: s.conversationToken,
        ownerUserId: s.ownerUserId,
        visitorId: s.visitorId,
        messages: s.messages,
        escalated: s.escalated,
      }),
    },
  ),
);
