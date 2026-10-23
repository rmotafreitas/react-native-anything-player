/* global location */
// The Sound API in a plain page: `Sound.load()` decodes a generated tone into
// memory, `play()` starts a copy of it. `window.soundTest` is for the
// end-to-end tests (e2e/sound.spec.ts).
import { Sound } from 'react-native-anything-player/sound';

const params = new URLSearchParams(location.search);
const log = document.getElementById('log');
const say = (text) => {
  log.textContent += `${text}\n`;
};

/** A mono 16-bit WAV of a sine wave. */
function tone(seconds, hz = 660, rate = 22050) {
  const frames = Math.round(seconds * rate);
  const bytes = new DataView(new ArrayBuffer(44 + frames * 2));
  const text = (at, value) =>
    [...value].forEach((c, i) => bytes.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  bytes.setUint32(4, 36 + frames * 2, true);
  text(8, 'WAVEfmt ');
  bytes.setUint32(16, 16, true);
  bytes.setUint16(20, 1, true);
  bytes.setUint16(22, 1, true);
  bytes.setUint32(24, rate, true);
  bytes.setUint32(28, rate * 2, true);
  bytes.setUint16(32, 2, true);
  bytes.setUint16(34, 16, true);
  text(36, 'data');
  bytes.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i += 1)
    bytes.setInt16(
      44 + i * 2,
      Math.sin((2 * Math.PI * hz * i) / rate) * 8000,
      true
    );
  return new Blob([bytes], { type: 'audio/wav' });
}

let clip = null;
const test = {
  Sound,
  tone,
  errors: [],
  async load(seconds, options) {
    clip = await Sound.load(tone(seconds), options);
    say(`loaded: ${clip.duration}s, ${clip.voices} voices`);
    return clip;
  },
  play(options) {
    try {
      const voice = clip.play(options);
      say('playing');
      return voice;
    } catch (error) {
      test.errors.push(error.code);
      say(`error: ${error.code}`);
      return null;
    }
  },
};
window.soundTest = test;

document.getElementById('load').onclick = () => test.load(0.4);
document.getElementById('play').onclick = () =>
  test.play({ pan: Math.random() * 2 - 1 });
document.getElementById('stop').onclick = () => Sound.stopAll();

// `?autoplay=ms`: play without a gesture, to see the policy answer.
const autoplay = Number(params.get('autoplay') ?? 0);
if (autoplay > 0)
  test.load(0.4).then(() => setTimeout(() => test.play(), autoplay));
