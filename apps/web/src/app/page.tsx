import { GameSocketProvider } from '@/lib/game/GameSocketProvider';
import { TradeSurface } from '@/components/game/TradeSurface';

export default function GamePage() {
  return (
    <GameSocketProvider>
      {/*
        Trading-terminal layout. The parent <main> (AppShell trade frame) is a locked-height flex
        column, so this section simply fills it. TradeSurface picks the per-brand layout: the
        classic rise/fall curve terminal, or the Deriv-style digits broker screen.
      */}
      <TradeSurface />
    </GameSocketProvider>
  );
}
