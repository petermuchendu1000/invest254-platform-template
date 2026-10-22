'use client';

import { useEffect, useMemo, useState } from 'react';
import { TIMEFRAME_KEYS } from '@invest254/shared/candles';
import {
  LINE_STYLES, defaultLevelsOf, gannPipsPerBar, objectNameOf,
  type Drawing, type LineStyle, type ObjectLevel,
} from '@/lib/chart/drawings';
import {
  anchorFields, hasFill, hasGannAngle, hasGannScale, hasLevels, hasRays, objectTypeName,
} from '@/lib/chart/objects';
import { cn } from '@/lib/cn';

/**
 * MetaTrader's Object Properties dialog, reached from the Objects List's Properties button and from
 * a double click on the object.
 *
 * Built from MetaQuotes' own screenshots, which correct its prose in four places. See
 * docs/mt5/07-objects-list-and-properties.md for the sources and the contradictions.
 *
 *   TITLE        the object's NAME, alone: "M1 Gann Line 40253". No "Properties" word, no symbol.
 *   TABS         Common, Levels, Parameters, Visualization. Levels is SECOND, and appears only on
 *                the Fibonacci tools and Andrews' Pitchfork: "The 'Levels' tab is specifically used
 *                only for Fibonacci tools and Andrews' Pitchfork." Most objects show three tabs.
 *   BUTTONS      OK and Cancel. There is no Apply and no Delete; deleting is the Objects List's
 *                job and the chart context menu's.
 *
 * Every field label is the screenshot's, including its trailing colon and its sentence case. The
 * help prose writes "Ray Right" and "Pips Per Bar" in title case and the dialog does not.
 */

type Tab = 'common' | 'levels' | 'parameters' | 'visualization';

/**
 * MetaTrader's colour dropdown shows a swatch and the colour's NAME ("Red", "Black"), not a hex
 * code. These are the web colours MetaTrader's picker is built from, under its own names, mapped to
 * this terminal's palette where the two meet.
 */
const COLOURS: ReadonlyArray<{ hex: string; name: string }> = [
  { hex: '#ffffff', name: 'White' },
  { hex: '#c0c0c0', name: 'Silver' },
  { hex: '#808080', name: 'Gray' },
  { hex: '#000000', name: 'Black' },
  { hex: '#f23645', name: 'Red' },
  { hex: '#800000', name: 'Maroon' },
  { hex: '#ff9300', name: 'Orange' },
  { hex: '#808000', name: 'Olive' },
  { hex: '#41be56', name: 'Lime' },
  { hex: '#008000', name: 'Green' },
  { hex: '#00ffff', name: 'Aqua' },
  { hex: '#008080', name: 'Teal' },
  { hex: '#3183ff', name: 'Blue' },
  { hex: '#000080', name: 'Navy' },
  { hex: '#ff00ff', name: 'Magenta' },
  { hex: '#800080', name: 'Purple' },
];

