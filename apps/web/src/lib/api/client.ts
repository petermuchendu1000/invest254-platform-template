import { env } from '@/lib/env';
import { isStepUpExemptPath, reportSessionIdle, requestStepUp } from '@/lib/auth/stepUp';
import { noteOperatorActivity } from '@/lib/auth/operatorSession';

/** Standard error envelope from the API (docs/05 §8). */
export interface ApiErrorBody {
  error: { code: string; message: string; reasons?: string[] };
}

/** Typed error thrown for any non-2xx response. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly reasons?: string[];
  constructor(status: number, code: string, message: string, reasons?: string[]) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    if (reasons && reasons.length > 0) this.reasons = reasons;
  }
}

export type QueryValue = string | number | boolean | undefined;

export interface RequestOptions {
  method?: string;
  body?: unknown;
  token?: string | null;
  query?: Record<string, QueryValue>;
  signal?: AbortSignal;
  /**
   * Internal: set on the ONE automatic replay after a step-up challenge was satisfied (0196). It is
   * what bounds the retry — a replay that is itself refused surfaces its error instead of raising a
   * second challenge, so a session whose proof is rejected can never loop between prompt and 403.
   */
  stepUpReplay?: boolean;
}

function buildQuery(query?: Record<string, QueryValue>): string {
  if (!query) return '';
  const pairs = Object.entries(query)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return pairs.length > 0 ? `?${pairs.join('&')}` : '';
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Typed fetch against the Invest254 REST API. Injects the bearer token,
 * serialises JSON, and normalises the error envelope into an ApiError.
 */
export async function apiFetch<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, token, query, signal } = opts;
  const base = env.apiBaseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  if (signal) init.signal = signal;

  const res = await fetch(`${base}${path}${buildQuery(query)}`, init);
  const text = await res.text();
  const data = text ? safeJson(text) : null;

  // The 0196 idle gate measures inactivity from the last authenticated request, so an answered call
  // is exactly what keeps an operator session alive — and the only thing the countdown may measure
  // from, or it would promise time the server has already taken away. A no-op (one boolean) for
  // anonymous calls and for every player/marketer session, which never arm the clock.
  if (token) noteOperatorActivity();

  if (!res.ok) {
    const envelope = data as ApiErrorBody | null;
    const code = envelope?.error?.code ?? `HTTP_${res.status}`;
    const message = envelope?.error?.message ?? (res.statusText || 'Request failed');
    const error = new ApiError(res.status, code, message, envelope?.error?.reasons);

    // ── The two codes no caller can satisfy for itself (0196) ────────────────────────────────────
    // This is the single choke point every API call goes through, so handling them anywhere else
    // would mean ~120 call sites each growing its own copy — and the ones that forgot would fail
    // with an error the operator cannot act on.
    if (code === 'SESSION_IDLE') {
      // The token is dead server-side. Nothing to retry: clear the session and let the operator
      // sign in again.
      reportSessionIdle();
      throw error;
    }
    if (code === 'STEP_UP_REQUIRED' && !opts.stepUpReplay && !isStepUpExemptPath(path)) {
      // Raise (or join) the one challenge, then replay THIS request once so the operator's click is
      // not silently lost and they do not have to fill the form again. On cancel, on a failed proof,
      // or when nothing is mounted to ask with, the original 403 is what the caller sees.
      if (await requestStepUp(token ?? null)) {
        return apiFetch<T>(path, { ...opts, stepUpReplay: true });
      }
    }
    throw error;
  }
  return data as T;
}
