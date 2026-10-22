# A trade in progress survives a refresh

## The reported bug

> "refreshing the windows hides the trade in progress (does not show the current trade)"

Reload the browser with a contract running and the terminal showed nothing: the Trade screen said
"No open positions", the chart drew no position level, the Toolbox was empty. The contract was still
running on the server and still settled into the balance.

## Why

`activePosition` lives only in React state, and it was set in exactly one place: the trader's own
`openPosition()` call in the current page's life. Nothing re-asked on connect, and there was nothing
to ask with — the engine's socket protocol had no frame in either direction that reported a user's
open contracts. The `hello` reply carries only server time, the seed hash, the trade date and the
game config, and it is sent *before* auth, so it could not carry a user's data anyway.

Two things made it worse than "the UI forgot":

- **The engine was already talking to the refreshed tab.** Fan-out is keyed by `(siteId, userId)` and
  resolved at emit time, and the new socket joins that set during auth. So `position_update` frames
  for the running contract were arriving at the very page that showed nothing.
- **Every one of them was dropped.** That handler only ever *mutates* a position it already has
  (`cur && cur.positionId === d.positionId`). With `cur === null` the live P/L, the countdown and
  `sellable` all went nowhere, silently.

## The fix

The engine reports what it already holds, on the **auth reply** (`hello` is pre-auth and cannot):

```ts
const running = rt.game.openPositionsOf(userId);
return send(ws, "open_positions", { positions: running.map((p) => ({
  positionId: p.id, direction: p.direction, stakeCents: p.stakeCents, durationS: p.durationS,
  openedAtMs: p.openedAtMs, expiresAtMs: p.expiresAtMs, entryRate: p.outcome.entryRate,
  sellable: p.sellable,
})) });
```

`GameServer.openPositionsOf(userId)` is a scan, not a per-user index, deliberately: an index is a
second copy of the truth that has to be kept in step with every open, settle and recovery path, and
this map holds the open contracts of one brand, which is a handful. It is read-only and decides
nothing.

The client restores from it, and **only when nothing is already active**, so it can never overwrite
an optimistic open the trader raised in this page's life — that one is reconciled by
`position_opened` as before.

The live figures are seeded neutral (`liveMultiplier: 1`, `livePnlCents: 0`) and arrive on the
engine's next tick, within one tick interval. Inventing a multiplier here would print a P/L the
engine never said.

`positionId` is all the reattachment needs: `position_update` and `position_settled` are both matched
on it, so the live P/L, the countdown, `sellable`, the settle animation and `sell` itself all come
back by themselves.

## Why REST was not used

`GET /positions?status=open` already exists and is site- and user-scoped. It was rejected because its
DTO does not carry `kind`, and the `positions` table holds rise/fall, digit and multiplier contracts
together: restoring an open **digit** contract as a rise/fall position would have been worse than
restoring nothing. The engine holds the three kinds in separate maps, so the frame reports only
rise/fall by construction.

## A hole this closes incidentally

The one-contract-at-a-time rule is enforced **on the client** (`openPosition` returns
`'POSITION_OPEN'`); the engine's `openPosition` has no per-user open check. So a refreshed tab, with
`activePosition === null`, would happily open a *second* concurrent contract. Restoring the position
closes that in practice.

The engine-side gap is recorded rather than changed: adding a refusal there is a money-path
behaviour change, and it was not asked for.

## Verified

`scratchpad/refresh.mjs`, **10/10**, phone 360x800 and desktop 1440x900: a contract is opened, the
screen shows it, the page is reloaded, the contract is still on screen, and its live figures are
arriving from the engine again.

Red-green: with the client handler stubbed to `break`, both shells fail the
"still on screen after a refresh" assertion (phone `after null`, desktop `after null`), which is the
reported bug reproduced.

The desktop assertion reads the live-position card's own sentence ("Max loss"). A first version
tested "no order ticket on screen" and passed even with the restore stubbed out, because the
order-result panel covers the ticket for a moment after placing.
