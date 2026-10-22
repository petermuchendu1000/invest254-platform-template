'use client';

import { useEffect, useMemo, useState } from 'react';
import { objectNameOf, shownOn, type Drawing } from '@/lib/chart/drawings';
import { objectToken } from '@/lib/chart/objects';
import { cn } from '@/lib/cn';

/**
 * MetaTrader's Objects List (Ctrl+B), to its own screenshots rather than to its prose.
 *
 * The title is not the words "Objects List". MetaQuotes' own screenshot of the window reads
 * `Objects on EURUSD,M1 (2)`, so the pattern is `Objects on <SYMBOL>,<TIMEFRAME> (<count>)` and
 * that is what this builds. (The help calls the same window three other things: "Objects List" in
 * the hot-keys table, "Object List" in the context menu, and "the Objects window" in prose. All
 * four are MetaQuotes'.)
 *
 * Four columns, in MetaTrader's order:
 *
 *   Object       a CHECKBOX plus the type name as text, no icon. MetaQuotes: "Tick the 'Object'
 *                field to select the object on the chart" — so the tick is not the dialog's row
 *                selection, it selects the object out on the chart, and that is what it does here.
 *   Name         the object's unique name, "<TF> <Object type> <ID>".
 *   Description  `OBJPROP_TEXT`, empty until the trader sets one.
 *   Window       the window NUMBER. "0 is the main chart window, further numbers mean serial
 *                numbers of indicator sub-windows from the top down." It is an integer, never the
 *                words "Main chart". Every object here is on the price pane, so every row reads 0.
 *
 * Five buttons: Show, Properties, Delete, List all, and Close pinned bottom right. The three
 * row-scoped ones are greyed with no row focused, as MetaTrader greys them.
 *
 * "List all" is a BUTTON, not a checkbox, and it does NOT widen the list to other charts: it
 * un-filters objects marked `OBJPROP_HIDDEN`, which MQL5 programs set to keep their own service
 * objects out of the list. Nothing here is an MQL5 program, so no object carries that property.
 * The nearest true equivalent this platform HAS is an object the trader has hidden on the current
 * period from the Visualization tab, so that is what the list filters and what "List all" reveals.
 * That mapping is an adaptation and is called out here rather than passed off as MetaTrader's.
 *
 * Source: docs/mt5/07-objects-list-and-properties.md, from
 * https://www.metatrader5.com/en/terminal/help/charts_advanced/charts_objects_list
 */

