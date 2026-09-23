'use client';

import { PlayerSummary, BalanceAdjust, PlayerOverridesForm } from '@/components/platform/PlayerConsolePanels';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/lib/toast/ToastProvider';
import { checkFeasible } from '@invest254/shared/config';
import { useUpdateSite, useSetSiteConfig, useSetSiteTheme, useSetSiteOwner, usePlatformSiteUsers, usePlatformSiteAudit, usePlatformUserAction } from '@/lib/platform/hooks';
import type { SiteWithConfig, SiteConfig, SiteUserRow, AuditRow } from '@/lib/platform/endpoints';
import { deriveMinimalPalette } from '@/lib/brand/derivePalette';
import { groupedPresets, presetForSeed } from '@/lib/brand/presets';
import { BRAND_FONTS, googleFontsHref } from '@/lib/brand/fonts';
import { ThemeGallery } from '@/components/platform/ThemeGallery';
import { useCan } from '@/lib/auth/can';
import { useGameConfig, useUpdateGameConfig, useWithdrawalPool, useSetWithdrawalPool, useWithdrawalsEnabled, useSetWithdrawalsEnabled } from '@/lib/admin/hooks';
import { formatNumber } from '@/lib/format';
import { formatKes } from '@invest254/shared/money';
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

const STATUSES = ['active', 'paused', 'archived'] as const;

/** Identity, status, domain, locale & legal — all persisted via PATCH /platform/sites/:id. */
function IdentitySection({ site }: { site: SiteWithConfig }) {
  const ownerSettings = useCan('console.site.owner_settings');   // docs/42 UI-6: chart style / trade UI are owner-only at the API
  const update = useUpdateSite();
  const toast = useToast();
  const init = useMemo(() => ({
    name: site.name ?? '', status: site.status ?? 'active', primary_domain: site.primaryDomain ?? '',
    wordmark_text: site.wordmarkText ?? '', support_email: site.supportEmail ?? '',
    currency: site.currency ?? 'KES', locale: site.locale ?? 'en-KE', chart_style: site.chartStyle ?? 'line', trade_ui: site.tradeUi ?? 'classic',
    licence_line: site.licenceLine ?? '',
  }), [site]);
  const [form, setForm] = useState(init);
  useEffect(() => setForm(init), [init]);
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
        <div className="grid grid-cols-2 gap-3">
          <Input label="Currency" name={`cur-${site.siteId}`} value={form.currency} onChange={set('currency')} hint="display currency, e.g. KES or USD" />
          <Input label="Locale" name={`loc-${site.siteId}`} value={form.locale} onChange={set('locale')} />
        </div>
        {ownerSettings ? (
          <>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-fg">Price chart</span>
            <select className="h-11 rounded-brand border border-border bg-surface-2 px-3 text-fg" value={form.chart_style} onChange={set('chart_style')}>
              <option value="line">Line / area curve</option>
              <option value="candlestick">Candlesticks (TradingView)</option>
            </select>
            <span className="text-xs text-muted">How this brand renders the live price. Currency + chart are display-only; the money of record stays KES.</span>
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-fg">Trade interface</span>
            <select className="h-11 rounded-brand border border-border bg-surface-2 px-3 text-fg" value={form.trade_ui} onChange={set('trade_ui')}>
              <option value="classic">Classic (rise/fall curve)</option>
              <option value="digits">Digits broker (Deriv-style)</option>
            </select>
            <span className="text-xs text-muted">Which trade screen this brand shows. Layout only; the money of record stays KES.</span>
          </label>
          </>
        ) : (
          <p className="text-sm text-muted sm:col-span-2">
            Price chart: <span className="text-fg">{form.chart_style === 'candlestick' ? 'Candlesticks' : 'Line / area'}</span> · Trade interface:{' '}
            <span className="text-fg">{form.trade_ui === 'digits' ? 'Digits broker' : 'Classic'}</span> — set by the system owner (add-on).
          </p>
        )}
        <Input label="Licence line" name={`lic-${site.siteId}`} value={form.licence_line} onChange={set('licence_line')} hint="footer compliance text" />
      </div>
      <SaveBar dirty={dirty} saving={update.isPending} onSave={save} onReset={() => setForm(init)} />
    </div>
  );
}

