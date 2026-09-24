'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { INSTRUMENTS, type Instrument } from '@/lib/game/instruments';
import { DIcon, type IconName } from '@/components/game/digits/icons';

/**
 * DERIV-UI: the Markets picker (owner's mock). Desktop: a popover with a category rail on the left
 * (Favorites, then each market) and a searchable, grouped list with favourite stars on the right.
 * Phones: the same content as a bottom sheet, with the categories as chips.
 *
 * Only markets the engine can price and settle are listed (today: the synthetic Volatility
 * indices). Forex, stock indices, crypto and commodities join the catalogue when they are tradable.
 */

type CategoryId = 'favorites' | 'synthetic';
interface Group { id: string; label: string; items: Instrument[] }

const GROUPS: Group[] = [
  { id: 'vol1s', label: 'Volatility (1s) indices', items: INSTRUMENTS.filter((i) => i.tickMs === 1000) },
  { id: 'vol', label: 'Volatility indices', items: INSTRUMENTS.filter((i) => i.tickMs !== 1000) },
];
const CATEGORIES: { id: CategoryId; label: string; icon: IconName }[] = [
  { id: 'favorites', label: 'Favorites', icon: 'star' },
  { id: 'synthetic', label: 'Synthetic indices', icon: 'globe' },
];