export function MT5ObjectProperties({
  drawing, digits, barSeconds, onChange, onDismiss,
}: {
  drawing: Drawing;
  digits: number;
  /** The chart's bar length, so the Gann objects' `Pips per bar:` reads in bars. */
  barSeconds: number;
  onChange: (next: Drawing) => void;
  onDismiss: () => void;
}) {
  const [tab, setTab] = useState<Tab>('common');
  // MetaTrader's dialog is modal and buffered: OK applies, Cancel leaves the object alone.
  const [draft, setDraft] = useState<Drawing>(drawing);
  useEffect(() => { setDraft(drawing); setTab('common'); }, [drawing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  const levelled = hasLevels(draft.kind);
  const tabs = useMemo(() => ([
    { id: 'common' as Tab, label: 'Common' },
    // Levels sits between Common and Parameters, which is MetaTrader's order and not the one its
    // prose implies.
    ...(levelled ? [{ id: 'levels' as Tab, label: 'Levels' }] : []),
    { id: 'parameters' as Tab, label: 'Parameters' },
    { id: 'visualization' as Tab, label: 'Visualization' },
  ]), [levelled]);

  const set = <K extends keyof Drawing>(k: K, v: Drawing[K]) => setDraft((d) => ({ ...d, [k]: v }));

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={objectNameOf(drawing)}
      className="fixed inset-0 z-[85] flex flex-col bg-[var(--mt5-surface)] text-[var(--mt5-text)] sm:items-center sm:justify-center sm:bg-black/60 sm:p-4"
    >
      <div className="flex min-h-0 w-full flex-1 flex-col bg-[var(--mt5-surface)] sm:h-[72vh] sm:max-w-[460px] sm:flex-none sm:rounded-sm sm:border sm:border-[var(--mt5-border)]">
        {/* MetaTrader's title bar carries the object's NAME and nothing else. The type is shown
            underneath because a name alone ("M1 Fibo 26637") does not say what it is on a phone. */}
        <div className="flex items-center gap-2 border-b border-[var(--mt5-border)] px-3 py-2.5">
          <span className="min-w-0 flex-1">
            <span className="block truncate font-mono text-[14px] font-semibold leading-tight">{objectNameOf(drawing)}</span>
            <span className="block truncate text-[11px] text-[var(--mt5-muted)]">{objectTypeName(drawing.kind)}</span>
          </span>
          <button type="button" onClick={onDismiss} aria-label="Close" className="shrink-0 px-1 text-[18px] leading-none text-[var(--mt5-muted)] transition hover:text-white">×</button>
        </div>

        <div role="tablist" aria-label="Object properties" className="flex shrink-0 border-b border-[var(--mt5-border)]">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'flex-1 px-2 py-2 text-[11px] font-semibold transition',
                tab === t.id ? 'border-b-2 border-[var(--mt5-blue)] text-white' : 'text-[var(--mt5-muted)] hover:text-white',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {tab === 'common' ? <CommonTab draft={draft} set={set} /> : null}
          {tab === 'levels' && levelled ? <LevelsTab draft={draft} set={set} /> : null}
          {tab === 'parameters' ? <ParametersTab draft={draft} digits={digits} barSeconds={barSeconds} setDraft={setDraft} set={set} /> : null}
          {tab === 'visualization' ? <VisualizationTab draft={draft} set={set} /> : null}
        </div>

        {/* OK and Cancel, and nothing else: MetaTrader has no Apply here and no Delete. */}
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
        </div>
      </div>
    </div>
  );
}

type Setter = <K extends keyof Drawing>(k: K, v: Drawing[K]) => void;

const input = 'h-8 min-w-0 flex-1 rounded-sm border border-[var(--mt5-border)] bg-[var(--mt5-surface)] px-2 font-mono text-[11px] text-[var(--mt5-text)] outline-none focus:border-[var(--mt5-blue)]';
const select = 'h-8 min-w-0 rounded-sm border border-[var(--mt5-border)] bg-[var(--mt5-surface)] px-1.5 text-[11px] text-[var(--mt5-text)] outline-none focus:border-[var(--mt5-blue)]';

/** A labelled row. MetaTrader right-aligns the label to the left of its control, with a colon. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mb-2 flex items-center gap-2 last:mb-0">
      <span className="w-24 shrink-0 text-right text-[11px] text-[var(--mt5-muted)]">{label}</span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">{children}</span>
    </label>
  );
}

/** A checkbox. MetaTrader's carry no colon. */
function Check({ label, on, onToggle }: { label: string; on: boolean; onToggle: (v: boolean) => void }) {
  return (
    <label className="mb-2 flex items-center gap-2 text-[11px] last:mb-0">
      <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} className="h-3.5 w-3.5 accent-[var(--mt5-blue)]" />
      <span>{label}</span>
    </label>
  );
}

/**
 * MetaTrader's `Style:` field: one label, three controls. Used on the Common tab for the object and
 * again under the Levels grid for its levels, which is how MetaTrader reuses it.
 */