/** Economy — the full game config with a live feasibility preview (mirrors the DB CHECK). */
type EK = 'targetWinRate' | 'houseEdge' | 'minStakeCents' | 'maxStakeCents' | 'defaultDurationS' | 'maxMultiplier' | 'driftBias' | 'volatility' | 'tickRateMs';
const EFIELDS: { key: EK; label: string; hint: string; kes?: boolean; pct?: boolean; step?: string }[] = [
  { key: 'targetWinRate', label: 'Win rate (%)', hint: 'Share of rounds a player wins', pct: true, step: '1' },
  { key: 'houseEdge', label: 'House edge (%)', hint: 'House margin; RTP = 100% − edge', pct: true, step: '0.5' },
  { key: 'minStakeCents', label: 'Min stake (KES)', hint: 'Smallest stake', kes: true, step: '1' },
  { key: 'maxStakeCents', label: 'Max stake (KES)', hint: 'Largest stake', kes: true, step: '1' },
  // Min withdrawal is edited separately as a CURRENCY-NATIVE value (docs/25 §16) — see EconomySection.
  { key: 'defaultDurationS', label: 'Round duration (s)', hint: '1–3600', step: '1' },
  { key: 'maxMultiplier', label: 'Max payout ×', hint: 'Cap on a single win', step: '0.1' },
  { key: 'driftBias', label: 'Drift bias', hint: 'Advanced (−1..1)', step: '0.001' },
  { key: 'volatility', label: 'Volatility', hint: 'Advanced (>0)', step: '0.001' },
  { key: 'tickRateMs', label: 'Tick rate (ms)', hint: '50–60000', step: '10' },
];
const toField = (c: SiteConfig, f: (typeof EFIELDS)[number]): string => {
  const raw = c[f.key] as number;
  if (f.kes) return String(raw / 100);
  if (f.pct) return String(Math.round(raw * 1000) / 10);
  return String(raw);
};

function EconomySection({ site }: { site: SiteWithConfig }) {
  const setConfig = useSetSiteConfig();
  const toast = useToast();
  const c = site.config;
  const init = useMemo(() => Object.fromEntries(EFIELDS.map((f) => [f.key, toField(c, f)])) as Record<EK, string>, [c]);
  const [form, setForm] = useState<Record<EK, string>>(init);
  useEffect(() => setForm(init), [init]);

  // Min withdrawal is CURRENCY-NATIVE (docs/25 §16): entered in the brand's own currency (e.g. 100 =>
  // $100 for a USD brand, 2000 => KES 2,000). The API converts it to the enforced KES-cents floor at
  // the live FX rate, so KES brands are unchanged and foreign brands get an exact native minimum.
  const currency = site.currency || 'KES';
  const [minWd, setMinWd] = useState<string>(c.minWithdrawalNative != null ? String(c.minWithdrawalNative) : '');
  useEffect(() => setMinWd(c.minWithdrawalNative != null ? String(c.minWithdrawalNative) : ''), [c.minWithdrawalNative]);

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
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted">
        <span>RTP: <span className="font-medium text-fg tabular-nums">{((1 - c.houseEdge) * 100).toFixed(2)}%</span></span>
        <span>Version: <span className="font-medium text-fg tabular-nums">v{c.version}</span></span>
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
            : <>After saving, RTP becomes <span className="font-semibold text-fg tabular-nums">{((1 - merged.houseEdge) * 100).toFixed(2)}%</span>, mean win ×<span className="font-semibold text-fg tabular-nums">{feasible.requiredMeanWinMultiplier.toFixed(2)}</span>.</>}
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

