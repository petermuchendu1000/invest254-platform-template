'use client';

import { create } from 'zustand';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api/client';
import { env } from '@/lib/env';
import { useSession } from '@/lib/auth/session';

/** ACCT-1: which account dialog is open (Two-factor, Verify identity). */
export const useAccountUi = create<{ dialog: null | 'twofactor' | 'verify'; open: (d: 'twofactor' | 'verify') => void; close: () => void }>((set) => ({
  dialog: null, open: (dialog) => set({ dialog }), close: () => set({ dialog: null }),
}));

export type KycStatus = 'none' | 'pending' | 'approved' | 'rejected';
export interface KycMine { status: KycStatus; latest: { status: KycStatus; docType: string; submittedAt: string; reviewedAt: string | null; reviewNote: string | null } | null }
export interface KycStaffRow {
  id: string; userId: string; siteId: string; username: string | null; phone: string | null; status: 'pending' | 'approved' | 'rejected';
  docType: 'national_id' | 'passport' | 'driving_licence'; fullName: string; idNumber: string; dateOfBirth: string; submittedAt: string;
  reviewedAt: string | null; reviewerName: string | null; reviewNote: string | null;
  files?: { front: string | null; back: string | null; selfie: string | null };
}
export const DOC_LABEL: Record<string, string> = { national_id: 'National ID', passport: 'Passport', driving_licence: 'Driving licence' };

export function useMyKyc(enabled = true) {
  const token = useSession((s) => s.token);
  return useQuery({ queryKey: ['kyc', 'me'], enabled: !!token && enabled, queryFn: () => apiFetch<KycMine>('/kyc', { token }) });
}

async function uploadKycFile(token: string, file: Blob): Promise<string> {
  const res = await fetch(`${env.apiBaseUrl.replace(/\/+$/, '')}/kyc/files`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': file.type }, body: file });
  const j = await res.json().catch(() => null) as { id?: string; error?: { code: string; message: string } } | null;
  if (!res.ok || !j?.id) throw new ApiError(res.status, j?.error?.code ?? 'UPLOAD_FAILED', j?.error?.message ?? 'Could not upload the file.');
  return j.id;
}

export function useSubmitKyc() {
  const token = useSession((s) => s.token);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { docType: string; fullName: string; idNumber: string; dateOfBirth: string; front: Blob; back: Blob | null; selfie: Blob }) => {
      const frontId = await uploadKycFile(token as string, v.front);
      const backId = v.back ? await uploadKycFile(token as string, v.back) : undefined;
      const selfieId = await uploadKycFile(token as string, v.selfie);
      return apiFetch<{ id: string }>('/kyc', { method: 'POST', token, body: { docType: v.docType, fullName: v.fullName, idNumber: v.idNumber, dateOfBirth: v.dateOfBirth, frontId, selfieId, ...(backId ? { backId } : {}) } });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['kyc'] }); },
  });
}

// ── staff ──
export function useKycList(status: 'pending' | 'approved' | 'rejected' | 'all', userId?: string) {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: ['kyc', 'staff', status, userId ?? ''],
    enabled: !!token,
    queryFn: () => apiFetch<{ items: KycStaffRow[] }>('/admin/kyc', { token, query: { status, userId } }),
    refetchInterval: 30_000,
  });
}
export function useKycDetail(id: string | null) {
  const token = useSession((s) => s.token);
  return useQuery({ queryKey: ['kyc', 'detail', id], enabled: !!token && !!id, queryFn: () => apiFetch<{ submission: KycStaffRow }>(`/admin/kyc/${id}`, { token }) });
}
export function useKycDecision() {
  const token = useSession((s) => s.token);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; decision: 'approved' | 'rejected'; note?: string }) =>
      apiFetch<{ status: string }>(`/admin/kyc/${v.id}/decision`, { method: 'POST', token, body: { decision: v.decision, ...(v.note ? { note: v.note } : {}) } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['kyc'] }); },
  });
}
export const fileUrl = (u: string | null) => (u ? `${env.apiBaseUrl.replace(/\/api\/v1\/?$/, '')}${u}` : null);
