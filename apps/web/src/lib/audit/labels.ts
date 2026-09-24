/**
 * UI-F: audit actions in plain words. The log stores machine codes (`balance.adjust`); people read
 * "Adjusted a balance". Unknown codes fall back to a readable form of the code, never hidden.
 */
const LABELS: Record<string, string> = {
  'balance.adjust': 'Adjusted a balance', 'balance.clear': 'Cleared a balance', 'balance.reset_last_funded': 'Reset a balance to the last deposit',
  'user.status': 'Changed a player’s status', 'user.role': 'Changed a role', 'user.set_role': 'Changed a role', 'user.delete': 'Deleted an account',
  'user.update_details': 'Edited account details', 'user.overrides': 'Changed a player’s game overrides', 'user.overrides.cap_enforced': 'Capped a player’s overrides',
  'notification.create': 'Sent a notice to a player', 'notification.broadcast': 'Sent an announcement', 'notification.resolve': 'Cleared a notice',
  'notification.resolve_category': 'Cleared announcements',
  'withdrawals.toggle': 'Switched withdrawals on/off', 'withdrawal.mark_paid': 'Marked a withdrawal paid',
  'game.config': 'Changed the brand economy', 'game.seed_rotate': 'Rotated the fairness seed', 'pool_mode.toggle': 'Switched pool mode', 'pool.mode.enable': 'Switched pool mode on',
  'pool.set': 'Set today’s payout budget', 'pool.default.set': 'Set the daily payout budget', 'pool.auto_settings': 'Changed automatic pool distribution',
  'platform.pool.distribute': 'Distributed the pool', 'platform.pool.realtime_topup': 'Topped up a pool',
  'platform.create': 'Created a platform', 'platform.update': 'Edited a platform', 'platform.admin.appoint': 'Appointed a platform admin', 'platform.admin.revoke': 'Removed a platform admin',
  'platform.site.create': 'Created a brand', 'platform.site.update': 'Edited a brand', 'platform.site.theme': 'Changed a brand theme', 'platform.site.config': 'Changed a brand economy',
  'platform.site.assign': 'Moved a brand to a platform', 'platform.set_site_owner': 'Set the default marketer', 'admin.set_site_owner': 'Set the default marketer',
  'platform.impersonate': 'Opened a brand back office', 'platform.global_config.set': 'Changed a global control', 'platform.registrar.config': 'Changed the domain registrar',
  'platform.provider.global': 'Offered or withdrew a gateway', 'platform.provider.config': 'Changed gateway credentials', 'platform.provider.site': 'Changed a gateway for a brand',
  'platform.provider.site.clear': 'Reset a gateway for a brand', 'platform.marketer.create': 'Created a marketer', 'platform.marketer.link': 'Linked a marketer',
  'mpesa.config': 'Changed M-Pesa settings', 'payment.scope.activate': 'Put payment accounts live', 'payment.scope.deactivate': 'Switched back to System accounts',
  'payment.scope.config': 'Changed payment account details', 'payment.scope.config.clear': 'Removed payment account details',
  'marketer.expense.add': 'Logged a marketer expense', 'marketer.advance.approve': 'Approved a marketer advance', 'marketer.advance.reject': 'Declined a marketer advance',
  'marketer.enroll.backfill': 'Enrolled marketers', 'affiliate.rate': 'Changed a commission rate',
  'addon.request': 'Requested an add-on', 'addon.request.cancel': 'Withdrew an add-on request', 'addon.request.reject': 'Declined an add-on request',
  'addon.grant': 'Assigned an add-on', 'addon.revoke': 'Removed an add-on', 'addon.charge': 'Charged for an add-on', 'addon.activate': 'Switched chart or trade screen',
  'addon.update': 'Edited the add-on catalog', 'addon.set_price': 'Changed an add-on price',
  'billing.run': 'Ran billing', 'billing.settings': 'Changed billing settings', 'billing.exempt': 'Changed billing exemption', 'billing.plan.upsert': 'Edited a plan',
  'billing.invoice.create': 'Created an invoice', 'billing.invoice.void': 'Voided an invoice', 'billing.invoice.uncollectible': 'Wrote off an invoice',
  'site.update': 'Edited a brand', 'site.theme': 'Changed a brand theme', 'withdrawal.approve': 'Approved a withdrawal',
  'withdrawal.reject': 'Declined a withdrawal', 'withdrawal.retry': 'Retried a withdrawal', 'deposit.reconcile': 'Checked a deposit with M-Pesa',
  'billing.payment.record': 'Recorded a payment', 'billing.charge.add': 'Added a charge or credit', 'billing.charge.void': 'Removed a charge',
};

export function actionLabel(code: string): string {
  if (LABELS[code]) return LABELS[code]!;
  const t = code.replace(/[._]+/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : code;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONEY_KEYS = /(^|_)(amount|cents|before|after|price|total)(_|$)|Cents$/;
/** A short "key: value · key: value" summary of the detail blob (money keys in KES), max ~4 entries. */
export function detailSummary(detail: unknown): string {
  if (detail == null) return '';
  if (typeof detail !== 'object' || Array.isArray(detail)) return String(detail);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(detail as Record<string, unknown>)) {
    if (v == null || typeof v === 'object') continue;
    // Internal ids (uuids) mean nothing to a reader; the full record keeps them.
    if (typeof v === 'string' && UUID.test(v)) continue;
    const key = k.replace(/_?cents$/i, '').replace(/Cents$/, '').replace(/_/g, ' ').trim();
    const val = typeof v === 'number' && MONEY_KEYS.test(k) ? `KES ${(v / 100).toLocaleString('en-KE')}` : String(v).replace(/_/g, ' ');
    parts.push(`${key}: ${val}`);
    if (parts.length === 4) break;
  }
  return parts.join(' · ');
}