/** Players in a brand — searchable table + an actions panel for the selected player. */
function PlayersSection({ site }: { site: SiteWithConfig }) {
  const ownerSettings = useCan('console.site.owner_settings');   // docs/42 UI-6: site owner / default marketer is owner-only at the API
  const [q, setQ] = useState('');
  const [statusF, setStatusF] = useState('');
  const params = useMemo(() => ({ q: q.trim() || undefined, status: statusF || undefined, limit: '50' }), [q, statusF]);
  const users = usePlatformSiteUsers(site.siteId, params);
  const action = usePlatformUserAction(site.siteId);
  const setOwner = useSetSiteOwner();
  const toast = useToast();
  const [sel, setSel] = useState<SiteUserRow | null>(null);
  const rows = users.data?.items ?? [];

  function run(v: Parameters<typeof action.mutate>[0], ok: string) {
    action.mutate(v, {
      onSuccess: () => { toast.push({ tone: 'success', title: ok }); },
      onError: (e) => toast.push({ tone: 'error', title: 'Action failed', description: (e as Error).message }),
    });
  }
  const pill = (s: string) => `rounded-full px-2 py-0.5 text-xs font-semibold ${s === 'active' ? 'bg-up/20 text-up' : s === 'suspended' ? 'bg-warn/20 text-warn' : 'bg-down/20 text-down'}`;

  // Assign/clear this brand's DEFAULT marketer (owner_user_id). Every deposit on the brand credits
  // the default marketer 25% (docs/09 §3). The backend (fn_platform_set_site_owner) enforces that the
  // beneficiary is a marketer on THIS brand, so the button is gated on the same rule client-side.
  function setBrandDefault(ownerUserId: string | null, ok: string) {
    setOwner.mutate({ id: site.siteId, ownerUserId }, {
      onSuccess: () => toast.push({ tone: 'success', title: ok }),
      onError: (e) => toast.push({ tone: 'error', title: 'Update failed', description: (e as Error).message }),
    });
  }
  // Prefer the freshest role from the live table (a just-promoted marketer updates without reselecting).
  const selRole = sel ? (rows.find((r) => r.userId === sel.userId)?.role ?? sel.role) : null;
  const selIsDefault = !!sel && site.ownerUserId === sel.userId;

  return (
    <div className="flex flex-col gap-3">
      {ownerSettings ? (
        <>
      {/* Brand marketer (commission owner) — every deposit on this brand credits this marketer by default. */}
      <div className="flex flex-wrap items-center gap-2 rounded-brand border border-accent/30 bg-accent/5 p-3">
        <span className="text-xs font-semibold text-fg">Brand marketer (commission owner):</span>
        <select
          value={site.ownerUserId ?? ''}
          onChange={(e) => setOwner.mutate({ id: site.siteId, ownerUserId: e.target.value || null }, {
            onSuccess: () => toast.push({ tone: 'success', title: 'Brand marketer updated' }),
            onError: (er) => toast.push({ tone: 'error', title: 'Update failed', description: (er as Error).message }),
          })}
          disabled={setOwner.isPending}
          className="h-9 rounded-lg border border-border bg-surface-2 px-2 text-sm text-fg"
        >
          <option value="">— unassigned —</option>
          {rows.filter((u) => u.role === 'marketer').map((m) => (
            <option key={m.userId} value={m.userId}>@{m.username} · {m.phone}</option>
          ))}
        </select>
        <span className="text-[11px] text-muted">All deposits on this brand credit this marketer (25%) unless a player used a specific referral code.</span>
      </div>
        </>
      ) : (
        <p className="text-xs text-muted">Brand marketer (commission owner): {site.ownerUserId ? (rows.find((u) => u.userId === site.ownerUserId)?.username ? `@${rows.find((u) => u.userId === site.ownerUserId)!.username}` : 'assigned') : 'unassigned'} — managed by the system owner.</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search phone / username…" className="h-9 w-56 max-w-full rounded-lg border border-border bg-surface-2 px-3 text-sm text-fg outline-none focus:border-accent" />
        <select value={statusF} onChange={(e) => setStatusF(e.target.value)} className="h-9 rounded-lg border border-border bg-surface-2 px-2 text-sm text-fg">
          <option value="">All statuses</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="banned">Banned</option>
        </select>
        <span className="text-xs text-muted">{rows.length} shown</span>
      </div>
      <div className="table-wrapper overflow-x-auto rounded-brand border border-border">
        <table className="w-full min-w-[640px] text-sm">
          <thead><tr className="text-left text-xs uppercase tracking-wide text-muted">
            <th className="px-3 py-2">Player</th><th className="px-3 py-2">Role</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Balance</th><th className="px-3 py-2">Deposits</th><th className="px-3 py-2">Bets</th>
          </tr></thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.userId} onClick={() => setSel(u)} className={`cursor-pointer border-t border-border hover:bg-surface-2 ${sel?.userId === u.userId ? 'bg-surface-2' : ''}`}>
                <td className="px-3 py-2"><span className="font-medium text-fg">@{u.username}</span> <span className="text-muted">{u.phone}</span>{site.ownerUserId === u.userId ? <span className="ml-2 rounded-full bg-accent/20 px-2 py-0.5 text-[10px] font-semibold text-accent">★ default</span> : null}</td>
                <td className="px-3 py-2 text-muted">{u.role}</td>
                <td className="px-3 py-2"><span className={pill(u.status)}>{u.status}</span></td>
                <td className="px-3 py-2 tabular-nums">{kes(u.realBalanceCents)}</td>
                <td className="px-3 py-2 tabular-nums">{kes(u.depositsCents)}</td>
                <td className="px-3 py-2 tabular-nums">{formatNumber(u.betCount)}</td>
              </tr>
            ))}
            {rows.length === 0 ? <tr><td className="px-3 py-3 text-muted" colSpan={6}>{users.isLoading ? 'Loading…' : 'No players.'}</td></tr> : null}
          </tbody>
        </table>
      </div>

      {sel ? (
        <div className="flex flex-col gap-3 rounded-brand border border-border bg-surface-2 p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-fg">Manage @{sel.username} <span className="font-normal text-muted">{sel.phone}</span></span>
            <button className="text-xs text-muted hover:text-fg" onClick={() => setSel(null)}>close ✕</button>
          </div>
          <PlayerSummary key={sel.userId} siteId={site.siteId} uid={sel.userId} />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted">Status:</span>
            <Button size="sm" variant="outline" disabled={action.isPending} onClick={() => run({ kind: 'status', uid: sel.userId, status: 'active', reason: 'platform console' }, 'Activated')}>Activate</Button>
            <Button size="sm" variant="outline" disabled={action.isPending} onClick={() => run({ kind: 'status', uid: sel.userId, status: 'suspended', reason: 'platform console' }, 'Suspended')}>Suspend</Button>
            <Button size="sm" variant="down" disabled={action.isPending} onClick={() => run({ kind: 'status', uid: sel.userId, status: 'banned', reason: 'platform console' }, 'Banned')}>Ban</Button>
            <span className="ml-2 text-xs text-muted">Role:</span>
            <select defaultValue={sel.role} onChange={(e) => run({ kind: 'role', uid: sel.userId, role: e.target.value }, `Role → ${e.target.value}`)} className="h-8 rounded-lg border border-border bg-surface px-2 text-sm text-fg">
              <option value="player">player</option><option value="marketer">marketer</option><option value="admin">admin</option>
            </select>
          </div>
          {ownerSettings ? (
            <>
          {/* Brand default marketer — make this marketer earn 25% of every deposit on this client. */}
          <div className="flex flex-wrap items-center gap-2 rounded-brand border border-accent/30 bg-accent/5 p-2">
            <span className="text-xs font-semibold text-fg">Brand default marketer:</span>
            {selIsDefault ? (
              <>
                <span className="rounded-full bg-accent/20 px-2 py-0.5 text-xs font-semibold text-accent">★ Current default</span>
                <Button size="sm" variant="outline" disabled={setOwner.isPending} onClick={() => setBrandDefault(null, `@${sel.username} removed as brand default`)}>Remove as default</Button>
              </>
            ) : (
              <>
                <Button size="sm" disabled={setOwner.isPending || selRole !== 'marketer'} onClick={() => setBrandDefault(sel.userId, `@${sel.username} is now the brand default marketer`)}>Make brand default</Button>
                <span className="text-[11px] text-muted">
                  {selRole !== 'marketer'
                    ? <>Set role to <span className="font-medium text-fg">marketer</span> first.</>
                    : <>Every deposit on this brand will credit @{sel.username} 25%.</>}
                </span>
              </>
            )}
          </div>
            </>
          ) : null}
          {/* docs/42 UI-10: a named wallet, a before → after confirmation, and the player's overrides. */}
          <div className="flex flex-col gap-2 border-t border-border pt-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Adjust balance</h4>
            <BalanceAdjust key={sel.userId} siteId={site.siteId} uid={sel.userId} username={sel.username} />
          </div>
          <details className="border-t border-border pt-3">
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted">Game overrides for this player</summary>
            <div className="pt-2"><PlayerOverridesForm key={sel.userId} site={site} uid={sel.userId} /></div>
          </details>
        </div>
      ) : <p className="text-xs text-muted">Select a player to see their details and manage status, role, balance and overrides.</p>}
    </div>
  );
}