const FAV_KEY = 'pp:fav-instruments';
function readFavs(): string[] {
  try { const v = JSON.parse(window.localStorage.getItem(FAV_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
}
function writeFavs(ids: string[]) { try { window.localStorage.setItem(FAV_KEY, JSON.stringify(ids)); } catch { /* private mode */ } }

/** Compact per-index badge: the volatility level, with "1s" under it for the fast variants. */
export function IndexBadge({ inst, active = false, size = 'md' }: { inst: Instrument; active?: boolean; size?: 'sm' | 'md' }) {
  return (
    <span className={cn('relative grid shrink-0 place-items-center rounded-full font-bold tabular-nums leading-none',
      size === 'md' ? 'h-8 w-8 text-[11px]' : 'h-6 w-6 text-[9px]',
      active ? 'bg-accent text-accent-fg' : 'bg-accent/15 text-accent')}>
      <span className="flex flex-col items-center">
        {inst.volPct}
        {inst.tickMs === 1000 ? <span className={cn('mt-px font-semibold opacity-80', size === 'md' ? 'text-[7px]' : 'text-[6px]')}>1s</span> : null}
      </span>
    </span>
  );
}

/** "Volatility 10 (1s) Index" with the "(1s)" tag emphasised, as in Deriv's list. */
function IndexName({ inst }: { inst: Instrument }) {
  const m = inst.label.match(/^(Volatility \d+)( \(1s\))?( Index)$/);
  if (!m) return <>{inst.label}</>;
  return <>{m[1]}{m[2] ? <b className="font-semibold">{m[2]}</b> : null}{m[3]}</>;
}

export function MarketsPanel({ current, onSelect, onClose }: { current: Instrument; onSelect: (inst: Instrument) => void; onClose: () => void }) {
  const [cat, setCat] = useState<CategoryId>('synthetic');
  const [q, setQ] = useState('');
  const [favs, setFavs] = useState<string[]>([]);
  const [expanded, setExpanded] = useState(true);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { setFavs(readFavs()); }, []);
  useEffect(() => {
    // desktop: type straight away; phones: don't pop the keyboard over the list
    if (window.matchMedia('(min-width: 1024px)').matches) searchRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggleFav = (id: string) => setFavs((f) => { const next = f.includes(id) ? f.filter((x) => x !== id) : [...f, id]; writeFavs(next); return next; });

  const query = q.trim().toLowerCase();
  const groups = useMemo<Group[]>(() => {
    const match = (i: Instrument) => !query || i.label.toLowerCase().includes(query) || i.short.toLowerCase().includes(query);
    if (query) return GROUPS.map((g) => ({ ...g, items: g.items.filter(match) })).filter((g) => g.items.length);
    if (cat === 'favorites') {
      const items = INSTRUMENTS.filter((i) => favs.includes(i.id));
      return items.length ? [{ id: 'fav', label: 'Favorites', items }] : [];
    }
    return GROUPS;
  }, [cat, favs, query]);

  const jumpTo = (groupId: string) => {
    setCat('synthetic'); setQ('');
    window.requestAnimationFrame(() => listRef.current?.querySelector(`[data-group="${groupId}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  };

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      {/* Category rail (desktop) */}
      <nav aria-label="Market categories" className="hidden w-52 shrink-0 flex-col border-r border-border p-3 lg:flex">
        <h2 className="px-2 pb-3 pt-1 text-[17px] font-bold text-fg">Markets</h2>
        {CATEGORIES.map((c) => (
          <div key={c.id}>
            <button type="button" onClick={() => { if (c.id === 'synthetic' && cat === 'synthetic') setExpanded((v) => !v); setCat(c.id); setQ(''); }}
              aria-current={cat === c.id && !query ? 'true' : undefined}
              className={cn('flex w-full items-center gap-2.5 rounded-lg px-2 py-2.5 text-left text-[14px] transition',
                cat === c.id && !query ? 'font-semibold text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg')}>
              <DIcon name={c.icon} className={cn('h-4 w-4 shrink-0', c.id === 'favorites' && favs.length ? 'text-warn' : '')} />
              <span className="flex-1">{c.label}</span>
              {c.id === 'favorites' && favs.length ? <span className="text-[11px] tabular-nums text-muted">{favs.length}</span> : null}
              {c.id === 'synthetic' ? <DIcon name="chevronDown" className={cn('h-3.5 w-3.5 transition-transform', expanded ? 'rotate-180' : '')} /> : null}
            </button>
            {c.id === 'synthetic' && expanded ? (
              <div className="mb-1 ml-8 flex flex-col">
                {GROUPS.map((g) => (
                  <button key={g.id} type="button" onClick={() => jumpTo(g.id)} className="rounded-md px-2 py-1.5 text-left text-[12.5px] text-muted transition hover:text-fg">
                    {g.label.replace(' indices', '')}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Phone header + category chips */}
        <div className="flex items-center justify-between px-4 pb-2 pt-4 lg:hidden">
          <h2 className="text-[17px] font-bold text-fg">Markets</h2>
          <button type="button" onClick={onClose} aria-label="Close markets" className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:text-fg">
            <DIcon name="close" className="h-5 w-5" />
          </button>
        </div>

        {/* Search */}
        <div className="px-4 pb-2 lg:px-4 lg:pt-4">
          <label className="flex h-11 items-center gap-2 rounded-xl border border-border bg-bg/60 px-3 focus-within:border-accent">
            <DIcon name="search" className="h-4 w-4 shrink-0 text-muted" />
            <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" aria-label="Search markets"
              className="min-w-0 flex-1 bg-transparent text-[14px] text-fg outline-none placeholder:text-muted" />
            {q ? <button type="button" onClick={() => setQ('')} aria-label="Clear search" className="text-muted hover:text-fg"><DIcon name="close" className="h-4 w-4" /></button> : null}
          </label>
        </div>
        <div className="flex gap-2 overflow-x-auto px-4 pb-2 lg:hidden" role="tablist" aria-label="Market categories">
          {CATEGORIES.map((c) => (
            <button key={c.id} type="button" role="tab" aria-selected={cat === c.id && !query} onClick={() => { setCat(c.id); setQ(''); }}
              className={cn('flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12.5px] font-medium transition',
                cat === c.id && !query ? 'border-fg bg-fg text-bg' : 'border-border text-muted')}>
              <DIcon name={c.icon} className="h-3.5 w-3.5" />{c.label}
            </button>
          ))}
        </div>

        {/* List */}
        <div ref={listRef} role="listbox" aria-label="Markets" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">
          {groups.length === 0 ? (
            <p className="px-4 py-10 text-center text-[13px] text-muted">
              {query ? 'No market matches your search.' : 'No favorites yet. Tap the star next to a market to keep it here.'}
            </p>
          ) : groups.map((g) => (
            <section key={g.id} data-group={g.id} className="scroll-mt-2">
              <h3 className="px-3 pb-1.5 pt-3 text-[13px] font-bold text-fg">{g.label}</h3>
              {g.items.map((inst) => {
                const active = inst.id === current.id;
                const fav = favs.includes(inst.id);
                return (
                  <div key={inst.id} className={cn('group flex items-center gap-1 rounded-lg transition', active ? 'bg-surface-2' : 'hover:bg-surface-2/60')}>
                    <button type="button" role="option" aria-selected={active} onClick={() => { onSelect(inst); onClose(); }}
                      className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left">
                      <IndexBadge inst={inst} active={active} />
                      <span className={cn('min-w-0 truncate text-[14px]', active ? 'font-semibold text-fg' : 'text-fg/90')}><IndexName inst={inst} /></span>
                    </button>
                    <button type="button" onClick={() => toggleFav(inst.id)} aria-pressed={fav} aria-label={fav ? `Remove ${inst.label} from favorites` : `Add ${inst.label} to favorites`}
                      className={cn('mr-2 grid h-9 w-9 shrink-0 place-items-center rounded-lg transition', fav ? 'text-warn' : 'text-muted/60 hover:text-fg')}>
                      <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill={fav ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
                        <path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z" />
                      </svg>
                    </button>
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
