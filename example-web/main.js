/* global location */
// The plain-web example: the same Player API as React Native, in a page with
// no framework. `window.rnap` exposes the player to the end-to-end tests.
import {
  Player,
  addCastStateListener,
  addRoutePickerAvailabilityListener,
  configureCast,
  configureHls,
  getCastStatus,
  isRoutePickerAvailable,
  playFromSearch,
  setCatalog,
  showCastPicker,
  showRoutePicker,
  stopCasting,
} from 'react-native-anything-player/web';

const params = new URLSearchParams(location.search);
/** The test radio (scripts/stream-server); `?stream=` overrides it. */
const STREAM = params.get('stream') ?? 'http://localhost:8765';

// HLS needs hls.js outside Safari. In an app: `import Hls from 'hls.js';
// configureHls(Hls);`. This page loads the copy from node_modules with a
// <script> (see index.html), which also sets `window.Hls`.
if (window.Hls) configureHls(window.Hls);

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
  {
    label: 'Test radio (AAC, ICY)',
    source: {
      uri: `${STREAM}/live.aac?titleEvery=4`,
      live: true,
      metadata: { title: 'RNAP Test Radio AAC' },
    },
  },
  {
    label: 'HLS (on demand)',
    source: {
      uri: `${STREAM}/hls/vod.m3u8`,
      metadata: { title: 'HLS tones' },
    },
  },
  {
    label: 'HLS (live)',
    source: {
      uri: `${STREAM}/hls/live.m3u8`,
      metadata: { title: 'HLS live tones' },
    },
  },
];

/** What a search box (or a microphone) can ask for. */
const CATALOG = [
  {
    id: 'radio',
    title: 'Test radio',
    genre: 'Test Tones',
    keywords: ['RNAP radio', 'test station'],
    source: STATIONS[0].source,
  },
  {
    id: 'tone',
    title: 'Remote tone',
    artist: 'RNAP',
    kind: 'song',
    keywords: ['a tone', 'test tone'],
    source: STATIONS[2].source,
  },
  {
    id: 'animu',
    title: 'Rádio Animu',
    genre: 'Anime',
    keywords: ['animu', 'anime radio'],
    source: STATIONS[3].source,
  },
];

const player = new Player({
  mediaSession: { commands: ['next', 'previous'] },
  progressInterval: 500,
});
const events = [];
window.rnap = { player, events, stations: STATIONS, stopCasting };

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

// ── Local files: a picker and a drop zone. A File goes straight to load();
// RNAP makes the object URL and revokes it when the item is replaced. ──
function playLocalFile(file) {
  document
    .querySelectorAll('#stations button')
    .forEach((b) => b.setAttribute('aria-pressed', 'false'));
  $('file-name').textContent = `${file.name} (${file.type || 'unknown type'})`;
  // A pick or a drop is a gesture: the browser lets it start audio.
  player
    .load(file, { autoplay: true })
    .catch((error) => log(`file failed: ${error.code} ${error.message}`));
}
$('file').addEventListener('change', (event) => {
  const [file] = event.target.files;
  if (file) playLocalFile(file);
});
const dropZone = $('drop');
dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropZone.setAttribute('data-over', 'true');
});
dropZone.addEventListener('dragleave', () =>
  dropZone.removeAttribute('data-over')
);
dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropZone.removeAttribute('data-over');
  const [file] = event.dataTransfer.files;
  if (file) playLocalFile(file);
});
// A file dropped beside the zone would otherwise navigate away from the page.
for (const type of ['dragover', 'drop'])
  window.addEventListener(type, (event) => event.preventDefault());

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

// ── Outputs: the browser's picker (AirPlay in Safari, Remote Playback in
// Chrome) and Google Cast ──
player.on('routeChange', (route, previous) => {
  $('output').textContent = route.name
    ? `${route.kind} (${route.name})`
    : route.kind;
  record('routeChange', { route, previous });
  log(`route ${previous.kind} → ${route.kind}`);
});

const showRoute = () => {
  $('route').hidden = !isRoutePickerAvailable();
};
$('route').addEventListener('click', () => {
  showRoutePicker(player).catch((error) => log(`picker: ${error.code}`));
});
addRoutePickerAvailabilityListener((available) => {
  record('routePickerAvailability', { available });
  showRoute();
});
showRoute();

const CAST_LABELS = {
  notConnected: () => 'Cast',
  connecting: () => 'Connecting…',
  connected: (device) => `Casting to ${device ?? 'a receiver'}`,
};
function showCast({ state, device }) {
  $('cast-state').textContent = device ? `${state} (${device})` : state;
  const label = CAST_LABELS[state];
  // As the library's Cast button: only where there is something to cast to.
  $('cast').hidden = !label;
  if (label) $('cast').textContent = label(device);
}
addCastStateListener((status) => {
  record('castState', status);
  showCast(status);
});
showCast(getCastStatus());
$('cast').addEventListener('click', () => {
  // A click: the browser lets the Cast dialog open from it.
  showCastPicker().catch((error) => log(`cast: ${error.code}`));
});
// Loads the Cast SDK (Chrome only; elsewhere the state stays `unavailable`).
configureCast({ receiverApplicationId: params.get('receiver') ?? undefined });

// ── Voice: the same search a voice assistant runs, from a box or a microphone ──
setCatalog(CATALOG).catch((error) => log(`catalog: ${error.message}`));
player.on('searchPlay', ({ request, item }) => {
  record('searchPlay', { request, item });
  log(`search “${request.query}” → ${item.title}`);
});

async function search(query) {
  $('search-result').textContent = `“${query}”…`;
  try {
    const item = await playFromSearch(query, player);
    $('search-result').textContent = item
      ? `“${query}” → ${item.title}`
      : `“${query}” → nothing found`;
  } catch (error) {
    $('search-result').textContent = `${error.code}: ${error.message}`;
  }
}
$('search').addEventListener('submit', (event) => {
  event.preventDefault();
  // Submitting is a click or Enter: a gesture, so the audio may start.
  search($('query').value.trim());
});

// Web Speech (Chrome, Safari): speech to text, then the same search.
const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
if (Recognition) {
  $('mic').hidden = false;
  $('mic').addEventListener('click', () => {
    const recognition = new Recognition();
    recognition.lang = navigator.language;
    recognition.onresult = (event) => {
      const said = event.results[0][0].transcript;
      $('query').value = said;
      search(said);
    };
    recognition.onerror = (event) => log(`speech: ${event.error}`);
    recognition.start();
  });
}

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