/** A brand's recent admin actions (audit trail). */
function AuditSection({ site }: { site: SiteWithConfig }) {
  const audit = usePlatformSiteAudit(site.siteId);
  const rows: AuditRow[] = audit.data?.items ?? [];
  return (
    <div className="table-wrapper overflow-x-auto rounded-brand border border-border">
      <table className="w-full min-w-[640px] text-sm">
        <thead><tr className="text-left text-xs uppercase tracking-wide text-muted">
          <th className="px-3 py-2">When</th><th className="px-3 py-2">Actor</th><th className="px-3 py-2">Action</th><th className="px-3 py-2">Target</th>
        </tr></thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id} className="border-t border-border">
              <td className="px-3 py-2 whitespace-nowrap text-muted">{new Date(a.createdAtMs).toLocaleString()}</td>
              <td className="px-3 py-2 text-muted">{a.actorRole}</td>
              <td className="px-3 py-2 font-medium text-fg">{a.action}</td>
              <td className="px-3 py-2 text-muted">{a.targetType}{a.targetId ? ` · ${a.targetId.slice(0, 8)}` : ''}</td>
            </tr>
          ))}
          {rows.length === 0 ? <tr><td className="px-3 py-3 text-muted" colSpan={4}>{audit.isLoading ? 'Loading…' : 'No audit entries.'}</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}

