'use client';

import { useCallback } from 'react';
import { ApiError } from '@/lib/api/client';
import { useToast } from '@/lib/toast/ToastProvider';

/**
 * One error toast for mutations (BUGLOG #108: many console actions failed silently — a wrong owner
 * password, a refused switch, a pool distribute error showed nothing). Server messages are shown;
 * anything else (network, programming) becomes a plain "Not saved".
 */
export function useFailToast() {
  const toast = useToast();
  return useCallback((e: unknown, title = 'Not saved') => {
    const msg = e instanceof ApiError ? e.message : null;
    toast.push({ tone: 'error', title, ...(msg ? { description: msg } : {}) });
  }, [toast]);
}
