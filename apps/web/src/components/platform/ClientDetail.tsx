'use client';

import Link from 'next/link';
import { PlayerSummary, PlayerOverridesForm } from '@/components/platform/PlayerConsolePanels';
import { OpenBrandButton } from '@/components/platform/OpenBrandButton';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ConfirmButton } from '@/components/admin/ui';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/lib/toast/ToastProvider';
import { checkFeasible } from '@invest254/shared/config';
import { useStakeLimitsAdmin, useSetStakeLimits, useUpdateSite, useSetSiteConfig, useSetSiteTheme, usePlatformSiteUsers, usePlatformUserAction } from '@/lib/platform/hooks';
import type { SiteWithConfig, SiteConfig, SiteUserRow } from '@/lib/platform/endpoints';
import { deriveMinimalPalette } from '@/lib/brand/derivePalette';
import { groupedPresets, presetForSeed } from '@/lib/brand/presets';
import { BRAND_FONTS, googleFontsHref } from '@/lib/brand/fonts';
import { ThemeGallery } from '@/components/platform/ThemeGallery';
import { useGameConfig } from '@/lib/admin/hooks';
import { formatNumber } from '@/lib/format';
import { formatKes } from '@invest254/shared/money';
import { isMultipleOf5, pillLabel, stakeLadder } from '@/lib/game/stakeLadder';
import { PageTabs, useTabParam } from '@/components/admin/Tabs';

/** Expandable section (accordion) — remembers its own open state; the spine of Client Detail. */
export function Expandable({
  title, subtitle, defaultOpen = false, badge, children,
}: { title: string; subtitle?: string; defaultOpen?: boolean; badge?: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-surface">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-surface-2"
        aria-expanded={open}
      >
        <span className="flex flex-col">
          <span className="text-sm font-semibold text-fg">{title}</span>
          {subtitle ? <span className="text-xs text-muted">{subtitle}</span> : null}
        </span>
        <span className="flex items-center gap-2">
          {badge}
          <span className="text-muted transition" style={{ transform: open ? 'rotate(180deg)' : 'none' }}>▾</span>
        </span>
      </button>
      {open ? <div className="border-t border-border p-4">{children}</div> : null}
    </div>
  );
}

/** Sticky save bar shown when a section has unsaved edits. */
function SaveBar({ dirty, saving, onSave, onReset }: { dirty: number; saving: boolean; onSave: () => void; onReset: () => void }) {
  if (dirty === 0) return <p className="text-xs text-muted">No unsaved changes.</p>;
  return (
    <div className="flex items-center gap-3">
      <Button size="sm" onClick={onSave} disabled={saving}>
        {saving ? 'Saving…' : `Save ${dirty} change${dirty > 1 ? 's' : ''}`}
      </Button>
      <Button size="sm" variant="ghost" onClick={onReset} disabled={saving}>Reset</Button>
    </div>
  );
}

/**
 * A form seeded from server data that NEVER overwrites unsaved edits (BUGLOG #110): when the server
 * value changes (a save in another section, another admin, a refetch), the form follows it only if the
 * admin has not changed anything since the last server value.
 */
function useSyncedForm<T>(init: T) {
  const [form, setForm] = useState<T>(init);
  const prev = useRef(init);
  useEffect(() => {
    const was = JSON.stringify(prev.current);
    prev.current = init;
    setForm((cur) => (JSON.stringify(cur) === was ? init : cur));
  }, [init]);
  return [form, setForm] as const;
}

const STATUSES = ['active', 'paused', 'archived'] as const;

