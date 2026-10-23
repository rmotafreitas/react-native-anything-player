import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CLI, makeDir, read, runCli, write } from './cli-fixtures.mjs';
import { detectSource, migrateCode } from '../../bin/cli/migrate.mjs';

const EXPO_AUDIO = `import { createAudioPlayer, useAudioPlayerStatus, AudioSource } from 'expo-audio';

const audio = createAudioPlayer('https://radio.example/live.mp3');
audio.volume = 0.5;
audio.muted = true;
audio.replace('https://radio.example/other.mp3');
audio.seekTo(10);
audio.setPlaybackRate(1.5);

export function status(source: AudioSource) {
  const current = useAudioPlayerStatus(audio);
  return { current, source };
}
`;

const EXPO_AV = `import { Audio, Video, AVPlaybackStatus } from 'expo-av';

export async function play(source: string) {
  Audio.setAudioModeAsync({ staysActiveInBackground: true });
  const { sound } = await Audio.Sound.createAsync(source, { shouldPlay: true, positionMillis: 2500 });
  await sound.playAsync();
  await sound.setVolumeAsync(0.5);
  await sound.setPositionAsync(30000);
  sound.setOnPlaybackStatusUpdate((status: AVPlaybackStatus) => console.log(status));
}
`;

test('detectSource knows the three migrations', () => {
  assert.equal(detectSource("import T from 'react-native-track-player';"), 'track-player');
  assert.equal(detectSource("const T = require('@rntp/player');"), 'track-player');
  assert.equal(detectSource("import { createAudioPlayer } from 'expo-audio';"), 'expo-audio');
  assert.equal(detectSource("import { Audio } from 'expo-av';"), 'expo-av');
  assert.equal(detectSource("import { Player } from 'react-native-anything-player';"), null);
});

test('expo-audio: the player, its setters and its types', () => {
  const result = migrateCode(EXPO_AUDIO, { file: 'audio.ts' });
  assert.ok(result);
  assert.equal(result.source, 'expo-audio');
  assert.equal(result.changes, 9);
  assert.match(
    result.code,
    /import \{ Player, usePlayerStatus \} from 'react-native-anything-player';/
  );
  assert.match(
    result.code,
    /import type \{ SourceInput \} from 'react-native-anything-player';/
  );
  assert.doesNotMatch(result.code, /from 'expo-audio'/);
  assert.match(result.code, /const audio = new Player\(\);\naudio\.load\('https:\/\/radio\.example\/live\.mp3'\);/);
  assert.match(result.code, /audio\.setVolume\(0\.5\);/);
  assert.match(result.code, /audio\.setMuted\(true\);/);
  assert.match(result.code, /audio\.load\('https:\/\/radio\.example\/other\.mp3'\);/);
  assert.match(result.code, /audio\.setRate\(1\.5\);/);
  assert.match(result.code, /usePlayerStatus\(audio\)/);
  assert.match(result.code, /source: SourceInput/);
  const notes = result.notes.map((note) => note.text);
  assert.ok(notes.some((note) => /^createAudioPlayer\(\) became/.test(note)));
  assert.ok(notes.some((note) => /^useAudioPlayerStatus\(\) became/.test(note)));
});

test('expo-audio: a hook that creates its own player is left alone', () => {
  const code = `import { useAudioPlayer } from 'expo-audio';
export function Play({ url }: { url: string }) {
  const player = useAudioPlayer(url);
  return player.playing;
}
`;
  const result = migrateCode(code, { file: 'Player.tsx' });
  assert.ok(result);
  assert.equal(result.changes, 0);
  assert.match(result.code, /import \{ useAudioPlayer \} from 'expo-audio';/);
  assert.match(result.notes[0].text, /^useAudioPlayer\(\) creates a player/);
});

