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
import { siteFromToken } from '@/lib/auth/token';
import { walletFigures, type WalletFigures } from '@/lib/wallet/figures';

export function useWallet() {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: ['wallet'],
    queryFn: () => api.wallet(token as string),
    enabled: !!token,
  });
}

/**
 * DEMO-2: the figures every wallet surface renders from, resolved once. `canWithdraw` is the gate a
 * surface asks before offering ANY way out — see `walletFigures`.
 */
export function useWalletFigures(): WalletFigures {
  return walletFigures(useWallet().data);
}

/** DEMO-1: switch between the Real and Demo account; the server returns the new wallet. */
export function useSetAccountMode() {
  const token = useSession((s) => s.token);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mode: 'real' | 'demo') => api.setAccountMode(token as string, mode),
    onSuccess: (r) => {
      qc.setQueryData(['wallet'], r.wallet);
      void qc.invalidateQueries({ queryKey: ['ledger'] });
      void qc.invalidateQueries({ queryKey: ['wallet-ledger'] });
    },
  });
}

/** DEMO-1: refill the demo balance. */
export function useTopupDemo() {
  const token = useSession((s) => s.token);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.topupDemo(token as string),
    onSuccess: (r) => { qc.setQueryData(['wallet'], r.wallet); },
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

/** PayHero (Lipwa) STK deposit — same settle-by-poll UX as the other rails. */
export function useDepositPayhero() {
  const token = useSession((s) => s.token);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { amount: number; phone: string }) => api.createPayheroDeposit(token as string, vars),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['wallet'] });
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      pollSettlement(qc);
    },
  });
}

/**
 * PayHero Lipwa hosted-checkout deposit (card / bank / mobile money / cross-border). Returns the
 * checkout URL, which the UI opens in an IN-APP modal. Settlement is by the ledger reconcile; the
 * sheet then polls this deposit's transaction status to react the instant it lands.
 */
export function useDepositLipwa() {
  const token = useSession((s) => s.token);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { amount: number }) => api.createPayheroLipwaDeposit(token as string, vars),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['wallet'] });
      void qc.invalidateQueries({ queryKey: ['transactions'] });
    },
  });
}

/**
 * The deposit CHANNELS the server says this player can actually complete (plus the raw gateway list).
 * The sheet renders `methods` verbatim — see DepositMethodDto. Older API builds omit `methods`; the
 * panel falls back to deriving a single M-Pesa entry per gateway in that case.
 */
export function useDepositProviders() {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: ['deposit-providers'],
    enabled: !!token,
    staleTime: 60_000,
    queryFn: async () => {
      const r = await api.depositProviders(token as string);
      return { providers: r.providers ?? [], methods: r.methods };
    },
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
  // PAY-1: name the player's brand — a brand on its own payment accounts has no (System) Pay Bill.
  const site = siteFromToken(useSession((st) => st.token));
  return useQuery({ queryKey: ['paybill-info', site ?? ''], queryFn: () => api.paybillInfo(site ?? undefined) });
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
