/**
 * On-device integration scenarios. They run the real native player against
 * the controllable test server and log one greppable line per result:
 *
 *   [RNAPTest] PASS race-load (2140 ms)
 *   [RNAPTest] FAIL reconnect-drop: timed out waiting for playing
 *
 * Trigger from the UI, or by deep link (so a CI script can drive them):
 *   adb shell am start -W -a android.intent.action.VIEW -d "anythingplayer-example://test/all"
 *   xcrun simctl openurl booted "anythingplayer-example://test/all"
 */
import {
  Player,
  type AudioSample,
  type PlayerOptions,
  type PlayerStatus,
  type Progress,
  isPlayerError,
} from 'react-native-anything-player';
import { LOCAL_TONE, STREAM_HOST, serverControl, serverStats } from './config';

type Scenario = {
  name: string;
  timeoutMs: number;
  run: (log: (m: string) => void) => Promise<void>;
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(() => resolve(), ms));

class AssertionFailure extends Error {}
function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AssertionFailure(message);
}

/** Resolves when `predicate(status)` holds (now or on a later status event). */
function waitFor(
  player: Player,
  predicate: (s: PlayerStatus) => boolean,
  timeoutMs: number,
  label: string
) {
  return new Promise<PlayerStatus>((resolve, reject) => {
    if (predicate(player.status)) return resolve(player.status);
    const timer = setTimeout(() => {
      off();
      reject(
        new AssertionFailure(
          `timed out (${timeoutMs} ms) waiting for ${label}; state=${player.state}`
        )
      );
    }, timeoutMs);
    const off = player.on('status', (s) => {
      if (predicate(s)) {
        clearTimeout(timer);
        off();
        resolve(s);
      }
    });
  });
}

async function expectRejects(promise: Promise<unknown>, code: string) {
  try {
    await promise;
  } catch (error) {
    expect(
      isPlayerError(error),
      `expected a PlayerError, got ${String(error)}`
    );
    expect(
      error.code === code,
      `expected ${code}, got ${error.code}: ${error.message}`
    );
    return error;
  }
  throw new AssertionFailure(`expected rejection with ${code}`);
}

/** Waits until the server reports `count` open stream connections. */
async function expectConnections(
  count: number,
  withinMs: number,
  label: string
) {
  const deadline = Date.now() + withinMs;
  let last = -1;
  while (Date.now() < deadline) {
    last = (await serverStats()).active;
    if (last === count) return;
    await sleep(250);
  }
  throw new AssertionFailure(
    `${label}: expected ${count} open connections, server has ${last}`
  );
}

const live = (query = '') => ({
  uri: `${STREAM_HOST}/live.mp3?titleEvery=4${query}`,
  live: true,
});

/** Native engine trace of the last failing scenario (printed by the runner). */
let failureTrace: string[] = [];

async function withPlayer(
  body: (player: Player) => Promise<void>,
  options: PlayerOptions = {}
) {
  const player = new Player({ diagnostics: false, ...options });
  try {
    await body(player);
  } catch (error) {
    failureTrace = player
      .getDiagnostics()
      .slice(-30)
      .map(
        (e) =>
          `${new Date(e.time).toISOString().slice(14, 23)} g${e.generation} ${e.state} ${e.event} ${JSON.stringify(e.details)}`
      );
    throw error;
  } finally {
    await player.release();
  }
}