/** Identity, status, domain, locale & legal — all persisted via PATCH /platform/sites/:id. */
function IdentitySection({ site }: { site: SiteWithConfig }) {
  const update = useUpdateSite();
  const toast = useToast();
  const init = useMemo(() => ({
    name: site.name ?? '', status: site.status ?? 'active', primary_domain: site.primaryDomain ?? '',
    wordmark_text: site.wordmarkText ?? '', support_email: site.supportEmail ?? '', support_whatsapp: site.supportWhatsapp ?? '',
    currency: site.currency ?? 'KES', locale: site.locale ?? 'en-KE',
    licence_line: site.licenceLine ?? '',
  }), [site]);
  const [form, setForm] = useSyncedForm(init);
  const set = (k: keyof typeof init) => (e: { target: { value: string } }) => setForm((s) => ({ ...s, [k]: e.target.value }));
  const patch = useMemo(() => Object.fromEntries(Object.entries(form).filter(([k, v]) => v !== (init as Record<string, string>)[k])), [form, init]);
  const dirty = Object.keys(patch).length;

  function save() {
    update.mutate({ id: site.siteId, patch }, {
      onSuccess: () => toast.push({ tone: 'success', title: 'Identity saved', description: `${dirty} field(s) updated for ${form.name}.` }),
      onError: (e) => toast.push({ tone: 'error', title: 'Save failed', description: (e as Error).message }),
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input label="Brand name" name={`name-${site.siteId}`} value={form.name} onChange={set('name')} />
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium text-fg">Status</span>
          <select className="h-11 rounded-brand border border-border bg-surface-2 px-3 text-fg" value={form.status} onChange={set('status')}>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <Input label="Primary domain" name={`dom-${site.siteId}`} value={form.primary_domain} onChange={set('primary_domain')} hint="apex domain, no protocol" />
        <Input label="Wordmark" name={`wm-${site.siteId}`} value={form.wordmark_text} onChange={set('wordmark_text')} hint="shown in the header; defaults to name" />
        <Input label="Support email" name={`se-${site.siteId}`} type="email" value={form.support_email} onChange={set('support_email')} />
        <Input label="WhatsApp support number" name={`wa-${site.siteId}`} inputMode="tel" value={form.support_whatsapp} onChange={set('support_whatsapp')} hint="international format, e.g. +254712345678; shown in live chat and the account menu" />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Currency" name={`cur-${site.siteId}`} value={form.currency} onChange={set('currency')} hint="display currency, e.g. KES or USD" />
          <Input label="Locale" name={`loc-${site.siteId}`} value={form.locale} onChange={set('locale')} />
        </div>
        <Input label="Licence line" name={`lic-${site.siteId}`} value={form.licence_line} onChange={set('licence_line')} hint="footer compliance text" />
      </div>
      <SaveBar dirty={dirty} saving={update.isPending} onSave={save} onReset={() => setForm(init)} />
      {/* UI-F: each of these has one home elsewhere; this page only points to it. */}
      <ul className="flex flex-col gap-1 border-t border-border pt-3 text-sm text-muted">
        <li>Price chart and trade screen: <Link href={`/platform/clients/${site.siteId}?tab=addons`} className="text-accent hover:underline">Add-ons</Link></li>
        <li>Which M-Pesa and gateway accounts it uses: <Link href={`/platform/payment-accounts?scope=site:${site.siteId}`} className="text-accent hover:underline">Payment accounts</Link></li>
        <li>Daily payout budget and pool mode: <Link href="/platform/pool" className="text-accent hover:underline">Withdrawal pool</Link></li>
      </ul>
    </div>
  );
}

/** Economy — the full game config with a live feasibility preview (mirrors the DB CHECK). */
type EK = 'targetWinRate' | 'houseEdge' | 'minStakeCents' | 'maxStakeCents' | 'defaultDurationS' | 'maxMultiplier' | 'driftBias' | 'volatility' | 'tickRateMs';
const EFIELDS: { key: EK; label: string; hint: string; kes?: boolean; pct?: boolean; step?: string }[] = [
  { key: 'targetWinRate', label: 'Win rate (%)', hint: 'Share of rounds a player wins', pct: true, step: '1' },
  { key: 'houseEdge', label: 'House edge (%)', hint: 'House margin; RTP = 100% − edge', pct: true, step: '0.5' },
  // Min / max stake are set in the brand's own currency on the Stake card (STAKE-1).
  // Min withdrawal is edited separately as a CURRENCY-NATIVE value (docs/25 §16) — see EconomySection.
  { key: 'defaultDurationS', label: 'Round duration (s)', hint: '1–3600', step: '1' },
  { key: 'maxMultiplier', label: 'Max payout ×', hint: 'Cap on a single win', step: '0.1' },
  { key: 'driftBias', label: 'Price trend', hint: 'Advanced: pull of the price line up (+) or down (−), −1 to 1', step: '0.001' },
  { key: 'volatility', label: 'Price movement', hint: 'Advanced: how much the price line moves per tick (above 0)', step: '0.001' },
  { key: 'tickRateMs', label: 'Price update speed (ms)', hint: 'Time between price updates, 50–60000', step: '10' },
];
const toField = (c: SiteConfig, f: (typeof EFIELDS)[number]): string => {
  const raw = c[f.key] as number;
  if (f.kes) return String(raw / 100);
  if (f.pct) return String(Math.round(raw * 1000) / 10);
  return String(raw);
};

/**
 * STAKE-1 (BUGLOG #87): min / max stake in the brand's own currency, multiples of 5. The player's
 * pills are min ×1 2 4 5 10 20 up to max (previewed live). The API writes the engine's KES-cents limits.
 */
function StakeLimitsCard({ siteId, currency }: { siteId: string; currency: string }) {
  const { data } = useStakeLimitsAdmin(siteId);
  const save = useSetStakeLimits(siteId);
  const toast = useToast();
  const kes = currency === 'KES';
  const fallback = (c: number | null | undefined) => (kes && c != null ? String(Math.round(c / 100)) : '');
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  // Server values fill the form only while the admin has not typed (a refetch never clobbers input).
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!data || touched) return;
    setMin(data.min != null ? String(data.min) : fallback(data.minStakeCents));
    setMax(data.max != null ? String(data.max) : fallback(data.maxStakeCents));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, touched]);
  const a = Number(min), b = Number(max);
  const err = min === '' || max === '' ? null
    : !isMultipleOf5(a) || a < 5 ? 'Min: multiple of 5'
    : !isMultipleOf5(b) || b < a ? 'Max: multiple of 5, ≥ min'
    : null;
  const dirty = data ? String(data.min ?? '') !== min || String(data.max ?? '') !== max : false;
  const pills = !err && min !== '' && max !== '' ? stakeLadder(a, b) : [];
  const sym = kes ? 'KES ' : currency === 'USD' ? '$' : `${currency} `;
  return (
    <div className="rounded-brand border border-border bg-surface-2 p-3" data-testid="stake-limits">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-semibold text-fg">Stake</span>
        <span className="text-xs text-muted">{currency}</span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Input type="number" inputMode="numeric" step="5" min="5" label={`Min (${currency})`} value={min} disabled={!data} onChange={(e) => { setTouched(true); setMin(e.target.value); }} />
        <Input type="number" inputMode="numeric" step="5" min="5" label={`Max (${currency})`} value={max} disabled={!data} onChange={(e) => { setTouched(true); setMax(e.target.value); }} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5" aria-label="Player stake pills">
        {pills.map((p) => <span key={p} className="rounded-md border border-border bg-surface px-2 py-1 text-xs font-semibold tabular-nums text-fg">{sym}{pillLabel(p)}</span>)}
        {err ? <span className="text-xs text-down" role="alert">{err}</span> : null}
      </div>
      <div className="mt-3">
        <Button size="sm" disabled={!!err || !dirty || min === '' || max === '' || save.isPending}
          onClick={() => save.mutate({ min: a, max: b }, {
            onSuccess: () => { setTouched(false); toast.push({ tone: 'success', title: 'Stake saved', description: `${sym}${a} – ${sym}${b}` }); },
            onError: (e) => toast.push({ tone: 'error', title: 'Not saved', description: (e as Error).message }),
          })}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}

