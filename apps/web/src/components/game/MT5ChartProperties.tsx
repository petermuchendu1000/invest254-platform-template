'use client';

import { useEffect, useState } from 'react';
import {
  CHART_KINDS, COLOUR_FIELDS, SCHEMES, SCHEME_NAMES, SHOW_ROWS,
  applyShowRules, clampScale, clampShift, tickVolumesBlocked,
  type ChartKind, type ChartProperties, type ColourField, type SchemeName, type VolumeMode,
} from '@/lib/chart/chartProperties';
import { cn } from '@/lib/cn';

/**
 * MetaTrader's Chart Properties, opened with F8.
 *
 * Title `Properties of <SYMBOL>,<TIMEFRAME>`, with no space after the comma, which is what
 * MetaQuotes' own title bar reads. Three tabs in MetaTrader's order, Common, Show and Colors, and
 * three buttons, OK, Cancel and Help. There is no Apply.
 *
 * What is deliberately NOT here:
 *
 *   A price-scale TYPE. MetaTrader has no logarithmic and no percentage scale: no such chart
 *   property exists, no such control appears in this dialog or in Options, and MQL5's own moderator
 *   states that the terminal "always uses a linear scale for price representation". The
 *   `Linear | Log | Percent` control this chart used to carry was TradingView's and is gone.
 *
 *   The live chart preview that fills the left sixty per cent of MetaTrader's dialog. A desktop
 *   terminal has the room for it; a phone does not, and the real chart sits behind this sheet.
 *
 * Source: docs/mt5/08-chart-properties.md, from
 * https://www.metatrader5.com/en/terminal/help/charts_advanced/charts_settings
 */

type Tab = 'common' | 'show' | 'colors';