function StyleField({ color, style, width, onColor, onStyle, onWidth }: {
  color: string;
  style: LineStyle | undefined;
  width: number | undefined;
  onColor: (v: string) => void;
  onStyle: (v: LineStyle) => void;
  onWidth: (v: number) => void;
}) {
  const known = COLOURS.some((c) => c.hex === color);
  return (
    <Row label="Style:">
      <select aria-label="Colour" className={select} value={color} onChange={(e) => onColor(e.target.value)}>
        {/* MetaTrader's picker is the named web colours plus a Custom entry; a colour outside the
            palette shows as Custom rather than as a hex code the dialog would never print. */}
        {known ? null : <option value={color}>Custom</option>}
        {COLOURS.map((c) => <option key={c.hex} value={c.hex}>{c.name}</option>)}
      </select>
      <select aria-label="Line style" className={select} value={style ?? 'solid'} onChange={(e) => onStyle(e.target.value as LineStyle)}>
        {LINE_STYLES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
      </select>
      <select aria-label="Line width" className={select} value={width ?? 1} onChange={(e) => onWidth(Number(e.target.value))}>
        {[1, 2, 3, 4, 5].map((w) => <option key={w} value={w}>{w}</option>)}
      </select>
    </Row>
  );
}

function CommonTab({ draft, set }: { draft: Drawing; set: Setter }) {
  return (
    <div>
      <Row label="Name:">
        <input className={input} value={objectNameOf(draft)} onChange={(e) => set('name', e.target.value)} />
      </Row>
      <Row label="Description:">
        <input className={input} value={draft.label ?? ''} onChange={(e) => set('label', e.target.value)} />
      </Row>
      <StyleField
        color={draft.color}
        style={draft.style}
        width={draft.width}
        onColor={(v) => set('color', v)}
        onStyle={(v) => set('style', v)}
        onWidth={(v) => set('width', v)}
      />
      <div className="mt-3 border-t border-[var(--mt5-border)] pt-3">
        <Check label="Draw object as background" on={draft.back === true} onToggle={(v) => set('back', v)} />
        {/* MetaTrader words this as the negative and stores the positive (`OBJPROP_SELECTABLE`). */}
        <Check label="Disable selection" on={draft.selectable === false} onToggle={(v) => set('selectable', !v)} />
      </div>
    </div>
  );
}

/** MetaTrader writes an anchor's time as `YYYY.MM.DD HH:MM:SS`, and that is what this parses back. */
function fmtTime(seconds: number): string {
  const d = new Date(seconds * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function parseTime(text: string, fallback: number): number {
  const m = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text.trim());
  if (!m) return fallback;
  const t = new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    m[4] ? Number(m[4]) : 0, m[5] ? Number(m[5]) : 0, m[6] ? Number(m[6]) : 0,
  ).getTime();
  return Number.isFinite(t) ? Math.round(t / 1000) : fallback;
}

function ParametersTab({ draft, digits, barSeconds, setDraft, set }: {
  draft: Drawing; digits: number; barSeconds: number;
  setDraft: (f: (d: Drawing) => Drawing) => void; set: Setter;
}) {
  const edit = (i: number, patch: { time?: number; price?: number }) =>
    setDraft((d) => ({ ...d, points: d.points.map((pt, j) => (j === i ? { ...pt, ...patch } : pt)) }));

  return (
    <div>
      {draft.points.map((pt, i) => {
        const fields = anchorFields(draft.kind, i);
        return (
          <div key={i} className="mb-3 last:mb-0">
            {fields.date ? (
              <Row label="Date:">
                <input
                  className={input}
                  defaultValue={fmtTime(pt.time)}
                  onBlur={(e) => edit(i, { time: parseTime(e.target.value, pt.time) })}
                />
              </Row>
            ) : null}
            {fields.value ? (
              <Row label="Value:">
                <input
                  className={input}
                  defaultValue={pt.price.toFixed(digits)}
                  onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) edit(i, { price: v }); }}
                />
              </Row>
            ) : null}
          </div>
        );
      })}
      {draft.points.length === 0 ? <p className="text-[11px] text-[var(--mt5-muted)]">This object has no anchors.</p> : null}

      {hasGannAngle(draft.kind) ? (
        <Row label="Gann angle:">
          <input
            className={input}
            defaultValue={(draft.gannAngle ?? 7.76).toString()}
            onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) set('gannAngle', v); }}
          />
        </Row>
      ) : null}
      {hasGannScale(draft.kind) ? (
        /* MetaTrader shows 4.000000 on a Fan and 1.000000 on a Line. Unset, this shows the slope
           the object was actually DRAWN at rather than a number the chart is not using. */
        <Row label="Pips per bar:">
          <input
            className={input}
            defaultValue={(gannPipsPerBar(draft, barSeconds, digits) ?? 1).toFixed(6)}
            onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v > 0) set('pipsPerBar', v); }}
          />
        </Row>
      ) : null}

      {hasGannScale(draft.kind) && draft.kind !== 'gannLine' ? (
        <div className="mt-3 border-t border-[var(--mt5-border)] pt-3">
          <Check label="Downtrend" on={draft.downtrend === true} onToggle={(v) => set('downtrend', v)} />
        </div>
      ) : null}
      {hasFill(draft.kind) ? (
        <div className="mt-3 border-t border-[var(--mt5-border)] pt-3">
          <Check label="Fill" on={draft.fill === true} onToggle={(v) => set('fill', v)} />
        </div>
      ) : null}
      {hasRays(draft.kind) ? (
        <div className="mt-3 border-t border-[var(--mt5-border)] pt-3">
          {/* Ray right comes first in MetaTrader's dialog. Neither starts ticked: MetaQuotes does
              not document the defaults, so an untouched object is the segment it was drawn as. */}
          <Check label="Ray right" on={draft.rayRight === true} onToggle={(v) => set('rayRight', v)} />
          <Check label="Ray left" on={draft.rayLeft === true} onToggle={(v) => set('rayLeft', v)} />
        </div>
      ) : null}
    </div>
  );
}