test('expo-av: createAsync becomes one player, and the mode call goes away', () => {
  const result = migrateCode(EXPO_AV, { file: 'av.tsx' });
  assert.ok(result);
  assert.equal(result.source, 'expo-av');
  assert.match(result.code, /^import \{ Video, AVPlaybackStatus \} from 'expo-av';/m);
  assert.match(result.code, /^import \{ player \} from '\.\/player';/m);
  assert.doesNotMatch(result.code, /\n\s*Audio\.setAudioModeAsync/);
  assert.match(
    result.code,
    /await player\.load\(source, \{ autoplay: true, startPosition: 2\.5 \}\);/
  );
  assert.match(result.code, /await player\.play\(\);/);
  assert.match(result.code, /await player\.setVolume\(0\.5\);/);
  assert.match(result.code, /await player\.seekTo\(30\);/);
  // The status payload differs (PlayerStatus is not AVPlaybackStatus), so the
  // listener is left for a human.
  assert.match(
    result.code,
    /sound\.setOnPlaybackStatusUpdate\(\(status: AVPlaybackStatus\) =>/
  );
  assert.doesNotMatch(result.code, /player\.on\('status'/);
  const notes = result.notes.map((note) => note.text);
  assert.ok(
    notes.some((note) =>
      /setOnPlaybackStatusUpdate\(fn\) is left as it is.*#status-and-events/.test(note)
    )
  );
  assert.ok(notes.some((note) => /^`sound` is gone/.test(note)));
  assert.ok(notes.some((note) => /Audio\.setAudioModeAsync\(\) is not needed/.test(note)));
  assert.ok(notes.some((note) => /`Video` stays in expo-av/.test(note)));
});

test('expo-av: a sound that outlives the calls is called out', () => {
  const code = EXPO_AV.replace(
    '  sound.setOnPlaybackStatusUpdate',
    '  return sound;\n  sound.setOnPlaybackStatusUpdate'
  );
  const result = migrateCode(code, { file: 'av.tsx' });
  assert.ok(result);
  const notes = result.notes.map((note) => note.text);
  assert.ok(notes.some((note) => note.startsWith('`sound` is gone')));
});

test('expo-av: anything but the mechanical shape is not rewritten', () => {
  const code = `import { Audio } from 'expo-av';
export function load(source: string) {
  const pending = Audio.Sound.createAsync(source);
  return pending;
}
`;
  const result = migrateCode(code, { file: 'av.ts' });
  assert.ok(result);
  assert.equal(result.changes, 0);
  assert.match(result.code, /Audio\.Sound\.createAsync\(source\)/);
  assert.match(
    result.notes[0].text,
    /outside `const \{ sound \} = await …`/
  );
});

test('track player: hooks and State move, the singleton stays when a call cannot', () => {
  const code = `import TrackPlayer, { State, useProgress, usePlaybackState } from 'react-native-track-player';
export async function start(url: string) {
  await TrackPlayer.setupPlayer();
  await TrackPlayer.play();
  const progress = useProgress();
  const playback = usePlaybackState();
  return { progress, playback, playing: State.Playing };
}
`;
  const result = migrateCode(code, { file: 'player.ts' });
  assert.ok(result);
  assert.match(result.code, /^import TrackPlayer from 'react-native-track-player';/m);
  assert.match(result.code, /^import \{ useProgress, usePlaybackState \} from 'react-native-anything-player';/m);
  assert.match(result.code, /useProgress\(player\)/);
  assert.match(result.code, /usePlaybackState\(player\)/);
  assert.match(result.code, /playing: 'playing'/);
  assert.match(result.code, /await TrackPlayer\.setupPlayer\(\);/);
  const notes = result.notes.map((note) => note.text);
  assert.ok(notes.some((note) => /TrackPlayer\.setupPlayer\(\): create one/.test(note)));
  assert.ok(notes.some((note) => /must point at the module that creates/.test(note)));
});

test('track player: a fully mapped file moves every call to the player', () => {
  const code = `import TrackPlayer, { State } from 'react-native-track-player';
export function a() {
  TrackPlayer.play();
  TrackPlayer.seekBy(5000);
  const v = TrackPlayer.getVolume();
  const s = TrackPlayer.getState();
  return { v, s, playing: State.Playing };
}
`;
  const result = migrateCode(code, { file: 'player.ts' });
  assert.ok(result);
  assert.doesNotMatch(result.code, /react-native-track-player/);
  assert.match(result.code, /^import \{ player \} from '\.\/player';$/m);
  assert.match(result.code, /player\.play\(\);/);
  assert.match(
    result.code,
    /player\.seekTo\(player\.getProgress\(\)\.position \+ 5000\);/
  );
  assert.match(result.code, /player\.status\.volume/);
  assert.match(result.code, /const s = player\.state;/);
  assert.doesNotMatch(result.code, /player\.status;/);
});

test('track player: getPlaybackState() keeps the { state } shape', () => {
  const code = `import TrackPlayer from 'react-native-track-player';
export async function a() {
  const playback = await TrackPlayer.getPlaybackState();
  return (await TrackPlayer.getPlaybackState()).state === 'playing' ? playback : null;
}
`;
  const result = migrateCode(code, { file: 'player.ts' });
  assert.ok(result);
  assert.match(result.code, /const playback = await \{ state: player\.state \};/);
  assert.match(result.code, /\(await \{ state: player\.state \}\)\.state === 'playing'/);
  assert.ok(result.notes.some((note) => /getPlaybackState\(\) became \{ state: player\.state \}/.test(note.text)));
});

test('track player: a namespace import is migrated member by member', () => {
  const code = `import * as TrackPlayer from 'react-native-track-player';
export async function a() {
  await TrackPlayer.play();
  const progress = TrackPlayer.useProgress(500);
  const s = await TrackPlayer.getState();
  return { progress, s, playing: TrackPlayer.State.Playing };
}
`;
  const result = migrateCode(code, { file: 'player.ts' });
  assert.ok(result);
  assert.doesNotMatch(result.code, /TrackPlayer/);
  assert.doesNotMatch(result.code, /react-native-track-player/);
  assert.match(result.code, /^import \{ useProgress \} from 'react-native-anything-player';/m);
  assert.match(result.code, /^import \{ player \} from '\.\/player';/m);
  assert.match(result.code, /await player\.play\(\);/);
  assert.match(result.code, /useProgress\(player, 500\)/);
  assert.match(result.code, /await player\.state;/);
  assert.match(result.code, /playing: 'playing'/);
});

test('track player: a namespace with a call that cannot move is left whole', () => {
  const code = `import * as TrackPlayer from 'react-native-track-player';
export async function a() {
  await TrackPlayer.setupPlayer();
  await TrackPlayer.play();
}
`;
  const result = migrateCode(code, { file: 'player.ts' });
  assert.ok(result);
  assert.match(result.code, /^import \* as TrackPlayer from 'react-native-track-player';/m);
  assert.match(result.code, /await TrackPlayer\.play\(\);/);
  assert.match(result.code, /await TrackPlayer\.setupPlayer\(\);/);
  assert.ok(result.notes.some((note) => /TrackPlayer\.setupPlayer\(\): create one/.test(note.text)));
  assert.equal(migrateCode(result.code, { file: 'player.ts' }), null);
});

test('expo-audio: a namespace import stays with its calls, and says so', () => {
  const code = `import * as Audio from 'expo-audio';
export const player = Audio.createAudioPlayer('https://radio.example/live.mp3');
export function useStatus() {
  return Audio.useAudioPlayerStatus(player);
}
`;
  const result = migrateCode(code, { file: 'audio.ts' });
  assert.ok(result);
  assert.match(result.code, /^import \* as Audio from 'expo-audio';/m);
  assert.match(result.code, /Audio\.createAudioPlayer\(/);
  assert.match(result.code, /Audio\.useAudioPlayerStatus\(player\)/);
  assert.ok(result.notes.some((note) => /`Audio` imports all of expo-audio/.test(note.text)));
  assert.equal(migrateCode(result.code, { file: 'audio.ts' }), null);
});

test('a CRLF file keeps CRLF in its edits and its notes', () => {
  const crlf = (text) => text.replace(/\n/g, '\r\n');
  const code = crlf(`import { createAudioPlayer } from 'expo-audio';
import { other } from './other';

const audio = createAudioPlayer('https://radio.example/live.mp3');
audio.loop = true;
`);
  const result = migrateCode(code, { file: 'audio.ts' });
  assert.ok(result);
  assert.match(result.code, /rnap-migrate/);
  assert.doesNotMatch(result.code, /[^\r]\n/);
  assert.match(result.code, /new Player\(\);\r\naudio\.load\(/);
  // A second run merges into the same header and stays CRLF.
  assert.equal(migrateCode(result.code, { file: 'audio.ts' }), null);
});

test('a file with LF stays LF', () => {
  const result = migrateCode(EXPO_AUDIO, { file: 'audio.ts' });
  assert.ok(result);
  assert.doesNotMatch(result.code, /\r/);
});

test('a second run changes nothing', () => {
  for (const [file, code] of [
    ['audio.ts', EXPO_AUDIO],
    ['av.tsx', EXPO_AV],
    [
      'player.ts',
      `import TrackPlayer, { useProgress } from 'react-native-track-player';\nexport const p = () => useProgress();\n`,
    ],
  ]) {
    const once = migrateCode(code, { file });
    assert.ok(once, `${file} should migrate once`);
    assert.equal(migrateCode(once.code, { file }), null, `${file} should be idempotent`);
  }
});

function fixture(t) {
  const root = makeDir(t);
  write(
    root,
    'package.json',
    JSON.stringify({ name: 'app', dependencies: { 'react-native': '0.86.3' } })
  );
  write(root, 'src/audio.ts', EXPO_AUDIO);
  write(root, 'src/broken.ts', "import { Audio } from 'expo-av';\nconst x = ;\n");
  return root;
}

test('migrate --dry-run shows the diff and writes nothing', (t) => {
  const root = fixture(t);
  const before = read(root, 'src/audio.ts');
  const result = runCli(['migrate', '--dry-run'], { cwd: root });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /\+\+\+ b\/src\/audio\.ts/);
  assert.match(result.stdout, /Dry run: 1 file would change, nothing written\./);
  assert.match(result.stdout, /Could not parse\n {2}src\/broken\.ts:/);
  assert.equal(read(root, 'src/audio.ts'), before);
});

test('migrate --yes --json writes the files and speaks only JSON', (t) => {
  const root = fixture(t);
  const result = runCli(['migrate', '--yes', '--json'], { cwd: root });

  assert.equal(result.status, 1);
  assert.equal(result.json.schemaVersion, 1);
  assert.equal(result.json.command, 'migrate');
  assert.equal(result.json.from, 'auto');
  assert.equal(result.json.dryRun, false);
  assert.deepEqual(result.json.applied, ['src/audio.ts']);
  assert.deepEqual(result.json.skipped, []);
  assert.equal(result.json.files[0].source, 'expo-audio');
  assert.deepEqual(result.json.unparsed.map((item) => item.file), [
    'src/broken.ts',
  ]);

  const after = read(root, 'src/audio.ts');
  assert.match(after, /^\/\/ rnap-migrate: what still needs a human/m);
  assert.match(after, /import \{ Player, usePlayerStatus \}/);
});

test('a migrated project has nothing left to rewrite', (t) => {
  const root = makeDir(t);
  write(root, 'package.json', JSON.stringify({ name: 'app' }));
  write(root, 'src/audio.ts', EXPO_AUDIO);

  assert.equal(runCli(['migrate', '--yes'], { cwd: root }).status, 0);
  const again = runCli(['migrate', '--yes'], { cwd: root });
  assert.equal(again.status, 0);
  assert.match(again.stdout, /Nothing to rewrite/);
});

test('bad usage and unsafe paths exit 2', (t) => {
  const root = fixture(t);

  const from = runCli(['migrate', '--from', 'nope'], { cwd: root });
  assert.equal(from.status, 2);
  assert.match(from.stdout, /unknown migration `--from nope`/);

  const missing = runCli(['migrate', 'nope.ts'], { cwd: root });
  assert.equal(missing.status, 2);
  assert.match(missing.stdout, /no such path: nope\.ts/);

  const outside = runCli(['migrate', '..'], { cwd: root });
  assert.equal(outside.status, 2);
  assert.match(outside.stdout, /outside the project: \.\./);
});

test('--from limits the migration to one library', (t) => {
  const root = fixture(t);
  const result = runCli(['migrate', 'src/audio.ts', '--from', 'expo-av'], {
    cwd: root,
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Nothing to rewrite/);
  assert.match(read(root, 'src/audio.ts'), /^import \{ createAudioPlayer,/m);
});

test('migrate loads @babel/parser from the project being migrated', (t) => {
  const root = makeDir(t);
  write(root, 'package.json', JSON.stringify({ name: 'app' }));
  write(root, 'src/audio.ts', EXPO_AUDIO);
  // The project's copy wins over the CLI's own: a stub proves which one ran.
  write(
    root,
    'node_modules/@babel/parser/index.js',
    "exports.parse = () => { throw new Error('project parser'); };\n"
  );
  const result = runCli(['migrate', '--dry-run'], { cwd: root });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /src\/audio\.ts: could not parse: project parser/);
});

test('migrate says how to install @babel/parser when nothing provides it', (t) => {
  // A copy of the CLI outside the repository has no node_modules to fall back
  // on, like the published package in a project without @babel/parser.
  const home = makeDir(t, 'rnap-cli-home-');
  fs.cpSync(path.dirname(CLI), path.join(home, 'bin'), { recursive: true });
  fs.copyFileSync(
    path.resolve(path.dirname(CLI), '../package.json'),
    path.join(home, 'package.json')
  );
  const root = makeDir(t);
  write(root, 'package.json', JSON.stringify({ name: 'app' }));
  write(root, 'src/audio.ts', EXPO_AUDIO);
  const before = read(root, 'src/audio.ts');

  const result = spawnSync(
    process.execPath,
    [path.join(home, 'bin/rnap.mjs'), 'migrate', '--yes', '--no-color'],
    { cwd: root, encoding: 'utf8' }
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /needs @babel\/parser/);
  assert.match(result.stdout, /npm install --save-dev @babel\/parser/);
  assert.equal(read(root, 'src/audio.ts'), before);
});
