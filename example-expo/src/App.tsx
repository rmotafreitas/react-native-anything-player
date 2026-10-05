import { useEffect, useMemo, useState } from 'react';
import {
  Image,
  Linking,
  Platform,
  Settings,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  Player,
  type DiagnosticEntry,
  type PlayerError,
  usePlayerEvent,
  usePlayerStatus,
  useProgress,
  useStreamMetadata,
} from 'react-native-anything-player';
import { COVER, STATIONS, serverControl } from './config';
import { runScenarios, SCENARIOS } from './scenarios';

// One app-wide player, created at module scope: playback is independent of
// any component's lifetime.
export const player = new Player({
  mediaSession: { commands: ['next', 'previous'] },
  diagnostics: __DEV__,
});

const log = (...args: unknown[]) => console.log('[RNAP]', ...args);
player.on('stateChange', (state, previous) =>
  log(`state ${previous} → ${state}`)
);
player.on('error', (error, { fatal }) =>
  log(
    `error ${error.code} fatal=${fatal}: ${error.message} | ${error.nativeCause ?? ''}`
  )
);
player.on('metadata', (m) =>
  log(
    `metadata ${m.artist ?? '?'} - ${m.title ?? '?'} station=${m.station ?? '-'}`
  )
);

function format(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds)) return '--:--';
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function Button({
  title,
  onPress,
  active,
}: {
  title: string;
  onPress: () => void;
  active?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        active && styles.buttonActive,
        pressed && styles.buttonPressed,
      ]}
    >
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  );
}

