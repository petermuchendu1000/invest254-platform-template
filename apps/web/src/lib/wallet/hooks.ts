 'use client';

import {
  useQuery,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { api, type TransactionFilter } from '@/lib/api/endpoints';
import type { Paginated, TransactionDto, LedgerEntryDto } from '@/lib/api/types';
import { useSession } from '@/lib/auth/session';

export function useWallet() {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: ['wallet'],
    queryFn: () => api.wallet(token as string),
    enabled: !!token,
  });
}

export function useLedger() {
  const token = useSession((s) => s.token);
  return useInfiniteQuery({
    queryKey: ['ledger'],
    enabled: !!token,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.ledger(token as string, { cursor: pageParam }),
    getNextPageParam: (last: Paginated<LedgerEntryDto>) => last.nextCursor ?? undefined,
  });
}

export function useTransactions(filter: Pick<TransactionFilter, 'kind'> = {}) {
  const token = useSession((s) => s.token);
  return useInfiniteQuery({
    queryKey: ['transactions', filter.kind ?? 'all'],
    enabled: !!token,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.transactions(token as string, { cursor: pageParam, ...(filter.kind ? { kind: filter.kind } : {}) }),
    getNextPageParam: (last: Paginated<TransactionDto>) => last.nextCursor ?? undefined,
  });
}

/** Poll the wallet/transactions for ~60s while an async M-Pesa callback settles. */
export function pollSettlement(qc: QueryClient): void {
  let ticks = 0;
  const id = setInterval(() => {
    void qc.invalidateQueries({ queryKey: ['wallet'] });
    void qc.invalidateQueries({ queryKey: ['transactions'] });
    if (++ticks >= 15) clearInterval(id);
  }, 4000);
}

export function useDeposit() {
  const token = useSession((s) => s.token);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { amount: number; phone: string }) => api.createDeposit(token as string, vars),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['wallet'] });
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      pollSettlement(qc);
    },
  });
}

/** Mega Pay STK deposit (migration 0116) — same settle-by-poll UX as the Daraja rail. */
export function useDepositMegapay() {
  const token = useSession((s) => s.token);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { amount: number; phone: string }) => api.createMegapayDeposit(token as string, vars),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['wallet'] });
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      pollSettlement(qc);
    },
  });
}

/** Deposit gateways effective-enabled for this player's brand (superadmin switch + per-site override). */
export function useDepositProviders() {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: ['deposit-providers'],
    enabled: !!token,
    staleTime: 60_000,
    queryFn: async () => (await api.depositProviders(token as string)).providers,
  });
}

export function useWithdraw() {
  const token = useSession((s) => s.token);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { amount: number; phone: string }) => api.createWithdrawal(token as string, vars),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['wallet'] });
      void qc.invalidateQueries({ queryKey: ['transactions'] });
    },
  });
}

/** Public Pay Bill display config (paybill number, account number, business name). */
export function usePaybillInfo() {
  return useQuery({ queryKey: ['paybill-info'], queryFn: () => api.paybillInfo() });
}

/** Claim a Pay Bill payment by its M-PESA confirmation code; on success the wallet is credited. */
export function useClaimPaybill() {
  const token = useSession((s) => s.token);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { code: string }) => api.claimPaybill(token as string, vars),
    onSuccess: (res) => {
      if (res.status === 'credited') {
        void qc.invalidateQueries({ queryKey: ['wallet'] });
        void qc.invalidateQueries({ queryKey: ['transactions'] });
        pollSettlement(qc);
      }
    },
  });
}
