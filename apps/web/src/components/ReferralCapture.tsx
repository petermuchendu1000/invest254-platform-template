'use client';

import { useEffect } from 'react';
import { referralFromSearch, storeReferral, readReferral } from '@/lib/auth/referral';
import { api } from '@/lib/api/endpoints';

/**
 * App-wide referral capture (funnel stage 0). Complements the dedicated `/r/<code>` landing: when a
 * visitor arrives on ANY page with a `?ref=CODE` (or `?r=`/`?code=`) — the common way marketers share
 * a brand's bare domain — we capture the code for first-touch attribution AND record a click
 * (fire-and-forget; server-side tolerant, never blocks). Deduped per code within a session so a
 * client-side re-render or back/forward doesn't double-count. Renders nothing.
 */
export function ReferralCapture(): null {
  useEffect(() => {
    const code = referralFromSearch(window.location.search);
    if (!code) return;
    // Store for sign-up prefill (first-touch: only if not already captured on this device).
    if (!readReferral()) storeReferral(code);
    // Record the click once per code per tab (guards against StrictMode double-invoke + re-renders).
    const key = `pp-click-${code}`;
    try {
      if (window.sessionStorage.getItem(key)) return;
      window.sessionStorage.setItem(key, '1');
    } catch { /* private mode: fall through and still record */ }
    const host = window.location.hostname || undefined;
    void api.recordAffiliateClick(code, host).catch(() => {});
  }, []);
  return null;
}