function EconomySection({ site }: { site: SiteWithConfig }) {
  const setConfig = useSetSiteConfig();
  const toast = useToast();
  const c = site.config;
  const init = useMemo(() => Object.fromEntries(EFIELDS.map((f) => [f.key, toField(c, f)])) as Record<EK, string>, [c]);
  const [form, setForm] = useSyncedForm<Record<EK, string>>(init);

  // Min withdrawal is CURRENCY-NATIVE (docs/25 §16): entered in the brand's own currency (e.g. 100 =>
  // $100 for a USD brand, 2000 => KES 2,000). The API converts it to the enforced KES-cents floor at
  // the live FX rate, so KES brands are unchanged and foreign brands get an exact native minimum.
  const currency = site.currency || 'KES';
  const [minWd, setMinWd] = useState<string>(c.minWithdrawalNative != null ? String(c.minWithdrawalNative) : '');
  const minWdPrev = useRef(minWd);
  useEffect(() => {
    const next = c.minWithdrawalNative != null ? String(c.minWithdrawalNative) : '';
    setMinWd((cur) => (cur === minWdPrev.current ? next : cur));   // keep an unsaved edit
    minWdPrev.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.minWithdrawalNative]);

  const patch = useMemo(() => {
    const out: Record<string, number> = {};
    const snake: Record<EK, string> = {
      targetWinRate: 'target_win_rate', houseEdge: 'house_edge', minStakeCents: 'min_stake', maxStakeCents: 'max_stake',
      defaultDurationS: 'default_duration_s', maxMultiplier: 'max_multiplier',
      driftBias: 'drift_bias', volatility: 'volatility', tickRateMs: 'tick_rate_ms',
    };
    for (const f of EFIELDS) {
      const cur = form[f.key]; if (cur === undefined || cur === '') continue;
      const next = f.kes ? Math.round(Number(cur) * 100) : f.pct ? Number(cur) / 100 : Number(cur);
      if (Number.isFinite(next) && next !== (c[f.key] as number)) out[snake[f.key]] = next;
    }
    const mw = Number(minWd);
    if (minWd !== '' && Number.isFinite(mw) && mw > 0 && mw !== (c.minWithdrawalNative ?? null)) out['min_withdrawal_native'] = mw;
    return out;
  }, [form, c, minWd]);
  const dirty = Object.keys(patch).length;

  const merged: SiteConfig = useMemo(() => {
    const m = { ...c } as SiteConfig;
    for (const f of EFIELDS) {
      const cur = form[f.key]; if (cur === '') continue;
      const n = f.kes ? Math.round(Number(cur) * 100) : f.pct ? Number(cur) / 100 : Number(cur);
      if (Number.isFinite(n)) (m as unknown as Record<string, number>)[f.key] = n;
    }
    return m;
  }, [form, c]);
  const feasible = useMemo(() => checkFeasible({
    houseEdge: merged.houseEdge, maxMultiplier: merged.maxMultiplier, minStakeCents: merged.minStakeCents,
    maxStakeCents: merged.maxStakeCents, minWithdrawalCents: merged.minWithdrawalCents, defaultDurationS: merged.defaultDurationS,
    tickRateMs: merged.tickRateMs, driftBias: merged.driftBias, volatility: merged.volatility, targetWinRate: merged.targetWinRate,
  }), [merged]);
  const blocked = !feasible.ok;

  function save() {
    setConfig.mutate({ id: site.siteId, patch }, {
      onSuccess: () => toast.push({ tone: 'success', title: 'Economy saved', description: `Live on the next round (${dirty} field(s)).` }),
      onError: (e) => toast.push({ tone: 'error', title: 'Update failed', description: (e as Error).message }),
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <StakeLimitsCard siteId={site.siteId} currency={currency} />
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted">
        <span title="Return to player: the share of stakes paid back over time">Return to player: <span className="font-medium text-fg tabular-nums">{((1 - c.houseEdge) * 100).toFixed(2)}%</span></span>
        <span>Settings version <span className="font-medium text-fg tabular-nums">{c.version}</span></span>
        <PoolModeNote siteId={site.siteId} />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {EFIELDS.map((f) => (
          <Input key={f.key} type="number" inputMode="decimal" step={f.step} label={f.label} hint={f.hint}
            value={form[f.key] ?? ''} onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))} />
        ))}
        <Input key="minWithdrawalNative" type="number" inputMode="decimal" step="0.01"
          label={`Min withdrawal (${currency})`}
          hint={`Reject requests below this, in ${currency}. Enforced at the live FX rate (e.g. 100 = $100 on a USD brand).`}
          value={minWd} onChange={(e) => setMinWd(e.target.value)} />
      </div>
      {dirty > 0 ? (
        <div className={blocked ? 'rounded-brand border border-down/40 bg-down/10 p-3 text-xs text-down' : 'rounded-brand border border-border bg-surface-2 p-3 text-xs text-muted'} role={blocked ? 'alert' : undefined}>
          {blocked ? <><span className="font-semibold">Cannot apply: </span>{feasible.reason}</>
            : <>After saving, return to player becomes <span className="font-semibold text-fg tabular-nums">{((1 - merged.houseEdge) * 100).toFixed(2)}%</span> and an average win pays <span className="font-semibold text-fg tabular-nums">×{feasible.requiredMeanWinMultiplier.toFixed(2)}</span>.</>}
        </div>
      ) : null}
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={save} disabled={dirty === 0 || blocked || setConfig.isPending}>
          {setConfig.isPending ? 'Saving…' : blocked ? 'Invalid economy' : dirty > 0 ? `Save ${dirty} change${dirty > 1 ? 's' : ''}` : 'No changes'}
        </Button>
        {dirty > 0 ? <Button size="sm" variant="ghost" onClick={() => setForm(init)}>Reset</Button> : null}
      </div>
    </div>
  );
}

