'use client';

import { useMemo, useState } from 'react';
import { SITE_THEMES, type SiteTheme } from '@/lib/brand/siteThemes';
import { useApplySiteTheme } from '@/lib/platform/hooks';
import type { SiteWithConfig } from '@/lib/platform/endpoints';
import { Button } from '@/components/ui/Button';

/**
 * Interactive theme library for the platform console (docs/22 / docs/24): the 56 curated crypto/
 * fintech mirrors from lib/brand/siteThemes, each rendered as a live mini trade-card from its OWN
 * tokens (colours + radius + semantics), so the owner sees exactly how a client will look and can
 * apply a complete identity to that client in one click. Apply writes theme_tokens + mode + colours
 * (useApplySiteTheme) and is served live on the next /site/brand fetch.
 */

const SWATCHES = ['bg', 'surface', 'surface2', 'border', 'muted', 'brand', 'accent', 'up', 'down'] as const;

/** One theme rendered from its own tokens — a realistic, self-contained preview. */
function ThemeCard({
  t, isCurrent, isApplying, onApply,
}: { t: SiteTheme; isCurrent: boolean; isApplying: boolean; onApply: () => void }) {
  const k = t.tokens;
  return (
    <div
      className="group relative flex flex-col overflow-hidden border transition"
      style={{ background: k.bg, borderColor: isCurrent ? k.brand : k.border, borderRadius: k.radius, borderWidth: isCurrent ? 2 : 1 }}
    >
      <div className="flex flex-col gap-1.5 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs font-bold" style={{ color: k.fg }}>{t.label}</span>
          <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: k.brand }} />
        </div>
        <div className="flex items-baseline gap-1.5">
          <span className="text-base font-bold tabular-nums" style={{ color: k.up }}>+1,284.50</span>
          <span className="rounded px-1 py-px text-[9px] font-semibold" style={{ background: `${k.up}22`, color: k.up }}>+2.14%</span>
        </div>
        <div className="flex gap-1">
          <span className="px-1.5 py-0.5 text-[9px] font-bold text-white" style={{ background: k.up, borderRadius: k.radius }}>BUY</span>
          <span className="px-1.5 py-0.5 text-[9px] font-bold text-white" style={{ background: k.down, borderRadius: k.radius }}>SELL</span>
          <span className="px-1.5 py-0.5 text-[9px] font-bold" style={{ background: k.accent, color: k.accentFg, borderRadius: k.radius }}>Trade</span>
        </div>
        <div className="flex gap-0.5">
          {SWATCHES.map((n) => (
            <span key={n} className="h-2 flex-1 rounded-sm" style={{ background: (k as unknown as Record<string, string>)[n] }} />
          ))}
        </div>
        <div className="truncate text-[9px]" style={{ color: k.muted }}>
          {k.fontTitle} · {t.mode} · r{k.radius} · w{k.headingWeight}
        </div>
      </div>
      <button
        type="button"
        onClick={onApply}
        disabled={isApplying}
        className="border-t px-2 py-1.5 text-[11px] font-semibold transition disabled:opacity-60"
        style={{ borderColor: k.border, color: k.accentFg, background: isCurrent ? k.brand : k.accent }}
      >
        {isApplying ? 'Applying…' : isCurrent ? 'Current — reapply' : 'Apply to client'}
      </button>
    </div>
  );
}

export function ThemeGallery({ site }: { site: SiteWithConfig }) {
  const apply = useApplySiteTheme();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [appliedLabel, setAppliedLabel] = useState<string | null>(null);

  const current = (site.colorPrimary ?? '').toLowerCase();
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? SITE_THEMES.filter((t) => t.label.toLowerCase().includes(s) || t.id.includes(s)) : SITE_THEMES;
  }, [q]);

  function applyTheme(t: SiteTheme) {
    setPendingId(t.id);
    setAppliedLabel(null);
    apply.mutate(
      { id: site.siteId, theme: t },
      {
        onSuccess: () => { setAppliedLabel(t.label); setPendingId(null); },
        onError: () => setPendingId(null),
      },
    );
  }

  return (
    <div className="mt-3 border-t border-border pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">
          Theme library · {SITE_THEMES.length} professional mirrors · one-click apply
        </span>
        <span className="text-xs text-muted">{open ? '▲ hide' : '▼ browse'}</span>
      </button>

      {open ? (
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search themes (binance, coinbase, uniswap…)"
              className="h-9 w-64 max-w-full rounded-lg border border-border bg-surface-2 px-3 text-sm text-fg outline-none placeholder:text-muted focus:border-accent"
              aria-label="Search themes"
            />
            <span className="text-xs text-muted">{list.length} shown</span>
          </div>

          {appliedLabel ? (
            <div className="rounded-lg border border-up/40 bg-up/10 px-3 py-2 text-xs text-up">
              Applied <strong>{appliedLabel}</strong> to {site.name}. Live on next load — colours apply
              immediately; radius/fonts/weight render after the next web deploy.
            </div>
          ) : null}
          {apply.isError ? (
            <div className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-xs text-down">
              {(apply.error as Error)?.message ?? 'Apply failed.'}
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
            {list.map((t) => (
              <ThemeCard
                key={t.id}
                t={t}
                isCurrent={t.tokens.brand.toLowerCase() === current}
                isApplying={pendingId === t.id}
                onApply={() => applyTheme(t)}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
