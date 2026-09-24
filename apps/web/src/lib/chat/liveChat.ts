'use client';

import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api/client';
import { env } from '@/lib/env';
import { useSession } from '@/lib/auth/session';

/** CHAT-1: human live chat (migration 0167). Client API, hooks and the open/close state. */
export interface ChatAttachmentDto { id: string; kind: 'image' | 'video' | 'audio'; mime: string; sizeBytes: number; url: string }
export interface ChatMessageDto { id: number; authorRole: 'player' | 'agent' | 'system'; authorName: string | null; body: string; attachment: ChatAttachmentDto | null; createdAt: string }
export interface ChatThreadDto {
  id: string; siteId: string; userId: string; username: string | null; phone: string | null; status: 'open' | 'resolved';
  playerUnread: number; agentUnread: number; lastMessageAt: string; lastPreview: string | null; createdAt: string;
}
export interface ChatContacts { email: string | null; whatsapp: string | null; brandName: string }

export const useLiveChat = create<{ open: boolean; setOpen: (v: boolean) => void }>((set) => ({ open: false, setOpen: (open) => set({ open }) }));

const apiOrigin = () => env.apiBaseUrl.replace(/\/api\/v1\/?$/, '');
/** Media links come back relative to the API; make them absolute for <img>/<video>/<audio>. */
export const mediaUrl = (u: string) => (/^https?:/.test(u) ? u : `${apiOrigin()}${u}`);

/** Upload one file (raw bytes, Content-Type = its MIME type) and return the attachment id. */
export async function uploadChatFile(path: string, token: string, file: Blob): Promise<string> {
  const res = await fetch(`${env.apiBaseUrl.replace(/\/+$/, '')}${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': file.type || 'application/octet-stream' }, body: file,
  });
  const j = await res.json().catch(() => null) as { id?: string; error?: { code: string; message: string } } | null;
  if (!res.ok || !j?.id) throw new ApiError(res.status, j?.error?.code ?? 'UPLOAD_FAILED', j?.error?.message ?? 'Could not upload the file.');
  return j.id;
}

/** Shrink big photos before upload (max 1600px, JPEG) — keeps chats fast on mobile data. */
export async function compressImage(file: File): Promise<Blob> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 900_000) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d')?.drawImage(bmp, 0, 0, c.width, c.height);
    const out = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.82));
    return out && out.size < file.size ? out : file;
  } catch { return file; }
}

// ── Player ──
export function usePlayerChat(enabled: boolean, pollMs: number) {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: ['live-chat', 'me'],
    enabled: !!token && enabled,
    queryFn: () => apiFetch<{ thread: ChatThreadDto | null; messages: ChatMessageDto[]; contacts: ChatContacts }>('/chat', { token }),
    refetchInterval: pollMs,
    refetchIntervalInBackground: false,
  });
}
export function useSendChat() {
  const token = useSession((s) => s.token);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { body: string; file?: Blob | null }) => {
      const attachmentId = v.file ? await uploadChatFile('/chat/attachments', token as string, v.file) : undefined;
      return apiFetch<{ id: number }>('/chat/messages', { method: 'POST', token, body: { body: v.body, ...(attachmentId ? { attachmentId } : {}) } });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['live-chat', 'me'] }); },
  });
}
export function useMarkChatRead() {
  const token = useSession((s) => s.token);
  return useMutation({ mutationFn: () => apiFetch('/chat/read', { method: 'POST', token }) });
}

// ── Agents (back office) ──
export function useChatThreads(status: 'open' | 'resolved' | 'all', q: string) {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: ['live-chat', 'threads', status, q],
    enabled: !!token,
    queryFn: () => apiFetch<{ items: ChatThreadDto[] }>('/admin/chat/threads', { token, query: { status, q: q || undefined } }),
    refetchInterval: 5000,
  });
}
export function useChatUnread() {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: ['live-chat', 'unread'],
    enabled: !!token,
    queryFn: () => apiFetch<{ count: number }>('/admin/chat/unread', { token }),
    refetchInterval: 15000,
  });
}
export function useChatThread(id: string | null) {
  const token = useSession((s) => s.token);
  return useQuery({
    queryKey: ['live-chat', 'thread', id],
    enabled: !!token && !!id,
    queryFn: () => apiFetch<{ thread: ChatThreadDto; messages: ChatMessageDto[] }>(`/admin/chat/threads/${id}`, { token }),
    refetchInterval: 3000,
  });
}
export function useAgentReply(id: string | null) {
  const token = useSession((s) => s.token);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { body: string; file?: Blob | null }) => {
      const attachmentId = v.file ? await uploadChatFile(`/admin/chat/threads/${id}/attachments`, token as string, v.file) : undefined;
      return apiFetch<{ id: number }>(`/admin/chat/threads/${id}/messages`, { method: 'POST', token, body: { body: v.body, ...(attachmentId ? { attachmentId } : {}) } });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['live-chat'] }); },
  });
}
export function useAgentThreadAction(id: string | null) {
  const token = useSession((s) => s.token);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { kind: 'read' } | { kind: 'status'; status: 'open' | 'resolved' }) =>
      v.kind === 'read'
        ? apiFetch(`/admin/chat/threads/${id}/read`, { method: 'POST', token })
        : apiFetch(`/admin/chat/threads/${id}/status`, { method: 'POST', token, body: { status: v.status } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['live-chat'] }); },
  });
}

/** Call `onNew` when a message from the OTHER side arrives after the first load. */
export function useOnNewMessages(messages: ChatMessageDto[] | undefined, fromOther: (m: ChatMessageDto) => boolean, onNew: () => void) {
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (!messages) return;
    const max = messages.reduce((n, m) => Math.max(n, m.id), 0);
    if (last.current !== null && messages.some((m) => m.id > (last.current as number) && fromOther(m))) onNew();
    last.current = max;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);
}