export function MT5ChartProperties({
  symbol, timeframe, value, onChange, onDismiss,
}: {
  symbol: string;
  timeframe: string;
  value: ChartProperties;
  onChange: (next: ChartProperties) => void;
  onDismiss: () => void;
}) {
  const [tab, setTab] = useState<Tab>('common');
  /**
   * Buffered, as MetaTrader's modal dialog is: OK applies, Cancel leaves the chart alone.
   *
   * Seeded ONCE, when the dialog opens. It used to be re-seeded from `value` whenever `value`
   * changed, which looked harmless and was not: the chart re-renders on every incoming tick, so the
   * draft was being reset several times a second and nothing the trader ticked could stay ticked.
   * The dialog is mounted fresh each time it opens, so the initial value is the right one and there
   * is nothing to re-seed from.
   */
  const [draft, setDraft] = useState<ChartProperties>(value);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  const set = (patch: Partial<ChartProperties>) => setDraft((d) => applyShowRules(d, patch));

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Properties of ${symbol},${timeframe}`}
      className="fixed inset-0 z-[85] flex flex-col bg-[var(--mt5-surface)] text-[var(--mt5-text)] sm:items-center sm:justify-center sm:bg-black/60 sm:p-4"
    >
      <div className="flex min-h-0 w-full flex-1 flex-col bg-[var(--mt5-surface)] sm:h-[76vh] sm:max-w-[460px] sm:flex-none sm:rounded-sm sm:border sm:border-[var(--mt5-border)]">
        <div className="flex items-center gap-2 border-b border-[var(--mt5-border)] px-3 py-2.5">
          <span className="flex-1 truncate text-[15px] font-semibold leading-tight">
            Properties of {symbol},{timeframe}
          </span>
          <button type="button" onClick={onDismiss} aria-label="Close" className="shrink-0 px-1 text-[18px] leading-none text-[var(--mt5-muted)] transition hover:text-white">×</button>
        </div>

        <div role="tablist" aria-label="Chart properties" className="flex shrink-0 border-b border-[var(--mt5-border)]">
          {([['common', 'Common'], ['show', 'Show'], ['colors', 'Colors']] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cn(
                'flex-1 px-2 py-2 text-[11px] font-semibold transition',
                tab === id ? 'border-b-2 border-[var(--mt5-blue)] text-white' : 'text-[var(--mt5-muted)] hover:text-white',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {tab === 'common' ? <CommonTab draft={draft} set={set} /> : null}
          {tab === 'show' ? <ShowTab draft={draft} set={set} /> : null}
          {tab === 'colors' ? <ColorsTab draft={draft} set={set} /> : null}
        </div>

        {/* OK, Cancel and Help. MetaTrader has no Apply on this dialog. */}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--mt5-border)] px-3 py-2.5">
          <button
            type="button"
            onClick={() => { onChange(draft); onDismiss(); }}
            className="h-8 rounded-sm bg-[var(--mt5-blue)] px-6 text-[11px] font-semibold text-white transition hover:brightness-110"
          >
            OK
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="h-8 rounded-sm border border-[var(--mt5-border)] bg-[var(--mt5-raised)] px-5 text-[11px] font-semibold text-[var(--mt5-text)] transition hover:bg-[var(--mt5-border)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => setTab('common')}
            title="MetaTrader opens its own help site here. This platform has no help site, so the button returns to the first tab."
            className="h-8 rounded-sm border border-[var(--mt5-border)] bg-[var(--mt5-raised)] px-4 text-[11px] font-semibold text-[var(--mt5-muted)] transition hover:bg-[var(--mt5-border)]"
          >
            Help
          </button>
        </div>
      </div>
    </div>
  );
}

type Set = (patch: Partial<ChartProperties>) => void;

/** A checkbox. MetaTrader puts the label to the RIGHT with no colon on the Common and Show tabs. */
function Check({ label, on, onToggle, disabled, title }: {
  label: string;
  on: boolean;
  onToggle: (v: boolean) => void;
  disabled?: boolean | undefined;
  title?: string | undefined;
}) {
  return (
    <label
      title={title}
      className={cn('mb-1.5 flex items-center gap-2 text-[11px] last:mb-0', disabled && 'cursor-not-allowed opacity-45')}
    >
      <input
        type="checkbox"
        checked={on}
        disabled={disabled}
        onChange={(e) => onToggle(e.target.checked)}
        className="h-3.5 w-3.5 accent-[var(--mt5-blue)]"
      />
      <span>{label}</span>
    </label>
  );
}

function Group({ children }: { children: React.ReactNode }) {
  return <div className="mb-3 rounded-sm border border-[var(--mt5-border)] p-2.5 last:mb-0">{children}</div>;
}

const num = 'h-8 w-28 rounded-sm border border-[var(--mt5-border)] bg-[var(--mt5-surface)] px-2 font-mono text-[11px] text-[var(--mt5-text)] outline-none focus:border-[var(--mt5-blue)] disabled:opacity-40';

function CommonTab({ draft, set }: { draft: ChartProperties; set: Set }) {
  return (
    <div>
      {/* MetaTrader's three chart types, as radio buttons, with its own accelerators. */}
      <Group>
        {CHART_KINDS.map((k) => (
          <label key={k.id} className="mb-1.5 flex items-center gap-2 text-[11px] last:mb-0">
            <input
              type="radio"
              name="chart-kind"
              checked={draft.kind === k.id}
              onChange={() => set({ kind: k.id as ChartKind })}
              className="h-3.5 w-3.5 accent-[var(--mt5-blue)]"
            />
            <span className="flex-1">{k.label}</span>
            <span className="text-[10px] text-[var(--mt5-muted)]">{k.accelerator}</span>
          </label>
        ))}
      </Group>

      <Group>
        <Check label="Chart on foreground" on={draft.chartOnForeground} onToggle={(v) => set({ chartOnForeground: v })} />
        <Check label="Chart shift" on={draft.chartShift} onToggle={(v) => set({ chartShift: v })} />
        <Check label="Chart auto scroll" on={draft.autoScroll} onToggle={(v) => set({ autoScroll: v })} />
      </Group>

      {/* The scale block, in MetaTrader's own order: the slider, then one to one ABOVE scale fix. */}
      <Group>
        <label className="mb-2 flex items-center gap-2 text-[11px]">
          <span className="w-10 shrink-0 text-[var(--mt5-muted)]">Scale</span>
          <input
            type="range"
            min={0}
            max={5}
            step={1}
            value={draft.scale}
            onChange={(e) => set({ scale: clampScale(Number(e.target.value)) })}
            className="min-w-0 flex-1 accent-[var(--mt5-blue)]"
          />
          <span className="w-4 shrink-0 text-right font-mono">{draft.scale}</span>
        </label>
        <Check
          label="Scale fix one to one"
          on={draft.scaleFixOneToOne}
          onToggle={(v) => set({ scaleFixOneToOne: v })}
        />
        <Check label="Scale fix" on={draft.scaleFix} onToggle={(v) => set({ scaleFix: v, ...(v ? {} : { scaleFixOneToOne: false }) })} />
        <label className={cn('mb-1.5 flex items-center gap-2 text-[11px]', !draft.scaleFix && 'opacity-45')}>
          <span className="w-28 shrink-0 text-[var(--mt5-muted)]">Fixed maximum</span>
          <input
            className={num}
            disabled={!draft.scaleFix}
            defaultValue={draft.fixedMaximum ?? ''}
            key={`max-${draft.scaleFix}`}
            onBlur={(e) => { const v = Number(e.target.value); set({ fixedMaximum: Number.isFinite(v) && e.target.value !== '' ? v : null }); }}
          />
        </label>
        <label className={cn('mb-1.5 flex items-center gap-2 text-[11px]', !draft.scaleFix && 'opacity-45')}>
          <span className="w-28 shrink-0 text-[var(--mt5-muted)]">Fixed minimum</span>
          <input
            className={num}
            disabled={!draft.scaleFix}
            defaultValue={draft.fixedMinimum ?? ''}
            key={`min-${draft.scaleFix}`}
            onBlur={(e) => { const v = Number(e.target.value); set({ fixedMinimum: Number.isFinite(v) && e.target.value !== '' ? v : null }); }}
          />
        </label>
        <Check
          label="Scale points per bar"
          on={draft.scalePointsPerBar}
          onToggle={(v) => set({ scalePointsPerBar: v })}
        />
        <label className={cn('flex items-center gap-2 text-[11px]', !draft.scalePointsPerBar && 'opacity-45')}>
          <span className="w-28 shrink-0 text-[var(--mt5-muted)]">Points per bar</span>
          {/* MetaTrader draws this one as a dropdown, not a spinner. */}
          <select
            className={cn(num, 'px-1')}
            disabled={!draft.scalePointsPerBar}
            value={draft.pointsPerBar}
            onChange={(e) => set({ pointsPerBar: Number(e.target.value) })}
          >
            {[0.25, 0.5, 1, 2, 4, 8, 16, 32].map((v) => (
              <option key={v} value={v}>{v.toFixed(2)}</option>
            ))}
          </select>
        </label>
        {draft.chartShift ? (
          <label className="mt-2 flex items-center gap-2 text-[11px]">
            <span className="w-28 shrink-0 text-[var(--mt5-muted)]">Shift</span>
            <input
              type="range"
              min={10}
              max={50}
              step={1}
              value={draft.shiftSize}
              onChange={(e) => set({ shiftSize: clampShift(Number(e.target.value)) })}
              className="min-w-0 flex-1 accent-[var(--mt5-blue)]"
            />
            <span className="w-8 shrink-0 text-right font-mono">{draft.shiftSize}%</span>
          </label>
        ) : null}
      </Group>
    </div>
  );
}

function ShowTab({ draft, set }: { draft: ChartProperties; set: Set }) {
  const tickBlocked = tickVolumesBlocked(draft);
  return (
    <div>
      {SHOW_ROWS.map((row) => {
        if (row.id === 'tickVolumes' || row.id === 'realVolumes') {
          const mode: VolumeMode = row.id === 'tickVolumes' ? 'tick' : 'real';
          const blocked = row.unavailable ?? (mode === 'tick' && tickBlocked
            ? 'MetaTrader disables tick volumes while the scale is fixed.'
            : undefined);
          return (
            <Check
              key={row.id}
              label={row.label}
              on={draft.volumes === mode}
              disabled={blocked !== undefined}
              title={blocked}
              // The two checkboxes are one tri-state property, so choosing one clears the other.
              onToggle={(v) => set({ volumes: v ? mode : 'hide' })}
            />
          );
        }
        const key = row.id as keyof ChartProperties;
        return (
          <Check
            key={row.id}
            label={row.label}
            on={draft[key] === true}
            disabled={row.unavailable !== undefined}
            title={row.unavailable}
            onToggle={(v) => set({ [key]: v } as Partial<ChartProperties>)}
          />
        );
      })}
      <p className="mt-3 text-[11px] leading-snug text-[var(--mt5-muted)]">
        Unticking the ticker also unticks OHLC, and ticking OHLC ticks the ticker, which is how
        MetaTrader couples them.
      </p>
    </div>
  );
}

/**
 * MetaTrader's colour control is a combobox showing a swatch and the colour's NAME, so these are the
 * sixteen web colours its picker is built from, under those names.
 */
const COLOURS: ReadonlyArray<{ hex: string; name: string }> = [
  { hex: '#ffffff', name: 'White' }, { hex: '#c0c0c0', name: 'Silver' },
  { hex: '#808080', name: 'Gray' }, { hex: '#000000', name: 'Black' },
  { hex: '#ff0000', name: 'Red' }, { hex: '#800000', name: 'Maroon' },
  { hex: '#ff4500', name: 'OrangeRed' }, { hex: '#808000', name: 'Olive' },
  { hex: '#00ff00', name: 'Lime' }, { hex: '#008000', name: 'Green' },
  { hex: '#00ffff', name: 'Aqua' }, { hex: '#008080', name: 'Teal' },
  { hex: '#0000ff', name: 'Blue' }, { hex: '#000080', name: 'Navy' },
  { hex: '#ffff00', name: 'Yellow' }, { hex: '#ff00ff', name: 'Magenta' },
];

function ColorsTab({ draft, set }: { draft: ChartProperties; set: Set }) {
  const pick = (id: ColourField, hex: string) =>
    set({ colours: { ...draft.colours, [id]: hex }, scheme: null });

  return (
    <div>
      <label className="mb-3 flex items-center gap-2 text-[11px]">
        <span className="w-24 shrink-0 text-right text-[var(--mt5-muted)]">Scheme:</span>
        <select
          className="h-8 min-w-0 flex-1 rounded-sm border border-[var(--mt5-border)] bg-[var(--mt5-surface)] px-1.5 text-[11px] text-[var(--mt5-text)] outline-none focus:border-[var(--mt5-blue)]"
          value={draft.scheme ?? ''}
          onChange={(e) => {
            const name = e.target.value as SchemeName;
            if (SCHEME_NAMES.includes(name)) set({ scheme: name, colours: { ...SCHEMES[name] } });
          }}
        >
          {/* A chart whose colours match no scheme shows none selected, as MetaTrader's does once
              a single field has been changed by hand. */}
          {draft.scheme === null ? <option value="">&mdash;</option> : null}
          {SCHEME_NAMES.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>

      {COLOUR_FIELDS.map((f) => (
        <label key={f.id} className="mb-1.5 flex items-center gap-2 text-[11px] last:mb-0" title={f.note}>
          <span className="w-24 shrink-0 text-right text-[var(--mt5-muted)]">{f.label}</span>
          <span
            aria-hidden
            className="h-4 w-5 shrink-0 rounded-[2px] border border-[var(--mt5-border)]"
            style={{ background: draft.colours[f.id] }}
          />
          <select
            aria-label={f.label.replace(':', '')}
            className="h-8 min-w-0 flex-1 rounded-sm border border-[var(--mt5-border)] bg-[var(--mt5-surface)] px-1.5 text-[11px] text-[var(--mt5-text)] outline-none focus:border-[var(--mt5-blue)]"
            value={draft.colours[f.id]}
            onChange={(e) => pick(f.id, e.target.value)}
          >
            {COLOURS.some((c) => c.hex === draft.colours[f.id])
              ? null
              : <option value={draft.colours[f.id]}>Custom</option>}
            {COLOURS.map((c) => <option key={c.hex} value={c.hex}>{c.name}</option>)}
          </select>
        </label>
      ))}
    </div>
  );
}