export const SCENARIOS: Scenario[] = [
  {
    name: 'local-file',
    timeoutMs: 60_000,
    run: (log) =>
      withPlayer(async (p) => {
        const t0 = Date.now();
        await p.load(LOCAL_TONE);
        log(`ready in ${Date.now() - t0} ms`);
        expect(p.status.state === 'paused', `after load: ${p.status.state}`);
        expect(
          p.status.duration != null && Math.abs(p.status.duration - 30) < 1,
          `duration ${p.status.duration}`
        );
        expect(
          p.status.seekable && !p.status.isLive,
          'file must be seekable and not live'
        );
        await p.play();
        await waitFor(p, (s) => s.state === 'playing', 5_000, 'playing');
        await sleep(1_500);
        const progress = p.getProgress();
        expect(
          progress.position > 0.8,
          `position should advance, got ${progress.position}`
        );
        await p.seekTo(27);
        await sleep(300);
        expect(
          p.getProgress().position >= 26.5,
          `seek landed at ${p.getProgress().position}`
        );
        const t1 = Date.now();
        const ended = new Promise<void>((resolve) =>
          p.on('ended', () => resolve())
        );
        await ended;
        log(`ended ${Date.now() - t1} ms after seeking to 27 s of 30 s`);
        const afterEnd = p.status;
        expect(
          afterEnd.state === 'ended' && !afterEnd.playWhenReady,
          `after end: ${afterEnd.state}`
        );
        log('ended event received; restarting from 0');
        await p.play();
        await waitFor(p, (s) => s.state === 'playing', 5_000, 'replay');
        expect(
          p.getProgress().position < 5,
          'replay restarts from the beginning'
        );
      }),
  },
  {
    name: 'icy-metadata',
    timeoutMs: 30_000,
    run: (log) =>
      withPlayer(async (p) => {
        const titles: string[] = [];
        p.on('metadata', (m) => titles.push(`${m.artist} - ${m.title}`));
        await p.load(live(), { autoplay: true });
        await waitFor(p, (s) => s.state === 'playing', 10_000, 'playing');
        expect(
          p.status.isLive && !p.status.seekable,
          'live stream must be live and not seekable'
        );
        await expectRejects(p.seekTo(10), 'NOT_SEEKABLE');
        const deadline = Date.now() + 12_000;
        while (titles.length < 2 && Date.now() < deadline) await sleep(250);
        log(`titles: ${JSON.stringify(titles)}`);
        expect(
          titles.length >= 2,
          `expected ≥2 metadata updates, got ${titles.length}`
        );
        expect(p.metadata?.raw?.StreamTitle != null, 'raw StreamTitle kept');
      }),
  },
  {
    name: 'icy-latin1-malformed',
    timeoutMs: 30_000,
    run: (log) =>
      withPlayer(async (p) => {
        const seen: string[] = [];
        p.on('metadata', (m) =>
          seen.push(`${m.artist ?? '?'} - ${m.title ?? '?'}`)
        );
        await p.load(live('&charset=latin1&malformed=1&titleEvery=2'), {
          autoplay: true,
        });
        await waitFor(p, (s) => s.state === 'playing', 10_000, 'playing');
        await sleep(9_000);
        log(`metadata: ${JSON.stringify(seen)}`);
        expect(
          p.status.state === 'playing',
          `malformed metadata must not break playback: ${p.status.state}`
        );
        const bjork = seen.find((t) => t.startsWith('Bj'));
        if (bjork)
          expect(
            bjork.startsWith('Björk'),
            `Latin-1 decoded wrongly: ${bjork}`
          );
      }),
  },
  {
    name: 'race-load',
    timeoutMs: 30_000,
    run: () =>
      withPlayer(async (p) => {
        const a = p.load(live('&a=1'), { autoplay: true });
        const b = p.load(live('&b=1'));
        const c = p.load(live('&c=1'));
        await Promise.all([a, b, c]);
        expect(
          p.status.loadId === 3,
          `loadId should be 3, got ${p.status.loadId}`
        );
        await waitFor(p, (s) => s.state === 'playing', 10_000, 'playing C');
        await expectConnections(
          1,
          5_000,
          'only the last load may stay connected'
        );
      }),
  },
  {
    name: 'race-play-pause',
    timeoutMs: 30_000,
    run: () =>
      withPlayer(async (p) => {
        await p.load(live());
        const calls: Promise<void>[] = [];
        for (let i = 0; i < 10; i++)
          calls.push(i % 2 === 0 ? p.play() : p.pause());
        await Promise.all(calls);
        expect(!p.status.playWhenReady, 'the last command (pause) must win');
        await sleep(2_000);
        expect(
          p.status.state === 'paused',
          `must settle paused, got ${p.status.state}`
        );
        await p.play();
        await waitFor(p, (s) => s.state === 'playing', 10_000, 'playing');
        await expectConnections(1, 5_000, 'one connection');
      }),
  },
  {
    name: 'stale-slow-load',
    timeoutMs: 30_000,
    run: () =>
      withPlayer(async (p) => {
        const slow = p.load(
          { uri: `${STREAM_HOST}/live.mp3?delay=4000&slowone=1`, live: true },
          { autoplay: true }
        );
        await sleep(200);
        await p.load(live('&fast=1'));
        await slow;
        await waitFor(
          p,
          (s) => s.state === 'playing',
          10_000,
          'playing the fast source'
        );
        await sleep(5_000);
        expect(
          p.status.state === 'playing' && p.status.loadId === 2,
          `stale open must not disturb: ${p.status.state}`
        );
        await expectConnections(
          1,
          5_000,
          'the slow open must have been abandoned'
        );
      }),
  },
  {
    name: 'http-404',
    timeoutMs: 20_000,
    run: () =>
      withPlayer(async (p) => {
        const error = await expectRejects(
          p.load(
            { uri: `${STREAM_HOST}/live.mp3?status=404` },
            { autoplay: true }
          ),
          'SOURCE_NOT_FOUND'
        );
        expect(error.recoverable === false, '404 is not recoverable');
        await sleep(3_000);
        expect(
          p.status.state === 'error',
          `must stay in error, got ${p.status.state}`
        );
      }),
  },
  {
    // The example apps allow cleartext only to the test server (iOS ATS
    // local networking, Android network-security config).
    name: 'cleartext-blocked',
    timeoutMs: 20_000,
    run: () =>
      withPlayer(async (p) => {
        const error = await expectRejects(
          p.load(
            { uri: 'http://example.com/stream.mp3', live: true },
            { autoplay: true }
          ),
          'INVALID_SOURCE'
        );
        expect(error.recoverable === false, 'blocked cleartext is final');
        expect(p.status.state === 'error', `state ${p.status.state}`);
      }),
  },
  {
    name: 'server-outage-recovers',
    timeoutMs: 40_000,
    run: () =>
      withPlayer(async (p) => {
        await p.load(live()).catch(() => undefined);
        await serverControl('down=1');
        try {
          await p.play().catch(() => undefined);
          await serverControl('drop=1');
          await waitFor(
            p,
            (s) => s.state === 'reconnecting',
            15_000,
            'reconnecting'
          );
          await waitFor(
            p,
            (s) => (s.reconnect?.attempt ?? 0) >= 2,
            15_000,
            'second attempt'
          );
        } finally {
          await serverControl('down=0');
        }
        await waitFor(
          p,
          (s) => s.state === 'playing',
          20_000,
          'recovered playing'
        );
      }),
  },
  {
    name: 'reconnect-drop',
    timeoutMs: 50_000,
    run: (log) =>
      withPlayer(async (p) => {
        const states: string[] = [];
        p.on('stateChange', (s) => states.push(s));
        const before = (await serverStats()).total;
        await p.load(live('&dropAfter=5'), { autoplay: true });
        await waitFor(p, (s) => s.state === 'playing', 10_000, 'playing');
        // The server drops the socket every 5 s. Recovery is seamless (iOS:
        // the proxy splices a new connection into the response; Android: a
        // queued continuation item) or a visible reconnect. Either way audio
        // keeps coming back and there is never more than one connection.
        // Each connection also delivers a 2 s burst, so the buffer grows;
        // Android then defers the next connection while two items are queued
        // (bounding latency), so "zero connections" is legitimate for up to
        // one item's duration.
        let maxActive = 0;
        const until = Date.now() + 20_000;
        while (Date.now() < until) {
          maxActive = Math.max(maxActive, (await serverStats()).active);
          await sleep(250);
        }
        log(
          `states: ${states.join(' → ')}; max concurrent connections: ${maxActive}`
        );
        expect(
          maxActive <= 1,
          `at most one connection at a time, saw ${maxActive}`
        );
        await waitFor(
          p,
          (s) => s.state === 'playing',
          10_000,
          'playing after drops'
        );
        const opened = (await serverStats()).total - before;
        expect(
          opened >= 3,
          `the drops must have been recovered (${opened} connections opened)`
        );
        await expectConnections(
          1,
          10_000,
          'exactly one connection after recovery'
        );
      }),
  },
  {
    name: 'flapping-server-no-storm',
    timeoutMs: 40_000,
    run: (log) =>
      withPlayer(async (p) => {
        const before = (await serverStats()).total;
        // Accepts, sends a little, closes — forever.
        await p
          .load(
            { uri: `${STREAM_HOST}/live.mp3?endAfter=0.3`, live: true },
            { autoplay: true }
          )
          .catch(() => undefined);
        await sleep(20_000);
        const opened = (await serverStats()).total - before;
        log(
          `connections in 20 s: ${opened}; state=${p.state} attempt=${p.status.reconnect?.attempt ?? '-'}`
        );
        expect(opened <= 16, `connection storm: ${opened} connections in 20 s`);
      }),
  },
  {
    name: 'stall-recovers',
    timeoutMs: 60_000,
    run: (log) =>
      withPlayer(async (p) => {
        const states: string[] = [];
        p.on('stateChange', (s) => states.push(s));
        const before = (await serverStats()).total;
        // The socket goes silent after 4 s and never revives (stallFor=60).
        await p.load(live('&stallAfter=4&stallFor=60'), { autoplay: true });
        await waitFor(p, (s) => s.state === 'playing', 10_000, 'playing');
        // Whichever layer notices first (the engine's stall watchdog or the
        // native player's own read timeout), a dead socket must be replaced
        // by a new connection and audio must come back.
        const deadline = Date.now() + 30_000;
        while (
          Date.now() < deadline &&
          (await serverStats()).total - before < 2
        )
          await sleep(500);
        const opened = (await serverStats()).total - before;
        expect(
          opened >= 2,
          `the silent socket was never replaced (${opened} connection(s))`
        );
        await waitFor(
          p,
          (s) => s.state === 'playing',
          15_000,
          'playing after the stall'
        );
        log(`states: ${states.join(' → ')}; connections opened: ${opened}`);
        // The dead socket must be closed when it is replaced, not left to a
        // read timeout (found on Android: it lingered ~10 s).
        await expectConnections(
          1,
          2_000,
          'the replaced silent socket must be closed'
        );
      }),
  },
  {
    name: 'pause-releases-connection',
    timeoutMs: 60_000,
    run: () =>
      withPlayer(async (p) => {
        await p.load(live(), { autoplay: true });
        await waitFor(p, (s) => s.state === 'playing', 10_000, 'playing');
        await p.pause();
        await expectConnections(1, 2_000, 'connection kept right after pause');
        await expectConnections(
          0,
          40_000,
          'paused live stream must release its connection'
        );
        expect(p.status.state === 'paused', 'still paused after release');
        await p.play();
        await waitFor(
          p,
          (s) => s.state === 'playing',
          10_000,
          'resume re-opens at the live edge'
        );
      }),
  },
  {
    // Lock-screen song progress on a live stream (inspect with dumpsys / the log).
    name: 'song-progress',
    timeoutMs: 20_000,
    run: (log) =>
      withPlayer(async (p) => {
        await p.load(live(), { autoplay: true });
        await waitFor(p, (s) => s.state === 'playing', 10_000, 'playing');
        await p.updateNowPlaying({
          title: 'Song Progress Test',
          artist: 'RNAP',
          duration: 200,
          elapsed: 50,
        });
        await sleep(3_000);
        await p.pause();
        await sleep(2_000);
        await p.play();
        await waitFor(p, (s) => s.state === 'playing', 10_000, 'playing again');
        await sleep(2_000);
        log('set 50/200 s; then 3 s playing, 2 s paused, 2 s playing');
      }),
  },
  {
    // Decoded-PCM windows for visualizers, from a live stream.
    name: 'audio-sampling',
    timeoutMs: 25_000,
    run: (log) =>
      withPlayer(async (p) => {
        const windows: AudioSample[] = [];
        p.on('audioSample', (w) => windows.push(w));
        await p.load(live(), { autoplay: true });
        await waitFor(p, (s) => s.state === 'playing', 10_000, 'playing');
        expect(
          p.setAudioSampling({ enabled: true, points: 256 }),
          'sampling must be supported'
        );
        await sleep(3_000);
        const got = windows.length;
        const loud = windows.filter((w) => w.level > 0.01).length;
        const w = windows[windows.length - 1];
        log(
          `${got} windows in 3 s; level=${w?.level.toFixed(3)} span=${(
            (w?.duration ?? 0) * 1000
          ).toFixed(
            1
          )}ms outputLatency=${((w?.outputLatency ?? 0) * 1000).toFixed(0)}ms`
        );
        expect(got >= 20, `expected a steady stream of windows, got ${got}`);
        expect(w!.waveform.length === 256, `points: ${w!.waveform.length}`);
        expect(loud > got / 2, 'the windows must carry the audio');
        expect(
          w!.waveform.every((v) => v >= -1 && v <= 1),
          'samples are normalized'
        );
        p.setAudioSampling({ enabled: false });
        await sleep(300);
        const after = windows.length;
        await sleep(1_000);
        expect(windows.length === after, 'no windows after disabling');
      }),
  },
  {
    // `progressInterval`: native-timer readings while playing, none paused.
    name: 'progress-events',
    timeoutMs: 25_000,
    run: (log) =>
      withPlayer(
        async (p) => {
          const readings: Progress[] = [];
          p.on('progress', (r) => readings.push(r));
          await p.load(live(), { autoplay: true });
          await waitFor(p, (s) => s.state === 'playing', 10_000, 'playing');
          const from = readings.length;
          await sleep(2_000);
          const got = readings.slice(from);
          const last = got[got.length - 1];
          log(
            `${got.length} readings in 2 s; bufferedAhead=${last?.bufferedAhead.toFixed(2)}s position=${last?.position.toFixed(2)}s`
          );
          expect(got.length >= 6, `expected ~8 readings, got ${got.length}`);
          expect(
            got.every((r, i) => i === 0 || r.timestamp > got[i - 1]!.timestamp),
            'readings are fresh'
          );
          expect(
            got.every(
              (r) => Number.isFinite(r.bufferedAhead) && r.bufferedAhead >= 0
            ),
            'bufferedAhead is a finite reading'
          );
          await p.pause();
          await sleep(300);
          const paused = readings.length;
          await sleep(1_000);
          expect(readings.length === paused, 'no readings while paused');
        },
        { progressInterval: 250 }
      ),
  },
  {
    // Synchronous JSI reads while a stream plays: cost per call.
    name: 'bench-sync-reads',
    timeoutMs: 20_000,
    run: (log) =>
      withPlayer(async (p) => {
        await p.load(live(), { autoplay: true });
        await waitFor(p, (s) => s.state === 'playing', 10_000, 'playing');
        // React Native provides the High Resolution Time API at runtime.
        const { performance } = globalThis as unknown as {
          performance: { now(): number };
        };
        const measure = (read: () => unknown) => {
          const samples: number[] = [];
          for (let i = 0; i < 2_000; i++) {
            const t0 = performance.now();
            read();
            samples.push(performance.now() - t0);
          }
          samples.sort((a, b) => a - b);
          const at = (q: number) =>
            samples[Math.floor(q * (samples.length - 1))]! * 1000;
          return { p50: at(0.5), p99: at(0.99) };
        };
        const progress = measure(() => p.getProgress());
        const status = measure(() => p.refresh());
        log(
          `getProgress p50=${progress.p50.toFixed(1)}µs p99=${progress.p99.toFixed(1)}µs; ` +
            `refresh() (status + metadata) p50=${status.p50.toFixed(1)}µs p99=${status.p99.toFixed(1)}µs`
        );
        // p50 is the cost; p99 includes GC pauses and scheduler noise.
        expect(progress.p50 < 100, 'getProgress p50 must stay under 100 µs');
        expect(progress.p99 < 5_000, 'getProgress p99 must stay under 5 ms');
      }),
  },
  {
    name: 'release-frees-resources',
    timeoutMs: 20_000,
    run: async () => {
      const p = new Player();
      await p.load(live(), { autoplay: true });
      await waitFor(p, (s) => s.state === 'playing', 10_000, 'playing');
      await p.release();
      await expectConnections(
        0,
        4_000,
        'released player must close its connection'
      );
      await expectRejects(p.play(), 'PLAYER_RELEASED');
      expect(p.listenerCount() === 0, 'listeners cleared on release');
    },
  },
  {
    name: 'invalid-sources',
    timeoutMs: 10_000,
    run: () =>
      withPlayer(async (p) => {
        await expectRejects(p.load(''), 'INVALID_SOURCE');
        await expectRejects(
          p.load('ftp://example.com/a.mp3'),
          'INVALID_SOURCE'
        );
        await expectRejects(p.play(), 'NO_SOURCE');
        await expectRejects(p.setVolume(Number.NaN), 'INVALID_ARGUMENT');
      }),
  },
];

