'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { supportApi } from '@/lib/support/endpoints';
import type { SupportCitation } from '@/lib/support/types';
import { errorMessageFor } from '@/lib/support/format';
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
  visitorId: string | null;
  messages: ChatMessage[];
  sending: boolean;
  escalated: boolean;
  /** True after the assistant's last answer suggested a human handoff. */
  needsEscalation: boolean;
  setOpen: (open: boolean) => void;
  send: (text: string, token: string | null) => Promise<void>;
  escalate: (contact: { email?: string; phone?: string }, token: string | null) => Promise<boolean>;
  reset: () => void;
}

const MAX_MESSAGES = 60;
const rid = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

/**
 * Client-side support conversation. The public API cannot read a visitor's own transcript
 * (operator-only), so the widget keeps its message log here and persists the conversation id
 * plus an anonymous visitor id for continuity across reloads. Only lightweight state is stored.
 */
export const useSupportChat = create<SupportChatState>()(
  persist(
    (set, get) => ({
      open: false,
      conversationId: null,
      visitorId: null,
      messages: [],
      sending: false,
      escalated: false,
      needsEscalation: false,

      setOpen: (open) => set({ open }),

      async send(text, token) {
        const trimmed = text.trim();
        if (!trimmed || get().sending) return;

        const userMsg: ChatMessage = { id: rid(), role: 'user', content: trimmed };
        set((s) => ({ messages: [...s.messages, userMsg].slice(-MAX_MESSAGES), sending: true }));

        try {
          let conversationId = get().conversationId;
          let visitorId = get().visitorId;
          if (!visitorId) {
            visitorId = rid();
            set({ visitorId });
          }
          if (!conversationId) {
            const started = await supportApi.start({ visitorId }, token);
            conversationId = started.conversationId;
            set({ conversationId });
          }

          const res = await supportApi.ask(conversationId, trimmed, token);
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
        const conversationId = get().conversationId;
        if (!conversationId) return false;
        try {
          await supportApi.escalate(conversationId, contact, token);
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

      reset: () => set({ conversationId: null, messages: [], escalated: false, needsEscalation: false }),
    }),
    {
      name: 'pp-support-chat',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        conversationId: s.conversationId,
        visitorId: s.visitorId,
        messages: s.messages,
        escalated: s.escalated,
      }),
    },
  ),
);