/** Palette editor (seed hue → derived palette) — fine-tune beyond the 56-theme library. */
function PaletteEditor({ site }: { site: SiteWithConfig }) {
  const setTheme = useSetSiteTheme();
  const toast = useToast();
  const [seed, setSeed] = useState(site.colorPrimary || '#22c55e');
  const [mode, setMode] = useState<'dark' | 'light'>(site.theme === 'light' ? 'light' : 'dark');
  const [fontTitle, setFontTitle] = useState('Space Grotesk');
  const [fontBody, setFontBody] = useState('Inter');
  const tokens: Record<string, string> = { ...deriveMinimalPalette(seed, mode), fontTitle, fontBody };
  useEffect(() => {
    const href = googleFontsHref([fontTitle, fontBody]); if (!href) return;
    const el = document.createElement('link'); el.rel = 'stylesheet'; el.href = href; document.head.appendChild(el);
    return () => { el.remove(); };
  }, [fontTitle, fontBody]);
  const swatches: [string, string][] = [['bg', 'bg'], ['surface', 'surf'], ['border', 'bd'], ['muted', 'mut'], ['fg', 'fg'], ['brand', 'brand'], ['accent', 'acc'], ['up', 'gain'], ['down', 'loss']];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted">Fine-tune from a single seed hue (derives a full brand-tinted palette; gain/loss stay green/red).</p>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm"><span className="text-muted">Preset</span>
          <select value={presetForSeed(seed)?.label ?? ''} onChange={(e) => { const p = groupedPresets().flatMap((g) => g.presets).find((x) => x.label === e.target.value); if (p) { setSeed(p.seed); setFontTitle(p.fontTitle); setFontBody(p.fontBody); } }} className="h-9 rounded-lg border border-border bg-surface-2 px-2 text-sm text-fg">
            <option value="">Custom…</option>
            {groupedPresets().map(({ group, presets }) => <optgroup key={group} label={group}>{presets.map((p) => <option key={p.label} value={p.label}>{p.label}</option>)}</optgroup>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm"><span className="text-muted">Seed</span>
          <input type="color" value={seed} onChange={(e) => setSeed(e.target.value)} className="h-8 w-10 cursor-pointer rounded border border-border" /></label>
        <select value={mode} onChange={(e) => setMode(e.target.value as 'dark' | 'light')} className="h-9 rounded-lg border border-border bg-surface-2 px-2 text-sm text-fg"><option value="dark">dark</option><option value="light">light</option></select>
        <label className="flex items-center gap-2 text-sm"><span className="text-muted">Heading</span>
          <select value={fontTitle} onChange={(e) => setFontTitle(e.target.value)} className="h-9 rounded-lg border border-border bg-surface-2 px-2 text-sm text-fg">{BRAND_FONTS.map((f) => <option key={f} value={f}>{f}</option>)}</select></label>
        <label className="flex items-center gap-2 text-sm"><span className="text-muted">Body</span>
          <select value={fontBody} onChange={(e) => setFontBody(e.target.value)} className="h-9 rounded-lg border border-border bg-surface-2 px-2 text-sm text-fg">{BRAND_FONTS.map((f) => <option key={f} value={f}>{f}</option>)}</select></label>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {swatches.map(([k, lab]) => <div key={k} className="flex flex-col items-center"><span className="h-7 w-9 rounded border border-border" style={{ backgroundColor: tokens[k] }} /><span className="mt-0.5 text-[9px] text-muted">{lab}</span></div>)}
      </div>
      <div>
        <Button size="sm" variant="outline" disabled={setTheme.isPending} onClick={() => setTheme.mutate({ id: site.siteId, tokens }, { onSuccess: () => toast.push({ tone: 'success', title: 'Palette saved' }) })}>
          {setTheme.isPending ? 'Saving…' : 'Save custom palette'}
        </Button>
      </div>
    </div>
  );
}

const kes = (c: number) => formatKes(c);

/**
 * UI-F — People on this brand, from the console: who administers it (appoint / remove — the only place to do
 * that) and a read-only player list with each player's summary and game overrides. Everything else about one
 * player (status, balance, notes, marketer settings) has ONE home: the brand back office user page.
 */
function PeopleSection({ site }: { site: SiteWithConfig }) {
  const [q, setQ] = useState('');
  const [statusF, setStatusF] = useState('');
  const params = useMemo(() => ({ q: q.trim() || undefined, status: statusF || undefined, limit: '50' }), [q, statusF]);
  const users = usePlatformSiteUsers(site.siteId, params);
  const admins = usePlatformSiteUsers(site.siteId, { role: 'admin', limit: '50' });
  const action = usePlatformUserAction(site.siteId);
  const toast = useToast();
  const [sel, setSel] = useState<SiteUserRow | null>(null);
  const [appoint, setAppoint] = useState('');
  const rows = users.data?.items ?? [];
  const adminRows = (admins.data?.items ?? []).filter((u) => u.role === 'admin');
  const defaultMarketer = site.ownerUserId ? rows.find((u) => u.userId === site.ownerUserId) : undefined;

  const setRole = (uid: string, role: string, ok: string) => action.mutate({ kind: 'role', uid, role }, {
    onSuccess: () => { toast.push({ tone: 'success', title: ok }); setAppoint(''); },
    onError: (e) => toast.push({ tone: 'error', title: 'Not changed', description: (e as Error).message }),
  });
  const pill = (s: string) => `rounded-full px-2 py-0.5 text-xs font-medium ${s === 'active' ? 'bg-up/15 text-up' : s === 'suspended' ? 'bg-warn/15 text-warn' : 'bg-down/15 text-down'}`;
  const candidates = rows.filter((u) => u.role === 'player' || u.role === 'marketer');

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2" aria-label="Brand admins">
        <h3 className="text-sm font-semibold">Brand admins</h3>
        <p className="text-xs text-muted">They run this brand&apos;s back office: withdrawals, players, announcements.</p>
        <ul className="divide-y divide-border rounded-xl border border-border">
          {adminRows.map((u) => (
            <li key={u.userId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <span><span className="font-medium">@{u.username}</span> <span className="text-muted">{u.phone}</span></span>
              <ConfirmButton label="Remove" confirmLabel="Remove admin" variant="outline" busy={action.isPending} onConfirm={() => setRole(u.userId, 'player', `@${u.username} removed`)} />
            </li>
          ))}
          {!adminRows.length ? <li className="px-3 py-2 text-sm text-muted">{admins.isLoading ? 'Loading…' : 'No brand admin yet.'}</li> : null}
        </ul>
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Person to appoint" value={appoint} onChange={(e) => setAppoint(e.target.value)} className="h-9 min-w-56 rounded-lg border border-border bg-surface-2 px-2 text-sm text-fg">
            <option value="">Appoint someone from this brand…</option>
            {candidates.map((u) => <option key={u.userId} value={u.userId}>@{u.username} · {u.phone}</option>)}
          </select>
          <Button size="sm" disabled={!appoint || action.isPending} onClick={() => setRole(appoint, 'admin', 'Brand admin appointed')}>Appoint</Button>
          <span className="text-xs text-muted">Search the list below to find someone not shown.</span>
        </div>
      </section>

      <section className="flex flex-col gap-2" aria-label="Players">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Players</h3>
          <span className="text-xs text-muted">Default marketer: {site.ownerUserId ? (defaultMarketer ? `@${defaultMarketer.username}` : 'assigned') : 'none'} · changed on the marketer&apos;s page in the back office</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input aria-label="Search players" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search phone or username" className="h-9 w-56 max-w-full rounded-lg border border-border bg-surface-2 px-3 text-sm text-fg outline-none focus:border-accent" />
          <select aria-label="Status" value={statusF} onChange={(e) => setStatusF(e.target.value)} className="h-9 rounded-lg border border-border bg-surface-2 px-2 text-sm text-fg">
            <option value="">All statuses</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="banned">Banned</option>
          </select>
          <span className="text-xs text-muted">{rows.length} shown</span>
        </div>
        <div className="table-wrapper overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[640px] text-sm">
            <thead><tr className="text-left text-xs uppercase tracking-wide text-muted">
              <th className="px-3 py-2">Player</th><th className="px-3 py-2">Role</th><th className="px-3 py-2">Status</th><th className="px-3 py-2 text-right">Balance</th><th className="px-3 py-2 text-right">Deposits</th><th className="px-3 py-2 text-right">Bets</th>
            </tr></thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.userId} onClick={() => setSel(u)} className={`cursor-pointer border-t border-border hover:bg-surface-2 ${sel?.userId === u.userId ? 'bg-surface-2' : ''}`}>
                  <td className="px-3 py-2"><span className="font-medium text-fg">@{u.username}</span> <span className="text-muted">{u.phone}</span></td>
                  <td className="px-3 py-2 text-muted">{u.role}</td>
                  <td className="px-3 py-2"><span className={pill(u.status)}>{u.status}</span></td>
                  <td className="px-3 py-2 text-right tabular-nums">{kes(u.realBalanceCents)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{kes(u.depositsCents)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatNumber(u.betCount)}</td>
                </tr>
              ))}
              {rows.length === 0 ? <tr><td className="px-3 py-3 text-muted" colSpan={6}>{users.isLoading ? 'Loading…' : 'No players.'}</td></tr> : null}
            </tbody>
          </table>
        </div>
        {sel ? (
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface-2 p-3" aria-label={`Player @${sel.username}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-semibold text-fg">@{sel.username} <span className="font-normal text-muted">{sel.phone}</span></span>
              <div className="flex items-center gap-2">
                <OpenBrandButton siteId={site.siteId} brandName={site.name} to={`/admin/users/${sel.userId}`} label="Manage in back office" />
                <button className="text-xs text-muted hover:text-fg" onClick={() => setSel(null)} aria-label="Close player">✕</button>
              </div>
            </div>
            <PlayerSummary key={sel.userId} siteId={site.siteId} uid={sel.userId} />
            <details className="border-t border-border pt-3">
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted">Game overrides for this player</summary>
              <div className="pt-2"><PlayerOverridesForm key={sel.userId} site={site} uid={sel.userId} /></div>
            </details>
            <p className="text-xs text-muted">Status, balance, notifications and marketer settings are changed in the back office.</p>
          </div>
        ) : <p className="text-xs text-muted">Select a player to see their summary and game overrides.</p>}
      </section>
    </div>
  );
}

