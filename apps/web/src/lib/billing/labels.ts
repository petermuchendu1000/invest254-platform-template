/**
 * BILL-1: one vocabulary for billing states, in plain words (Stripe's invoice states, but said the way an
 * operator in Nairobi would say them). Tones map to the console's status colours.
 */
export type Tone = 'up' | 'warn' | 'down' | 'muted' | 'info';

const DAY = 86_400_000;

/** An invoice's state for a pill: Paid · Due in 3 days · Due today · Overdue 4 days · Void · Written off. */
export function invoiceState(inv: { status: string; dueAt: string; amountPaidCents?: number }, now = Date.now()): { label: string; tone: Tone } {
  switch (inv.status) {
    case 'paid': return { label: 'Paid', tone: 'up' };
    case 'void': return { label: 'Void', tone: 'muted' };
    case 'uncollectible': return { label: 'Written off', tone: 'muted' };
    case 'draft': return { label: 'Draft', tone: 'muted' };
    default: {
      const due = new Date(inv.dueAt).getTime();
      const days = Math.floor((due - now) / DAY);
      const part = (inv.amountPaidCents ?? 0) > 0 ? 'Part paid · ' : '';
      if (due < now) {
        const late = Math.max(1, Math.floor((now - due) / DAY));
        return { label: `${part}Overdue ${late} day${late === 1 ? '' : 's'}`, tone: 'down' };
      }
      if (days <= 0) return { label: `${part}Due today`, tone: 'warn' };
      return { label: `${part}Due in ${days} day${days === 1 ? '' : 's'}`, tone: days <= 3 ? 'warn' : 'info' };
    }
  }
}

/** A subscription's state in plain words, with what it means for the brands. */
export const SUB_STATE: Record<string, { label: string; tone: Tone; meaning: string }> = {
  trial: { label: 'Trial', tone: 'info', meaning: 'Free until the trial ends; the first invoice is sent then.' },
  active: { label: 'Active', tone: 'up', meaning: 'Paid up. Everything is running.' },
  past_due: { label: 'Payment overdue', tone: 'warn', meaning: 'An invoice is past its due date. Brands still run.' },
  grace_period: { label: 'Final notice', tone: 'down', meaning: 'Brands go offline when the grace period ends unless the invoice is paid.' },
  suspended: { label: 'Suspended', tone: 'down', meaning: 'Brands are offline until the overdue invoice is paid.' },
  cancelled: { label: 'Cancelled', tone: 'muted', meaning: 'No longer billed.' },
};
export function subState(status: string) { return SUB_STATE[status] ?? { label: status, tone: 'muted' as Tone, meaning: '' }; }

export const LINE_KIND: Record<string, string> = {
  plan: 'Plan', addon_monthly: 'Add-on (monthly)', addon_one_off: 'Add-on', addon_setup: 'Setup fee', adjustment: 'Charge', credit: 'Credit',
};
export const METHOD: Record<string, string> = { mpesa: 'M-Pesa', bank: 'Bank transfer', cash: 'Cash', other: 'Other' };

export const TONE_PILL: Record<Tone, string> = {
  up: 'bg-up/15 text-up', warn: 'bg-warn/15 text-warn', down: 'bg-down/15 text-down', muted: 'bg-surface-2 text-muted', info: 'bg-info/15 text-info',
};

/** "KES 40,000" -> cents; accepts "40000", "40,000", "40000.50". Null when not a positive/negative amount. */
export function parseKes(v: string): number | null {
  const s = v.replace(/[,\s]/g, '').replace(/^KES/i, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

/** Percent from basis points: 1600 -> "16%", 1650 -> "16.5%". */
export function bpToPct(bp: number): string { return `${Number((bp / 100).toFixed(2))}%`; }

/** A Kenyan Safaricom number the STK prompt can reach. */
export function validPhone(v: string): boolean { return /^(\+?254|0)?[17]\d{8}$/.test(v.replace(/\s+/g, '')); }

/** What changes when you move from one plan to another (for the comparison table). */
export function limitText(n: number | null, unit: string): string { return n == null ? `Unlimited ${unit}` : `${n.toLocaleString('en-KE')} ${unit}`; }

/** A stored phone in any common form (2547…, +2547…, 07…, 7…) as the local 07… form people type. */
export function localPhone(v: string | null | undefined): string {
  const d = (v ?? '').replace(/\D/g, '');
  if (/^254[17]\d{8}$/.test(d)) return `0${d.slice(3)}`;
  if (/^0[17]\d{8}$/.test(d)) return d;
  if (/^[17]\d{8}$/.test(d)) return `0${d}`;
  return '';
}