/** Per-brand M-Pesa config (non-secret). Secret values are infra-managed; live routing note below. */
function PaymentsSection({ site }: { site: SiteWithConfig }) {
  // PAY-1 (docs/43): the old per-brand M-Pesa fields here were never read by live payments. A brand's
  // payment accounts are now managed (and honoured) on the Payment accounts page.
  return (
    <div className="flex flex-col gap-3 rounded-brand border border-border bg-surface-2 p-4 text-sm">
      <p>Which M-Pesa / gateway accounts this brand&apos;s deposits and withdrawals use — the System&apos;s, its platform&apos;s, or its own — is set on the Payment accounts page.</p>
      <div><a href={`/platform/payment-accounts?scope=site:${site.siteId}`} className="font-medium text-accent hover:underline">Open payment accounts for {site.name} →</a></div>
    </div>
  );
}

/** Per-brand legal copy (terms, privacy, responsible gaming, about) — stored in sites.legal_copy. */
function LegalSection({ site }: { site: SiteWithConfig }) {
  const update = useUpdateSite();
  const toast = useToast();
  const lc = (site.legalCopy ?? {}) as Record<string, string>;
  const init = useMemo(() => ({ terms: lc.terms ?? '', privacy: lc.privacy ?? '', responsible: lc.responsible ?? '', about: lc.about ?? '' }), [site]);
  const [form, setForm] = useState(init);
  useEffect(() => setForm(init), [init]);
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


/**
 * docs/42 UI-2 — owner-only brand settings that used to live in the unscoped back office (where they
 * silently hit brand #1): this brand's pool mode, daily withdrawal budget and withdrawal kill switch.
 * Every call names THIS brand (?site=), which the API now requires of the system owner.
 */
function PoolPayoutsSection({ site }: { site: SiteWithConfig }) {
  const toast = useToast();
  const cfg = useGameConfig(site.siteId);
  const updateCfg = useUpdateGameConfig(site.siteId);
  const pool = useWithdrawalPool(undefined, site.siteId);
  const setPool = useSetWithdrawalPool(site.siteId);
  const wd = useWithdrawalsEnabled(site.siteId);
  const setWd = useSetWithdrawalsEnabled(site.siteId);
  const [today, setToday] = useState('');
  const [dflt, setDflt] = useState('');
  const err = (title: string) => (e: unknown) => toast.push({ tone: 'error', title, description: (e as Error).message });
  const kes = (c: number | undefined) => (typeof c === 'number' ? (c / 100).toLocaleString('en-KE') : '—');
  return (
    <div className="flex flex-col gap-5">
      <p className="text-xs text-muted">These settings apply to <span className="font-semibold text-fg">{site.name}</span> only.</p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Pool mode</p>
          <p className="text-xs text-muted">When on, outcomes follow this brand&apos;s withdrawal pool instead of the fixed win rate.</p>
        </div>
        <Button size="sm" variant="outline" disabled={!cfg.data || updateCfg.isPending}
          onClick={() => updateCfg.mutate({ poolMode: !cfg.data!.poolMode }, {
            onSuccess: (r) => toast.push({ tone: 'success', title: `Pool mode ${r.poolMode ? 'ON' : 'OFF'} for ${site.name}` }),
            onError: err('Pool mode not changed'),
          })}>
          {cfg.data ? (cfg.data.poolMode ? 'On — turn off' : 'Off — turn on') : '…'}
        </Button>
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">Daily withdrawal budget</p>
        <p className="text-xs text-muted">
          Today: KES {kes(pool.data?.amountCents)} (paid {kes(pool.data?.paidCents)}, available {kes(pool.data?.availableCents)}) · default for new days: KES {kes(pool.data?.defaultDailyPoolCents)}
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <Input label="Set today (KES)" name={`pt-${site.siteId}`} value={today} onChange={(e) => setToday(e.target.value)} />
          <Button size="sm" disabled={!today || setPool.isPending} onClick={() => setPool.mutate({ amountCents: Math.round(Number(today) * 100) }, {
            onSuccess: () => { setToday(''); toast.push({ tone: 'success', title: `Today's budget set for ${site.name}` }); }, onError: err('Budget not set'),
          })}>Set today</Button>
          <Input label="Default for new days (KES)" name={`pd-${site.siteId}`} value={dflt} onChange={(e) => setDflt(e.target.value)} />
          <Button size="sm" disabled={!dflt || setPool.isPending} onClick={() => setPool.mutate({ defaultAmountCents: Math.round(Number(dflt) * 100) }, {
            onSuccess: () => { setDflt(''); toast.push({ tone: 'success', title: `Default budget set for ${site.name}` }); }, onError: err('Default not set'),
          })}>Set default</Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Withdrawals</p>
          <p className="text-xs text-muted">Kill switch for this brand only. Pending requests stay pending.</p>
        </div>
        <Button size="sm" variant={wd.data?.enabled === false ? 'primary' : 'outline'} disabled={!wd.data || setWd.isPending}
          onClick={() => setWd.mutate(!wd.data!.enabled, {
            onSuccess: (r) => toast.push({ tone: 'success', title: `Withdrawals ${r.enabled ? 'enabled' : 'paused'} for ${site.name}` }),
            onError: err('Withdrawals switch not changed'),
          })}>
          {wd.data ? (wd.data.enabled ? 'Enabled — pause' : 'Paused — enable') : '…'}
        </Button>
      </div>
    </div>
  );
}

/** The full per-client management surface — a tabbed, consolidated detail (operator console). */
const DETAIL_TABS = [
  { id: 'identity', label: 'Identity' },
  { id: 'branding', label: 'Branding' },
  { id: 'economy', label: 'Economy' },
  { id: 'pool', label: 'Pool & payouts', ownerOnly: true },
  { id: 'payments', label: 'Payments' },
  { id: 'addons', label: 'Add-ons' },
  { id: 'legal', label: 'Legal' },
  { id: 'players', label: 'Players' },
  { id: 'audit', label: 'Audit' },
] as const;
type DetailTab = (typeof DETAIL_TABS)[number]['id'];

const DETAIL_TAB_IDS = DETAIL_TABS.map((t) => t.id) as DetailTab[];

export function ClientDetail({ site, addons }: { site: SiteWithConfig; addons?: React.ReactNode }) {
  // UI-C: the open tab lives in the URL (?tab=…), so it can be linked and survives a reload.
  const [tab, setTab] = useTabParam<DetailTab>(DETAIL_TAB_IDS, 'identity');
  const ownerSettings = useCan('console.site.owner_settings');
  const tabs = DETAIL_TABS.filter((t) => !('ownerOnly' in t && t.ownerOnly) || ownerSettings);
  return (
    <div className="flex flex-col gap-4">
      <PageTabs tabs={tabs} value={tab} onChange={setTab} label="Brand settings" />

      <div className="rounded-2xl border border-border bg-surface p-4">
        {tab === 'identity' ? <IdentitySection site={site} /> : null}
        {tab === 'pool' && ownerSettings ? <PoolPayoutsSection site={site} /> : null}
        {tab === 'branding' ? (
          <div className="flex flex-col gap-4">
            <ThemeGallery site={site} />
            <div className="border-t border-border pt-3"><PaletteEditor site={site} /></div>
          </div>
        ) : null}
        {tab === 'economy' ? <EconomySection site={site} /> : null}
        {tab === 'payments' ? <PaymentsSection site={site} /> : null}
        {tab === 'addons' ? addons ?? null : null}
        {tab === 'legal' ? <LegalSection site={site} /> : null}
        {tab === 'players' ? <PlayersSection site={site} /> : null}
        {tab === 'audit' ? <AuditSection site={site} /> : null}
      </div>
    </div>
  );
}