/** Pool mode is set on the Withdrawal pool page; the Economy tab only says which regime applies. */
function PoolModeNote({ siteId }: { siteId: string }) {
  const cfg = useGameConfig(siteId);
  if (!cfg.data) return null;
  return <span>Payouts: <span className="font-medium text-fg">{cfg.data.poolMode ? 'from the daily pool' : 'fixed win rate'}</span> · <Link href="/platform/pool" className="text-accent hover:underline">Withdrawal pool</Link></span>;
}

/** Per-brand legal copy (terms, privacy, responsible gaming, about) — stored in sites.legal_copy. */
function LegalSection({ site }: { site: SiteWithConfig }) {
  const update = useUpdateSite();
  const toast = useToast();
  const lc = (site.legalCopy ?? {}) as Record<string, string>;
  const init = useMemo(() => ({ terms: lc.terms ?? '', privacy: lc.privacy ?? '', responsible: lc.responsible ?? '', about: lc.about ?? '' }), [site]);
  const [form, setForm] = useSyncedForm(init);
  const dirty = JSON.stringify(form) !== JSON.stringify(init);
  const FIELDS: [keyof typeof init, string][] = [['terms', 'Terms & Conditions'], ['privacy', 'Privacy Policy'], ['responsible', 'Responsible Gaming'], ['about', 'About']];
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3">
        {FIELDS.map(([k, label]) => (
          <label key={k} className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-fg">{label}</span>
            <textarea rows={3} className="rounded-brand border border-border bg-surface-2 p-2.5 text-sm text-fg outline-none focus:border-accent"
              value={form[k]} onChange={(e) => setForm((s) => ({ ...s, [k]: e.target.value }))} />
          </label>
        ))}
      </div>
      <SaveBar dirty={dirty ? 1 : 0} saving={update.isPending} onSave={() => update.mutate({ id: site.siteId, patch: { legal_copy: { ...lc, ...form } } }, {
        onSuccess: () => toast.push({ tone: 'success', title: 'Legal copy saved' }),
        onError: (e) => toast.push({ tone: 'error', title: 'Save failed', description: (e as Error).message }),
      })} onReset={() => setForm(init)} />
    </div>
  );
}


