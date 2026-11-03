#!/usr/bin/env node
// Records the Expo example's `live-renditions` scenario on React Native Web
// (the Expo web export, served at PAGE) in a browser, and reports what each
// switch did to the audio, like android.mjs does on a device.
//
//   bash scripts/build-expo-web.sh && node example-web/serve.mjs 4400 example-expo/dist-web &
//   node scripts/stream-server/server.mjs &
//   node scripts/align-measure/rnw.mjs [chromium|firefox|webkit] [--hls]
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, firefox, webkit } from '@playwright/test';
import { jumps, readWav, seconds } from './analyze.mjs';

const browserName = process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) ?? 'chromium';
const scenario = process.argv.includes('--hls') ? 'live-hls-renditions' : 'live-renditions';
const PAGE = process.env.PAGE ?? 'http://localhost:4400/';
const SINK = 'rnap_align';

const sinks = execFileSync('pactl', ['list', 'short', 'sinks'], { encoding: 'utf8' });
if (!sinks.includes(SINK)) execFileSync('pactl', ['load-module', 'module-null-sink', `sink_name=${SINK}`]);
const wav = join(mkdtempSync(join(tmpdir(), 'rnap-align-')), `rnw-${browserName}.wav`);
const recorder = spawn('parecord', [`--device=${SINK}.monitor`, '--file-format=wav', '--channels=1', '--rate=44100', wav]);
const recordStart = Date.now();
const browser = await { chromium, firefox, webkit }[browserName].launch({
  env: { ...process.env, PULSE_SINK: SINK },
  ignoreDefaultArgs: browserName === 'chromium' ? ['--mute-audio'] : [],
  args: browserName === 'chromium' ? ['--autoplay-policy=no-user-gesture-required'] : [],
  firefoxUserPrefs: { 'media.autoplay.default': 0 },
});
const page = await browser.newPage();
const lines = [];
page.on('console', (m) => {
  const text = m.text();
  if (text.startsWith('[RNAPTest]')) lines.push(text.slice('[RNAPTest] '.length));
});
// A click before it starts: the page may play (the user's activation).
await page.goto(`${PAGE}?rnapTest=${scenario}&delay=2000`);
await page.mouse.click(5, 5);
const deadline = Date.now() + 320_000;
const done = () => lines.find((l) => new RegExp(`^(PASS|FAIL) ${scenario}\\b`).test(l));
while (Date.now() < deadline && !done()) await new Promise((r) => setTimeout(r, 1000));
await browser.close();
recorder.kill('SIGINT');
await new Promise((r) => recorder.on('exit', r));

const switches = lines
  .map((l) => /SWITCH (\d+) asked=(\d+) took=(\d+)/.exec(l))
  .filter(Boolean)
  .map(([, to, asked, took]) => ({ to, askedAt: (Number(asked) - recordStart) / 1000, tookOverAt: (Number(took) - recordStart) / 1000 }));
const heard = seconds(readWav(wav));
const { jumps: found } = jumps(heard);
const near = (s) => found.filter((j) => Math.abs(j.at - s.tookOverAt) < 2.5);
console.log(
  JSON.stringify(
    {
      browser: browserName,
      result: done() ?? 'no result',
      recording: wav,
      secondsHeard: heard.length,
      switches: switches.map((s) => ({
        ...s,
        takeoverAfter: Number((s.tookOverAt - s.askedAt).toFixed(1)),
        heardJump: Number(near(s).reduce((sum, j) => sum + j.jump, 0).toFixed(3)),
      })),
      otherJumps: found.filter((j) => !switches.some((s) => Math.abs(j.at - s.tookOverAt) < 2.5)),
    },
    null,
    2
  )
);
