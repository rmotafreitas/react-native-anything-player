/* global location */
// The plain-web example: the same Player API as React Native, in a page with
// no framework. `window.rnap` exposes the player to the end-to-end tests.
import { Player } from 'react-native-anything-player/web';

const params = new URLSearchParams(location.search);
/** The test radio (scripts/stream-server); `?stream=` overrides it. */
const STREAM = params.get('stream') ?? 'http://localhost:8765';

const STATIONS = [
  {
    label: 'Test radio (ICY)',
    source: {
      uri: `${STREAM}/live.mp3?titleEvery=4`,
      live: true,
      metadata: { title: 'RNAP Test Radio', artwork: `${STREAM}/artwork2.png` },
    },
  },
  {
    label: 'Test radio without CORS (plain <audio>)',
    source: { uri: `${STREAM}/live.mp3?noCors=1`, live: true },
  },
  {
    label: 'Remote file',
    source: {
      uri: `${STREAM}/file.mp3`,
      live: false,
      metadata: { title: 'Remote tone', artist: 'RNAP' },
    },
  },
  {
    label: 'Rádio Animu (real ICY)',
    source: {
      uri: 'https://stream.animu.moe/192',
      metadata: {
        title: 'Rádio Animu',
        artwork: 'https://www.animu.moe/favicon.png',
      },
    },
  },
];

const player = new Player({
  mediaSession: { commands: ['next', 'previous'] },
  progressInterval: 500,
});
const events = [];
window.rnap = { player, events, stations: STATIONS };

const $ = (id) => document.getElementById(id);
const log = (line) => {
  $('log').textContent =
    `${new Date().toISOString().slice(11, 23)} ${line}\n${$('log').textContent}`.slice(
      0,
      8000
    );
};
const record = (type, payload) =>
  events.push({ type, at: Date.now(), ...payload });

let selected = 0;
function load(index, autoplay) {
  selected = index;
  document
    .querySelectorAll('#stations button')
    .forEach((b, i) => b.setAttribute('aria-pressed', String(i === index)));
  player
    .load(STATIONS[index].source, { autoplay })
    .catch((error) => log(`load failed: ${error.code} ${error.message}`));
}

STATIONS.forEach((station, index) => {
  const button = document.createElement('button');
  button.textContent = station.label;
  button.setAttribute('aria-pressed', 'false');
  // A tap is a user gesture: the browser lets it start audio.
  button.addEventListener('click', () => load(index, true));
  $('stations').append(button);
});

$('toggle').addEventListener('click', () => {
  if (player.state === 'idle') return load(selected, true);
  player.toggle().catch((error) => log(`toggle failed: ${error.code}`));
});
$('stop').addEventListener('click', () => player.stop());
$('visualizer').addEventListener('click', (event) => {
  const on = event.currentTarget.getAttribute('aria-pressed') !== 'true';
  event.currentTarget.setAttribute('aria-pressed', String(on));
  const supported = player.setAudioSampling({ enabled: on, points: 256 });
  if (on && !supported) log('visualizer: Web Audio is not available');
});

player.on('stateChange', (state, previous) => {
  $('state').textContent = state;
  $('toggle').textContent = player.playWhenReady ? 'Pause' : 'Play';
  record('stateChange', { state, previous });
  log(`state ${previous} → ${state}`);
});
player.on('status', (status) => {
  $('toggle').textContent = status.playWhenReady ? 'Pause' : 'Play';
  const reason = status.interruption?.reason;
  if (reason) $('state').textContent = `${status.state} (${reason})`;
});
player.on('metadata', (metadata) => {
  $('now').textContent =
    [metadata.artist, metadata.title].filter(Boolean).join(' – ') || '–';
  $('station').textContent = metadata.station ?? '–';
  record('metadata', { metadata });
  log(`metadata ${metadata.artist ?? '?'} – ${metadata.title ?? '?'}`);
});
player.on('error', (error, { fatal }) => {
  $('error').textContent =
    `${error.code}${fatal ? ' (fatal)' : ''}: ${error.message}`;
  record('error', { code: error.code, fatal });
  log(`error ${error.code} fatal=${fatal}`);
});
player.on('discontinuity', (event) => {
  record('discontinuity', event);
  log(`discontinuity at ${event.position.toFixed(2)} s`);
});
player.on('remoteCommand', (event) => {
  record('remoteCommand', event);
  log(`remote ${event.command}`);
  const step =
    event.command === 'next' ? 1 : event.command === 'previous' ? -1 : 0;
  if (step) load((selected + step + STATIONS.length) % STATIONS.length, true);
});
player.on('progress', (progress) => {
  $('position').textContent =
    `${progress.position.toFixed(1)} s${progress.duration ? ` / ${progress.duration.toFixed(1)} s` : ''}`;
  $('live').textContent =
    progress.liveOffset == null ? '–' : `${progress.liveOffset.toFixed(1)} s`;
});

const scope = $('scope').getContext('2d');
player.on('audioSample', (sample) => {
  record('audioSample', {
    level: sample.level,
    points: sample.waveform.length,
  });
  const { width, height } = scope.canvas;
  scope.clearRect(0, 0, width, height);
  scope.strokeStyle = '#f0a07c';
  scope.beginPath();
  sample.waveform.forEach((v, i) => {
    const x = (i / (sample.waveform.length - 1)) * width;
    const y = height / 2 - v * (height / 2);
    i === 0 ? scope.moveTo(x, y) : scope.lineTo(x, y);
  });
  scope.stroke();
  if (events.filter((e) => e.type === 'audioSample').length > 50)
    events.splice(
      events.findIndex((e) => e.type === 'audioSample'),
      1
    );
});

// `?autoplay=MS`: start the radio MS after load, with no tap. Browsers refuse
// that (autoplay policy): `play()` rejects with AUTOPLAY_BLOCKED and the
// status says `interruption.reason: 'autoplay-blocked'` until the user taps.
// (A typed URL counts as a gesture for ~5 s in Chromium; a delay outlasts it.)
if (params.has('autoplay')) {
  setTimeout(
    () => {
      player
        .load(STATIONS[0].source)
        .then(() => player.play())
        .then(
          () => record('autoplay', { outcome: 'played' }),
          (error) => record('autoplay', { outcome: error.code })
        );
    },
    Number(params.get('autoplay')) || 0
  );
}
