'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { usePlatformSites } from '@/lib/platform/hooks';
import type { SiteWithConfig } from '@/lib/platform/endpoints';

interface Cmd { id: string; label: string; hint?: string; group: string; run: () => void }

/**
 * ⌘K / Ctrl-K command palette for the operator console: jump to any brand or run a top action in
 * two keystrokes. Keyboard-first (↑/↓ to move, ↵ to run, Esc to close), filtered live.
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const sites = usePlatformSites();
  const [q, setQ] = React.useState('');
  const [active, setActive] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (open) { setQ(''); setActive(0); setTimeout(() => inputRef.current?.focus(), 0); }
  }, [open]);

  const go = React.useCallback((href: string) => { onClose(); router.push(href); }, [onClose, router]);

  const commands = React.useMemo<Cmd[]>(() => {
    const brands = (sites.data?.sites ?? []) as SiteWithConfig[];
    const actions: Cmd[] = [
      { id: 'overview', label: 'Overview', hint: 'All brands', group: 'Go to', run: () => go('/platform') },
      { id: 'onboard', label: 'Onboard a client', hint: 'New brand', group: 'Actions', run: () => go('/platform/onboard') },
    ];
    const brandCmds: Cmd[] = brands.map((s) => ({
      id: `brand-${s.siteId}`,
      label: s.name,
      hint: `${s.slug}${s.primaryDomain ? ` · ${s.primaryDomain}` : ''}`,
      group: 'Clients',
      run: () => go(`/platform/clients/${s.siteId}`),
    }));
    return [...actions, ...brandCmds];
  }, [sites.data, go]);

  const filtered = React.useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return commands;
    return commands.filter((c) => `${c.label} ${c.hint ?? ''}`.toLowerCase().includes(s));
  }, [commands, q]);

  React.useEffect(() => { setActive(0); }, [q]);

  if (!open) return null;

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); filtered[active]?.run(); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  }

  // Group the filtered list, preserving order, and track a flat index for keyboard highlight.
  let flat = -1;
  const groups: { group: string; items: { cmd: Cmd; idx: number }[] }[] = [];
  for (const cmd of filtered) {
    flat += 1;
    const g = groups.find((x) => x.group === cmd.group);
    const entry = { cmd, idx: flat };
    if (g) g.items.push(entry); else groups.push({ group: cmd.group, items: [entry] });
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center px-4 pt-[12vh]" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative flex w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl" onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search brands or actions…"
          className="w-full border-b border-border bg-surface px-4 py-3.5 text-sm text-fg outline-none placeholder:text-muted"
        />
        <div className="max-h-[52vh] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted">No matches.</p>
          ) : (
            groups.map((g) => (
              <div key={g.group}>
                <p className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted">{g.group}</p>
                {g.items.map(({ cmd, idx }) => (
                  <button
                    key={cmd.id}
                    type="button"
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => cmd.run()}
                    className={`flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm transition ${idx === active ? 'bg-accent text-accent-fg' : 'text-fg hover:bg-surface-2'}`}
                  >
                    <span className="truncate font-medium">{cmd.label}</span>
                    {cmd.hint ? <span className={`truncate text-xs ${idx === active ? 'text-accent-fg/80' : 'text-muted'}`}>{cmd.hint}</span> : null}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
        <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-[11px] text-muted">
          <span>↑↓ navigate</span><span>↵ open</span><span>esc close</span>
        </div>
      </div>
    </div>
  );
}
