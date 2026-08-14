'use client';

import { useQuery } from '@tanstack/react-query';
import { supportApi } from '@/lib/support/endpoints';
import { useSession } from '@/lib/auth/session';

function useTok(): string {
  return useSession((s) => s.token) as string;
}

/** Operator: brand-scoped list of support conversations (auto-refreshes for a live inbox). */
export function useSupportConversations(limit = 50) {
  const t = useTok();
  return useQuery({
    queryKey: ['support', 'conversations', limit],
    queryFn: () => supportApi.conversations(t, limit),
    enabled: !!t,
    refetchInterval: 15_000,
  });
}

/** Operator: full transcript of one conversation (messages + sources + confidence). */
export function useSupportThread(id: string | null) {
  const t = useTok();
  return useQuery({
    queryKey: ['support', 'thread', id],
    queryFn: () => supportApi.thread(t, id as string),
    enabled: !!t && !!id,
  });
}