/** Measurement probes (not assertions): how long until the server sees the connection close. */
async function timeToClose(
  log: (m: string) => void,
  action: (p: Player) => Promise<void>
) {
  const p = new Player();
  await p.load(live(), { autoplay: true });
  await waitFor(p, (s) => s.state === 'playing', 10_000, 'playing');
  await sleep(3_000);
  const started = Date.now();
  await action(p);
  let closedAfter = -1;
  while (Date.now() - started < 60_000) {
    if ((await serverStats()).active === 0) {
      closedAfter = Date.now() - started;
      break;
    }
    await sleep(200);
  }
  log(`connection closed after ${closedAfter} ms`);
  if (!p.isReleased) await p.release();
  expect(
    closedAfter >= 0 && closedAfter < 3_000,
    `connection must close promptly (took ${closedAfter} ms)`
  );
}

SCENARIOS.push(
  {
    name: 'probe-stop-closes',
    timeoutMs: 80_000,
    run: (log) => timeToClose(log, (p) => p.stop()),
  },
  {
    name: 'probe-release-closes',
    timeoutMs: 80_000,
    run: (log) => timeToClose(log, (p) => p.release()),
  }
);

export async function runScenarios(
  names: string[] | 'all',
  onLog: (line: string) => void
): Promise<{ passed: number; failed: number }> {
  const selected =
    names === 'all'
      ? SCENARIOS
      : SCENARIOS.filter((s) => names.includes(s.name));
  let passed = 0;
  let failed = 0;
  const emit = (line: string) => {
    console.log(`[RNAPTest] ${line}`);
    onLog(line);
  };
  emit(`START ${selected.map((s) => s.name).join(',')}`);
  await serverControl('down=0&stall=0').catch(() =>
    emit('WARN test server unreachable')
  );
  for (const scenario of selected) {
    const started = Date.now();
    try {
      await Promise.race([
        scenario.run((m) => emit(`  ${scenario.name}: ${m}`)),
        sleep(scenario.timeoutMs).then(() => {
          throw new AssertionFailure(
            `scenario timeout ${scenario.timeoutMs} ms`
          );
        }),
      ]);
      passed += 1;
      emit(`PASS ${scenario.name} (${Date.now() - started} ms)`);
    } catch (error) {
      failed += 1;
      emit(
        `FAIL ${scenario.name}: ${error instanceof Error ? error.message : String(error)}`
      );
      failureTrace.forEach((line) => emit(`  trace ${line}`));
      failureTrace = [];
    }
    await sleep(500);
  }
  emit(`DONE passed=${passed} failed=${failed}`);
  return { passed, failed };
}
