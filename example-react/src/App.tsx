// RNAP in a plain React app (react-dom + Vite): the same Player, hooks and
// buttons as in React Native, from `react-native-anything-player/react`.
import { useEffect, useState } from 'react';
import {
  CastButton,
  Player,
  RoutePicker,
  playFromSearch,
  setCatalog,
  usePlayerStatus,
  useProgress,
  useStreamMetadata,
} from 'react-native-anything-player/react';

const params = new URLSearchParams(location.search);
/** The test radio (scripts/stream-server); `?stream=` overrides it. */
const STREAM = params.get('stream') ?? 'http://localhost:8765';

const STATIONS = [
  {
    id: 'test',
    title: 'Test radio',
    source: { uri: `${STREAM}/live.mp3?titleEvery=4`, live: true },
  },
  {
    id: 'file',
    title: 'Remote tone',
    source: { uri: `${STREAM}/file.mp3`, live: false },
  },
];

declare global {
  interface Window {
    rnap?: { player: Player };
  }
}

/** One player for the page, created in the browser (not while rendering on a server). */
function usePlayer(): Player | null {
  const [player, setPlayer] = useState<Player | null>(null);
  useEffect(() => {
    const created = new Player({ id: 'main' });
    window.rnap = { player: created };
    setPlayer(created);
    setCatalog(STATIONS, { playerId: 'main' }).catch(() => undefined);
    return () => {
      created.release().catch(() => undefined);
    };
  }, []);
  return player;
}

function Controls({ player }: { player: Player }) {
  const status = usePlayerStatus(player);
  const metadata = useStreamMetadata(player);
  const progress = useProgress(player, 500);
  const [query, setQuery] = useState('');
  return (
    <>
      <div className="row">
        {STATIONS.map((station) => (
          <button
            key={station.id}
            type="button"
            onClick={() => player.load(station.source, { autoplay: true })}
          >
            {station.title}
          </button>
        ))}
        <button type="button" onClick={() => player.toggle()}>
          {status.playWhenReady ? 'Pause' : 'Play'}
        </button>
        <RoutePicker player={player} />
        <CastButton />
      </div>
      <p data-testid="state">{status.state}</p>
      <p data-testid="title">
        {metadata ? `${metadata.artist ?? ''} – ${metadata.title ?? ''}` : '–'}
      </p>
      <p data-testid="position">{progress.position.toFixed(1)} s</p>
      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          playFromSearch(query, player).catch(() => undefined);
        }}
      >
        <input
          aria-label="Search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="submit">Search</button>
      </form>
    </>
  );
}

export function App() {
  const player = usePlayer();
  return (
    <main>
      <h1>RNAP in React (Vite)</h1>
      <p>
        <code>react-native-anything-player/react</code>: no React Native.
      </p>
      {player ? <Controls player={player} /> : null}
    </main>
  );
}
