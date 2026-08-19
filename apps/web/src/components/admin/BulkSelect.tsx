'use client';

import * as React from 'react';
import { Button } from '@/components/ui/Button';

/**
 * Row-selection primitive shared by the admin tables (withdrawals / transactions / affiliates /
 * marketers). Tracks a Set of selected ids, auto-prunes ids that leave the current row set (filter
 * change / refetch), and exposes select-all / indeterminate helpers.
 */
export function useRowSelection<T>(rows: T[], getId: (r: T) => string) {
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  const idKey = rows.map(getId).join(',');
  React.useEffect(() => {
    const present = new Set(rows.map(getId));
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => present.has(id)));
      return next.size === prev.size ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idKey]);

  const toggle = React.useCallback((id: string) => {
    setSelected((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }, []);
  const clear = React.useCallback(() => setSelected(new Set()), []);
  const setAll = React.useCallback((on: boolean) => setSelected(on ? new Set(rows.map(getId)) : new Set()), [idKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const setMany = React.useCallback((ids: string[], on: boolean) => {
    setSelected((p) => {
      const n = new Set(p);
      for (const id of ids) { if (on) n.add(id); else n.delete(id); }
      return n;
    });
  }, []);

  const selectedRows = rows.filter((r) => selected.has(getId(r)));
  return {
    selected,
    count: selected.size,
    isSelected: (id: string) => selected.has(id),
    toggle,
    clear,
    setAll,
    setMany,
    selectedRows,
    allSelected: rows.length > 0 && selected.size === rows.length,
    someSelected: selected.size > 0 && selected.size < rows.length,
  };
}

const CB = 'h-4 w-4 cursor-pointer rounded border-border text-accent accent-accent focus:ring-accent';

export function RowCheckbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      onClick={(e) => e.stopPropagation()}
      aria-label={label ?? 'Select row'}
      className={CB}
    />
  );
}

export function SelectAllCheckbox({ allSelected, someSelected, onChange }: { allSelected: boolean; someSelected: boolean; onChange: (v: boolean) => void }) {
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (ref.current) ref.current.indeterminate = someSelected && !allSelected;
  }, [someSelected, allSelected]);
  return (
    <input ref={ref} type="checkbox" checked={allSelected} onChange={(e) => onChange(e.target.checked)} aria-label="Select all rows" className={CB} />
  );
}

/**
 * Sticky bottom action bar shown while rows are selected. `summary` renders selection insight
 * (counts, totals); `children` are the action buttons. Hidden when nothing is selected.
 */
export function BulkBar({ count, onClear, summary, children }: { count: number; onClear: () => void; summary?: React.ReactNode; children: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <div className="sticky bottom-3 z-30 mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-accent/40 bg-surface/95 px-4 py-3 shadow-lg backdrop-blur">
      <span className="text-sm font-semibold text-fg">{count} selected</span>
      {summary ? <span className="text-xs text-muted">{summary}</span> : null}
      <span className="ml-auto flex flex-wrap items-center gap-2">
        {children}
        <Button size="sm" variant="ghost" onClick={onClear}>Clear</Button>
      </span>
    </div>
  );
}

/** Trigger a client-side CSV download from an array of flat row objects. */
export function downloadCsv(filename: string, rows: Record<string, unknown>[]): void {
  if (rows.length === 0) return;
  const cols = Object.keys(rows[0]!);
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Copy text to the clipboard (best-effort; silent on failure). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