/** The full per-client management surface — a tabbed, consolidated detail (operator console). */
const DETAIL_TABS = [
  { id: 'identity', label: 'Identity' },
  { id: 'branding', label: 'Branding' },
  { id: 'economy', label: 'Economy' },
  { id: 'addons', label: 'Add-ons' },
  { id: 'people', label: 'People' },
  { id: 'legal', label: 'Legal' },
] as const;
type DetailTab = (typeof DETAIL_TABS)[number]['id'];

const DETAIL_TAB_IDS = DETAIL_TABS.map((t) => t.id) as DetailTab[];

export function ClientDetail({ site, addons }: { site: SiteWithConfig; addons?: React.ReactNode }) {
  // UI-C: the open tab lives in the URL (?tab=…), so it can be linked and survives a reload.
  const [tab, setTab] = useTabParam<DetailTab>(DETAIL_TAB_IDS, 'identity');
  return (
    <div className="flex flex-col gap-4">
      <PageTabs tabs={DETAIL_TABS} value={tab} onChange={setTab} label="Brand settings" />

      <div className="rounded-2xl border border-border bg-surface p-4">
        {tab === 'identity' ? <IdentitySection site={site} /> : null}
        {tab === 'branding' ? (
          <div className="flex flex-col gap-4">
            <ThemeGallery site={site} />
            <div className="border-t border-border pt-3"><PaletteEditor site={site} /></div>
          </div>
        ) : null}
        {tab === 'economy' ? <EconomySection site={site} /> : null}
        {tab === 'addons' ? addons ?? null : null}
        {tab === 'legal' ? <LegalSection site={site} /> : null}
        {tab === 'people' ? <PeopleSection site={site} /> : null}
      </div>
    </div>
  );
}
