'use client';

import { useEffect, useRef } from 'react';
import { objectNameOf, type Drawing } from '@/lib/chart/drawings';
import { cn } from '@/lib/cn';

/**
 * MetaTrader's right-click menu on a chart object.
 *
 * Eight items, in MetaTrader's order and under its own labels, each doing what its help says it
 * does:
 *
 *   Properties            open the properties of a selected object
 *   Object List           open the Object List to manage objects on the chart
 *   Delete                delete the selected object
 *   Delete All Arrows     delete all arrows belonging to the Arrows group
 *   Delete All Selected   delete all selected objects
 *   Unselect All          unselect all objects on the chart
 *   Unselect              unselect the selected object
 *   Undo Delete           restore the last deleted object
 *
 * MetaTrader greys nothing here, but it also has a multi-selection where this chart has one
 * selected object at a time: "Delete All Selected" and "Unselect All" therefore act on that one,
 * and an item with nothing to act on is disabled rather than silently doing nothing.
 *
 * Source: docs/mt5/07-objects-list-and-properties.md, from
 * https://www.metatrader5.com/en/terminal/help/charts_analysis/objects
 */

export interface ObjectMenuAt { x: number; y: number; id: string }

export function MT5ObjectMenu({
  at, drawing, arrowCount, canUndo, onProperties, onObjectList, onDelete, onDeleteAllArrows,
  onUnselect, onUndoDelete, onDismiss,
}: {
  at: ObjectMenuAt;
  drawing: Drawing | null;
  /** How many objects of MetaTrader's Arrows group are on the chart. */
  arrowCount: number;
  canUndo: boolean;
  onProperties: () => void;
  onObjectList: () => void;
  onDelete: () => void;
  onDeleteAllArrows: () => void;
  onUnselect: () => void;
  onUndoDelete: () => void;
  onDismiss: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) onDismiss(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [onDismiss]);

  const run = (fn: () => void) => () => { fn(); onDismiss(); };
  const has = drawing !== null;

  return (
    <div
      ref={box}
      role="menu"
      aria-label={drawing ? objectNameOf(drawing) : 'Object'}
      className="fixed z-[90] min-w-44 rounded-sm border border-[var(--mt5-border)] bg-[var(--mt5-raised)] py-1 text-[11px] shadow-xl"
      style={{ left: at.x, top: at.y }}
    >
      <Item label="Properties" disabled={!has} onClick={run(onProperties)} />
      <Item label="Object List" onClick={run(onObjectList)} />
      <Item label="Delete" disabled={!has} onClick={run(onDelete)} />
      <Item label="Delete All Arrows" disabled={arrowCount === 0} onClick={run(onDeleteAllArrows)} />
      <Item label="Delete All Selected" disabled={!has} onClick={run(onDelete)} />
      <Item label="Unselect All" disabled={!has} onClick={run(onUnselect)} />
      <Item label="Unselect" disabled={!has} onClick={run(onUnselect)} />
      <Item label="Undo Delete" disabled={!canUndo} onClick={run(onUndoDelete)} />
    </div>
  );
}

function Item({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'block w-full px-3 py-1.5 text-left transition',
        disabled ? 'cursor-not-allowed text-[#4a5666]' : 'text-white hover:bg-[var(--mt5-blue)]',
      )}
    >
      {label}
    </button>
  );
}
