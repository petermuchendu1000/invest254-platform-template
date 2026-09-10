'use client';

import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api/endpoints';
import { useSession } from '@/lib/auth/session';

/**
 * A player's persisted DIGIT contract history (docs/34) — the reviewable receipt feed.
 * Cursor-paginated (newest-first). Call `invalidate` after a settlement to prepend the new receipt.
 */
export function useDigitHistory() {
  const token = useSession((s) => s.token);
  return useInfiniteQuery({
    queryKey: ['digit-history'],
    enabled: !!token,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.digitHistory(token as string, { cursor: pageParam ?? null, limit: 20 }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/** Invalidate the digit-history feed (call on `digit_settled` so the new receipt appears). */
export function useInvalidateDigitHistory() {
  const qc = useQueryClient();
  return () => { void qc.invalidateQueries({ queryKey: ['digit-history'] }); };
}