function LevelsTab({ draft, set }: { draft: Drawing; set: Setter }) {
  const levels = draft.levels ?? defaultLevelsOf(draft.kind);
  const [row, setRow] = useState<number | null>(null);
  const write = (next: ObjectLevel[]) => set('levels', next);
  return (
    <div>
      <div className="mb-1 flex gap-1.5 border-b border-[var(--mt5-border)] pb-1 text-[9px] font-semibold uppercase tracking-wider text-[var(--mt5-muted)]">
        <span className="w-20">Level</span>
        <span className="flex-1">Description</span>
      </div>
      <div className="max-h-44 overflow-y-auto">
        {levels.map((l, i) => (
          <div
            key={i}
            onClick={() => setRow(i)}
            className={cn('flex cursor-pointer items-center gap-1.5 border-b border-[var(--mt5-border)] py-1', row === i ? 'bg-[var(--mt5-blue)]/25' : '')}
          >
            {/* MetaTrader prefixes each Level cell with a small glyph of that level's line. */}
            <span aria-hidden className="ml-0.5 h-0 w-3 shrink-0 border-t" style={{ borderColor: l.color ?? draft.color }} />
            <span className="w-16 shrink-0 font-mono text-[11px]">{l.value}</span>
            <span className="min-w-0 flex-1 truncate text-[11px]">{l.text}</span>
          </div>
        ))}
      </div>

      {/* The same three-control Style field as the Common tab, below the grid rather than in it. */}
      <div className="mt-3 border-t border-[var(--mt5-border)] pt-3">
        <StyleField
          color={(row !== null ? levels[row]?.color : undefined) ?? draft.color}
          style={draft.style}
          width={draft.width}
          onColor={(v) => { if (row !== null) write(levels.map((x, j) => (j === row ? { ...x, color: v } : x))); }}
          onStyle={(v) => set('style', v)}
          onWidth={(v) => set('width', v)}
        />
      </div>

      <div className="mt-2 flex items-center gap-2">
        <LvlBtn label="Add" onClick={() => { write([...levels, { value: 0.5, text: '50.0' }]); setRow(levels.length); }} />
        <LvlBtn
          label="Delete"
          disabled={row === null}
          onClick={() => { if (row !== null) { write(levels.filter((_, j) => j !== row)); setRow(null); } }}
        />
        <LvlBtn
          label="Edit"
          disabled={row === null}
          onClick={() => {
            if (row === null) return;
            const l = levels[row];
            if (!l) return;
            const value = window.prompt('Level', String(l.value));
            if (value === null) return;
            const text = window.prompt('Description', l.text);
            if (text === null) return;
            const n = Number(value);
            write(levels.map((x, j) => (j === row ? { ...x, value: Number.isFinite(n) ? n : x.value, text } : x)));
          }}
        />
        {/* Separated from Delete/Edit by a gap, as MetaTrader separates it. */}
        <span className="w-3" />
        <LvlBtn label="Default" onClick={() => { write([...defaultLevelsOf(draft.kind)]); setRow(null); }} />
      </div>

      <p className="mt-3 text-[11px] leading-snug text-[var(--mt5-muted)]">
        A Fibonacci Retracement or Expansion shows a level&rsquo;s price when its description
        contains <span className="font-mono">%$</span>.
      </p>
    </div>
  );
}

function LvlBtn({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'h-8 flex-1 rounded-sm border text-[11px] font-semibold transition',
        disabled
          ? 'cursor-not-allowed border-[var(--mt5-border)] bg-[var(--mt5-raised)] text-[var(--mt5-border)]'
          : 'border-[var(--mt5-border)] bg-[var(--mt5-raised)] text-[var(--mt5-text)] hover:border-[var(--mt5-blue)] hover:bg-[var(--mt5-border)]',
      )}
    >
      {label}
    </button>
  );
}

