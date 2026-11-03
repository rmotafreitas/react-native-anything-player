#!/usr/bin/env node
// Records what a browser plays while RNAP switches between the test station's
// live renditions, and reports what each switch did to the audio.
//
//   yarn prepare && node scripts/stream-server/server.mjs &
//   node example-web/serve.mjs 4300 &
//   node scripts/align-measure/web.mjs [chromium|firefox|webkit] [--plain|--hls] [--qualities 320,64,320,192,64,192]
//
// `--hls` plays the live HLS renditions instead (/radio-hls: 2, 4 and 6 s
// segments with program dates), lined up by their program dates.
// `--plain` serves the mounts without CORS: the browser plays them on a plain
// <audio> (no MediaSource), where the new element cannot be moved and is run
// faster instead. Needs PulseAudio (`pactl`, `parecord`): the browser plays
// into a null sink whose monitor is recorded, so the recording is what would
// be heard. Prints a JSON summary; the recording is kept in the temp dir.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';
import { jumps, seconds, readWav } from './analyze.mjs';

const args = process.argv.slice(2);
const browserName = args.find((a) => !a.startsWith('--') && !/^[\d,]+$/.test(a)) ?? 'chromium';
const plain = args.includes('--plain');
const hls = args.includes('--hls');
const qualityArg = args[args.indexOf('--qualities') + 1];
const qualities = (args.includes('--qualities') ? qualityArg : '320,64,320,192,64,192').split(',');
const RADIO = process.env.RADIO ?? 'http://localhost:8765';
const PAGE = process.env.PAGE ?? 'http://localhost:4300/';
const SINK = 'rnap_align';
/** After a switch's takeover, this long is heard before the next one. */
const HEAR_AFTER_MS = 8_000;
const SWITCH_TIMEOUT_MS = 60_000;

function ensureSink() {
  const sinks = execFileSync('pactl', ['list', 'short', 'sinks'], { encoding: 'utf8' });
  if (!sinks.includes(SINK))
    execFileSync('pactl', ['load-module', 'module-null-sink', `sink_name=${SINK}`]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  ensureSink();
  const dir = mkdtempSync(join(tmpdir(), 'rnap-align-'));
  const wav = join(dir, `${browserName}${plain ? '-plain' : ''}${hls ? '-hls' : ''}.wav`);
  const recorder = spawn('parecord', [`--device=${SINK}.monitor`, '--file-format=wav', '--channels=1', '--rate=44100', wav]);
  const recordStart = Date.now();
  const kind = { chromium, firefox, webkit }[browserName];
  const browser = await kind.launch({
    env: { ...process.env, PULSE_SINK: SINK },
    // Playwright mutes Chromium: here the audio is the measurement.
    ignoreDefaultArgs: browserName === 'chromium' ? ['--mute-audio'] : [],
    args: browserName === 'chromium' ? ['--autoplay-policy=no-user-gesture-required'] : [],
    firefoxUserPrefs: { 'media.autoplay.default': 0 },
  });
  const page = await browser.newPage();
  await page.goto(PAGE);
  const suffix = plain ? '?noCors=1' : '';
  // A click: the page has the user's activation (autoplay, unmuting).
  await page.mouse.click(5, 5);
  await page.evaluate(
    async ({ radio, suffix, first, ids, hls }) => {
      const p = window.rnap.player;
      await p.load(
        {
          live: true,
          renditions: [...new Set(['64', '192', '320', ...ids])].map((id) => ({
            id,
            uri: hls ? `${radio}/radio-hls/${id}/live.m3u8` : `${radio}/radio/${id}${suffix}`,
            bitrate: parseInt(id, 10) * 1000 + (id.endsWith('aac') ? 1 : 0),
          })),
        },
        { quality: first }
      );
      await p.play();
    },
    { radio: RADIO, suffix, first: qualities[0], ids: qualities, hls }
  );
  await sleep(10_000);
  const switches = [];
  for (const quality of qualities.slice(1)) {
    const from = await page.evaluate(() => window.rnap.player.status.quality);
    const askedAt = Date.now();
    await page.evaluate((q) => window.rnap.player.selectQuality(q), quality);
    let tookOverAt = null;
    while (Date.now() - askedAt < SWITCH_TIMEOUT_MS) {
      const now = await page.evaluate(() => window.rnap.player.status.quality);
      if (now === quality) {
        tookOverAt = Date.now();
        break;
      }
      await sleep(50);
    }
    switches.push({ from, to: quality, askedAt: (askedAt - recordStart) / 1000, tookOverAt: tookOverAt == null ? null : (tookOverAt - recordStart) / 1000 });
    await sleep(HEAR_AFTER_MS);
  }
  const notes = await page.evaluate(() =>
    window.rnap.player
      .getDiagnostics()
      .filter((d) => /quality switch (aligned|not aligned)/.test(d.event))
      .map((d) => ({ event: d.event, details: d.details }))
  );
  const discontinuities = await page.evaluate(() => window.rnap.events.filter((e) => e.type === 'discontinuity').length);
  const engine = await page.evaluate(() => (window.rnap.player.getDiagnostics().some((d) => d.event.includes('plain playback')) ? 'plain <audio>' : 'MediaSource'));
  await browser.close();
  recorder.kill('SIGINT');
  await new Promise((r) => recorder.on('exit', r));
  const heard = seconds(readWav(wav));
  const { jumps: found } = jumps(heard);
  // Each switch's jump: the one heard near its takeover (none: under the
  // measurement's noise, 12 ms).
  const results = switches.map((s) => {
    const near = s.tookOverAt == null ? [] : found.filter((j) => Math.abs(j.at - s.tookOverAt) < 2.5);
    const jump = near.reduce((sum, j) => sum + j.jump, 0);
    return { ...s, heardJump: Number(jump.toFixed(3)) };
  });
  console.log(
    JSON.stringify(
      { browser: browserName, playback: engine, recording: wav, secondsHeard: heard.length, discontinuities, switches: results, otherJumps: found.filter((j) => !switches.some((s) => s.tookOverAt != null && Math.abs(j.at - s.tookOverAt) < 2.5)), notes },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