export function MT5ObjectsList({
  drawings, symbol, timeframe, selected, onSelect, onShow, onProperties, onDelete, onDismiss,
}: {
  drawings: readonly Drawing[];
  symbol: string;
  timeframe: string;
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** Move the chart to the object, which is what MetaTrader's Show does. */
  onShow: (id: string) => void;
  onProperties: (id: string) => void;
  onDelete: (id: string) => void;
  onDismiss: () => void;
}) {
  /** The focused row. MetaTrader's three row-scoped buttons are greyed until there is one. */
  const [focused, setFocused] = useState<string | null>(selected);
  /** MetaTrader's "List all": show the objects the list is filtering out. */
  const [listAll, setListAll] = useState(false);
  useEffect(() => { setFocused(selected); }, [selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  const hidden = useMemo(() => drawings.filter((d) => !shownOn(d, timeframe)).length, [drawings, timeframe]);
  const rows = useMemo(() => drawings
    .filter((d) => listAll || shownOn(d, timeframe))
    .map((d) => ({
      id: d.id,
      object: objectToken(d.kind),
      name: objectNameOf(d),
      description: d.label ?? '',
      hidden: !shownOn(d, timeframe),
    })), [drawings, timeframe, listAll]);

  const act = (fn: (id: string) => void) => { if (focused) fn(focused); };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Objects on ${symbol},${timeframe}`}
      className="fixed inset-0 z-[80] flex flex-col bg-[var(--mt5-surface)] text-[var(--mt5-text)] sm:items-center sm:justify-center sm:bg-black/60 sm:p-4"
    >
      <div className="flex min-h-0 w-full flex-1 flex-col bg-[var(--mt5-surface)] sm:h-[70vh] sm:max-w-[600px] sm:flex-none sm:rounded-sm sm:border sm:border-[var(--mt5-border)]">
        <div className="flex items-center gap-2 border-b border-[var(--mt5-border)] px-3 py-2.5">
          <span className="flex-1 truncate text-[15px] font-semibold leading-tight">
            Objects on {symbol},{timeframe} ({rows.length})
          </span>
          <button type="button" onClick={onDismiss} aria-label="Close" className="shrink-0 px-1 text-[18px] leading-none text-[var(--mt5-muted)] transition hover:text-white">×</button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <table className="w-full table-fixed border-collapse text-[11px]">
            <thead className="sticky top-0 bg-[var(--mt5-raised)] text-[var(--mt5-muted)]">
              <tr>
                <th scope="col" className="w-[32%] border-b border-[var(--mt5-border)] px-2 py-1.5 text-left font-semibold">Object</th>
                <th scope="col" className="w-[32%] border-b border-[var(--mt5-border)] px-2 py-1.5 text-left font-semibold">Name</th>
                <th scope="col" className="w-[26%] border-b border-[var(--mt5-border)] px-2 py-1.5 text-left font-semibold">Description</th>
                <th scope="col" className="w-[10%] border-b border-[var(--mt5-border)] px-2 py-1.5 text-left font-semibold">Window</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-2 py-6 text-center text-[var(--mt5-muted)]">
                    {hidden > 0 ? `No objects shown on ${timeframe}. Click "List all".` : 'No objects on this chart.'}
                  </td>
                </tr>
              ) : rows.map((r, i) => (
                <tr
                  key={r.id}
                  aria-selected={focused === r.id}
                  onClick={() => setFocused(r.id)}
                  className={cn(
                    'cursor-pointer border-b border-[var(--mt5-border)]',
                    focused === r.id ? 'bg-[var(--mt5-blue)]/25' : i % 2 === 1 ? 'bg-white/[0.02]' : '',
                  )}
                >
                  <td className="truncate px-2 py-1.5">
                    <label className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${r.name} on the chart`}
                        checked={selected === r.id}
                        onChange={(e) => { setFocused(r.id); onSelect(e.target.checked ? r.id : null); }}
                        className="h-3 w-3 shrink-0 accent-[var(--mt5-blue)]"
                      />
                      <span className="truncate">{r.object}</span>
                    </label>
                  </td>
                  <td className="truncate px-2 py-1.5 font-mono text-[var(--mt5-muted)]">{r.name}</td>
                  <td className="truncate px-2 py-1.5">{r.description}</td>
                  <td className="truncate px-2 py-1.5 text-[var(--mt5-muted)]">0</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-[var(--mt5-border)] px-3 py-2.5">
          <Btn label="Show" disabled={!focused} onClick={() => act(onShow)} />
          <Btn label="Properties" disabled={!focused} onClick={() => act(onProperties)} />
          <Btn label="Delete" disabled={!focused} onClick={() => act((id) => { onDelete(id); setFocused(null); })} />
          {/* Separated from the three row-scoped buttons by a gap, as MetaTrader separates it. */}
          <span className="w-3" />
          <Btn
            label="List all"
            pressed={listAll}
            disabled={hidden === 0 && !listAll}
            title={hidden === 0
              ? 'Every object on this chart is already listed. MetaTrader uses this to reveal objects an Expert Advisor marked hidden; nothing here is hidden.'
              : `${hidden} object${hidden === 1 ? '' : 's'} not shown on ${timeframe}`}
            onClick={() => setListAll((v) => !v)}
          />
          <Btn label="Close" onClick={onDismiss} />
        </div>
      </div>
    </div>
  );
}

function Btn({ label, disabled, onClick, title, pressed }: {
  label: string; disabled?: boolean; onClick: () => void; title?: string; pressed?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
      className={cn(
        'h-8 flex-1 rounded-sm border px-1 text-[11px] font-semibold transition',
        disabled
          ? 'cursor-not-allowed border-[var(--mt5-border)] bg-[var(--mt5-raised)] text-[var(--mt5-border)]'
          : pressed
            ? 'border-[var(--mt5-blue)] bg-[var(--mt5-blue)]/20 text-white'
            : 'border-[var(--mt5-border)] bg-[var(--mt5-raised)] text-[var(--mt5-text)] hover:border-[var(--mt5-blue)] hover:bg-[var(--mt5-border)]',
      )}
    >
      {label}
    </button>
  );
}