/**
 * MetaTrader's Visualization tab: an "All timeframes" checkbox above a five-node TREE, not a flat
 * grid of 21 checkboxes.
 *
 * Minutes and Hours expand; Day, Week and Month are leaves. MetaTrader draws the tree's checkboxes
 * tri-state with two glyphs, a green tick for on and a red cross for off, and that is reproduced
 * here. There are no Select all / Clear all buttons: the tab's only buttons are the dialog's own.
 *
 * The English words Minutes / Hours / Day / Week / Month come from MetaQuotes' RUSSIAN screenshot;
 * its English asset for this tab is the wrong image (it serves the Levels screenshot). They are
 * recorded as needing confirmation against a live English terminal in
 * docs/mt5/07-objects-list-and-properties.md.
 */
const TREE: ReadonlyArray<{ label: string; periods: readonly string[]; expandable: boolean }> = [
  { label: 'Minutes', periods: ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M10', 'M12', 'M15', 'M20', 'M30'], expandable: true },
  { label: 'Hours', periods: ['H1', 'H2', 'H3', 'H4', 'H6', 'H8', 'H12'], expandable: true },
  { label: 'Day', periods: ['D1'], expandable: false },
  { label: 'Week', periods: ['W1'], expandable: false },
  { label: 'Month', periods: ['MN1'], expandable: false },
];

function TriState({ state }: { state: 'on' | 'off' | 'some' }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[2px] border text-[9px] font-black leading-none',
        state === 'on' ? 'border-[var(--mt5-green)] text-[var(--mt5-green)]'
          : state === 'off' ? 'border-[var(--mt5-red)] text-[var(--mt5-red)]'
            : 'border-[var(--mt5-muted)] text-[var(--mt5-muted)]',
      )}
    >
      {state === 'on' ? '✓' : state === 'off' ? '✕' : '–'}
    </span>
  );
}

function VisualizationTab({ draft, set }: { draft: Drawing; set: Setter }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const all = draft.timeframes === undefined;
  const on = (k: string) => all || (draft.timeframes ?? []).includes(k);
  const current = (): string[] => (draft.timeframes === undefined ? [...TIMEFRAME_KEYS] : [...draft.timeframes]);
  const apply = (next: string[]) =>
    set('timeframes', next.length === TIMEFRAME_KEYS.length ? undefined : next);

  const toggleOne = (k: string) => {
    const base = current();
    apply(base.includes(k) ? base.filter((x) => x !== k) : [...base, k]);
  };
  const toggleGroup = (periods: readonly string[]) => {
    const base = current();
    const every = periods.every((p) => base.includes(p));
    apply(every ? base.filter((x) => !periods.includes(x)) : [...new Set([...base, ...periods])]);
  };
  const groupState = (periods: readonly string[]): 'on' | 'off' | 'some' => {
    const n = periods.filter((p) => on(p)).length;
    return n === periods.length ? 'on' : n === 0 ? 'off' : 'some';
  };

  return (
    <div>
      <Check label="All timeframes" on={all} onToggle={(v) => set('timeframes', v ? undefined : [])} />
      <div className="mt-2 rounded-sm border border-[var(--mt5-border)] p-1.5">
        {TREE.map((node) => (
          <div key={node.label}>
            <div className="flex items-center gap-1.5 py-0.5">
              {node.expandable ? (
                <button
                  type="button"
                  aria-label={`${open[node.label] ? 'Collapse' : 'Expand'} ${node.label}`}
                  aria-expanded={open[node.label] === true}
                  onClick={() => setOpen((o) => ({ ...o, [node.label]: !o[node.label] }))}
                  className="grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[2px] border border-[var(--mt5-border)] text-[9px] leading-none text-[var(--mt5-muted)] hover:text-white"
                >
                  {open[node.label] ? '−' : '+'}
                </button>
              ) : <span className="w-3.5 shrink-0" />}
              <button
                type="button"
                aria-pressed={groupState(node.periods) === 'on'}
                onClick={() => toggleGroup(node.periods)}
                className="flex min-w-0 items-center gap-1.5 text-[11px] text-white"
              >
                <TriState state={groupState(node.periods)} />
                <span className="truncate">{node.label}</span>
              </button>
            </div>
            {node.expandable && open[node.label] ? (
              <div className="ml-5 grid grid-cols-4 gap-1 py-1">
                {node.periods.map((p) => (
                  <button
                    key={p}
                    type="button"
                    aria-pressed={on(p)}
                    onClick={() => toggleOne(p)}
                    className="flex items-center gap-1 text-[10px] text-white"
                  >
                    <TriState state={on(p) ? 'on' : 'off'} />
                    <span>{p}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11px] leading-snug text-[var(--mt5-muted)]">
        The object is drawn only on the ticked periods, so it can carry different settings on
        different periods.
      </p>
    </div>
  );
}
