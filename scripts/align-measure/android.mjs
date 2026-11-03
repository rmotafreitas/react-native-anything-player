#!/usr/bin/env node
// Records what an Android emulator plays while the example app's
// `live-renditions` scenario switches between the test station's renditions,
// and reports what each switch did to the audio.
//
//   node scripts/stream-server/server.mjs &
//   yarn example start --port 8088 &
//   PULSE_SINK=rnap_align emulator -avd <avd> (with audio) &
//   node scripts/align-measure/android.mjs [serial] [--hls]
//
// The emulator plays into the PulseAudio null sink `rnap_align` (start it
// with PULSE_SINK=rnap_align, without -no-audio), or, with `--wav FILE`, into
// QEMU's wave writer (QEMU_AUDIO_DRV=wav QEMU_WAV_PATH=FILE emulator …): the
// file grows only while the device plays, so its time is anchored to the
// scenario's PLAYING line. The example app (debug build) reaches Metro and
// the test server through `adb reverse`.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jumps, readWav, seconds } from './analyze.mjs';

const argv = process.argv.slice(2);
const wavArg = argv.includes('--wav') ? argv[argv.indexOf('--wav') + 1] : null;
// `--hls`: the live HLS renditions (program dates) instead of the Icecast mounts.
const scenario = argv.includes('--hls') ? 'live-hls-renditions' : 'live-renditions';
const serial = argv.find((a) => !a.startsWith('--') && a !== wavArg) ?? process.env.ANDROID_SERIAL ?? 'emulator-5556';
const SINK = 'rnap_align';
const adb = (...args) => execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8' });

const sinks = execFileSync('pactl', ['list', 'short', 'sinks'], { encoding: 'utf8' });
if (!sinks.includes(SINK)) execFileSync('pactl', ['load-module', 'module-null-sink', `sink_name=${SINK}`]);
adb('reverse', 'tcp:8081', 'tcp:8088');
// The example's debug_http_host is localhost:8088 (docs/testing.md).
adb('reverse', 'tcp:8088', 'tcp:8088');
adb('reverse', 'tcp:8765', 'tcp:8765');
// The device's wall clock against this machine's: SWITCH times are the device's.
const before = Date.now();
const deviceNow = Number(adb('shell', 'date', '+%s%3N').trim());
const clockOffset = deviceNow - (before + Date.now()) / 2;

const dir = mkdtempSync(join(tmpdir(), 'rnap-align-'));
const wav = join(dir, 'android.wav');
const recorder = wavArg
  ? null
  : spawn('parecord', [`--device=${SINK}.monitor`, '--file-format=wav', '--channels=1', '--rate=44100', wav]);
const wavFrom = wavArg ? statSync(wavArg).size : 0;
const recordStart = Date.now();
adb('logcat', '-c');
const logcat = spawn('adb', ['-s', serial, 'logcat', '-v', 'raw', 'ReactNativeJS:I', 'RNAP:D', '*:S']);
const lines = [];
logcat.stdout.on('data', (d) => lines.push(...d.toString().split('\n')));
adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', `anythingplayer-example://test/${scenario}`);

const deadline = Date.now() + 320_000;
while (Date.now() < deadline && !lines.some((l) => new RegExp(`\\[RNAPTest\\] (PASS|FAIL) ${scenario}\\b`).test(l))) {
  await new Promise((r) => setTimeout(r, 1000));
}
await new Promise((r) => setTimeout(r, 1000));
logcat.kill();
if (recorder) {
  recorder.kill('SIGINT');
  await new Promise((r) => recorder.on('exit', r));
} else {
  // The device's output since the scenario started, as a WAV of its own (QEMU: 44.1 kHz, stereo, 16-bit).
  const all = readFileSync(wavArg);
  const from = Math.max(44, wavFrom - ((wavFrom - 44) % 4));
  const data = all.subarray(from);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(2, 22);
  head.writeUInt32LE(44100, 24);
  head.writeUInt32LE(44100 * 4, 28);
  head.writeUInt16LE(4, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  writeFileSync(wav, Buffer.concat([head, data]));
}

const result = lines.find((l) => new RegExp(`\\[RNAPTest\\] (PASS|FAIL) ${scenario}\\b`).test(l)) ?? 'no result';
// Where the recording's time 0 is on this machine's clock: when it started,
// or (the wave writer) when the device started playing.
const playing = lines.map((l) => /PLAYING at=(\d+)/.exec(l)).find(Boolean);
const origin = wavArg && playing ? Number(playing[1]) - clockOffset : recordStart;
const switches = lines
  .map((l) => /SWITCH (\d+) asked=(\d+) took=(\d+)/.exec(l))
  .filter(Boolean)
  .map(([, to, asked, took]) => ({
    to,
    askedAt: (Number(asked) - clockOffset - origin) / 1000,
    tookOverAt: (Number(took) - clockOffset - origin) / 1000,
  }));
const heard = seconds(readWav(wav));
const { jumps: found } = jumps(heard);
const near = (s) => found.filter((j) => Math.abs(j.at - s.tookOverAt) < 2.5);
console.log(
  JSON.stringify(
    {
      device: serial,
      result: result.replace(/.*\[RNAPTest\] /, ''),
      recording: wav,
      secondsHeard: heard.length,
      switches: switches.map((s) => ({
        ...s,
        takeoverAfter: Number((s.tookOverAt - s.askedAt).toFixed(1)),
        heardJump: Number(near(s).reduce((sum, j) => sum + j.jump, 0).toFixed(3)),
      })),
      otherJumps: found.filter((j) => !switches.some((s) => Math.abs(j.at - s.tookOverAt) < 2.5)),
      notes: lines.filter((l) => /quality switch/.test(l)).map((l) => l.trim()),
    },
    null,
    2
  )
);