export default function App() {
  const status = usePlayerStatus(player);
  const progress = useProgress(player, 500);
  const metadata = useStreamMetadata(player);
  const [stationIndex, setStationIndex] = useState<number | null>(null);
  const [lastError, setLastError] = useState<PlayerError | null>(null);
  const [diagnostics, setDiagnostics] = useState(false);
  const [trace, setTrace] = useState<DiagnosticEntry[]>([]);
  const [testLog, setTestLog] = useState<string[]>([]);

  usePlayerEvent(player, 'error', (error) => setLastError(error));
  usePlayerEvent(player, 'diagnostic', (entry) =>
    setTrace((t) => [entry, ...t].slice(0, 30))
  );
  usePlayerEvent(player, 'remoteCommand', ({ command }) => {
    log(`remote ${command}`);
    const delta = command === 'next' ? 1 : command === 'previous' ? -1 : 0;
    if (delta !== 0)
      select(((stationIndex ?? 0) + delta + STATIONS.length) % STATIONS.length);
  });

  const select = (index: number) => {
    setStationIndex(index);
    setLastError(null);
    const station = STATIONS[index]!;
    player
      .load(station.source, { autoplay: true })
      .catch((error: PlayerError) => setLastError(error));
  };

  const run = (names: string[] | 'all') => {
    setTestLog([]);
    runScenarios(names, (line) => setTestLog((l) => [...l, line])).catch((e) =>
      log('runner crashed', e)
    );
  };

  // anythingplayer-example://test/<name|all>  ·  anythingplayer-example://play/<stationIndex>
  useEffect(() => {
    const handle = (url: string | null | undefined) => {
      if (!url) return;
      const match =
        /anythingplayer-example:\/\/(test|play)\/([\w,-]+)(?:\?delay=(\d+))?/.exec(
          url
        );
      if (!match) return;
      // `?delay=ms` lets a test put the app in the background before the command runs.
      const go = () => {
        if (match[1] === 'test')
          run(match[2] === 'all' ? 'all' : match[2]!.split(','));
        else select(Number(match[2]));
      };
      if (match[3]) setTimeout(go, Number(match[3]));
      else go();
    };
    Linking.getInitialURL().then(handle);
    // iOS: `xcrun simctl launch booted anythingplayer.example -RNAPTest all`
    // (launch arguments land in NSUserDefaults; no URL confirmation dialog).
    if (Platform.OS === 'ios') {
      const requested = Settings.get('RNAPTest');
      if (typeof requested === 'string' && requested)
        handle(`anythingplayer-example://test/${requested}`);
      const station = Settings.get('AnythingPlayerPlay');
      if (station != null && station !== '')
        handle(`anythingplayer-example://play/${station}`);
    }
    const sub = Linking.addEventListener('url', ({ url }) => handle(url));
    return () => sub.remove();
  }, []);

  // Soak tests: the JS heap once a minute (Hermes only), to tell JS memory
  // apart from native memory in process-level readings.
  useEffect(() => {
    const hermes = (
      globalThis as {
        HermesInternal?: {
          getInstrumentedStats?: () => Record<string, number>;
        };
      }
    ).HermesInternal;
    if (!hermes?.getInstrumentedStats) return;
    const timer = setInterval(() => {
      const s = hermes.getInstrumentedStats!();
      console.log(
        `[RNAPMem] js_heapSize=${s.js_heapSize} js_allocatedBytes=${s.js_allocatedBytes} js_numGCs=${s.js_numGCs}`
      );
    }, 60_000);
    return () => clearInterval(timer);
  }, []);

  const artwork = useMemo(() => metadata?.artwork?.uri, [metadata]);
  const busy =
    status.state === 'loading' ||
    status.state === 'buffering' ||
    status.state === 'reconnecting';

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.h1}>RNAP</Text>

        <View style={styles.card}>
          <View style={styles.row}>
            <Image
              source={artwork ? { uri: artwork } : COVER}
              style={styles.cover}
            />
            <View style={styles.flex}>
              <Text style={styles.title} numberOfLines={2}>
                {metadata?.title ??
                  (stationIndex != null
                    ? STATIONS[stationIndex]!.label
                    : 'Pick a source')}
              </Text>
              <Text style={styles.subtle} numberOfLines={1}>
                {metadata?.artist ?? metadata?.station ?? ''}
              </Text>
              <Text style={styles.state} testID="state">
                {status.state}
                {busy ? '…' : ''}
                {status.interruption ? ` · ${status.interruption.reason}` : ''}
                {status.reconnect
                  ? ` · attempt ${status.reconnect.attempt}`
                  : ''}
              </Text>
            </View>
          </View>
          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                {
                  width: status.duration
                    ? `${Math.min(100, (progress.position / status.duration) * 100)}%`
                    : status.isLive
                      ? '100%'
                      : '0%',
                },
              ]}
            />
          </View>
          <Text style={styles.subtle}>
            {status.isLive
              ? 'LIVE'
              : `${format(progress.position)} / ${format(status.duration)}`}{' '}
            · buffer {progress.bufferedAhead.toFixed(1)} s · net{' '}
            {status.network} · vol {Math.round(status.volume * 100)}%
            {status.muted ? ' (muted)' : ''}
          </Text>
          {lastError && (
            <Text style={styles.error}>
              {lastError.code}: {lastError.message}
            </Text>
          )}
        </View>

        <View style={styles.wrap}>
          <Button
            title={status.playWhenReady ? 'Pause' : 'Play'}
            onPress={() => player.toggle().catch(setLastError)}
          />
          <Button
            title="Stop"
            onPress={() => player.stop().catch(setLastError)}
          />
          <Button
            title="Reset"
            onPress={() => player.reset().catch(setLastError)}
          />
          <Button
            title="−15 s"
            onPress={() =>
              player
                .seekTo(Math.max(0, progress.position - 15))
                .catch(setLastError)
            }
          />
          <Button
            title="+15 s"
            onPress={() =>
              player.seekTo(progress.position + 15).catch(setLastError)
            }
          />
          <Button
            title="Vol −"
            onPress={() => player.setVolume(status.volume - 0.1)}
          />
          <Button
            title="Vol +"
            onPress={() => player.setVolume(status.volume + 0.1)}
          />
          <Button
            title={status.muted ? 'Unmute' : 'Mute'}
            onPress={() => player.setMuted(!status.muted)}
          />
          <Button
            title={`Rate ${status.rate}×`}
            onPress={() =>
              player.setRate(status.rate >= 1.5 ? 1 : status.rate + 0.25)
            }
          />
        </View>

        <Text style={styles.h2}>Sources</Text>
        {STATIONS.map((station, index) => (
          <Button
            key={station.label}
            title={station.label}
            active={index === stationIndex}
            onPress={() => select(index)}
          />
        ))}

        <Text style={styles.h2}>Test server</Text>
        <View style={styles.wrap}>
          <Button
            title="Server down"
            onPress={() => serverControl('down=1&drop=1')}
          />
          <Button title="Server up" onPress={() => serverControl('down=0')} />
          <Button title="Stall all" onPress={() => serverControl('stall=1')} />
          <Button title="Unstall" onPress={() => serverControl('stall=0')} />
          <Button title="Drop all" onPress={() => serverControl('drop=1')} />
        </View>

        <Text style={styles.h2}>Integration scenarios</Text>
        <View style={styles.wrap}>
          <Button title="Run all" onPress={() => run('all')} />
          {SCENARIOS.map((s) => (
            <Button key={s.name} title={s.name} onPress={() => run([s.name])} />
          ))}
        </View>
        {testLog.map((line, i) => (
          <Text
            key={i}
            style={[styles.mono, line.startsWith('FAIL') && styles.error]}
          >
            {line}
          </Text>
        ))}

        <Text style={styles.h2}>Diagnostics</Text>
        <View style={styles.wrap}>
          <Button
            title={diagnostics ? 'Diagnostics on' : 'Diagnostics off'}
            active={diagnostics}
            onPress={() => {
              player.setDiagnosticsEnabled(!diagnostics);
              setDiagnostics(!diagnostics);
            }}
          />
          <Button
            title="Dump trace"
            onPress={() =>
              setTrace(player.getDiagnostics().reverse().slice(0, 30))
            }
          />
        </View>
        {trace.map((entry, i) => (
          <Text key={i} style={styles.mono}>
            {new Date(entry.time).toISOString().slice(11, 23)} g
            {entry.generation} {entry.state} {entry.event}{' '}
            {Object.entries(entry.details)
              .map(([k, v]) => `${k}=${v}`)
              .join(' ')}
          </Text>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0f1020' },
  content: { padding: 16, paddingBottom: 64 },
  h1: { color: 'white', fontSize: 28, fontWeight: '700', marginBottom: 12 },
  h2: {
    color: '#c8c8ff',
    fontSize: 16,
    fontWeight: '600',
    marginTop: 20,
    marginBottom: 8,
  },
  card: { backgroundColor: '#1b1c35', borderRadius: 16, padding: 14 },
  row: { flexDirection: 'row', gap: 12 },
  flex: { flex: 1 },
  cover: { width: 84, height: 84, borderRadius: 10, backgroundColor: '#333' },
  title: { color: 'white', fontSize: 17, fontWeight: '600' },
  subtle: { color: '#9a9ac0', fontSize: 13, marginTop: 4 },
  state: { color: '#7bed9f', fontSize: 14, marginTop: 6, fontWeight: '600' },
  error: { color: '#ff7675', marginTop: 6 },
  progressTrack: {
    height: 4,
    backgroundColor: '#2e2f55',
    borderRadius: 2,
    marginTop: 12,
    overflow: 'hidden',
  },
  progressFill: { height: 4, backgroundColor: '#6c5ce7' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  button: {
    backgroundColor: '#2e2f55',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    marginBottom: 6,
  },
  buttonActive: { backgroundColor: '#6c5ce7' },
  buttonPressed: { opacity: 0.6 },
  buttonText: { color: 'white', fontSize: 14 },
  mono: { color: '#d0d0e8', fontFamily: 'Menlo', fontSize: 11, marginTop: 2 },
});
