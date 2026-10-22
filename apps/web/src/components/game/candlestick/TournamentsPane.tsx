'use client';

/**
 * The rail's Tours tab: the mock's tournaments list.
 *
 * Like the leaderboard beside it, there is nothing behind this yet — no tournament table, no entry,
 * no prize ledger — and a tournament a player could "join" that does not exist would be worse than
 * an empty tab. The mock's surface is here; the state it shows is the true one.
 */
export function TournamentsPane() {
  const tournaments: { id: string; name: string; prize: string; ends: string }[] = [];

  return (
    <div className="flex h-full w-full min-w-0 flex-col space-y-3 overflow-y-auto bg-bg p-3 sm:p-4">
      <div className="shrink-0 truncate text-xs font-bold uppercase tracking-widest text-fg">Tournaments</div>
      {tournaments.length === 0 ? (
        <p className="px-2 py-8 text-center text-xs italic text-muted">No tournaments running right now.</p>
      ) : (
        tournaments.map((t) => (
          <div key={t.id} className="min-w-0 rounded-xl bg-surface-2 p-3 sm:p-4">
            <div className="truncate text-sm font-bold text-fg">{t.name}</div>
            <div className="mt-1 break-words text-xs text-muted">Prize {t.prize} · ends {t.ends}</div>
          </div>
        ))
      )}
    </div>
  );
}
